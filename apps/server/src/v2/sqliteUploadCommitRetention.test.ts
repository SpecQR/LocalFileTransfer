import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PersistedRoom, PersistedRoomItem } from "./types.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("bounds upload idempotency history while retaining the newest replay records", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-commit-retention-"));
   const repository = new SqliteRoomRepository(join(root, "rooms.sqlite"));

   t.after(async () => {
      repository.close();
      await rm(root, { recursive: true, force: true });
   });

   await repository.initialize();
   const room: PersistedRoom = {
      roomId: "room_retention123",
      tokenHash: "a".repeat(64),
      appBaseUrl: "http://127.0.0.1:8787",
      destinationDir: root,
      createdAt: 1,
      lastActivityAt: 1,
      expiresAt: 10_000,
      hardExpiresAt: 20_000,
      status: "active",
      eventId: 0
   };
   const item: PersistedRoomItem = {
      itemId: "item_retention12",
      roomId: room.roomId,
      direction: "device_to_windows",
      name: "photo.jpg",
      type: "image/jpeg",
      size: 10,
      lastModified: 1,
      confirmedBytes: 0,
      state: "transferring",
      createdAt: 1,
      updatedAt: 1
   };

   repository.createRoom(room);
   repository.insertItem(item);

   for (let index = 1; index <= 5; index += 1) {
      item.confirmedBytes = index;
      item.updatedAt = index;
      repository.commitUploadCheckpoint(item, {
         itemId: item.itemId,
         idempotencyKey: "key-" + index,
         startOffset: index - 1,
         endOffset: index,
         checksum: "checksum-" + index,
         createdAt: index
      });
   }

   repository.trimUploadCommits(item.itemId, 2);
   assert.equal(repository.getUploadCommit(item.itemId, "key-3"), undefined);
   assert.ok(repository.getUploadCommit(item.itemId, "key-4"));
   assert.ok(repository.getUploadCommit(item.itemId, "key-5"));

   repository.deleteUploadCommitsBefore(5);
   assert.equal(repository.getUploadCommit(item.itemId, "key-4"), undefined);
   assert.ok(repository.getUploadCommit(item.itemId, "key-5"));
});
