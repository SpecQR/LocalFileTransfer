import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { RoomItemView, RoomView } from "../../../../packages/protocol/src/index.ts";
import { checkpointIdempotencyKey } from "../../../server/src/v2/roomStore.ts";
import { maxProtocolLineBytes, ProtocolLineReader, type HostAction, type HostResponse, type HostSnapshot } from "./protocol.ts";

function startService(t: TestContext) {
   const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
      env: { ...process.env, LFT_SMOKE_LOOPBACK_ONLY: "1" },
      stdio: ["pipe", "pipe", "pipe"]
   });
   const pending = new Map<string, { resolve: (response: HostResponse) => void; reject: (error: Error) => void }>();
   const lines = new ProtocolLineReader();
   let nextId = 0;
   let stderr = "";
   let protocolError = false;
   let exited = false;
   const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => {
         exited = true;
         for (const waiter of pending.values()) {
            waiter.reject(new Error("Sidecar exited before its response"));
         }

         pending.clear();
         resolve({ code, signal });
      });
   });

   child.stdin.on("error", () => undefined);
   child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
   child.stdout.on("data", (chunk: Buffer) => {
      try {
         for (const line of lines.push(chunk)) {
            const response = JSON.parse(line.toString("utf8")) as HostResponse;
            const waiter = pending.get(response.requestId);

            if (!waiter || typeof response.ok !== "boolean") {
               protocolError = true;
               continue;
            }

            pending.delete(response.requestId);
            waiter.resolve(response);
         }
      } catch {
         protocolError = true;
      }
   });
   t.after(async () => {
      if (!exited) {
         child.kill("SIGKILL");
         await closed;
      }
   });

   async function response(action: HostAction, payload?: unknown): Promise<HostResponse> {
      const requestId = "test_" + (++nextId);
      let timer: NodeJS.Timeout;
      const result = new Promise<HostResponse>((resolve, reject) => {
         pending.set(requestId, { resolve, reject });
         timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Sidecar response timed out"));
         }, 10_000);
      }).finally(() => clearTimeout(timer));

      child.stdin.write(JSON.stringify({ requestId, action, ...(payload === undefined ? {} : { payload }) }) + "\n");
      return result;
   }

   return {
      child,
      closed,
      response,
      async request<T>(action: HostAction, payload?: unknown): Promise<T> {
         const result = await response(action, payload);

         assert.equal(result.ok, true, "Owner command failed: " + (result.error ?? "unknown"));
         return result.result as T;
      },
      verifyOutput() {
         assert.equal(protocolError, false, "stdout must contain only correlated RPC responses");
         lines.finish();
      },
      get stderr() { return stderr; }
   };
}

async function authorize(snapshot: HostSnapshot): Promise<string> {
   const result = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: snapshot.runtime.localUrl },
      body: JSON.stringify({ token: snapshot.credential.token })
   });

   assert.equal(result.status, 204);
   const cookie = result.headers.get("set-cookie");

   assert.ok(cookie);
   assert.match(cookie, /HttpOnly/iu);
   assert.match(cookie, /SameSite=Strict/iu);
   return cookie.split(";", 1)[0]!;
}

async function checkpoint(snapshot: HostSnapshot, cookie: string, itemId: string, offset: number, content: Buffer) {
   const checksum = createHash("sha256").update(content).digest("base64");

   return fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/uploads/${itemId}`, {
      method: "PATCH",
      headers: {
         cookie,
         origin: snapshot.runtime.localUrl,
         "content-type": "application/offset+octet-stream",
         "upload-offset": String(offset),
         "upload-checksum": "sha256 " + checksum,
         "idempotency-key": checkpointIdempotencyKey(snapshot.credential.roomId, itemId, offset, content.length, checksum)
      },
      body: new Uint8Array(content)
   });
}

test("stdio service preserves transfer hashes, durable resume and encrypted shared text across a killed child", { timeout: 30_000 }, async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-webview2-service-"));

   const payload = {
      storageDir: join(root, "storage"), receiveDir: join(root, "receive"), staticRoot: join(root, "web"), version: "2.0.1-preview"
   };
   let service = startService(t);

   t.after(async () => {
      service.child.kill("SIGKILL");
      await service.closed;
      await rm(root, { recursive: true, force: true });
   });
   await mkdir(payload.staticRoot);
   await writeFile(join(payload.staticRoot, "index.html"), "<!doctype html><title>Test room</title>");
   let snapshot = await service.request<HostSnapshot>("initialize", payload);
   let cookie = await authorize(snapshot);
   const health = await fetch(snapshot.runtime.localUrl + "/healthz");

   assert.equal(health.status, 200);
   assert.deepEqual(await health.json(), { ok: true });
   assert.match(health.headers.get("content-security-policy") ?? "", /frame-src 'none'; object-src 'none'/u);
   assert.equal(health.headers.get("content-security-policy")?.includes("http://ipc.localhost"), false);
   const nativeDocument = await fetch(snapshot.runtime.localUrl + "/app");

   assert.equal(nativeDocument.status, 200);
   assert.match(nativeDocument.headers.get("content-security-policy") ?? "", /connect-src 'self' http:\/\/ipc\.localhost;/u);
   await nativeDocument.arrayBuffer();
   for (const path of ["/room/" + snapshot.credential.roomId, "/app?outside-native-document=1"]) {
      const document = await fetch(snapshot.runtime.localUrl + path);

      assert.equal(document.headers.get("content-security-policy")?.includes("http://ipc.localhost"), false);
      await document.arrayBuffer();
   }
   const otherHost = await fetch(`http://localhost:${snapshot.runtime.port}/app`);

   assert.equal(otherHost.headers.get("content-security-policy")?.includes("http://ipc.localhost"), false);
   await otherHost.arrayBuffer();
   const sourcePath = join(root, "source.txt");

   await writeFile(sourcePath, "0123456789");
   const view = await service.request<RoomView>("add-files", {
      files: [{ path: sourcePath, name: "untrusted-name.txt", type: "text/plain", size: 1, lastModified: 1 }]
   });
   const source = view.items.find((item) => item.direction === "windows_to_device");

   assert.ok(source);
   assert.equal(source.name, "source.txt");
   assert.equal(source.size, 10);
   assert.equal(source.sha256, createHash("sha256").update("0123456789").digest("hex"));
   const download = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/files/${source.itemId}/content`, {
      headers: { cookie, range: "bytes=3-6" }
   });

   assert.equal(download.status, 206);
   assert.equal(await download.text(), "3456");
   const textFixture = "standalone shared text fixture";
   const shared = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/shared-text`, {
      method: "PUT",
      headers: { cookie, origin: snapshot.runtime.localUrl, "content-type": "application/json" },
      body: JSON.stringify({ content: textFixture, expectedRevision: 0 })
   });

   assert.equal(shared.status, 200);
   await shared.arrayBuffer();
   const registered = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/uploads`, {
      method: "POST",
      headers: { cookie, origin: snapshot.runtime.localUrl, "content-type": "application/json" },
      body: JSON.stringify({ name: "received.txt", type: "text/plain", size: 11, lastModified: 1, fingerprint: "f".repeat(43) })
   });

   assert.equal(registered.status, 201);
   const itemId = ((await registered.json()) as { item: RoomItemView }).item.itemId;
   const first = await checkpoint(snapshot, cookie, itemId, 0, Buffer.from("hello "));

   assert.equal(first.status, 204);
   assert.equal(first.headers.get("upload-offset"), "6");
   const active = await service.request<HostSnapshot>("bootstrap");

   assert.equal(active.transferActive, true);
   const credential = snapshot.credential;

   service.child.kill("SIGKILL");
   await service.closed;
   service.verifyOutput();
   service = startService(t);
   snapshot = await service.request<HostSnapshot>("initialize", { ...payload, credential, serviceRestarts: 1 });
   assert.ok(snapshot.credential.roomId === credential.roomId, "Room identity must survive a child restart");
   assert.ok(snapshot.credential.token === credential.token, "Room credential must survive a child restart");
   cookie = await authorize(snapshot);
   const resumed = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/uploads/${itemId}`, {
      method: "HEAD", headers: { cookie }
   });

   assert.equal(resumed.status, 204);
   assert.equal(resumed.headers.get("upload-offset"), "6");
   const replay = await checkpoint(snapshot, cookie, itemId, 0, Buffer.from("hello "));

   assert.equal(replay.status, 204);
   assert.equal(replay.headers.get("upload-offset"), "6");
   const restoredText = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/shared-text`, { headers: { cookie } });

   assert.equal(restoredText.status, 200);
   assert.equal(((await restoredText.json()) as { content: string }).content, textFixture);
   const completed = await checkpoint(snapshot, cookie, itemId, 6, Buffer.from("world"));

   assert.equal(completed.status, 204);
   assert.equal(completed.headers.get("upload-offset"), "11");
   const completedPath = await service.request<string>("completed-path", { roomId: snapshot.credential.roomId, itemId });

   assert.equal((await readFile(completedPath)).toString(), "hello world");
   const roomResult = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}`, { headers: { cookie } });
   const completeView = await roomResult.json() as RoomView;
   const received = completeView.items.find((item) => item.itemId === itemId);

   assert.equal(received?.state, "ready");
   assert.equal(received?.sha256, createHash("sha256").update("hello world").digest("hex"));
   const missing = await service.response("add-files", {
      files: [{ path: join(root, "private-missing-source.txt"), name: "missing.txt", type: "text/plain", size: 1, lastModified: 1 }]
   });

   assert.equal(missing.ok, false);
   assert.equal(missing.error, "request-failed");
   const events = await fetch(`${snapshot.runtime.localUrl}/api/v2/rooms/${snapshot.credential.roomId}/events`, { headers: { cookie } });

   assert.equal(events.status, 200);
   const replacement = await service.request<HostSnapshot>("reset-room");

   assert.ok(replacement.credential.roomId !== snapshot.credential.roomId);
   const stale = await service.response("completed-path", { roomId: snapshot.credential.roomId, itemId });

   assert.equal(stale.error, "inactive-room");
   await service.request("shutdown");
   assert.equal((await service.closed).code, 0);
   await events.body?.cancel().catch(() => undefined);
   service.verifyOutput();
   const logs = await readFile(join(snapshot.runtime.logDir, "service.jsonl"), "utf8");

   assert.match(logs, /service-ready/u);
   assert.match(logs, /service-stopped/u);
   for (const privateValue of [credential.token, replacement.credential.token, textFixture, sourcePath, root]) {
      assert.equal(logs.includes(privateValue), false, "Structured log must not expose private values");
      assert.equal(service.stderr.includes(privateValue), false, "stderr must not expose private values");
   }

   const database = await readFile(join(payload.storageDir, "rooms.sqlite"));

   assert.equal(database.includes(Buffer.from(textFixture)), false, "SQLite must not contain shared text plaintext");
});

test("stdio EOF shuts down the listening service and oversized input terminates without leaking it", { timeout: 20_000 }, async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-webview2-eof-"));

   const service = startService(t);

   t.after(async () => {
      service.child.kill("SIGKILL");
      await service.closed;
      await rm(root, { recursive: true, force: true });
   });
   const snapshot = await service.request<HostSnapshot>("initialize", {
      storageDir: join(root, "storage"), receiveDir: join(root, "receive"), staticRoot: join(root, "web"), version: "2.0.1-preview"
   });

   service.child.stdin.end();
   assert.equal((await service.closed).code, 0);
   service.verifyOutput();
   await assert.rejects(fetch(snapshot.runtime.localUrl + "/healthz"));
   const oversized = startService(t);

   oversized.child.stdin.write(Buffer.alloc(maxProtocolLineBytes + 1, 0x61));
   assert.equal((await oversized.closed).code, 1);
   oversized.verifyOutput();
});
