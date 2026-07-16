import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
   LocalLanSessionStore,
   LocalSessionError
} from "./localSessionStore.ts";

async function temporaryRoot(t: TestContext): Promise<string> {
   const rootDir = await mkdtemp(join(tmpdir(), "local-file-transfer-"));

   t.after(() => rm(rootDir, { recursive: true, force: true }));
   return rootDir;
}

test("creates token-protected local send sessions", async (t) => {
   const rootDir = await temporaryRoot(t);
   const store = new LocalLanSessionStore({
      rootDir,
      ttlMs: 60_000,
      now: () => 1000
   });
   const created = await store.create({
      kind: "send",
      appBaseUrl: "http://192.168.1.10:8787",
      files: [
         {
            name: "photo.jpg",
            type: "image/jpeg",
            size: 42,
            lastModified: 900
         }
      ]
   });

   assert.equal(created.session.files.length, 1);
   assert.equal(store.require(created.session.sid, created.token, "send").sid, created.session.sid);
   assert.throws(
      () => store.require(created.session.sid, "wrong-token", "send"),
      LocalSessionError
   );
});

test("expires sessions by TTL", async (t) => {
   const rootDir = await temporaryRoot(t);
   let now = 1000;
   const store = new LocalLanSessionStore({
      rootDir,
      ttlMs: 10,
      now: () => now
   });
   const created = await store.create({
      kind: "upload",
      appBaseUrl: "http://192.168.1.10:8787"
   });

   now = 1011;

   assert.equal(store.get(created.session.sid), undefined);
});

test("enforces file and session quotas", async (t) => {
   const rootDir = await temporaryRoot(t);
   const store = new LocalLanSessionStore({
      rootDir,
      ttlMs: 60_000,
      limits: {
         maxFiles: 1,
         maxFileSize: 5,
         maxSessionSize: 5
      }
   });

   await assert.rejects(
      store.create({
         kind: "send",
         appBaseUrl: "http://127.0.0.1:8787",
         files: [
            { name: "a", type: "text/plain", size: 3, lastModified: 1 },
            { name: "b", type: "text/plain", size: 2, lastModified: 1 }
         ]
      }),
      /at most 1 files/u
   );
   await assert.rejects(
      store.create({
         kind: "send",
         appBaseUrl: "http://127.0.0.1:8787",
         files: [{ name: "large", type: "text/plain", size: 6, lastModified: 1 }]
      }),
      /size limit/u
   );
});

test("issues short-lived browser tickets without exposing the master token", async (t) => {
   const rootDir = await temporaryRoot(t);
   const store = new LocalLanSessionStore({
      rootDir,
      ttlMs: 60_000,
      hardTtlMs: 120_000,
      now: () => 1000
   });
   const created = await store.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const issued = store.issueBrowserTicket(created.session.sid, created.token);

   assert.notEqual(issued.ticket, created.token);
   assert.equal(store.requireAuthorized(created.session.sid, { ticket: issued.ticket }).sid, created.session.sid);
   assert.throws(
      () => store.requireAuthorized(created.session.sid, { ticket: "wrong" }),
      LocalSessionError
   );
});

test("publishes session events to subscribers", async (t) => {
   const rootDir = await temporaryRoot(t);
   const store = new LocalLanSessionStore({ rootDir, ttlMs: 60_000 });
   const created = await store.create({
      kind: "send",
      appBaseUrl: "http://127.0.0.1:8787",
      files: [{
         name: "source.txt",
         type: "text/plain",
         size: 1,
         lastModified: 1,
         sourcePath: join(rootDir, "source.txt"),
         sourceModifiedMs: 1
      }]
   });
   const events: string[] = [];
   const unsubscribe = store.subscribe(created.session.sid, (event) => events.push(event.t));

   store.issueBrowserTicket(created.session.sid, created.token);
   unsubscribe();

   assert.deepEqual(events, ["joined"]);
});
test("TTL cleanup removes partial uploads but preserves no incomplete artifact", async (t) => {
   const rootDir = await temporaryRoot(t);
   const receiveDir = join(rootDir, "received-files");
   let now = 1000;
   const store = new LocalLanSessionStore({
      rootDir,
      receiveDir,
      ttlMs: 10,
      hardTtlMs: 100,
      now: () => now
   });
   const created = await store.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });
   const file = await store.addUploadedFile(created.session, {
      name: "unfinished.bin",
      type: "application/octet-stream",
      size: 4,
      lastModified: 1
   });

   assert.ok(file.partialPath);
   await writeFile(file.partialPath, Buffer.from("ab"));
   now = 1011;
   await store.sweepExpired();

   await assert.rejects(access(file.partialPath));
   assert.equal(store.get(created.session.sid), undefined);
});
test("never extends activity beyond the absolute session TTL", async (t) => {
   const rootDir = await temporaryRoot(t);
   let now = 1000;
   const store = new LocalLanSessionStore({
      rootDir,
      ttlMs: 10,
      hardTtlMs: 25,
      now: () => now
   });
   const created = await store.create({
      kind: "upload",
      appBaseUrl: "http://127.0.0.1:8787"
   });

   now = 1009;
   assert.equal(store.require(created.session.sid, created.token).expiresAt, 1019);
   now = 1018;
   assert.equal(store.require(created.session.sid, created.token).expiresAt, 1025);
   now = 1025;
   assert.equal(store.get(created.session.sid), undefined);
});