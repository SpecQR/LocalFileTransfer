import assert from "node:assert/strict";
import test from "node:test";
import {
   browserUploadChunkSize,
   UploadPausedError,
   xhrUploadCheckpoint,
   xhrUploadChunk
} from "./uploadRequest.ts";

test("uses one MiB browser upload checkpoints", () => {
   assert.equal(browserUploadChunkSize, 1024 * 1024);
});

test("does not infer a stall from missing progress events", async () => {
   const request = new FakeRequest({ completeAtMs: 30 });
   const response = await xhrUploadChunk<{ ok: boolean }>(
      "/upload",
      new Blob(["slow-without-progress-events"]),
      { start: 0, end: 27, total: 28 },
      undefined,
      { createRequest: () => request as unknown as XMLHttpRequest }
   );

   assert.deepEqual(response, { ok: true });
   assert.equal(request.aborted, false);
   assert.equal(request.timeout, 0);
});

test("surfaces browser-reported network failures", async () => {
   const request = new FakeRequest({ errorAtMs: 5 });

   await assert.rejects(
      xhrUploadChunk(
         "/upload",
         new Blob(["network-error"]),
         { start: 0, end: 12, total: 13 },
         undefined,
         { createRequest: () => request as unknown as XMLHttpRequest }
      ),
      /Check the LAN connection/u
   );
});

test("sends durable checkpoint headers and accepts authoritative offsets", async () => {
   const request = new FakeRequest({
      completeAtMs: 5,
      status: 204,
      responseHeaders: {
         "upload-offset": "10",
         "upload-length": "20",
         "upload-fingerprint": "f".repeat(43),
         "upload-state": "transferring"
      }
   });
   const result = await xhrUploadCheckpoint(
      "/upload",
      new Blob(["checkpoint"]),
      {
         offset: 0,
         total: 20,
         checksum: "a".repeat(43) + "=",
         idempotencyKey: "b".repeat(43)
      },
      undefined,
      { createRequest: () => request as unknown as XMLHttpRequest }
   );

   assert.equal(request.method, "PATCH");
   assert.equal(request.headers.get("content-type"), "application/offset+octet-stream");
   assert.equal(request.headers.get("upload-offset"), "0");
   assert.equal(request.headers.get("upload-checksum"), "sha256 " + "a".repeat(43) + "=");
   assert.equal(request.headers.get("idempotency-key"), "b".repeat(43));
   assert.deepEqual(result, {
      offset: 10,
      length: 20,
      fingerprint: "f".repeat(43),
      state: "transferring"
   });
});

test("aborting a durable checkpoint pauses the active XHR", async () => {
   const request = new FakeRequest({});
   const controller = new AbortController();
   const pending = xhrUploadCheckpoint(
      "/upload",
      new Blob(["checkpoint"]),
      {
         offset: 0,
         total: 10,
         checksum: "a".repeat(43) + "=",
         idempotencyKey: "b".repeat(43),
         signal: controller.signal
      },
      undefined,
      { createRequest: () => request as unknown as XMLHttpRequest }
   );

   controller.abort();
   await assert.rejects(pending, UploadPausedError);
   assert.equal(request.aborted, true);
});

interface FakeRequestPlan {
   completeAtMs?: number;
   errorAtMs?: number;
   status?: number;
   responseHeaders?: Record<string, string>;
}

class FakeRequest {
   readonly upload: {
      onprogress: ((event: { loaded: number }) => void) | null;
   } = {
      onprogress: null
   };
   status = 0;
   responseText = "";
   timeout = 0;
   withCredentials = false;
   onload: (() => void) | null = null;
   onerror: (() => void) | null = null;
   onabort: (() => void) | null = null;
   aborted = false;
   method = "";
   readonly headers = new Map<string, string>();
   private readonly plan: FakeRequestPlan;

   constructor(plan: FakeRequestPlan) {
      this.plan = plan;
   }

   open(method: string): void {
      this.method = method;
   }

   setRequestHeader(name: string, value: string): void {
      this.headers.set(name.toLowerCase(), value);
   }

   getResponseHeader(name: string): string | null {
      return this.plan.responseHeaders?.[name.toLowerCase()] ?? null;
   }

   send(): void {
      if (this.plan.completeAtMs !== undefined) {
         setTimeout(() => {
            this.status = this.plan.status ?? 200;
            this.responseText = JSON.stringify({ ok: true });
            this.onload?.();
         }, this.plan.completeAtMs);
      }

      if (this.plan.errorAtMs !== undefined) {
         setTimeout(() => this.onerror?.(), this.plan.errorAtMs);
      }
   }

   abort(): void {
      this.aborted = true;
      this.onabort?.();
   }
}