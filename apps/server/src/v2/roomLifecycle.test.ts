import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoomError, RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

const appBaseUrl = "http://127.0.0.1:8787";

test("ensureRoom keeps an active room and rotates it at the hard expiry", async (t) => {
   const harness = await createHarness();

   t.after(() => harness.close());

   const original = await harness.rooms.createRoom(appBaseUrl);

   harness.clock.value += 80;
   const firstResume = await harness.rooms.ensureRoom(
      original.room.roomId,
      original.token,
      appBaseUrl
   );

   assert.equal(firstResume.room.roomId, original.room.roomId);
   assert.equal(firstResume.token, original.token);

   harness.clock.value += 80;
   const secondResume = await harness.rooms.ensureRoom(
      original.room.roomId,
      original.token,
      appBaseUrl
   );

   assert.equal(secondResume.room.roomId, original.room.roomId);
   assert.equal(secondResume.room.expiresAt, original.room.hardExpiresAt);

   harness.clock.value = original.room.hardExpiresAt;
   const replacement = await harness.rooms.ensureRoom(
      original.room.roomId,
      original.token,
      appBaseUrl
   );

   assert.notEqual(replacement.room.roomId, original.room.roomId);
   assert.notEqual(replacement.token, original.token);
   assert.throws(
      () => harness.rooms.view(original.room.roomId),
      (error: unknown) => error instanceof RoomError && error.statusCode === 404
   );
});

test("replaceRoom creates a new room after the previous room expired", async (t) => {
   const harness = await createHarness();

   t.after(() => harness.close());

   const original = await harness.rooms.createRoom(appBaseUrl);

   harness.clock.value = original.room.expiresAt;
   const replacement = await harness.rooms.replaceRoom(
      original.room.roomId,
      original.token,
      appBaseUrl
   );

   assert.notEqual(replacement.room.roomId, original.room.roomId);
   assert.notEqual(replacement.token, original.token);
   assert.equal((await harness.rooms.diagnosticState()).rooms, 1);
});

test("ensureRoom does not replace an active room with an invalid token", async (t) => {
   const harness = await createHarness();

   t.after(() => harness.close());

   const original = await harness.rooms.createRoom(appBaseUrl);

   await assert.rejects(
      harness.rooms.ensureRoom(original.room.roomId, "invalid-token", appBaseUrl),
      (error: unknown) => error instanceof RoomError && error.statusCode === 401
   );
   assert.equal((await harness.rooms.diagnosticState()).rooms, 1);
});

async function createHarness() {
   const root = await mkdtemp(join(tmpdir(), "lft-room-lifecycle-"));
   const clock = { value: 10_000 };
   const rooms = new RoomStore({
      repository: new SqliteRoomRepository(join(root, "rooms.sqlite")),
      rootDir: join(root, "state"),
      receiveDir: join(root, "received"),
      ttlMs: 100,
      hardTtlMs: 250,
      limits: {
         maxFiles: 10,
         maxFileSize: 1024 * 1024,
         maxRoomSize: 10 * 1024 * 1024,
         uploadChunkSize: 1024
      },
      availableBytes: async () => Number.MAX_SAFE_INTEGER,
      now: () => clock.value
   });

   await rooms.initialize();

   return {
      clock,
      rooms,
      async close(): Promise<void> {
         rooms.close();
         await rm(root, { recursive: true, force: true });
      }
   };
}
