import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import {
   defaultTransferLimits,
   LocalLanSessionStore
} from "./localSessionStore.ts";

async function fixture(t: TestContext) {
   const base = await mkdtemp(join(tmpdir(), "lft-integration-"));
   const storageDir = join(base, "sessions");
   const receiveDir = join(base, "received");
   const config: ServerConfig = {
      port: 8787,
      storageDir,
      sessionTtlMs: 15 * 60 * 1000,
      sessionHardTtlMs: 60 * 60 * 1000,
      limits: defaultTransferLimits,
      staticRoot: join(base, "missing-web")
   };
   const sessions = new LocalLanSessionStore({
      rootDir: storageDir,
      receiveDir,
      ttlMs: config.sessionTtlMs,
      hardTtlMs: config.sessionHardTtlMs,
      limits: config.limits
   });
   const app = await buildApp({
      config,
      sessions,
      enableLegacyRoutes: true
   });

   t.after(async () => {
      try {
         await app.close();
      } finally {
         await rm(base, { recursive: true, force: true });
      }
   });

   return { app, base, receiveDir, sessions };
}

async function authorize(app: Awaited<ReturnType<typeof buildApp>>, sid: string, token: string): Promise<string> {
   const response = await app.inject({
      method: "POST",
      url: `/api/local/sessions/${sid}/authorize`,
      headers: {
         authorization: `Bearer ${token}`
      }
   });

   assert.equal(response.statusCode, 204);
   const header = response.headers["set-cookie"];
   const serialized = Array.isArray(header) ? header[0] : header;

   assert.ok(serialized);
   assert.match(serialized, /HttpOnly/u);
   assert.match(serialized, /SameSite=Strict/u);
   return serialized.split(";", 1)[0] ?? "";
}

test("zero-copy source supports HEAD, range resume, and source-change protection", async (t) => {
   const { app, base, sessions } = await fixture(t);

   const sourcePath = join(base, "source.bin");
   const source = Buffer.from("0123456789", "utf8");

   await writeFile(sourcePath, source);
   const sourceInfo = await stat(sourcePath);
   const created = await sessions.create({
      kind: "send",
      appBaseUrl: "http://127.0.0.1:8787",
      files: [{
         name: "source.bin",
         type: "application/octet-stream",
         size: sourceInfo.size,
         lastModified: sourceInfo.mtimeMs,
         sourcePath,
         sourceModifiedMs: sourceInfo.mtimeMs
      }]
   });
   const file = created.session.files[0];

   assert.ok(file);
   const queryTokenAttempt = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}?token=${created.token}`
   });

   assert.equal(queryTokenAttempt.statusCode, 401);
   const cookie = await authorize(app, created.session.sid, created.token);
   const head = await app.inject({
      method: "HEAD",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: { cookie }
   });

   assert.equal(head.statusCode, 200);
   assert.equal(head.headers["content-length"], "10");
   assert.equal(head.headers["accept-ranges"], "bytes");
   assert.equal(head.rawPayload.length, 0);

   const ranged = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: {
         cookie,
         range: "bytes=2-5"
      }
   });

   assert.equal(ranged.statusCode, 206);
   assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
   assert.equal(ranged.rawPayload.toString(), "2345");

   const invalid = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: {
         cookie,
         range: "bytes=99-"
      }
   });

   assert.equal(invalid.statusCode, 416);
   assert.equal(invalid.headers["content-range"], "bytes */10");

   const ifRangeMiss = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: {
         cookie,
         range: "bytes=5-",
         "if-range": "\"different\""
      }
   });

   assert.equal(ifRangeMiss.statusCode, 200);
   assert.deepEqual(ifRangeMiss.rawPayload, source);

   await writeFile(sourcePath, Buffer.from("abcdefghij"));
   await utimes(sourcePath, new Date(), new Date(sourceInfo.mtimeMs + 5_000));
   const changed = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: { cookie }
   });

   assert.equal(changed.statusCode, 409);
});

test("chunk upload resumes, rejects duplicate offsets, hashes, and atomically completes", async (t) => {
   const { app, receiveDir, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const register = await app.inject({
      method: "POST",
      url: `/api/local/upload-sessions/${created.session.sid}/files`,
      headers: { cookie },
      payload: {
         name: "bad?.txt",
         type: "text/plain",
         size: 10,
         lastModified: 1234
      }
   });

   assert.equal(register.statusCode, 201);
   const fileId = register.json().file.fileId as string;
   const first = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 0-3/10"
      },
      payload: Buffer.from("0123")
   });

   assert.equal(first.statusCode, 200);
   assert.equal(first.json().file.receivedSize, 4);

   const duplicate = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 0-3/10"
      },
      payload: Buffer.from("0123")
   });

   assert.equal(duplicate.statusCode, 409);
   assert.match(duplicate.json().error, /offset 4/u);

   const resumed = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 4-9/10"
      },
      payload: Buffer.from("456789")
   });

   assert.equal(resumed.statusCode, 200);
   assert.equal(resumed.json().file.ready, true);
   assert.equal(resumed.json().file.sha256, createHash("sha256").update("0123456789").digest("hex"));

   const completedPath = sessions.getCompletedPath(created.session.sid, fileId);

   assert.ok(completedPath);
   assert.equal(completedPath, join(receiveDir, "bad_.txt"));
   assert.equal((await readFile(completedPath)).toString(), "0123456789");
   await assert.rejects(access(`${completedPath}.partial`));

   const deleted = await app.inject({
      method: "DELETE",
      url: `/api/local/sessions/${created.session.sid}`,
      headers: { authorization: `Bearer ${created.token}` }
   });

   assert.equal(deleted.statusCode, 204);
   assert.equal((await readFile(completedPath)).toString(), "0123456789");
});

test("cancelling a session removes partial uploads and invalidates access", async (t) => {
   const { app, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const register = await app.inject({
      method: "POST",
      url: `/api/local/upload-sessions/${created.session.sid}/files`,
      headers: { cookie },
      payload: {
         name: "partial.bin",
         type: "application/octet-stream",
         size: 5,
         lastModified: 1
      }
   });
   const fileId = register.json().file.fileId as string;
   const internalFile = sessions.getFile(created.session, fileId);

   assert.ok(internalFile?.partialPath);
   const chunk = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 0-1/5"
      },
      payload: Buffer.from("ab")
   });

   assert.equal(chunk.statusCode, 200);
   await access(internalFile.partialPath);

   const deleted = await app.inject({
      method: "DELETE",
      url: `/api/local/sessions/${created.session.sid}`,
      headers: { authorization: `Bearer ${created.token}` }
   });

   assert.equal(deleted.statusCode, 204);
   await assert.rejects(access(internalFile.partialPath));
   const stale = await app.inject({
      method: "GET",
      url: `/api/local/upload-sessions/${created.session.sid}`,
      headers: { cookie }
   });
   assert.equal(stale.statusCode, 401);
});

test("rejects unrecognized Host headers", async (t) => {
   const { app } = await fixture(t);

   const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { host: "attacker.example" }
   });

   assert.equal(response.statusCode, 421);
});
test("serves a sparse 1 GiB source by range without staging a copy", async (t) => {
   const { app, base, sessions } = await fixture(t);

   const sourcePath = join(base, "large.bin");
   const size = 1024 * 1024 * 1024;

   await writeFile(sourcePath, Buffer.alloc(1));
   await truncate(sourcePath, size);
   const info = await stat(sourcePath);
   const created = await sessions.create({
      kind: "send",
      appBaseUrl: "http://127.0.0.1:8787",
      files: [{
         name: "large.bin",
         type: "application/octet-stream",
         size: info.size,
         lastModified: info.mtimeMs,
         sourcePath,
         sourceModifiedMs: info.mtimeMs
      }]
   });
   const file = created.session.files[0];

   assert.ok(file);
   const cookie = await authorize(app, created.session.sid, created.token);
   const start = size - 1024;
   const response = await app.inject({
      method: "GET",
      url: `/api/local/send-sessions/${created.session.sid}/files/${file.fileId}`,
      headers: {
         cookie,
         range: `bytes=${start}-`
      }
   });

   assert.equal(response.statusCode, 206);
   assert.equal(response.rawPayload.length, 1024);
   assert.equal(response.headers["content-range"], `bytes ${start}-${size - 1}/${size}`);
   assert.deepEqual(await readdir(join(sessions.rootDir, `send-${created.session.sid}`)), []);
});
test("applies restrictive security headers without permissive CORS", async (t) => {
   const { app } = await fixture(t);

   const response = await app.inject({ method: "GET", url: "/healthz" });

   assert.equal(response.statusCode, 200);
   assert.match(String(response.headers["content-security-policy"] ?? ""), /default-src 'self'/u);
   assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
   assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
   assert.equal(response.headers["referrer-policy"], "no-referrer");
   assert.equal(response.headers["x-content-type-options"], "nosniff");
   assert.match(String(response.headers["permissions-policy"] ?? ""), /camera=\(\)/u);
   assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("completes a zero-byte upload atomically", async (t) => {
   const { app, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const response = await app.inject({
      method: "POST",
      url: `/api/local/upload-sessions/${created.session.sid}/files`,
      headers: { cookie },
      payload: {
         name: "empty.txt",
         type: "text/plain",
         size: 0,
         lastModified: 1
      }
   });

   assert.equal(response.statusCode, 201);
   const body = response.json();
   assert.equal(body.file.ready, true);
   assert.equal(body.file.state, "ready");
   assert.equal(body.file.sha256, createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
   const completedPath = sessions.getCompletedPath(created.session.sid, body.file.fileId);

   assert.ok(completedPath);
   assert.equal((await readFile(completedPath)).length, 0);
});
test("accepts bracketed IPv6 loopback Host", async (t) => {
   const { app } = await fixture(t);

   const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { host: "[::1]:8787" }
   });

   assert.equal(response.statusCode, 200);
});
test("accepts multiple sequential mobile files after the first finalizes", async (t) => {
   const { app, receiveDir, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const uploadOne = async (payload: Buffer) => {
      const register = await app.inject({
         method: "POST",
         url: `/api/local/upload-sessions/${created.session.sid}/files`,
         headers: { cookie },
         payload: {
            name: "photo.jpg",
            type: "image/jpeg",
            size: payload.length,
            lastModified: 1234
         }
      });

      assert.equal(register.statusCode, 201);
      const registered = register.json().file;
      const uploaded = await app.inject({
         method: "PUT",
         url: `/api/local/upload-sessions/${created.session.sid}/files/${registered.fileId}/chunks`,
         headers: {
            cookie,
            "content-type": "application/octet-stream",
            "content-range": `bytes 0-${payload.length - 1}/${payload.length}`
         },
         payload
      });

      assert.equal(uploaded.statusCode, 200);
      assert.equal(uploaded.json().file.ready, true);
      assert.equal(uploaded.json().file.sha256, createHash("sha256").update(payload).digest("hex"));
      return uploaded.json().file;
   };
   const first = await uploadOne(Buffer.from("one"));
   const second = await uploadOne(Buffer.from("two"));
   const session = sessions.publicView(created.session);

   assert.notEqual(first.fileId, second.fileId);
   assert.equal(session.files.length, 2);
   assert.equal(session.files.every((file) => file.ready), true);
   assert.equal((await readFile(join(receiveDir, "photo.jpg"))).toString(), "one");
   assert.equal((await readFile(join(receiveDir, "photo (1).jpg"))).toString(), "two");
});
test("rolls back incremental SHA state when a chunk is truncated", async (t) => {
   const { app, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const register = await app.inject({
      method: "POST",
      url: `/api/local/upload-sessions/${created.session.sid}/files`,
      headers: { cookie },
      payload: {
         name: "retry.bin",
         type: "application/octet-stream",
         size: 4,
         lastModified: 1
      }
   });
   const fileId = register.json().file.fileId as string;
   const truncated = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 0-3/4"
      },
      payload: Buffer.from("ab")
   });

   assert.equal(truncated.statusCode, 400);
   assert.equal(sessions.getFile(created.session, fileId)?.receivedSize, 0);
   const payload = Buffer.from("WXYZ");
   const retried = await app.inject({
      method: "PUT",
      url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
      headers: {
         cookie,
         "content-type": "application/octet-stream",
         "content-range": "bytes 0-3/4"
      },
      payload
   });

   assert.equal(retried.statusCode, 200);
   assert.equal(retried.json().file.sha256, createHash("sha256").update(payload).digest("hex"));
});
test("accepts a 15 MiB JPEG through one MiB mobile checkpoints", async (t) => {
   const { app, receiveDir, sessions } = await fixture(t);

   const created = await sessions.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const cookie = await authorize(app, created.session.sid, created.token);
   const chunkSize = 1024 * 1024;
   const payload = Buffer.alloc((15 * 1024 * 1024) + 317, 0x5a);

   payload.set([0xff, 0xd8, 0xff, 0xe0], 0);
   const register = await app.inject({
      method: "POST",
      url: `/api/local/upload-sessions/${created.session.sid}/files`,
      headers: { cookie },
      payload: {
         name: "IMG_3248.jpeg",
         type: "image/jpeg",
         size: payload.length,
         lastModified: 1234
      }
   });
   const fileId = register.json().file.fileId as string;
   let latest: { receivedSize: number; ready: boolean; sha256?: string } | undefined;

   for (let start = 0; start < payload.length; start += chunkSize) {
      const end = Math.min(payload.length, start + chunkSize) - 1;
      const uploaded = await app.inject({
         method: "PUT",
         url: `/api/local/upload-sessions/${created.session.sid}/files/${fileId}/chunks`,
         headers: {
            cookie,
            "content-type": "application/octet-stream",
            "content-range": `bytes ${start}-${end}/${payload.length}`
         },
         payload: payload.subarray(start, end + 1)
      });

      assert.equal(uploaded.statusCode, 200);
      latest = uploaded.json().file;
      assert.equal(latest?.receivedSize, end + 1);
   }

   assert.equal(latest?.ready, true);
   assert.equal(latest?.sha256, createHash("sha256").update(payload).digest("hex"));
   assert.deepEqual(await readFile(join(receiveDir, "IMG_3248.jpeg")), payload);
});