import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { defaultTransferLimits } from "../local/localSessionStore.ts";
import { RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("Download all releases cancellation and terminates when a source changes mid-stream", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-archive-fault-"));
   const storageDir = join(root, "state");
   const receiveDir = join(root, "received");
   const firstPath = join(root, "large-one.bin");
   const secondPath = join(root, "large-two.bin");

   await Promise.all([
      writeFile(firstPath, randomBytes(24 * 1024 * 1024)),
      writeFile(secondPath, randomBytes(24 * 1024 * 1024))
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
   const streamErrors: unknown[] = [];
   const app = await buildApp({
      config,
      rooms,
      onError: (error) => streamErrors.push(error)
   });
   const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

   t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom(baseUrl);

   await rooms.addSourceFiles(created.room.roomId, created.token, [
      fileInput(firstPath),
      fileInput(secondPath)
   ]);
   const archiveUrl = baseUrl
      + "/api/v2/rooms/"
      + encodeURIComponent(created.room.roomId)
      + "/files/archive";
   const headers = { authorization: "Bearer " + created.token };
   const cancel = new AbortController();
   const cancelledResponse = await fetch(archiveUrl, {
      headers,
      signal: cancel.signal
   });

   assert.equal(cancelledResponse.status, 200);
   const cancelledReader = cancelledResponse.body?.getReader();

   assert.ok(cancelledReader);
   assert.equal((await cancelledReader.read()).done, false);
   cancel.abort();
   await waitFor(async () => (await rooms.diagnosticState()).activeReads === 0);

   const changedResponse = await fetch(archiveUrl, { headers });
   const changedReader = changedResponse.body?.getReader();

   assert.equal(changedResponse.status, 200);
   assert.ok(changedReader);
   assert.equal((await changedReader.read()).done, false);
   const handle = await open(firstPath, "r+");

   try {
      await handle.write(Buffer.from([0xa5]), 0, 1, 0);
   } finally {
      await handle.close();
   }

   const received: Buffer[] = [];
   let terminated = false;

   try {
      while (true) {
         const chunk = await changedReader.read();

         if (chunk.done) {
            break;
         }

         received.push(Buffer.from(chunk.value));
      }
   } catch {
      terminated = true;
   }

   const incomplete = Buffer.concat(received);

   assert.ok(terminated || !incomplete.includes(Buffer.from("PK\u0005\u0006", "binary")));
   await waitFor(async () => (await rooms.diagnosticState()).activeReads === 0);
   assert.ok(streamErrors.some(
      (error) => (error as { code?: unknown }).code === "LFT_ARCHIVE_SOURCE_CHANGED"
   ));
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
   const deadline = Date.now() + timeoutMs;

   while (Date.now() < deadline) {
      if (await predicate()) {
         return;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
   }

   throw new Error("Timed out waiting for archive stream cleanup");
}
