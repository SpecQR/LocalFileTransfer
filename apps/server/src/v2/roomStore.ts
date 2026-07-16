import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
   access,
   mkdir,
   open,
   rename,
   rm,
   stat,
   statfs,
   truncate,
   writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
   ContentRange,
   DesktopSourceFile,
   RoomEvent,
   RoomEventType,
   RegisterRoomUploadRequest,
   RoomItemView,
   RoomLimits,
   RoomSharedText,
   RoomView,
   UpdateRoomSharedTextRequest,
   UploadRecoveryDiagnostics
} from "../../../../packages/protocol/src/index.ts";
import { availableFilePath } from "../local/fileNames.ts";
import type {
   PersistedRoom,
   PersistedRoomItem,
   PersistedUploadCommit,
   RoomRepository
} from "./types.ts";
import {
   decryptSharedText,
   deriveSharedTextKey,
   encryptSharedText,
   zeroizeKey
} from "./sharedTextCrypto.ts";

const reserveBytes = 64 * 1024 * 1024;
const eventHistoryLimit = 256;
const maxActiveWrites = 4;
const maxActiveReads = 8;
const maxUploadCommitsPerItem = 4_096;
const uploadCommitRetentionMs = 24 * 60 * 60 * 1_000;

export interface RoomStoreOptions {
   repository: RoomRepository;
   rootDir: string;
   receiveDir: string;
   ttlMs: number;
   hardTtlMs: number;
   limits: RoomLimits;
   sourceHasher?: SourceHasher;
   availableBytes?: (directory: string) => Promise<number>;
   now?: () => number;
   uploadCheckpointFault?: UploadCheckpointFaultInjector;
}

export type UploadCheckpointFaultPhase =
   | "before-write"
   | "after-write-before-fsync"
   | "after-fsync-before-commit"
   | "after-commit-before-ack";

export interface UploadCheckpointFaultContext {
   roomId: string;
   itemId: string;
   start: number;
   length: number;
   total: number;
}

export type UploadCheckpointFaultInjector = (
   phase: UploadCheckpointFaultPhase,
   context: UploadCheckpointFaultContext
) => void | Promise<void>;

export interface SourceHasher {
   hash(path: string, size: number, modifiedMs: number): Promise<string>;
}

export interface CreatedRoom {
   room: PersistedRoom;
   token: string;
}

export interface RoomCredential {
   token?: string;
   ticket?: string;
}

export interface UploadCheckpointOptions {
   checksum: string;
   idempotencyKey: string;
}

export interface RoomDiagnosticState {
   rooms: number;
   items: number;
   transferringItems: number;
   activeWrites: number;
   activeReads: number;
   diskSpace: "ok" | "low" | "unavailable";
   recovery: UploadRecoveryDiagnostics;
}

export class RoomStore {
   readonly limits: RoomLimits;
   private readonly repository: RoomRepository;
   private readonly rootDir: string;
   private readonly receiveDir: string;
   private readonly ttlMs: number;
   private readonly hardTtlMs: number;
   private readonly sourceHasher: SourceHasher;
   private readonly availableBytes: (directory: string) => Promise<number>;
   private readonly now: () => number;
   private readonly uploadCheckpointFault: UploadCheckpointFaultInjector | undefined;
   private readonly events = new EventEmitter();
   private readonly writeLocks = new Set<string>();
   private activeReads = 0;
   private readonly abortControllers = new Map<string, AbortController>();
   private readonly sharedTextKeys = new Map<string, Buffer>();
   private readonly recovery: UploadRecoveryDiagnostics = {
      startupTruncations: 0,
      startupTruncatedBytes: 0,
      startupRewinds: 0,
      startupRewoundBytes: 0,
      checkpointRollbacks: 0,
      idempotentReplays: 0,
      recoveredCompletions: 0
   };

   constructor(options: RoomStoreOptions) {
      this.repository = options.repository;
      this.rootDir = options.rootDir;
      this.receiveDir = options.receiveDir;
      this.ttlMs = options.ttlMs;
      this.hardTtlMs = options.hardTtlMs;
      this.limits = options.limits;
      this.sourceHasher = options.sourceHasher ?? { hash: hashSourceFile };
      this.availableBytes = options.availableBytes ?? filesystemAvailableBytes;
      this.now = options.now ?? Date.now;
      this.uploadCheckpointFault = options.uploadCheckpointFault;
      this.events.setMaxListeners(200);
   }

   async initialize(): Promise<void> {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(this.receiveDir, { recursive: true });
      await this.repository.initialize();
      await this.sweepExpired();
      await this.recoverActiveRooms();
   }

   async diagnosticState(): Promise<RoomDiagnosticState> {
      const activeRooms = this.repository.listActiveRooms(this.now());
      const items = activeRooms.flatMap((room) => this.repository.listItems(room.roomId));
      let diskSpace: RoomDiagnosticState["diskSpace"] = "unavailable";

      try {
         const available = await this.availableBytes(this.receiveDir);

         diskSpace = Number.isFinite(available) && available >= reserveBytes ? "ok" : "low";
      } catch {
         diskSpace = "unavailable";
      }

      return {
         rooms: activeRooms.length,
         items: items.length,
         transferringItems: items.filter((item) => item.state === "transferring").length,
         activeWrites: this.writeLocks.size,
         activeReads: this.activeReads,
         diskSpace,
         recovery: { ...this.recovery }
      };
   }

   beginDownload(): () => void {
      if (this.activeReads >= maxActiveReads) {
         throw new RoomError(503, "Too many downloads are active");
      }

      let released = false;

      this.activeReads += 1;
      return () => {
         if (!released) {
            released = true;
            this.activeReads = Math.max(0, this.activeReads - 1);
         }
      };
   }
   close(): void {
      for (const controller of this.abortControllers.values()) {
         controller.abort();
      }

      this.abortControllers.clear();

      for (const key of this.sharedTextKeys.values()) {
         zeroizeKey(key);
      }

      this.sharedTextKeys.clear();
      this.repository.close();
   }

   async createRoom(appBaseUrl: string): Promise<CreatedRoom> {
      const baseUrl = normalizedBaseUrl(appBaseUrl);
      const token = randomId(32);
      const now = this.now();
      const room: PersistedRoom = {
         roomId: randomId(16),
         tokenHash: credentialDigest(token),
         appBaseUrl: baseUrl,
         destinationDir: this.receiveDir,
         createdAt: now,
         lastActivityAt: now,
         expiresAt: now + this.ttlMs,
         hardExpiresAt: now + this.hardTtlMs,
         status: "active",
         eventId: 0
      };

      this.repository.createRoom(room);
      this.rememberSharedTextKey(room.roomId, token);
      this.abortControllers.set(room.roomId, new AbortController());
      this.publish(room, "snapshot");

      return { room, token };
   }

   getLatestActiveRoom(): PersistedRoom | undefined {
      return this.repository.getLatestActiveRoom(this.now());
   }

   resumeRoom(roomId: string, token: string, appBaseUrl: string): PersistedRoom {
      const room = this.requireByToken(roomId, token);

      room.appBaseUrl = normalizedBaseUrl(appBaseUrl);
      this.touch(room);
      this.repository.updateRoom(room);
      this.abortControllers.set(room.roomId, new AbortController());

      return room;
   }

   requireAuthorized(roomId: string, credential: RoomCredential): PersistedRoom {
      const room = this.requireActive(roomId);
      const tokenAuthorized = Boolean(
         credential.token && safeDigestEqual(room.tokenHash, credentialDigest(credential.token))
      );
      const ticketAuthorized = Boolean(
         credential.ticket
         && this.repository.hasTicket(room.roomId, credentialDigest(credential.ticket), this.now())
      );

      if (!tokenAuthorized && !ticketAuthorized) {
         throw new RoomError(401, "Room was not found or authorization expired");
      }

      if (tokenAuthorized && credential.token) {
         this.rememberSharedTextKey(room.roomId, credential.token);
      }

      this.touch(room);
      this.repository.updateRoom(room);

      return room;
   }

   issueTicket(roomId: string, token: string): { ticket: string; expiresAt: number; room: PersistedRoom } {
      const room = this.requireByToken(roomId, token);
      const ticket = randomId(32);

      this.repository.saveTicket(room.roomId, credentialDigest(ticket), room.hardExpiresAt);
      this.publish(room, "peer-joined");

      return {
         ticket,
         expiresAt: room.hardExpiresAt,
         room
      };
   }

   view(roomOrId: PersistedRoom | string): RoomView {
      const room = typeof roomOrId === "string"
         ? this.requireActive(roomOrId)
         : roomOrId;
      const items = this.repository.listItems(room.roomId).map(publicItem);

      return {
         roomId: room.roomId,
         createdAt: room.createdAt,
         expiresAt: room.expiresAt,
         hardExpiresAt: room.hardExpiresAt,
         eventId: room.eventId,
         sharedTextRevision: this.repository.getSharedText(room.roomId)?.revision ?? 0,
         items
      };
   }

   getSharedText(roomOrId: PersistedRoom | string): RoomSharedText {
      const room = typeof roomOrId === "string"
         ? this.requireActive(roomOrId)
         : this.requireActive(roomOrId.roomId);
      return this.readSharedText(room);
   }

   updateSharedText(
      roomOrId: PersistedRoom | string,
      request: UpdateRoomSharedTextRequest
   ): RoomSharedText {
      const room = typeof roomOrId === "string"
         ? this.requireActive(roomOrId)
         : this.requireActive(roomOrId.roomId);
      const current = this.readSharedText(room);

      if (current.revision !== request.expectedRevision) {
         throw new SharedTextConflictError(current);
      }

      const updated: RoomSharedText = {
         content: request.content,
         revision: current.revision + 1,
         updatedAt: this.now()
      };
      const encrypted = encryptSharedText(
         this.requireSharedTextKey(room.roomId),
         room.roomId,
         updated
      );

      if (!this.repository.replaceSharedText(encrypted, request.expectedRevision)) {
         throw new SharedTextConflictError(this.readSharedText(room));
      }

      this.touch(room);
      this.publish(room, "shared-text-updated", undefined, undefined, updated.revision);
      return updated;
   }

   eventsAfter(roomId: string, eventId: number, limit = eventHistoryLimit): RoomEvent[] {
      this.requireActive(roomId);

      return this.repository.listEventsAfter(roomId, Math.max(0, eventId), Math.max(1, Math.min(limit, eventHistoryLimit)));
   }

   subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void {
      this.requireActive(roomId);
      const name = this.eventName(roomId);

      this.events.on(name, listener);
      return () => this.events.off(name, listener);
   }

   async addSourceFiles(roomId: string, token: string, files: DesktopSourceFile[]): Promise<RoomView> {
      const room = this.requireByToken(roomId, token);
      const existing = this.repository.listItems(roomId);
      const checked = await Promise.all(files.map(async (file) => {
         if (!isAbsolute(file.path)) {
            throw new RoomError(400, "A selected source path is invalid");
         }

         const info = await stat(file.path);

         if (!info.isFile()) {
            throw new RoomError(400, "Only regular files can be transferred");
         }

         const modifiedMs = Math.trunc(info.mtimeMs);
         const sha256 = await this.sourceHasher.hash(file.path, info.size, modifiedMs);

         return {
            ...file,
            name: basename(file.path),
            size: info.size,
            lastModified: modifiedMs,
            sha256
         };
      }));

      this.assertWithinLimits(existing, checked);

      for (const file of checked) {
         const item: PersistedRoomItem = {
            itemId: randomId(16),
            roomId,
            direction: "windows_to_device",
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            lastModified: file.lastModified,
            confirmedBytes: 0,
            state: "ready",
            sourcePath: file.path,
            sourceModifiedMs: file.lastModified,
            sha256: file.sha256,
            createdAt: this.now(),
            updatedAt: this.now()
         };

         this.repository.insertItem(item);
         this.publish(room, "item-added", item.itemId);
      }

      return this.view(room);
   }

   async registerUpload(room: PersistedRoom, metadata: RegisterRoomUploadRequest): Promise<PersistedRoomItem> {
      const existing = this.repository.listItems(room.roomId);
      const incompleteMatch = existing.find((item) => (
         item.direction === "device_to_windows"
         && item.state !== "ready"
         && item.state !== "cancelled"
         && item.fingerprint === metadata.fingerprint
      ));

      if (incompleteMatch) {
         return incompleteMatch;
      }

      this.assertWithinLimits(existing, [metadata]);
      await mkdir(room.destinationDir, { recursive: true });
      await this.assertDiskSpace(room.destinationDir, metadata.size);
      const itemId = randomId(16);
      const finalPath = await availableFilePath(room.destinationDir, metadata.name);
      const partialPath = `${finalPath}.lft-part-${room.roomId}-${itemId}`;
      const createdAt = this.now();
      const item: PersistedRoomItem = {
         itemId,
         roomId: room.roomId,
         direction: "device_to_windows",
         name: metadata.name,
         type: metadata.type || "application/octet-stream",
         size: metadata.size,
         lastModified: metadata.lastModified,
         confirmedBytes: 0,
         state: metadata.size === 0 ? "ready" : "pending",
         ...(metadata.size === 0 ? {} : { partialPath }),
         finalPath,
         createdAt,
         updatedAt: createdAt,
         fingerprint: metadata.fingerprint,
         ...(metadata.size === 0 ? {
            sha256: createHash("sha256").digest("hex"),
            completedAt: createdAt
         } : {})
      };

      if (metadata.size === 0) {
         await writeFile(finalPath, Buffer.alloc(0), { flag: "wx" });
      }

      this.repository.insertItem(item);
      this.publish(room, metadata.size === 0 ? "item-complete" : "item-added", item.itemId);

      return item;
   }

   async appendChunk(
      room: PersistedRoom,
      itemId: string,
      range: ContentRange,
      body: unknown
   ): Promise<PersistedRoomItem> {
      return this.writeUploadCheckpoint(room, itemId, range, body);
   }

   async appendCheckpoint(
      room: PersistedRoom,
      itemId: string,
      range: ContentRange,
      options: UploadCheckpointOptions,
      body: unknown
   ): Promise<PersistedRoomItem> {
      return this.writeUploadCheckpoint(room, itemId, range, body, options);
   }

   private async writeUploadCheckpoint(
      room: PersistedRoom,
      itemId: string,
      range: ContentRange,
      body: unknown,
      options?: UploadCheckpointOptions
   ): Promise<PersistedRoomItem> {
      const item = this.requireItem(room.roomId, itemId);
      const existingCommit = options
         ? this.repository.getUploadCommit(item.itemId, options.idempotencyKey)
         : undefined;

      if (existingCommit) {
         if (
            existingCommit.startOffset !== range.start
            || existingCommit.endOffset !== range.start + range.length
            || !safeTextEqual(existingCommit.checksum, options?.checksum ?? "")
         ) {
            throw new RoomError(409, "The idempotency key was already used for different bytes");
         }

         this.recovery.idempotentReplays += 1;
         await this.recoverCommittedCompletion(room, item);
         return item;
      }

      if (
         item.direction !== "device_to_windows"
         || !item.partialPath
         || !item.finalPath
         || item.state === "ready"
         || item.state === "cancelled"
      ) {
         throw new RoomError(409, "This item is not accepting upload checkpoints");
      }

      if (range.total !== item.size || range.length > this.limits.uploadChunkSize) {
         throw new RoomError(400, "The upload checkpoint does not match the registered item");
      }

      if (options) {
         const expectedKey = checkpointIdempotencyKey(
            room.roomId,
            item.itemId,
            range.start,
            range.length,
            options.checksum
         );

         if (!safeTextEqual(expectedKey, options.idempotencyKey)) {
            throw new RoomError(400, "Invalid checkpoint idempotency key");
         }
      }

      if (range.start !== item.confirmedBytes) {
         throw new RoomError(409, "Expected upload offset " + item.confirmedBytes);
      }

      const release = this.acquireWriteLock(room.roomId, item.itemId);
      const start = range.start;
      const faultContext: UploadCheckpointFaultContext = {
         roomId: room.roomId,
         itemId: item.itemId,
         start,
         length: range.length,
         total: range.total
      };

      try {
         await this.injectUploadCheckpointFault("before-write", faultContext);

         if (start > 0) {
            const info = await stat(item.partialPath);

            if (info.size !== start) {
               throw new RoomError(409, "The partial file offset does not match durable state");
            }
         }

         const input = bodyToReadable(body);
         const checkpointHash = createHash("sha256");
         let written = 0;
         const counter = new Transform({
            transform(chunk: Buffer | string, _encoding, callback) {
               const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

               written += buffer.byteLength;
               checkpointHash.update(buffer);
               callback(null, buffer);
            }
         });
         const output = createWriteStream(item.partialPath, {
            flags: start === 0 ? "w" : "a"
         });

         try {
            await pipeline(input, counter, output, {
               signal: this.controller(room.roomId).signal
            });
         } catch (error) {
            await truncate(item.partialPath, start).catch(() => undefined);
            throw error;
         }

         if (written !== range.length) {
            await truncate(item.partialPath, start).catch(() => undefined);
            throw new RoomError(400, "Upload checkpoint length did not match the request");
         }

         const digest = checkpointHash.digest("base64");

         if (options && !safeTextEqual(digest, options.checksum)) {
            await truncate(item.partialPath, start).catch(() => undefined);
            throw new RoomError(460, "Upload checkpoint checksum did not match");
         }

         await this.injectUploadCheckpointFault("after-write-before-fsync", faultContext);

         const handle = await open(item.partialPath, "r+");

         try {
            await handle.sync();
         } finally {
            await handle.close();
         }

         await this.injectUploadCheckpointFault("after-fsync-before-commit", faultContext);

         item.confirmedBytes = start + written;
         item.state = "transferring";
         item.lastChunkDigest = digest;
         item.updatedAt = this.now();
         delete item.error;

         try {
            if (options) {
               const commit: PersistedUploadCommit = {
                  itemId: item.itemId,
                  idempotencyKey: options.idempotencyKey,
                  startOffset: start,
                  endOffset: item.confirmedBytes,
                  checksum: options.checksum,
                  createdAt: item.updatedAt
               };

               this.repository.commitUploadCheckpoint(item, commit);
            } else {
               this.repository.updateItem(item);
            }
         } catch (error) {
            try {
               await truncate(item.partialPath, start);
            } catch (rollbackError) {
               throw new AggregateError(
                  [error, rollbackError],
                  "Upload checkpoint commit and file rollback both failed"
               );
            }

            this.recovery.checkpointRollbacks += 1;
            throw error;
         }

         if (options) {
            this.repository.trimUploadCommits(item.itemId, maxUploadCommitsPerItem);
         }

         await this.injectUploadCheckpointFault("after-commit-before-ack", faultContext);

         this.touch(room);
         this.publish(room, "item-progress", item.itemId);

         if (item.confirmedBytes === item.size) {
            await this.finalizeUpload(room, item);
         }

         return item;
      } finally {
         release();
      }
   }

   item(roomId: string, itemId: string): PersistedRoomItem {
      this.requireActive(roomId);

      return this.requireItem(roomId, itemId);
   }

   readySourceItems(room: PersistedRoom): PersistedRoomItem[] {
      this.requireActive(room.roomId);

      return this.repository.listItems(room.roomId).filter((item) => (
         item.direction === "windows_to_device"
         && item.state === "ready"
         && Boolean(item.sourcePath)
      ));
   }

   reportDownloadProgress(room: PersistedRoom, item: PersistedRoomItem, confirmedBytes: number): void {
      item.confirmedBytes = Math.max(item.confirmedBytes, Math.min(item.size, confirmedBytes));
      this.repository.updateItem(item);
      this.touch(room);
      this.publish(room, confirmedBytes >= item.size ? "item-complete" : "item-progress", item.itemId);
   }

   async cancelItem(room: PersistedRoom, itemId: string): Promise<void> {
      const item = this.requireItem(room.roomId, itemId);

      if (item.partialPath) {
         await rm(item.partialPath, { force: true });
      }

      item.state = "cancelled";
      delete item.error;
      item.completedAt = this.now();
      item.updatedAt = item.completedAt;
      this.repository.updateItem(item);
      this.publish(room, "item-cancelled", item.itemId);
   }

   getCompletedPath(roomId: string, itemId: string): string | undefined {
      const item = this.repository.getItem(roomId, itemId);

      return item?.direction === "device_to_windows" && item.state === "ready"
         ? item.finalPath
         : undefined;
   }

   async deleteRoom(roomId: string, token: string): Promise<void> {
      const room = this.requireByToken(roomId, token);

      room.status = "closed";
      this.repository.updateRoom(room);
      this.publish(room, "room-reset");
      this.controller(roomId).abort();

      for (const item of this.repository.listItems(roomId)) {
         if (item.partialPath) {
            await rm(item.partialPath, { force: true });
         }
      }

      this.repository.deleteRoom(roomId);
      this.abortControllers.delete(roomId);
      this.forgetSharedTextKey(roomId);
   }

   async sweepExpired(): Promise<void> {
      const now = this.now();

      this.repository.deleteUploadCommitsBefore(now - uploadCommitRetentionMs);

      for (const roomId of this.repository.listExpiredRoomIds(now)) {
         const room = this.repository.getRoom(roomId);

         if (!room) {
            continue;
         }

         room.status = "expired";
         this.repository.updateRoom(room);
         this.publish(room, "room-expired");
         this.abortControllers.get(roomId)?.abort();

         for (const item of this.repository.listItems(roomId)) {
            if (item.partialPath) {
               await rm(item.partialPath, { force: true });
            }
         }

         this.repository.deleteRoom(roomId);
         this.abortControllers.delete(roomId);
         this.forgetSharedTextKey(roomId);
      }
   }

   private requireByToken(roomId: string, token: string): PersistedRoom {
      const room = this.requireActive(roomId);

      if (!safeDigestEqual(room.tokenHash, credentialDigest(token))) {
         throw new RoomError(401, "Room was not found or capability is invalid");
      }

      this.rememberSharedTextKey(room.roomId, token);
      this.touch(room);
      this.repository.updateRoom(room);

      return room;
   }

   private requireActive(roomId: string): PersistedRoom {
      const room = this.repository.getRoom(roomId);
      const now = this.now();

      if (!room || room.status !== "active" || room.expiresAt <= now || room.hardExpiresAt <= now) {
         throw new RoomError(404, "Room was not found or has expired");
      }

      return room;
   }

   private requireItem(roomId: string, itemId: string): PersistedRoomItem {
      const item = this.repository.getItem(roomId, itemId);

      if (!item) {
         throw new RoomError(404, "Transfer item was not found");
      }

      return item;
   }

   private touch(room: PersistedRoom): void {
      const now = this.now();

      room.lastActivityAt = now;
      room.expiresAt = Math.min(now + this.ttlMs, room.hardExpiresAt);
   }

   private publish(
      room: PersistedRoom,
      type: RoomEventType,
      itemId?: string,
      message?: string,
      sharedTextRevision?: number
   ): RoomEvent {
      room.eventId += 1;
      this.repository.updateRoom(room);
      const event: RoomEvent = {
         id: room.eventId,
         t: type,
         ...(
            type === "room-reset"
            || type === "room-expired"
            || type === "shared-text-updated"
               ? {}
               : { room: this.view(room) }
         ),
         ...(itemId ? { itemId } : {}),
         ...(sharedTextRevision === undefined ? {} : { sharedTextRevision }),
         ...(message ? { message } : {}),
         createdAt: this.now()
      };

      this.repository.appendEvent(room.roomId, event);
      this.repository.trimEvents(room.roomId, eventHistoryLimit);
      this.events.emit(this.eventName(room.roomId), event);

      return event;
   }

   private readSharedText(room: PersistedRoom): RoomSharedText {
      const encrypted = this.repository.getSharedText(room.roomId);

      if (!encrypted) {
         return {
            content: "",
            revision: 0,
            updatedAt: room.createdAt
         };
      }

      return decryptSharedText(this.requireSharedTextKey(room.roomId), encrypted);
   }

   private rememberSharedTextKey(roomId: string, token: string): void {
      const next = deriveSharedTextKey(roomId, token);
      const current = this.sharedTextKeys.get(roomId);

      if (current && current.byteLength === next.byteLength && timingSafeEqual(current, next)) {
         zeroizeKey(next);
         return;
      }

      if (current) {
         zeroizeKey(current);
      }

      this.sharedTextKeys.set(roomId, next);
   }

   private requireSharedTextKey(roomId: string): Buffer {
      const key = this.sharedTextKeys.get(roomId);

      if (!key) {
         throw new RoomError(503, "Shared text is temporarily unavailable");
      }

      return key;
   }

   private forgetSharedTextKey(roomId: string): void {
      const key = this.sharedTextKeys.get(roomId);

      if (key) {
         zeroizeKey(key);
         this.sharedTextKeys.delete(roomId);
      }
   }

   private eventName(roomId: string): string {
      return `room:${roomId}`;
   }

   private controller(roomId: string): AbortController {
      let controller = this.abortControllers.get(roomId);

      if (!controller || controller.signal.aborted) {
         controller = new AbortController();
         this.abortControllers.set(roomId, controller);
      }

      return controller;
   }

   private acquireWriteLock(roomId: string, itemId: string): () => void {
      const key = `${roomId}:${itemId}`;

      if (this.writeLocks.has(key)) {
         throw new RoomError(409, "Another chunk is already being written");
      }

      if (this.writeLocks.size >= maxActiveWrites) {
         throw new RoomError(503, "Too many uploads are active");
      }

      this.writeLocks.add(key);
      return () => this.writeLocks.delete(key);
   }

   private assertWithinLimits(
      current: PersistedRoomItem[],
      additions: Array<{ size: number }>
   ): void {
      const count = current.filter((item) => item.state !== "cancelled").length + additions.length;

      if (count > this.limits.maxFiles) {
         throw new RoomError(413, `A room can contain at most ${this.limits.maxFiles} files`);
      }

      let total = current
         .filter((item) => item.state !== "cancelled")
         .reduce((sum, item) => sum + item.size, 0);

      for (const addition of additions) {
         if (
            !Number.isSafeInteger(addition.size)
            || addition.size < 0
            || addition.size > this.limits.maxFileSize
         ) {
            throw new RoomError(413, "A file exceeds the configured size limit");
         }

         total += addition.size;

         if (!Number.isSafeInteger(total) || total > this.limits.maxRoomSize) {
            throw new RoomError(413, "The room exceeds the configured total size limit");
         }
      }
   }

   private async assertDiskSpace(directory: string, requiredBytes: number): Promise<void> {
      try {
         const available = await this.availableBytes(directory);

         if (!Number.isFinite(available) || available < requiredBytes + reserveBytes) {
            throw new RoomError(507, "There is not enough free disk space");
         }
      } catch (error) {
         if (error instanceof RoomError) {
            throw error;
         }

         throw new RoomError(507, "Free disk space could not be verified");
      }
   }

   private async finalizeUpload(room: PersistedRoom, item: PersistedRoomItem): Promise<void> {
      if (!item.partialPath || !item.finalPath) {
         throw new RoomError(500, "Upload destination is missing");
      }

      const sha256 = await hashFile(item.partialPath);
      let finalPath = item.finalPath;

      if (await pathExists(finalPath)) {
         finalPath = await availableFilePath(dirname(finalPath), basename(finalPath));
      }

      await rename(item.partialPath, finalPath);
      item.finalPath = finalPath;
      delete item.partialPath;
      item.confirmedBytes = item.size;
      item.sha256 = sha256;
      item.state = "ready";
      item.completedAt = this.now();
      item.updatedAt = item.completedAt;
      this.repository.updateItem(item);
      this.publish(room, "item-complete", item.itemId);
   }

   private async recoverCommittedCompletion(
      room: PersistedRoom,
      item: PersistedRoomItem
   ): Promise<boolean> {
      if (item.confirmedBytes !== item.size || item.state === "ready") {
         return false;
      }

      if (item.finalPath && await pathExists(item.finalPath)) {
         const finalInfo = await stat(item.finalPath);

         if (finalInfo.size === item.size) {
            delete item.partialPath;
            item.confirmedBytes = item.size;
            item.sha256 = await hashFile(item.finalPath);
            item.state = "ready";
            item.completedAt = this.now();
            item.updatedAt = item.completedAt;
            this.repository.updateItem(item);
            this.publish(room, "item-complete", item.itemId);
            this.recovery.recoveredCompletions += 1;
            return true;
         }
      }

      if (item.partialPath && await pathExists(item.partialPath)) {
         const partialInfo = await stat(item.partialPath);

         if (partialInfo.size === item.size) {
            await this.finalizeUpload(room, item);
            this.recovery.recoveredCompletions += 1;
            return true;
         }
      }

      return false;
   }

   private async recoverActiveRooms(): Promise<void> {
      for (const room of this.repository.listActiveRooms(this.now())) {
         this.abortControllers.set(room.roomId, new AbortController());

         for (const item of this.repository.listItems(room.roomId)) {
            if (
               item.direction !== "device_to_windows"
               || item.state === "ready"
               || item.state === "cancelled"
            ) {
               continue;
            }

            if (await this.recoverCommittedCompletion(room, item)) {
               continue;
            }

            if (item.partialPath && await pathExists(item.partialPath)) {
               const partialInfo = await stat(item.partialPath);
               const durableOffset = Math.min(item.confirmedBytes, item.size);

               if (partialInfo.size > durableOffset) {
                  this.recovery.startupTruncations += 1;
                  this.recovery.startupTruncatedBytes += partialInfo.size - durableOffset;
                  await truncate(item.partialPath, durableOffset);
               } else if (partialInfo.size < durableOffset) {
                  this.recovery.startupRewinds += 1;
                  this.recovery.startupRewoundBytes += durableOffset - partialInfo.size;
                  item.confirmedBytes = partialInfo.size;
                  this.repository.deleteUploadCommitsAfter(item.itemId, partialInfo.size);
               }

               item.confirmedBytes = Math.min(item.confirmedBytes, item.size);
               item.state = item.confirmedBytes > 0 ? "transferring" : "pending";
               item.updatedAt = this.now();
               this.repository.updateItem(item);

               if (item.confirmedBytes === item.size) {
                  await this.recoverCommittedCompletion(room, item);
               }
            } else {
               item.confirmedBytes = 0;
               item.state = "pending";
               item.updatedAt = this.now();
               this.repository.deleteUploadCommitsAfter(item.itemId, 0);
               this.repository.updateItem(item);
            }
         }
      }
   }

   private async injectUploadCheckpointFault(
      phase: UploadCheckpointFaultPhase,
      context: UploadCheckpointFaultContext
   ): Promise<void> {
      await this.uploadCheckpointFault?.(phase, context);
   }
}

export class RoomError extends Error {
   readonly statusCode: number;

   constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
   }
}

export class SharedTextConflictError extends RoomError {
   readonly current: RoomSharedText;

   constructor(current: RoomSharedText) {
      super(409, "Shared text changed on another device");
      this.current = current;
   }
}

export function randomId(bytes: number): string {
   return randomBytes(bytes).toString("base64url");
}

export function credentialDigest(value: string): string {
   return createHash("sha256").update(`local-file-transfer-room:${value}`).digest("hex");
}

export function checkpointIdempotencyKey(
   roomId: string,
   itemId: string,
   offset: number,
   length: number,
   checksum: string
): string {
   return createHash("sha256")
      .update([
         "lft-checkpoint-v1",
         roomId,
         itemId,
         String(offset),
         String(length),
         checksum
      ].join("\n"))
      .digest("base64url");
}

export function publicItem(item: PersistedRoomItem): RoomItemView {
   return {
      itemId: item.itemId,
      direction: item.direction,
      name: item.name,
      type: item.type,
      size: item.size,
      lastModified: item.lastModified,
      confirmedBytes: item.confirmedBytes,
      state: item.state,
      createdAt: item.createdAt,
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
      ...(item.error ? { error: item.error } : {}),
      ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
      ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
      ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt })
   };
}

function safeTextEqual(expected: string, actual: string): boolean {
   const expectedBytes = Buffer.from(expected, "utf8");
   const actualBytes = Buffer.from(actual, "utf8");

   return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function safeDigestEqual(expectedHex: string, actualHex: string): boolean {
   const expected = Buffer.from(expectedHex, "hex");
   const actual = Buffer.from(actualHex, "hex");

   return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizedBaseUrl(value: string): string {
   const url = new URL(value);

   if (url.protocol !== "http:" || url.username || url.password) {
      throw new RoomError(400, "Room base URL must be local HTTP");
   }

   return url.origin;
}

function bodyToReadable(body: unknown): Readable {
   if (body instanceof Readable) {
      return body;
   }

   if (Buffer.isBuffer(body)) {
      return Readable.from([body]);
   }

   if (typeof body === "string") {
      return Readable.from([Buffer.from(body)]);
   }

   throw new RoomError(400, "Request body must be application/octet-stream");
}

async function hashFile(path: string): Promise<string> {
   const hash = createHash("sha256");

   for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
   }

   return hash.digest("hex");
}

async function hashSourceFile(path: string, size: number, modifiedMs: number): Promise<string> {
   const before = await stat(path);

   if (!before.isFile() || before.size !== size || Math.trunc(before.mtimeMs) !== modifiedMs) {
      throw new RoomError(409, "The selected source file changed before hashing");
   }

   const digest = await hashFile(path);
   const after = await stat(path);

   if (!after.isFile() || after.size !== size || Math.trunc(after.mtimeMs) !== modifiedMs) {
      throw new RoomError(409, "The selected source file changed while hashing");
   }

   return digest;
}

async function filesystemAvailableBytes(directory: string): Promise<number> {
   const info = await statfs(directory);

   return Number(info.bavail) * Number(info.bsize);
}

async function pathExists(path: string): Promise<boolean> {
   try {
      await access(path);
      return true;
   } catch {
      return false;
   }
}
