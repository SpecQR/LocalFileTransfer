import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, open, rename, stat, truncate } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ContentRange } from "../../../../packages/protocol/src/index.ts";
import { availableFilePath } from "./fileNames.ts";
import {
   LocalLanSessionStore,
   LocalSessionError
} from "./localSessionStore.ts";
import type {
   InternalLocalFileRecord,
   LocalSession
} from "./types.ts";

export async function appendUploadChunk(
   sessions: LocalLanSessionStore,
   session: LocalSession,
   file: InternalLocalFileRecord,
   range: ContentRange,
   body: unknown
): Promise<InternalLocalFileRecord> {
   if (!file.partialPath || !file.finalPath || file.ready) {
      throw new LocalSessionError(409, "This file is not accepting upload chunks");
   }

   if (range.total !== file.size || range.length > sessions.limits.uploadChunkSize) {
      throw new LocalSessionError(400, "The upload chunk does not match the registered file");
   }

   if (range.start !== file.receivedSize) {
      throw new LocalSessionError(409, `Expected upload offset ${file.receivedSize}`);
   }

   const release = sessions.acquireWriteLock(session, file.fileId);
   const start = range.start;
   const activeHash = file.uploadHash ?? createHash("sha256");
   const rollbackHash = activeHash.copy();

   file.uploadHash = activeHash;

   try {
      if (start > 0) {
         const partialInfo = await stat(file.partialPath);

         if (partialInfo.size !== start) {
            throw new LocalSessionError(409, "The partial file offset does not match the session");
         }
      }

      const input = bodyToReadable(body);
      let written = 0;
      const counter = new Transform({
         transform(chunk: Buffer | string, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

            written += buffer.byteLength;
            activeHash.update(buffer);
            callback(null, buffer);
         }
      });
      const output = createWriteStream(file.partialPath, {
         flags: start === 0 ? "w" : "a"
      });

      try {
         await pipeline(input, counter, output, {
            signal: session.abortController.signal
         });
      } catch (error) {
         await truncate(file.partialPath, start).catch(() => undefined);
         file.uploadHash = rollbackHash;
         sessions.markUploadProgress(session, file, start);
         throw error;
      }

      if (written !== range.length) {
         await truncate(file.partialPath, start).catch(() => undefined);
         file.uploadHash = rollbackHash;
         sessions.markUploadProgress(session, file, start);
         throw new LocalSessionError(400, `Expected ${range.length} chunk bytes but received ${written}`);
      }

      const confirmed = start + written;

      sessions.markUploadProgress(session, file, confirmed);

      if (confirmed === file.size) {
         await finalizeUpload(sessions, session, file);
      }

      return file;
   } finally {
      release();
   }
}

export function bodyToReadable(body: unknown): Readable {
   if (body instanceof Readable) {
      return body;
   }

   if (Buffer.isBuffer(body)) {
      return Readable.from([body]);
   }

   if (typeof body === "string") {
      return Readable.from([Buffer.from(body)]);
   }

   throw new LocalSessionError(400, "Request body must be application/octet-stream");
}

async function finalizeUpload(
   sessions: LocalLanSessionStore,
   session: LocalSession,
   file: InternalLocalFileRecord
): Promise<void> {
   if (!file.partialPath || !file.finalPath) {
      throw new LocalSessionError(500, "Upload destination is missing");
   }

   const handle = await open(file.partialPath, "r+");

   try {
      await handle.sync();
   } finally {
      await handle.close();
   }

   if (!file.uploadHash) {
      throw new LocalSessionError(500, "Upload digest state is missing");
   }

   const sha256 = file.uploadHash.copy().digest("hex");

   if (await pathExists(file.finalPath)) {
      file.finalPath = await availableFilePath(dirname(file.finalPath), basename(file.finalPath));
   }

   await rename(file.partialPath, file.finalPath);
   sessions.markUploadReady(session, file, sha256);
}

async function pathExists(path: string): Promise<boolean> {
   try {
      await access(path);
      return true;
   } catch {
      return false;
   }
}