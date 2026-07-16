import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { defaultTransferLimits } from "../local/localSessionStore.ts";
import { checkpointIdempotencyKey, RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("v2 room transfers both directions and resumes after service restart", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-integration-"));
   const storageDir = join(root, "state");
   const receiveDir = join(root, "received");
   const databasePath = join(storageDir, "rooms.sqlite");
   const config: ServerConfig = {
      port: 8787,
      storageDir,
      sessionTtlMs: 15 * 60 * 1000,
      sessionHardTtlMs: 60 * 60 * 1000,
      limits: defaultTransferLimits,
      staticRoot: join(root, "missing-web")
   };
   const createRooms = () => new RoomStore({
      repository: new SqliteRoomRepository(databasePath),
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
   let rooms = createRooms();
   let app = await buildApp({ config, rooms });

   t.after(async () => {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom("http://127.0.0.1:8787");
   const auth = await app.inject({
      method: "POST",
      url: `/api/v2/rooms/${created.room.roomId}/authorize`,
      payload: { token: created.token }
   });

   assert.equal(auth.statusCode, 204);
   const setCookie = auth.headers["set-cookie"];
   const serializedCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

   assert.ok(serializedCookie);
   const cookie = serializedCookie.split(";", 1)[0] ?? "";
   const sourcePath = join(root, "source.bin");
   const source = Buffer.from("0123456789", "utf8");

   await writeFile(sourcePath, source);
   const sourceInfo = await stat(sourcePath);
   const roomAfterSource = await rooms.addSourceFiles(created.room.roomId, created.token, [{
      path: sourcePath,
      name: "ignored.bin",
      type: "application/octet-stream",
      size: 1,
      lastModified: 1
   }]);
   const outbound = roomAfterSource.items.find((item) => item.direction === "windows_to_device");

   assert.ok(outbound);
   const range = await app.inject({
      method: "GET",
      url: `/api/v2/rooms/${created.room.roomId}/files/${outbound.itemId}/content`,
      headers: {
         cookie,
         range: "bytes=3-6"
      }
   });

   assert.equal(range.statusCode, 206);
   assert.equal(range.body, "3456");
   assert.equal(range.headers["content-range"], "bytes 3-6/10");
   assert.equal(outbound.size, sourceInfo.size);

   const registered = await app.inject({
      method: "POST",
      url: `/api/v2/rooms/${created.room.roomId}/uploads`,
      headers: { cookie },
      payload: {
         name: "phone.jpg",
         type: "image/jpeg",
         size: 11,
         lastModified: 123,
         fingerprint: "f".repeat(43)
      }
   });

   assert.equal(registered.statusCode, 201);
   const itemId = registered.json().item.itemId as string;
   const first = Buffer.from("hello ", "utf8");
   const firstChecksum = createHash("sha256").update(first).digest("base64");
   const firstKey = checkpointIdempotencyKey(
      created.room.roomId,
      itemId,
      0,
      first.length,
      firstChecksum
   );
   const firstChunk = await app.inject({
      method: "PATCH",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads/" + itemId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "0",
         "upload-checksum": "sha256 " + firstChecksum,
         "idempotency-key": firstKey
      },
      payload: first
   });

   assert.equal(firstChunk.statusCode, 204);
   assert.equal(firstChunk.headers["upload-offset"], "6");
   const repeatedFirst = await app.inject({
      method: "PATCH",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads/" + itemId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "0",
         "upload-checksum": "sha256 " + firstChecksum,
         "idempotency-key": firstKey
      },
      payload: first
   });

   assert.equal(repeatedFirst.statusCode, 204);
   assert.equal(repeatedFirst.headers["upload-offset"], "6");
   const partialPath = rooms.item(created.room.roomId, itemId).partialPath;

   assert.ok(partialPath);
   await app.close();
   await appendFile(partialPath, Buffer.from("uncommitted", "utf8"));

   rooms = createRooms();
   app = await buildApp({ config, rooms });
   const uploadHead = await app.inject({
      method: "HEAD",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads/" + itemId,
      headers: { cookie }
   });

   assert.equal(uploadHead.statusCode, 204);
   assert.equal(uploadHead.headers["upload-offset"], "6");
   assert.equal(uploadHead.headers["upload-length"], "11");
   assert.equal(uploadHead.headers["upload-fingerprint"], "f".repeat(43));
   const resumedView = await app.inject({
      method: "GET",
      url: `/api/v2/rooms/${created.room.roomId}`,
      headers: { cookie }
   });

   assert.equal(resumedView.statusCode, 200);
   assert.equal(resumedView.json().items.find((item: { itemId: string }) => item.itemId === itemId).confirmedBytes, 6);
   assert.equal((await stat(partialPath)).size, 6);
   assert.ok(rooms.eventsAfter(created.room.roomId, 0).length >= 3);

   const second = Buffer.from("world", "utf8");
   const secondChecksum = createHash("sha256").update(second).digest("base64");
   const secondKey = checkpointIdempotencyKey(
      created.room.roomId,
      itemId,
      6,
      second.length,
      secondChecksum
   );
   const secondChunk = await app.inject({
      method: "PATCH",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads/" + itemId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "6",
         "upload-checksum": "sha256 " + secondChecksum,
         "idempotency-key": secondKey
      },
      payload: second
   });

   assert.equal(secondChunk.statusCode, 204);
   assert.equal(secondChunk.headers["upload-offset"], "11");
   const finalView = await app.inject({
      method: "GET",
      url: "/api/v2/rooms/" + created.room.roomId,
      headers: { cookie }
   });
   const finalItem = finalView.json().items.find(
      (item: { itemId: string }) => item.itemId === itemId
   ) as { state: string; sha256: string };

   assert.equal(finalItem.state, "ready");
   const completedPath = rooms.getCompletedPath(created.room.roomId, itemId);

   assert.ok(completedPath);
   const completed = await readFile(completedPath);

   assert.equal(completed.toString("utf8"), "hello world");
   assert.equal(
      finalItem.sha256,
      createHash("sha256").update(completed).digest("hex")
   );
   const diagnostics = await rooms.diagnosticState();

   assert.equal(diagnostics.rooms, 1);
   assert.equal(diagnostics.items, 2);
   assert.equal(diagnostics.activeWrites, 0);
   assert.equal(diagnostics.activeReads, 0);
   assert.equal(JSON.stringify(diagnostics).includes(created.token), false);
   assert.equal(JSON.stringify(diagnostics).includes(sourcePath), false);

   const releaseDownload = rooms.beginDownload();

   assert.equal((await rooms.diagnosticState()).activeReads, 1);
   releaseDownload();
   releaseDownload();
   assert.equal((await rooms.diagnosticState()).activeReads, 0);
});

test("rejects a bad checkpoint digest without advancing durable state", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-checksum-"));
   const storageDir = join(root, "state");
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
      receiveDir: join(root, "received"),
      ttlMs: config.sessionTtlMs,
      hardTtlMs: config.sessionHardTtlMs,
      limits: {
         maxFiles: config.limits.maxFiles,
         maxFileSize: config.limits.maxFileSize,
         maxRoomSize: config.limits.maxSessionSize,
         uploadChunkSize: config.limits.uploadChunkSize
      }
   });
   const app = await buildApp({ config, rooms });

   t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom("http://127.0.0.1:8787");
   const auth = await app.inject({
      method: "POST",
      url: "/api/v2/rooms/" + created.room.roomId + "/authorize",
      payload: { token: created.token }
   });
   const setCookie = auth.headers["set-cookie"];
   const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;

   assert.ok(serialized);
   const cookie = serialized.split(";", 1)[0] ?? "";
   const registered = await app.inject({
      method: "POST",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads",
      headers: { cookie },
      payload: {
         name: "digest.bin",
         type: "application/octet-stream",
         size: 4,
         lastModified: 1,
         fingerprint: "d".repeat(43)
      }
   });
   const itemId = registered.json().item.itemId as string;
   const expected = Buffer.from("good");
   const actual = Buffer.from("evil");
   const checksum = createHash("sha256").update(expected).digest("base64");
   const key = checkpointIdempotencyKey(created.room.roomId, itemId, 0, 4, checksum);
   const rejected = await app.inject({
      method: "PATCH",
      url: "/api/v2/rooms/" + created.room.roomId + "/uploads/" + itemId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "0",
         "upload-checksum": "sha256 " + checksum,
         "idempotency-key": key
      },
      payload: actual
   });

   assert.equal(rejected.statusCode, 460);
   const item = rooms.item(created.room.roomId, itemId);

   assert.equal(item.confirmedBytes, 0);
   assert.ok(item.partialPath);
   assert.equal((await stat(item.partialPath)).size, 0);
});
