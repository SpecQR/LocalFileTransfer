import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PersistedRoom, PersistedRoomItem } from "./types.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("SQLite room repository migrates, persists, and replays events", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-repository-"));
   const path = join(root, "rooms.sqlite");
   const repository = new SqliteRoomRepository(path);

   t.after(async () => {
      repository.close();
      await rm(root, { recursive: true, force: true });
   });

   await repository.initialize();
   const room: PersistedRoom = {
      roomId: "room_abcdefghijkl",
      tokenHash: "a".repeat(64),
      appBaseUrl: "http://192.168.1.10:8787",
      destinationDir: join(root, "received"),
      createdAt: 10,
      lastActivityAt: 10,
      expiresAt: 1_000,
      hardExpiresAt: 2_000,
      status: "active",
      eventId: 1
   };
   const item: PersistedRoomItem = {
      itemId: "item_abcdefghijkl",
      roomId: room.roomId,
      direction: "device_to_windows",
      name: "photo.jpg",
      type: "image/jpeg",
      size: 100,
      lastModified: 9,
      confirmedBytes: 40,
      state: "transferring",
      partialPath: join(root, "photo.part"),
      finalPath: join(root, "photo.jpg"),
      createdAt: 11,
      updatedAt: 11,
      fingerprint: "f".repeat(43)
   };

   repository.createRoom(room);
   repository.insertItem(item);
   item.confirmedBytes = 60;
   item.lastChunkDigest = "digest";
   item.updatedAt = 13;
   repository.commitUploadCheckpoint(item, {
      itemId: item.itemId,
      idempotencyKey: "i".repeat(43),
      startOffset: 40,
      endOffset: 60,
      checksum: "c".repeat(43) + "=",
      createdAt: 13
   });
   repository.saveTicket(room.roomId, "b".repeat(64), 1_500);
   repository.appendEvent(room.roomId, {
      id: 1,
      t: "item-progress",
      itemId: item.itemId,
      createdAt: 12
   });
   const sharedText = {
      roomId: room.roomId,
      revision: 1,
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.from([2, 3, 4]),
      authTag: Buffer.alloc(16, 5),
      updatedAt: 14
   };

   assert.equal(repository.replaceSharedText(sharedText, 0), true);
   assert.equal(repository.replaceSharedText({ ...sharedText, revision: 2 }, 0), false);

   repository.close();
   const reopened = new SqliteRoomRepository(path);

   await reopened.initialize();
   assert.deepEqual(reopened.getRoom(room.roomId), room);
   assert.deepEqual(reopened.getItem(room.roomId, item.itemId), item);
   assert.deepEqual(reopened.getUploadCommit(item.itemId, "i".repeat(43)), {
      itemId: item.itemId,
      idempotencyKey: "i".repeat(43),
      startOffset: 40,
      endOffset: 60,
      checksum: "c".repeat(43) + "=",
      createdAt: 13
   });
   assert.equal(reopened.hasTicket(room.roomId, "b".repeat(64), 100), true);
   assert.equal(reopened.listEventsAfter(room.roomId, 0, 10)[0]?.t, "item-progress");
   assert.deepEqual(reopened.getSharedText(room.roomId), sharedText);
   reopened.close();
});

test("migrates an existing schema v1 database without losing room items", async () => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-migration-"));
   const path = join(root, "rooms.sqlite");
   const legacy = new DatabaseSync(path);

   legacy.exec([
      "PRAGMA foreign_keys=ON;",
      "CREATE TABLE rooms (room_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, app_base_url TEXT NOT NULL, destination_dir TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, hard_expires_at INTEGER NOT NULL, status TEXT NOT NULL, event_id INTEGER NOT NULL DEFAULT 0) STRICT;",
      "CREATE TABLE room_items (item_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, direction TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, last_modified INTEGER NOT NULL, confirmed_bytes INTEGER NOT NULL, sha256 TEXT, state TEXT NOT NULL, error TEXT, source_path TEXT, source_modified_ms INTEGER, partial_path TEXT, final_path TEXT, created_at INTEGER NOT NULL, completed_at INTEGER) STRICT;",
      "CREATE TABLE room_tickets (ticket_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, expires_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE room_events (room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, event_id INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(room_id, event_id)) STRICT;",
      "PRAGMA user_version=1;"
   ].join("\n"));
   legacy.prepare("INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "room_legacy1234",
      "a".repeat(64),
      "http://127.0.0.1:8787",
      root,
      10,
      10,
      1000,
      2000,
      "active",
      0
   );
   legacy.prepare("INSERT INTO room_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "item_legacy1234",
      "room_legacy1234",
      "device_to_windows",
      "legacy.jpg",
      "image/jpeg",
      100,
      9,
      40,
      null,
      "transferring",
      null,
      null,
      null,
      join(root, "legacy.part"),
      join(root, "legacy.jpg"),
      11,
      null
   );
   legacy.close();

   const repository = new SqliteRoomRepository(path);

   try {
      await repository.initialize();
      const migrated = repository.getItem("room_legacy1234", "item_legacy1234");

      assert.ok(migrated);
      assert.equal(migrated.confirmedBytes, 40);
      assert.equal(migrated.updatedAt, 11);
      assert.equal(migrated.fingerprint, undefined);
      assert.equal(repository.getUploadCommit(migrated.itemId, "missing"), undefined);
      repository.close();

      const checked = new DatabaseSync(path);
      const version = checked.prepare("PRAGMA user_version").get() as { user_version: number };

      assert.equal(version.user_version, 3);
      checked.close();
   } finally {
      repository.close();
      await rm(root, { recursive: true, force: true });
   }
});