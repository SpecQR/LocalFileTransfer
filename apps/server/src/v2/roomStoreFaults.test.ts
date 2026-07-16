import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { checkpointIdempotencyKey, RoomError, RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("rejects registration when the injected filesystem reports insufficient space", async (t) => {
   const harness = await createHarness(async () => 1);

   t.after(() => harness.close());

   await assert.rejects(
      harness.rooms.registerUpload(harness.room, uploadMetadata("low-space.bin", 1, "L")),
      (error: unknown) => error instanceof RoomError && error.statusCode === 507
   );
   assert.equal((await harness.rooms.diagnosticState()).diskSpace, "low");
});

test("bounds concurrent upload writers and download readers without leaking locks", async (t) => {
   const harness = await createHarness(async () => Number.MAX_SAFE_INTEGER);

   t.after(() => harness.close());

   const items = await Promise.all(Array.from({ length: 5 }, (_, index) => (
      harness.rooms.registerUpload(
         harness.room,
         uploadMetadata("concurrent-" + index + ".bin", 1, String(index))
      )
   )));
   const streams = Array.from({ length: 5 }, () => new PassThrough());
   const active = items.slice(0, 4).map((item, index) => harness.rooms.appendChunk(
      harness.room,
      item.itemId,
      { start: 0, end: 0, total: 1, length: 1 },
      streams[index] as PassThrough
   ));

   await new Promise((resolve) => setTimeout(resolve, 30));
   const fifthItem = items[4];
   const fifthStream = streams[4];

   assert.ok(fifthItem);
   assert.ok(fifthStream);
   await assert.rejects(
      harness.rooms.appendChunk(
         harness.room,
         fifthItem.itemId,
         { start: 0, end: 0, total: 1, length: 1 },
         fifthStream
      ),
      (error: unknown) => error instanceof RoomError && error.statusCode === 503
   );

   for (const stream of streams.slice(0, 4)) {
      stream.end(Buffer.from([1]));
   }

   await Promise.all(active);
   assert.equal((await harness.rooms.diagnosticState()).activeWrites, 0);

   const releases = Array.from({ length: 8 }, () => harness.rooms.beginDownload());

   assert.throws(
      () => harness.rooms.beginDownload(),
      (error: unknown) => error instanceof RoomError && error.statusCode === 503
   );

   for (const release of releases) {
      release();
   }

   assert.equal((await harness.rooms.diagnosticState()).activeReads, 0);
});

test("rejects reuse of an idempotency key for a different checkpoint", async (t) => {
   const harness = await createHarness(async () => Number.MAX_SAFE_INTEGER);

   t.after(() => harness.close());

   const item = await harness.rooms.registerUpload(
      harness.room,
      uploadMetadata("replay.bin", 2, "R")
   );
   const checksum = createHash("sha256").update("x").digest("base64");
   const key = checkpointIdempotencyKey(harness.room.roomId, item.itemId, 0, 1, checksum);

   await harness.rooms.appendCheckpoint(
      harness.room,
      item.itemId,
      { start: 0, end: 0, total: 2, length: 1 },
      { checksum, idempotencyKey: key },
      Buffer.from("x")
   );

   await assert.rejects(
      harness.rooms.appendCheckpoint(
         harness.room,
         item.itemId,
         { start: 1, end: 1, total: 2, length: 1 },
         { checksum, idempotencyKey: key },
         Buffer.from("x")
      ),
      (error: unknown) => error instanceof RoomError && error.statusCode === 409
   );
});

function uploadMetadata(name: string, size: number, suffix: string) {
   return {
      name,
      type: "application/octet-stream",
      size,
      lastModified: 1,
      fingerprint: "F".repeat(42) + suffix
   };
}

async function createHarness(availableBytes: (directory: string) => Promise<number>) {
   const root = await mkdtemp(join(tmpdir(), "lft-room-faults-"));
   const rooms = new RoomStore({
      repository: new SqliteRoomRepository(join(root, "rooms.sqlite")),
      rootDir: join(root, "state"),
      receiveDir: join(root, "received"),
      ttlMs: 60_000,
      hardTtlMs: 120_000,
      limits: {
         maxFiles: 100,
         maxFileSize: 1024 * 1024,
         maxRoomSize: 10 * 1024 * 1024,
         uploadChunkSize: 1024
      },
      availableBytes
   });

   await rooms.initialize();
   const created = await rooms.createRoom("http://127.0.0.1:8787");

   return {
      rooms,
      room: created.room,
      async close(): Promise<void> {
         rooms.close();
         await rm(root, { recursive: true, force: true });
      }
   };
}
