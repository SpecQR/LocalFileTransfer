import assert from "node:assert/strict";
import { readdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sharedTextMaxBytes } from "../../../../packages/protocol/src/index.ts";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { defaultTransferLimits } from "../local/localSessionStore.ts";
import { RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("shared text authorizes, conflicts, journals revisions, and survives restart encrypted", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-shared-text-"));
   const storageDir = join(root, "state");
   const databasePath = join(storageDir, "rooms.sqlite");
   const config = testConfig(root, storageDir);
   const createRooms = () => new RoomStore({
      repository: new SqliteRoomRepository(databasePath),
      rootDir: join(storageDir, "v2"),
      receiveDir: join(root, "received"),
      ttlMs: config.sessionTtlMs,
      hardTtlMs: config.sessionHardTtlMs,
      limits: roomLimits(config)
   });
   let rooms = createRooms();
   let app = await buildApp({ config, rooms });

   t.after(async () => {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom("http://127.0.0.1:8787");
   const roomUrl = "/api/v2/rooms/" + created.room.roomId;
   const unauthorized = await app.inject({
      method: "GET",
      url: roomUrl + "/shared-text"
   });

   assert.equal(unauthorized.statusCode, 401);
   const cookie = await authorize(app, roomUrl, created.token);
   const empty = await app.inject({
      method: "GET",
      url: roomUrl + "/shared-text",
      headers: { cookie }
   });

   assert.equal(empty.statusCode, 200);
   assert.deepEqual(empty.json(), {
      content: "",
      revision: 0,
      updatedAt: created.room.createdAt
   });

   const rejectedOrigin = await app.inject({
      method: "PUT",
      url: roomUrl + "/shared-text",
      headers: {
         cookie,
         origin: "http://example.invalid"
      },
      payload: {
         content: "blocked",
         expectedRevision: 0
      }
   });

   assert.equal(rejectedOrigin.statusCode, 403);
   const marker = "PLAINTEXT-MARKER-71f8 日本語🙂\n<script>globalThis.pwned=true</script>";
   const createdText = await app.inject({
      method: "PUT",
      url: roomUrl + "/shared-text",
      headers: { cookie },
      payload: {
         content: marker,
         expectedRevision: 0
      }
   });

   assert.equal(createdText.statusCode, 200);
   assert.equal(createdText.json().content, marker);
   assert.equal(createdText.json().revision, 1);
   const textEvent = rooms.eventsAfter(created.room.roomId, 0).find(
      (event) => event.t === "shared-text-updated"
   );

   assert.ok(textEvent);
   assert.equal(textEvent.sharedTextRevision, 1);
   assert.equal(textEvent.room, undefined);
   assert.equal(JSON.stringify(textEvent).includes(marker), false);
   assert.equal("content" in textEvent, false);

   const stale = await app.inject({
      method: "PUT",
      url: roomUrl + "/shared-text",
      headers: { cookie },
      payload: {
         content: "stale writer",
         expectedRevision: 0
      }
   });

   assert.equal(stale.statusCode, 409);
   assert.equal(stale.json().current.content, marker);
   assert.equal(stale.json().current.revision, 1);

   const oversized = await app.inject({
      method: "PUT",
      url: roomUrl + "/shared-text",
      headers: { cookie },
      payload: {
         content: "あ".repeat(Math.floor(sharedTextMaxBytes / 3) + 1),
         expectedRevision: 1
      }
   });

   assert.equal(oversized.statusCode, 400);
   assert.equal(JSON.stringify(oversized.json()).includes("あああ"), false);
   const latestMarker = marker + "\nrestart-safe";
   const updated = await app.inject({
      method: "PUT",
      url: roomUrl + "/shared-text",
      headers: { cookie },
      payload: {
         content: latestMarker,
         expectedRevision: 1
      }
   });

   assert.equal(updated.statusCode, 200);
   assert.equal(updated.json().revision, 2);
   await app.close();
   const databaseFiles = (await readdir(storageDir))
      .filter((name) => name.startsWith("rooms.sqlite"));

   assert.ok(databaseFiles.length >= 1);

   for (const name of databaseFiles) {
      const bytes = await readFile(join(storageDir, name));

      assert.equal(bytes.includes(Buffer.from("PLAINTEXT-MARKER-71f8", "utf8")), false);
      assert.equal(bytes.includes(Buffer.from(created.token, "utf8")), false);
   }

   const checked = new DatabaseSync(databasePath, { readOnly: true });
   const stored = checked.prepare(`
      SELECT revision, nonce, ciphertext, auth_tag FROM room_shared_text WHERE room_id = ?
   `).get(created.room.roomId) as {
      revision: number;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      auth_tag: Uint8Array;
   };
   const journal = checked.prepare(`
      SELECT event_json FROM room_events
      WHERE room_id = ? AND event_json LIKE '%shared-text-updated%'
   `).all(created.room.roomId) as Array<{ event_json: string }>;

   assert.equal(stored.revision, 2);
   assert.equal(stored.nonce.byteLength, 12);
   assert.equal(stored.auth_tag.byteLength, 16);
   assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from("PLAINTEXT-MARKER-71f8")), false);
   assert.equal(journal.some((entry) => entry.event_json.includes("PLAINTEXT-MARKER-71f8")), false);
   checked.close();

   rooms = createRooms();
   app = await buildApp({ config, rooms });
   rooms.resumeRoom(created.room.roomId, created.token, "http://127.0.0.1:8787");
   const afterRestart = await app.inject({
      method: "GET",
      url: roomUrl + "/shared-text",
      headers: { cookie }
   });

   assert.equal(afterRestart.statusCode, 200);
   assert.equal(afterRestart.json().content, latestMarker);
   assert.equal(afterRestart.json().revision, 2);

   await rooms.deleteRoom(created.room.roomId, created.token);
   const afterReset = new DatabaseSync(databasePath, { readOnly: true });
   const remaining = afterReset.prepare("SELECT COUNT(*) AS count FROM room_shared_text").get() as {
      count: number;
   };

   assert.equal(remaining.count, 0);
   afterReset.close();
});

test("expired rooms delete shared text ciphertext", async () => {
   const root = await mkdtemp(join(tmpdir(), "lft-shared-expiry-"));
   const databasePath = join(root, "rooms.sqlite");
   const repository = new SqliteRoomRepository(databasePath);
   let now = 1_000;
   const rooms = new RoomStore({
      repository,
      rootDir: join(root, "state"),
      receiveDir: join(root, "received"),
      ttlMs: 10,
      hardTtlMs: 20,
      limits: {
         maxFiles: 10,
         maxFileSize: 1024,
         maxRoomSize: 4096,
         uploadChunkSize: 256
      },
      now: () => now
   });

   try {
      await rooms.initialize();
      const created = await rooms.createRoom("http://127.0.0.1:8787");

      rooms.updateSharedText(created.room, {
         content: "expires with room",
         expectedRevision: 0
      });
      assert.ok(repository.getSharedText(created.room.roomId));
      now = 1_011;
      await rooms.sweepExpired();
      assert.equal(repository.getSharedText(created.room.roomId), undefined);
   } finally {
      rooms.close();
      await rm(root, { recursive: true, force: true });
   }
});

async function authorize(
   app: Awaited<ReturnType<typeof buildApp>>,
   roomUrl: string,
   token: string
): Promise<string> {
   const response = await app.inject({
      method: "POST",
      url: roomUrl + "/authorize",
      payload: { token }
   });
   const header = response.headers["set-cookie"];
   const serialized = Array.isArray(header) ? header[0] : header;

   assert.equal(response.statusCode, 204);
   assert.ok(serialized);
   return serialized.split(";", 1)[0] ?? "";
}

function testConfig(root: string, storageDir: string): ServerConfig {
   return {
      port: 8787,
      storageDir,
      sessionTtlMs: 15 * 60 * 1_000,
      sessionHardTtlMs: 60 * 60 * 1_000,
      limits: defaultTransferLimits,
      staticRoot: join(root, "missing-web")
   };
}

function roomLimits(config: ServerConfig) {
   return {
      maxFiles: config.limits.maxFiles,
      maxFileSize: config.limits.maxFileSize,
      maxRoomSize: config.limits.maxSessionSize,
      uploadChunkSize: config.limits.uploadChunkSize
   };
}
