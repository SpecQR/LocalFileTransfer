import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { checkpointIdempotencyKey, RoomStore } from "./roomStore.ts";
import { SqliteRoomRepository } from "./sqliteRoomRepository.ts";

test("hardens authorization, malformed boundaries, Unicode names, and public source hashes", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-v2-security-"));
   const storageDir = join(root, "state");
   const receiveDir = join(root, "received");
   const config: ServerConfig = {
      port: 8787,
      storageDir,
      sessionTtlMs: 60_000,
      sessionHardTtlMs: 120_000,
      limits: {
         maxFiles: 20,
         maxFileSize: 1024,
         maxSessionSize: 4096,
         uploadChunkSize: 8
      },
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
   const app = await buildApp({ config, rooms });

   t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
   });

   const created = await rooms.createRoom("http://127.0.0.1:8787");
   const roomUrl = "/api/v2/rooms/" + created.room.roomId;
   const unauthorized = await app.inject({ method: "GET", url: roomUrl });

   assert.equal(unauthorized.statusCode, 401);

   const wrongCapability = await app.inject({
      method: "POST",
      url: roomUrl + "/authorize",
      payload: { token: "x".repeat(32) }
   });

   assert.equal(wrongCapability.statusCode, 401);

   const malformedHost = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { host: "user@localhost:80" }
   });

   assert.equal(malformedHost.statusCode, 400);

   const authorized = await app.inject({
      method: "POST",
      url: roomUrl + "/authorize",
      payload: { token: created.token }
   });
   const setCookie = authorized.headers["set-cookie"];
   const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;

   assert.ok(serialized);
   const cookie = serialized.split(";", 1)[0] ?? "";
   const badOrigin = await app.inject({
      method: "POST",
      url: roomUrl + "/uploads",
      headers: {
         cookie,
         host: "localhost:80",
         origin: "http://localhost:80/"
      },
      payload: uploadMetadata("blocked.bin", 1, "B")
   });

   assert.equal(badOrigin.statusCode, 403);

   const oversizedRegistration = await app.inject({
      method: "POST",
      url: roomUrl + "/uploads",
      headers: { cookie },
      payload: uploadMetadata("oversized.bin", 9, "O")
   });
   const oversizedId = oversizedRegistration.json().item.itemId as string;
   const oversized = Buffer.alloc(9, 1);
   const oversizedChecksum = createHash("sha256").update(oversized).digest("base64");
   const oversizedKey = checkpointIdempotencyKey(
      created.room.roomId,
      oversizedId,
      0,
      oversized.length,
      oversizedChecksum
   );
   const rejectedCheckpoint = await app.inject({
      method: "PATCH",
      url: roomUrl + "/uploads/" + oversizedId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "0",
         "upload-checksum": "sha256 " + oversizedChecksum,
         "idempotency-key": oversizedKey
      },
      payload: oversized
   });

   assert.equal(rejectedCheckpoint.statusCode, 413);

   const unicodeName = "写真 ① résumé.jpeg";
   const content = Buffer.from("mobile", "utf8");
   const unicodeRegistration = await app.inject({
      method: "POST",
      url: roomUrl + "/uploads",
      headers: { cookie },
      payload: uploadMetadata(unicodeName, content.length, "U")
   });
   const unicodeId = unicodeRegistration.json().item.itemId as string;
   const checksum = createHash("sha256").update(content).digest("base64");
   const key = checkpointIdempotencyKey(
      created.room.roomId,
      unicodeId,
      0,
      content.length,
      checksum
   );
   const uploaded = await app.inject({
      method: "PATCH",
      url: roomUrl + "/uploads/" + unicodeId,
      headers: {
         cookie,
         "content-type": "application/offset+octet-stream",
         "upload-offset": "0",
         "upload-checksum": "sha256 " + checksum,
         "idempotency-key": key
      },
      payload: content
   });

   assert.equal(uploaded.statusCode, 204);
   const completedPath = rooms.getCompletedPath(created.room.roomId, unicodeId);

   assert.ok(completedPath);
   assert.equal(basename(completedPath), unicodeName.normalize("NFC"));
   assert.deepEqual(await readFile(completedPath), content);

   const sourcePath = join(root, "送信元 résumé.txt");
   const sourceContent = Buffer.from("source", "utf8");

   await writeFile(sourcePath, sourceContent);
   const sourceInfo = await stat(sourcePath);
   const withSource = await rooms.addSourceFiles(created.room.roomId, created.token, [{
      path: sourcePath,
      name: "ignored",
      type: "text/plain",
      size: 0,
      lastModified: 0
   }]);
   const sourceItem = withSource.items.find((item) => item.direction === "windows_to_device");

   assert.ok(sourceItem);
   assert.equal(sourceItem.sha256, createHash("sha256").update(sourceContent).digest("hex"));
   assert.equal(JSON.stringify(sourceItem).includes(sourcePath), false);
   assert.equal(sourceItem.size, sourceInfo.size);

   await writeFile(sourcePath, "changed", "utf8");
   const changedSource = await app.inject({
      method: "GET",
      url: roomUrl + "/files/" + sourceItem.itemId + "/content",
      headers: { cookie }
   });

   assert.equal(changedSource.statusCode, 409);
});

function uploadMetadata(name: string, size: number, suffix: string) {
   return {
      name,
      type: "application/octet-stream",
      size,
      lastModified: 1,
      fingerprint: "S".repeat(42) + suffix
   };
}
