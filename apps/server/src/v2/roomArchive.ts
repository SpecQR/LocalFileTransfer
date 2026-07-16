import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable, Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZipFile } from "yazl";
import { RoomError, RoomStore } from "./roomStore.ts";
import type { PersistedRoom, PersistedRoomItem } from "./types.ts";

const archiveName = "Local File Transfer.zip";
const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

interface PreparedArchiveEntry {
   entryName: string;
   item: PersistedRoomItem;
   path: string;
}

export interface ArchivePreflight {
   entries: PreparedArchiveEntry[];
   excludedCount: number;
}

export async function sendRoomArchive(
   rooms: RoomStore,
   room: PersistedRoom,
   request: FastifyRequest,
   reply: FastifyReply,
   onStreamError?: (error: unknown) => void
): Promise<void> {
   const preflight = await prepareRoomArchive(rooms, room);

   if (preflight.entries.length < 2) {
      throw new RoomError(409, "At least two unchanged files are required for Download all");
   }

   const releaseDownload = rooms.beginDownload();
   const zip = new ZipFile();
   const output = zip.outputStream as Readable;
   let activeSource: ManagedSource | undefined;
   let outputEnded = false;
   let released = false;

   const release = (): void => {
      if (released) {
         return;
      }

      released = true;
      request.raw.off("aborted", cancel);
      reply.raw.off("close", handleResponseClose);
      releaseDownload();
   };
   const cancel = (): void => {
      activeSource?.destroy();
      activeSource = undefined;
      output.destroy();
      release();
   };
   const handleResponseClose = (): void => {
      if (!outputEnded) {
         cancel();
      } else {
         release();
      }
   };

   zip.once("error", (error) => {
      activeSource?.destroy(error instanceof Error ? error : undefined);
      activeSource = undefined;
      onStreamError?.(error);
      output.destroy(error instanceof Error ? error : new Error("Archive stream failed"));
      release();
   });
   output.once("end", () => {
      outputEnded = true;
      release();
   });
   output.once("close", release);
   request.raw.once("aborted", cancel);
   reply.raw.once("close", handleResponseClose);

   for (const entry of preflight.entries) {
      zip.addReadStreamLazy(entry.entryName, {
         mtime: new Date(entry.item.sourceModifiedMs ?? entry.item.lastModified),
         size: entry.item.size
      }, (callback) => {
         try {
            const managed = verifiedSourceStream(rooms, room, entry);

            activeSource = managed;
            managed.stream.once("close", () => {
               if (activeSource === managed) {
                  activeSource = undefined;
               }
            });
            managed.stream.once("error", (error) => zip.emit("error", error));
            callback(null, managed.stream);
         } catch (error) {
            callback(error, undefined as unknown as NodeJS.ReadableStream);
         }
      });
   }

   reply.header("cache-control", "no-store");
   reply.header("content-type", "application/zip");
   reply.header(
      "content-disposition",
      `attachment; filename="${archiveName}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`
   );
   reply.header("x-archive-file-count", String(preflight.entries.length));
   reply.header("x-archive-excluded-count", String(preflight.excludedCount));

   zip.end();
   await reply.send(output);
}

export async function prepareRoomArchive(
   rooms: RoomStore,
   room: PersistedRoom
): Promise<ArchivePreflight> {
   const valid: Array<{ item: PersistedRoomItem; path: string }> = [];
   let excludedCount = 0;

   for (const item of rooms.readySourceItems(room)) {
      const path = item.sourcePath;

      if (!path || !item.sha256) {
         excludedCount += 1;
         continue;
      }

      try {
         const info = await stat(path);
         const expectedModified = item.sourceModifiedMs ?? item.lastModified;

         if (
            !info.isFile()
            || info.size !== item.size
            || Math.abs(info.mtimeMs - expectedModified) > 1
         ) {
            excludedCount += 1;
            continue;
         }

         valid.push({ item, path });
      } catch {
         excludedCount += 1;
      }
   }

   const names = uniqueArchiveEntryNames(valid.map(({ item }) => item.name));

   return {
      entries: valid.map(({ item, path }, index) => ({
         entryName: names[index] ?? `file-${index + 1}`,
         item,
         path
      })),
      excludedCount
   };
}

export function uniqueArchiveEntryNames(names: readonly string[]): string[] {
   const used = new Set<string>();

   return names.map((name) => {
      const safe = safeArchiveEntryName(name);
      const extension = extname(safe);
      const stem = extension ? safe.slice(0, -extension.length) : safe;
      let candidate = safe;
      let sequence = 2;

      while (used.has(candidate.toLocaleLowerCase("en-US"))) {
         const suffix = ` (${sequence})`;
         const maximumStemLength = Math.max(1, 240 - extension.length - suffix.length);

         candidate = stem.slice(0, maximumStemLength) + suffix + extension;
         sequence += 1;
      }

      used.add(candidate.toLocaleLowerCase("en-US"));
      return candidate;
   });
}

export function safeArchiveEntryName(value: string): string {
   let name = value
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "_")
      .replace(/[\\/:*?"<>|]/gu, "_")
      .replace(/[. ]+$/gu, "")
      .trim();

   if (!name || name === "." || name === "..") {
      name = "file";
   }

   if (windowsReservedName.test(name)) {
      name = "_" + name;
   }

   return name.slice(0, 240);
}

interface ManagedSource {
   stream: Readable;
   destroy(error?: Error): void;
}

function verifiedSourceStream(
   rooms: RoomStore,
   room: PersistedRoom,
   entry: PreparedArchiveEntry
): ManagedSource {
   const source = createReadStream(entry.path);
   const hash = createHash("sha256");
   let bytes = 0;
   let lastReportAt = 0;
   const verifier = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
         const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

         bytes += buffer.byteLength;
         hash.update(buffer);
         const now = Date.now();

         if (now - lastReportAt >= 250) {
            rooms.reportDownloadProgress(room, entry.item, bytes);
            lastReportAt = now;
         }

         callback(null, buffer);
      },
      flush(callback) {
         void verifyCompletedSource(entry, bytes, hash.digest("hex"))
            .then(() => {
               rooms.reportDownloadProgress(room, entry.item, bytes);
               callback();
            })
            .catch((error: unknown) => callback(error as Error));
      }
   });

   source.once("error", (error) => verifier.destroy(error));
   verifier.once("close", () => source.destroy());

   return {
      stream: source.pipe(verifier),
      destroy(error?: Error): void {
         source.destroy(error);
         verifier.destroy(error);
      }
   };
}

async function verifyCompletedSource(
   entry: PreparedArchiveEntry,
   bytes: number,
   digest: string
): Promise<void> {
   const info = await stat(entry.path);
   const expectedModified = entry.item.sourceModifiedMs ?? entry.item.lastModified;

   if (
      !info.isFile()
      || bytes !== entry.item.size
      || info.size !== entry.item.size
      || Math.abs(info.mtimeMs - expectedModified) > 1
      || digest !== entry.item.sha256
   ) {
      const error = new Error("A source changed while Download all was streaming");

      Object.assign(error, { code: "LFT_ARCHIVE_SOURCE_CHANGED" });
      throw error;
   }
}
