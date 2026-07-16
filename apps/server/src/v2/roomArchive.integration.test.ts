import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fromBufferPromise } from "yauzl";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { defaultTransferLimits } from "../local/localSessionStore.ts";
import {
   safeArchiveEntryName,
   uniqueArchiveEntryNames
} from "./roomArchive.ts";
import { RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("archive entry names are traversal-safe, Unicode-preserving, and unique on Windows", () => {
   assert.equal(safeArchiveEntryName("../危険\\CON.txt"), ".._危険_CON.txt");
   assert.equal(safeArchiveEntryName("NUL.txt"), "_NUL.txt");
   assert.equal(safeArchiveEntryName("..."), "file");
   assert.deepEqual(
      uniqueArchiveEntryNames(["写真.jpeg", "写真.jpeg", "PHOTO.JPG", "photo.jpg"]),
      ["写真.jpeg", "写真 (2).jpeg", "PHOTO.JPG", "photo (2).jpg"]
   );
});

test("authorized Download all streams only unchanged sources with safe unique names", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-archive-"));
   const storageDir = join(root, "state");
   const receiveDir = join(root, "received");
   const firstDir = join(root, "first");
   const secondDir = join(root, "second");
   const changedDir = join(root, "changed");

   await Promise.all([
      mkdir(firstDir, { recursive: true }),
      mkdir(secondDir, { recursive: true }),
      mkdir(changedDir, { recursive: true })
   ]);
   const firstPath = join(firstDir, "duplicate.txt");
   const secondPath = join(secondDir, "duplicate.txt");
   const changedPath = join(changedDir, "変更済み.txt");
   const firstBytes = Buffer.from("first archive entry\n", "utf8");
   const secondBytes = Buffer.from("second archive entry\n", "utf8");

   await Promise.all([
      writeFile(firstPath, firstBytes),
      writeFile(secondPath, secondBytes),
      writeFile(changedPath, Buffer.from("original\n", "utf8"))
   ]);

   const config: ServerConfig = {
      port: 8787,
      storageDir,
      sessionTtlMs: 60_000,
      sessionHardTtlMs: 120_000,
      limits: defaultTransferLimits,
      staticRoot: join(root, "missing-web")
   };
   const rooms = new RoomStore({
      repository: new SqliteRoomRepository(join(storageDir, "rooms.sqlite")),
      rootDir: join(storageDir, "v2"),
      receiveDir,
      ttlMs: config.sessionTtlMs,
      hardTtlMs: config.sessionHardTtlMs,
      limits: {
         maxFiles: config.limits.maxFiles,
         maxFileSize: config.limits.maxFileSize,
         maxRoomSize: config.limits.maxSessionSize,
         uploadChunkSize: config.limits.uploadChunkSize
      }
   });
   const diagnosticSnapshot = {
      version: "archive-test",
      protocol: "lft-resume-v1" as const,
      uptimeSeconds: 1,
      port: 8787,
      serviceRestarts: 0,
      rooms: 1,
      items: 3,
      transferringItems: 0,
      activeWrites: 0,
      activeReads: 0,
      diskSpace: "ok" as const,
      sourceHash: { workers: 0, queued: 0, cacheEntries: 3, jobsStarted: 3 },
      structuredLog: "ready" as const,
      recentErrorCodes: [],
      lanCandidates: [],
      generatedAt: 1
   };
   const app = await buildApp({
      config,
      rooms,
      getDiagnostics: async () => diagnosticSnapshot
   });

   t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom("http://127.0.0.1:8787");

   await rooms.addSourceFiles(created.room.roomId, created.token, [
      fileInput(firstPath),
      fileInput(secondPath),
      fileInput(changedPath)
   ]);
   await writeFile(changedPath, Buffer.from("changed after registration\n", "utf8"));

   const archiveUrl = "/api/v2/rooms/" + created.room.roomId + "/files/archive";
   const unauthorized = await app.inject({ method: "GET", url: archiveUrl });

   assert.equal(unauthorized.statusCode, 401);
   const auth = await app.inject({
      method: "POST",
      url: "/api/v2/rooms/" + created.room.roomId + "/authorize",
      payload: { token: created.token }
   });
   const setCookie = auth.headers["set-cookie"];
   const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;

   assert.ok(serialized);
   const cookie = serialized.split(";", 1)[0] ?? "";
   const diagnostics = await app.inject({
      method: "GET",
      url: "/api/v2/rooms/" + created.room.roomId + "/diagnostics",
      headers: { cookie }
   });

   assert.equal(diagnostics.statusCode, 200);
   assert.deepEqual(diagnostics.json(), diagnosticSnapshot);

   const archive = await app.inject({
      method: "GET",
      url: archiveUrl,
      headers: { cookie }
   });

   assert.equal(archive.statusCode, 200);
   assert.equal(archive.headers["content-type"], "application/zip");
   assert.equal(archive.headers["x-archive-file-count"], "2");
   assert.equal(archive.headers["x-archive-excluded-count"], "1");
   assert.ok(archive.rawPayload.byteLength > 0);
   assert.match(archive.headers["content-disposition"] ?? "", /Local File Transfer\.zip/u);

   const entries = await readArchiveEntries(archive.rawPayload);

   assert.deepEqual([...entries.keys()], ["duplicate.txt", "duplicate (2).txt"]);
   assert.deepEqual(entries.get("duplicate.txt"), firstBytes);
   assert.deepEqual(entries.get("duplicate (2).txt"), secondBytes);
   assert.equal((await rooms.diagnosticState()).activeReads, 0);
});

function fileInput(path: string) {
   return {
      path,
      name: "ignored",
      type: "application/octet-stream",
      size: 0,
      lastModified: 0
   };
}

async function readArchiveEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
   const zip = await fromBufferPromise(buffer, { lazyEntries: true });
   const entries = new Map<string, Buffer>();

   try {
      for await (const entry of zip.eachEntry()) {
         const source = await zip.openReadStreamPromise(entry);
         const chunks: Buffer[] = [];

         for await (const chunk of source) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
         }

         entries.set(entry.fileName, Buffer.concat(chunks));
      }
   } finally {
      zip.close();
   }

   return entries;
}
