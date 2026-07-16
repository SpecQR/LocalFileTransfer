import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseByteRange } from "../../../../packages/protocol/src/index.ts";
import {
   LocalLanSessionStore,
   LocalSessionError
} from "./localSessionStore.ts";
import type {
   InternalLocalFileRecord,
   LocalSession
} from "./types.ts";

export async function sendSessionFile(
   sessions: LocalLanSessionStore,
   session: LocalSession,
   fileId: string,
   request: FastifyRequest,
   reply: FastifyReply
): Promise<void> {
   const file = sessions.getFile(session, fileId);
   const path = file && transferPath(file);

   if (!file?.ready || !path) {
      throw new LocalSessionError(404, "File is not available");
   }

   const info = await stat(path);

   if (
      file.sourcePath
      && (info.size !== file.size || Math.abs(info.mtimeMs - (file.sourceModifiedMs ?? file.lastModified)) > 1)
   ) {
      throw new LocalSessionError(409, "The source file changed. Create a new transfer session.");
   }

   const etag = fileEtag(file);
   const lastModified = new Date(info.mtimeMs).toUTCString();
   const requestedRange = firstHeader(request.headers.range);
   const useRange = requestedRange && ifRangeMatches(firstHeader(request.headers["if-range"]), etag, info.mtimeMs);
   let start = 0;
   let end = file.size - 1;
   let statusCode = 200;

   if (useRange) {
      try {
         const parsed = parseByteRange(requestedRange, file.size);

         start = parsed.start;
         end = parsed.end;
         statusCode = 206;
         reply.header("content-range", `bytes ${start}-${end}/${file.size}`);
      } catch {
         reply.header("content-range", `bytes */${file.size}`);
         throw new LocalSessionError(416, "Requested range is not satisfiable");
      }
   }

   const length = file.size === 0 ? 0 : end - start + 1;

   reply.code(statusCode);
   reply.header("accept-ranges", "bytes");
   reply.header("cache-control", "no-store");
   reply.header("content-type", file.type || "application/octet-stream");
   reply.header("content-length", String(length));
   reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
   reply.header("etag", etag);
   reply.header("last-modified", lastModified);

   if (request.method === "HEAD" || file.size === 0) {
      await reply.send();
      return;
   }

   sessions.beginDownload(session, file);
   let sent = 0;
   let lastReportAt = 0;
   const tracker = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
         const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

         sent += buffer.byteLength;
         const now = Date.now();

         if (now - lastReportAt >= 250) {
            sessions.reportDownloadProgress(session, file, start + sent);
            lastReportAt = now;
         }

         callback(null, buffer);
      },
      flush(callback) {
         sessions.reportDownloadProgress(session, file, start + sent);

         if (end === file.size - 1) {
            sessions.markDownloadComplete(session, file);
         }

         callback();
      }
   });
   const source = createReadStream(path, {
      start,
      end,
      signal: session.abortController.signal
   });

   source.on("error", (error) => tracker.destroy(error));
   await reply.send(source.pipe(tracker));
}

function transferPath(file: InternalLocalFileRecord): string | undefined {
   return file.sourcePath ?? file.storedPath ?? file.finalPath;
}

function fileEtag(file: InternalLocalFileRecord): string {
   const digest = createHash("sha256")
      .update(`${file.fileId}:${file.size}:${file.sourceModifiedMs ?? file.lastModified}:${file.sha256 ?? ""}`)
      .digest("base64url");

   return `"${digest}"`;
}

function ifRangeMatches(value: string | undefined, etag: string, modifiedMs: number): boolean {
   if (!value) {
      return true;
   }

   if (value.charCodeAt(0) === 34) {
      return value === etag;
   }

   const timestamp = Date.parse(value);

   return Number.isFinite(timestamp) && Math.floor(modifiedMs / 1000) <= Math.floor(timestamp / 1000);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
   return Array.isArray(value) ? value[0] : value;
}