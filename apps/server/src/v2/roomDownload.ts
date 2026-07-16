import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseByteRange } from "../../../../packages/protocol/src/index.ts";
import { RoomError, RoomStore } from "./roomStore.ts";
import type { PersistedRoom, PersistedRoomItem } from "./types.ts";

export async function sendRoomItem(
   rooms: RoomStore,
   room: PersistedRoom,
   itemId: string,
   request: FastifyRequest,
   reply: FastifyReply
): Promise<void> {
   const item = rooms.item(room.roomId, itemId);
   const path = item.sourcePath ?? item.finalPath;

   if (item.state !== "ready" || !path) {
      throw new RoomError(404, "File is not available");
   }

   const info = await stat(path);

   if (
      item.sourcePath
      && (info.size !== item.size || Math.abs(info.mtimeMs - (item.sourceModifiedMs ?? item.lastModified)) > 1)
   ) {
      throw new RoomError(409, "The source file changed. Add it to the room again.");
   }

   const etag = itemEtag(item);
   const requestedRange = firstHeader(request.headers.range);
   const useRange = requestedRange && ifRangeMatches(firstHeader(request.headers["if-range"]), etag, info.mtimeMs);
   let start = 0;
   let end = item.size - 1;
   let status = 200;

   if (useRange) {
      try {
         const range = parseByteRange(requestedRange, item.size);

         start = range.start;
         end = range.end;
         status = 206;
         reply.header("content-range", `bytes ${start}-${end}/${item.size}`);
      } catch {
         reply.header("content-range", `bytes */${item.size}`);
         throw new RoomError(416, "Requested range is not satisfiable");
      }
   }

   const length = item.size === 0 ? 0 : end - start + 1;

   reply.code(status);
   reply.header("accept-ranges", "bytes");
   reply.header("cache-control", "no-store");
   reply.header("content-type", item.type || "application/octet-stream");
   reply.header("content-length", String(length));
   reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
   reply.header("etag", etag);
   reply.header("last-modified", new Date(info.mtimeMs).toUTCString());

   if (request.method === "HEAD" || item.size === 0) {
      await reply.send();
      return;
   }

   let sent = 0;
   let lastReportAt = 0;
   const tracker = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
         const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

         sent += buffer.byteLength;
         const now = Date.now();

         if (now - lastReportAt >= 250) {
            rooms.reportDownloadProgress(room, item, start + sent);
            lastReportAt = now;
         }

         callback(null, buffer);
      },
      flush(callback) {
         rooms.reportDownloadProgress(room, item, start + sent);
         callback();
      }
   });
   const source = createReadStream(path, {
      start,
      end
   });

   const releaseDownload = rooms.beginDownload();

   source.on("error", (error) => tracker.destroy(error));

   try {
      await reply.send(source.pipe(tracker));
   } finally {
      releaseDownload();
   }
}

function itemEtag(item: PersistedRoomItem): string {
   const digest = createHash("sha256")
      .update(`${item.itemId}:${item.size}:${item.sourceModifiedMs ?? item.lastModified}:${item.sha256 ?? ""}`)
      .digest("base64url");

   return `"${digest}"`;
}

function ifRangeMatches(value: string | undefined, etag: string, modifiedMs: number): boolean {
   if (!value) {
      return true;
   }

   if (value.startsWith('"')) {
      return value === etag;
   }

   const timestamp = Date.parse(value);

   return Number.isFinite(timestamp) && Math.floor(modifiedMs / 1000) <= Math.floor(timestamp / 1000);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
   return Array.isArray(value) ? value[0] : value;
}
