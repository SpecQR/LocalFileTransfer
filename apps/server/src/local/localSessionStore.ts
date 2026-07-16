import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadChunkSize } from "../../../../packages/protocol/src/index.ts";
import { availableFilePath } from "./fileNames.ts";
import type {
   InternalLocalFileRecord,
   LocalFileRecord,
   LocalSession,
   LocalSessionEvent,
   LocalSessionEventType,
   LocalSessionKind,
   LocalSessionView,
   LocalTransferLimits
} from "./types.ts";

const idPattern = /^[A-Za-z0-9_-]{12,128}$/u;
const orphanPartialPattern = /\.lft-part-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/u;
const diskReserveBytes = 64 * 1024 * 1024;

export const defaultTransferLimits: LocalTransferLimits = {
   maxFiles: 100,
   maxFileSize: 4 * 1024 * 1024 * 1024,
   maxSessionSize: 20 * 1024 * 1024 * 1024,
   uploadChunkSize
};

export interface LocalLanSessionStoreOptions {
   rootDir: string;
   receiveDir?: string;
   ttlMs: number;
   hardTtlMs?: number;
   limits?: Partial<LocalTransferLimits>;
   now?: () => number;
}

export interface SourceFileInput {
   name: string;
   type: string;
   size: number;
   lastModified: number;
   sourcePath?: string;
   sourceModifiedMs?: number;
}

export interface CreateSessionInput {
   kind: LocalSessionKind;
   appBaseUrl: string;
   destinationDir?: string;
   files?: SourceFileInput[];
}

export interface CreatedLocalSession {
   session: LocalSession;
   token: string;
}

export interface SessionCredential {
   token?: string;
   ticket?: string;
}

export class LocalLanSessionStore {
   readonly rootDir: string;
   readonly receiveDir: string;
   readonly ttlMs: number;
   readonly hardTtlMs: number;
   readonly limits: LocalTransferLimits;
   private readonly now: () => number;
   private readonly sessions = new Map<string, LocalSession>();
   private readonly events = new EventEmitter();
   private readonly writeLocks = new Set<string>();

   constructor(options: LocalLanSessionStoreOptions) {
      this.rootDir = options.rootDir;
      this.receiveDir = options.receiveDir ?? join(options.rootDir, "received");
      this.ttlMs = options.ttlMs;
      this.hardTtlMs = options.hardTtlMs ?? Math.max(options.ttlMs, 60 * 60 * 1000);
      this.limits = {
         ...defaultTransferLimits,
         ...options.limits
      };
      this.now = options.now ?? Date.now;
      this.events.setMaxListeners(200);
   }

   async create(input: CreateSessionInput): Promise<CreatedLocalSession> {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(input.destinationDir ?? this.receiveDir, { recursive: true });
      this.assertFilesWithinLimits(input.files ?? []);

      const sid = randomBase64Url(16);
      const token = randomBase64Url(32);
      const createdAt = this.now();
      const hardExpiresAt = createdAt + this.hardTtlMs;
      const session: LocalSession = {
         sid,
         tokenHash: tokenDigest(token),
         kind: input.kind,
         createdAt,
         lastActivityAt: createdAt,
         expiresAt: Math.min(createdAt + this.ttlMs, hardExpiresAt),
         hardExpiresAt,
         appBaseUrl: input.appBaseUrl,
         destinationDir: input.destinationDir ?? this.receiveDir,
         files: (input.files ?? []).map((file) => this.createFileRecord(file, createdAt)),
         browserTicketHashes: new Map(),
         abortController: new AbortController()
      };

      if (session.kind === "send") {
         for (const file of session.files) {
            if (!file.sourcePath) {
               const storedPath = this.filePath(session, file.fileId);

               file.partialPath = `${storedPath}.partial`;
               file.finalPath = storedPath;
               file.storedPath = storedPath;
               file.temporaryOwned = true;
            }
         }
      }

      this.sessions.set(session.sid, session);
      await mkdir(this.sessionDir(session), { recursive: true });

      for (const file of session.files) {
         if (session.kind === "send" && !file.sourcePath && file.size === 0 && file.storedPath) {
            await writeFile(file.storedPath, Buffer.alloc(0), { flag: "wx" });
            delete file.partialPath;
            file.sha256 = createHash("sha256").digest("hex");
            file.ready = true;
            file.state = "ready";
            file.storedAt = this.now();
         }
      }

      return { session, token };
   }

   get(sid: string): LocalSession | undefined {
      const session = this.sessions.get(sid);

      if (!session) {
         return undefined;
      }

      if (session.expiresAt <= this.now() || session.hardExpiresAt <= this.now()) {
         void this.removeSession(session, "session-expired");
         return undefined;
      }

      return session;
   }

   require(sid: string, token: string, kind?: LocalSessionKind): LocalSession {
      const session = this.get(sid);

      if (!session || !this.verifyToken(session, token)) {
         throw new LocalSessionError(401, "Session was not found or the token is invalid");
      }

      this.assertKind(session, kind);
      this.touch(session);

      return session;
   }

   requireAuthorized(sid: string, credential: SessionCredential, kind?: LocalSessionKind): LocalSession {
      const session = this.get(sid);

      if (!session || !this.verifyCredential(session, credential)) {
         throw new LocalSessionError(401, "Session was not found or authorization has expired");
      }

      this.assertKind(session, kind);
      this.touch(session);

      return session;
   }

   issueBrowserTicket(sid: string, token: string): { ticket: string; expiresAt: number; session: LocalSession } {
      const session = this.require(sid, token);
      const ticket = randomBase64Url(32);

      session.browserTicketHashes.set(tokenDigest(ticket), session.hardExpiresAt);
      this.publish(session, "joined");

      return {
         ticket,
         expiresAt: session.hardExpiresAt,
         session
      };
   }

   verifyToken(session: LocalSession, token: string): boolean {
      return safeDigestEqual(session.tokenHash, tokenDigest(token));
   }

   verifyTicket(session: LocalSession, ticket: string): boolean {
      const digest = tokenDigest(ticket);
      const expiresAt = session.browserTicketHashes.get(digest);

      if (!expiresAt || expiresAt <= this.now()) {
         session.browserTicketHashes.delete(digest);
         return false;
      }

      return true;
   }

   getFile(session: LocalSession, fileId: string): InternalLocalFileRecord | undefined {
      return session.files.find((file) => file.fileId === fileId);
   }

   getCompletedPath(sid: string, fileId: string): string | undefined {
      const session = this.get(sid);
      const file = session && this.getFile(session, fileId);

      return file?.ready && session?.kind === "upload" ? file.finalPath : undefined;
   }

   async addUploadedFile(
      session: LocalSession,
      metadata: Pick<LocalFileRecord, "name" | "type" | "size" | "lastModified">
   ): Promise<InternalLocalFileRecord> {
      this.assertKind(session, "upload");
      const existing = session.files.find((file) => (
         !file.ready
         && file.name === metadata.name
         && file.size === metadata.size
         && file.lastModified === metadata.lastModified
      ));

      if (existing) {
         this.touch(session);
         return existing;
      }

      this.assertFilesWithinLimits([
         ...session.files,
         metadata
      ]);
      await mkdir(session.destinationDir, { recursive: true });
      await this.assertDiskSpace(session.destinationDir, metadata.size);

      const fileId = randomBase64Url(16);
      const reserved = new Set<string>();

      for (const candidateSession of this.sessions.values()) {
         for (const candidateFile of candidateSession.files) {
            if (candidateFile.finalPath) {
               reserved.add(candidateFile.finalPath);
            }
         }
      }

      const finalPath = await availableFilePath(session.destinationDir, metadata.name, reserved);
      const partialPath = `${finalPath}.lft-part-${session.sid}-${fileId}`;
      const createdAt = this.now();
      const file: InternalLocalFileRecord = {
         fileId,
         name: metadata.name,
         type: metadata.type || "application/octet-stream",
         size: metadata.size,
         lastModified: metadata.lastModified || createdAt,
         receivedSize: 0,
         ready: false,
         state: "pending",
         createdAt,
         partialPath,
         finalPath,
         uploadHash: createHash("sha256")
      };

      session.files.push(file);
      this.touch(session);

      if (file.size === 0) {
         await writeFile(partialPath, Buffer.alloc(0), { flag: "wx" });
         await rename(partialPath, finalPath);
         delete file.partialPath;
         file.receivedSize = 0;
         file.sha256 = createHash("sha256").digest("hex");
         delete file.uploadHash;
         file.ready = true;
         file.state = "ready";
         file.storedAt = this.now();
         this.publish(session, "file-complete", file.fileId);
      } else {
         this.publish(session, "upload-progress", file.fileId);
      }

      return file;
   }

   markUploadProgress(session: LocalSession, file: InternalLocalFileRecord, receivedSize: number): void {
      file.receivedSize = receivedSize;
      file.state = "transferring";
      delete file.error;
      this.touch(session);
      this.publish(session, "upload-progress", file.fileId);
   }

   markUploadReady(session: LocalSession, file: InternalLocalFileRecord, sha256: string): void {
      file.receivedSize = file.size;
      file.sha256 = sha256;
      file.ready = true;
      file.state = "ready";
      file.storedAt = this.now();
      delete file.partialPath;
      delete file.uploadHash;
      this.touch(session);
      this.publish(session, "file-complete", file.fileId);
   }

   markFileError(session: LocalSession, file: InternalLocalFileRecord, message: string): void {
      file.state = "failed";
      file.error = message;
      this.touch(session);
      this.publish(session, "error", file.fileId, message);
   }

   beginDownload(session: LocalSession, file: InternalLocalFileRecord): void {
      file.transferredSize = 0;
      this.touch(session);
      this.publish(session, "download-progress", file.fileId);
   }

   reportDownloadProgress(session: LocalSession, file: InternalLocalFileRecord, bytes: number): void {
      file.transferredSize = Math.min(file.size, Math.max(file.transferredSize ?? 0, bytes));
      this.touch(session);
      this.publish(session, "download-progress", file.fileId);
   }

   markDownloadComplete(session: LocalSession, file: InternalLocalFileRecord): void {
      file.transferredSize = file.size;
      this.touch(session);
      this.publish(session, "file-complete", file.fileId);
   }

   markStored(
      session: LocalSession,
      file: InternalLocalFileRecord,
      input: { storedPath: string; receivedSize: number; sha256: string }
   ): void {
      file.storedPath = input.storedPath;
      file.temporaryOwned = true;
      file.receivedSize = input.receivedSize;
      file.sha256 = input.sha256;
      file.ready = true;
      file.state = "ready";
      file.storedAt = this.now();
      this.touch(session);
      this.publish(session, "file-complete", file.fileId);
   }

   filePath(session: LocalSession, fileId: string): string {
      if (!idPattern.test(session.sid) || !idPattern.test(fileId)) {
         throw new LocalSessionError(400, "Invalid file id");
      }

      return join(this.sessionDir(session), `${fileId}.bin`);
   }

   acquireWriteLock(session: LocalSession, fileId: string): () => void {
      const key = `${session.sid}:${fileId}`;

      if (this.writeLocks.has(key)) {
         throw new LocalSessionError(409, "Another chunk is already being written for this file");
      }

      this.writeLocks.add(key);
      return () => this.writeLocks.delete(key);
   }

   subscribe(sid: string, listener: (event: LocalSessionEvent) => void): () => void {
      const eventName = this.eventName(sid);

      this.events.on(eventName, listener);
      return () => this.events.off(eventName, listener);
   }

   async delete(sid: string, token: string): Promise<void> {
      const session = this.require(sid, token);

      await this.removeSession(session, "session-deleted");
   }

   async sweepExpired(): Promise<void> {
      const now = this.now();

      for (const session of [...this.sessions.values()]) {
         if (session.expiresAt <= now || session.hardExpiresAt <= now) {
            await this.removeSession(session, "session-expired");
         }
      }

      await this.removeOrphanSessionDirectories();
      await this.removeOldPartialFiles();
   }

   publicView(session: LocalSession): LocalSessionView {
      return {
         sid: session.sid,
         kind: session.kind,
         createdAt: session.createdAt,
         expiresAt: session.expiresAt,
         files: session.files.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified,
            receivedSize: file.receivedSize,
            ...(file.transferredSize === undefined ? {} : { transferredSize: file.transferredSize }),
            ...(file.sha256 ? { sha256: file.sha256 } : {}),
            ready: file.ready,
            state: file.state,
            ...(file.error ? { error: file.error } : {}),
            createdAt: file.createdAt,
            ...(file.storedAt === undefined ? {} : { storedAt: file.storedAt })
         }))
      };
   }

   publish(
      session: LocalSession,
      type: LocalSessionEventType,
      fileId?: string,
      message?: string
   ): void {
      const event: LocalSessionEvent = {
         t: type,
         ...(type === "session-deleted" || type === "session-expired" ? {} : { session: this.publicView(session) }),
         ...(fileId ? { fileId } : {}),
         ...(message ? { message } : {})
      };

      this.events.emit(this.eventName(session.sid), event);
   }

   private createFileRecord(file: SourceFileInput, createdAt: number): InternalLocalFileRecord {
      const ready = Boolean(file.sourcePath);

      return {
         fileId: randomBase64Url(16),
         name: file.name,
         type: file.type || "application/octet-stream",
         size: file.size,
         lastModified: file.lastModified || createdAt,
         receivedSize: ready ? file.size : 0,
         ready,
         state: ready ? "ready" : "pending",
         createdAt,
         ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
         ...(file.sourceModifiedMs === undefined ? {} : { sourceModifiedMs: file.sourceModifiedMs })
      };
   }

   private verifyCredential(session: LocalSession, credential: SessionCredential): boolean {
      return Boolean(
         (credential.token && this.verifyToken(session, credential.token))
         || (credential.ticket && this.verifyTicket(session, credential.ticket))
      );
   }

   private assertKind(session: LocalSession, kind?: LocalSessionKind): void {
      if (kind && session.kind !== kind) {
         throw new LocalSessionError(404, "Session type does not match this route");
      }
   }

   private touch(session: LocalSession): void {
      const now = this.now();

      session.lastActivityAt = now;
      session.expiresAt = Math.min(now + this.ttlMs, session.hardExpiresAt);
   }

   private assertFilesWithinLimits(files: Array<{ size: number }>): void {
      if (files.length > this.limits.maxFiles) {
         throw new LocalSessionError(413, `A session can contain at most ${this.limits.maxFiles} files`);
      }

      let total = 0;

      for (const file of files) {
         if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.limits.maxFileSize) {
            throw new LocalSessionError(413, "A file exceeds the configured size limit");
         }

         total += file.size;

         if (!Number.isSafeInteger(total) || total > this.limits.maxSessionSize) {
            throw new LocalSessionError(413, "The session exceeds the configured total size limit");
         }
      }
   }

   private async assertDiskSpace(directory: string, requiredBytes: number): Promise<void> {
      try {
         const info = await statfs(directory);
         const available = Number(info.bavail) * Number(info.bsize);

         if (!Number.isFinite(available) || available < requiredBytes + diskReserveBytes) {
            throw new LocalSessionError(507, "There is not enough free disk space for this upload");
         }
      } catch (error) {
         if (error instanceof LocalSessionError) {
            throw error;
         }

         throw new LocalSessionError(507, "Free disk space could not be verified");
      }
   }

   private async removeSession(session: LocalSession, type: "session-expired" | "session-deleted"): Promise<void> {
      if (!this.sessions.has(session.sid)) {
         return;
      }

      this.sessions.delete(session.sid);
      session.abortController.abort();
      this.publish(session, type);
      await this.deleteTemporaryFiles(session);
   }

   private sessionDir(session: LocalSession): string {
      return join(this.rootDir, this.sessionDirName(session));
   }

   private sessionDirName(session: LocalSession): string {
      return `${session.kind}-${session.sid}`;
   }

   private async deleteTemporaryFiles(session: LocalSession): Promise<void> {
      for (const file of session.files) {
         if (file.partialPath) {
            await rm(file.partialPath, { force: true });
         }

         if (file.temporaryOwned && file.storedPath) {
            await rm(file.storedPath, { force: true });
         }
      }

      await rm(this.sessionDir(session), { recursive: true, force: true });
   }

   private async removeOrphanSessionDirectories(): Promise<void> {
      try {
         const entries = await readdir(this.rootDir, { withFileTypes: true });
         const active = new Set([...this.sessions.values()].map((session) => this.sessionDirName(session)));

         for (const entry of entries) {
            if (entry.isDirectory() && !active.has(entry.name)) {
               await rm(join(this.rootDir, entry.name), { recursive: true, force: true });
            }
         }
      } catch {
         // Cleanup is best-effort; active sessions remain protected by in-memory authorization.
      }
   }

   private async removeOldPartialFiles(): Promise<void> {
      try {
         const entries = await readdir(this.receiveDir, { withFileTypes: true });
         const active = new Set(
            [...this.sessions.values()].flatMap((session) => session.files.flatMap((file) => file.partialPath ?? []))
         );
         const oldestAllowed = this.now() - this.hardTtlMs;

         for (const entry of entries) {
            const path = join(this.receiveDir, entry.name);

            if (!entry.isFile() || !orphanPartialPattern.test(entry.name) || active.has(path)) {
               continue;
            }

            const info = await stat(path);

            if (info.mtimeMs <= oldestAllowed) {
               await rm(path, { force: true });
            }
         }
      } catch {
         // The destination may not exist yet or may be temporarily unavailable.
      }
   }

   private eventName(sid: string): string {
      return `session:${sid}`;
   }
}

export class LocalSessionError extends Error {
   readonly statusCode: number;

   constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
   }
}

export function randomBase64Url(byteLength: number): string {
   return randomBytes(byteLength).toString("base64url");
}

export function tokenDigest(token: string): string {
   return createHash("sha256").update(`local-file-transfer-token:${token}`).digest("hex");
}

function safeDigestEqual(expectedHex: string, actualHex: string): boolean {
   const expected = Buffer.from(expectedHex, "hex");
   const actual = Buffer.from(actualHex, "hex");

   return expected.length === actual.length && timingSafeEqual(expected, actual);
}