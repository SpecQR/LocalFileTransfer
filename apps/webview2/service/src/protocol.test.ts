import assert from "node:assert/strict";
import test from "node:test";
import {
   encodeHostResponse,
   HostRequestError,
   maxProtocolLineBytes,
   parseHostRequest,
   ProtocolLineReader,
   requestIdFromUnknown,
   responseError
} from "./protocol.ts";

test("stdio framing preserves split UTF-8 and bounds incomplete lines", () => {
   const reader = new ProtocolLineReader();
   const first = Buffer.from('{"requestId":"one","action":"add-files","payload":{"name":"日本語"}}\r\n');
   const split = first.indexOf(Buffer.from("日")) + 1;

   assert.deepEqual(reader.push(first.subarray(0, split)), []);
   const frames = reader.push(Buffer.concat([first.subarray(split), Buffer.from('{"requestId":"two","action":"bootstrap"}\n')]));

   assert.equal(frames.length, 2);
   assert.equal(JSON.parse(frames[0]!.toString()).payload.name, "日本語");
   assert.equal(JSON.parse(frames[1]!.toString()).requestId, "two");
   reader.finish();

   const oversized = new ProtocolLineReader();

   oversized.push(Buffer.alloc(maxProtocolLineBytes - 1, 0x61));
   assert.throws(() => oversized.push(Buffer.from("b\n")), /request-too-large/u);
   const incomplete = new ProtocolLineReader();

   incomplete.push(Buffer.from('{"requestId":"unfinished"}'));
   assert.throws(() => incomplete.finish(), /incomplete-request/u);
});

test("stdio accepts only narrow owner commands and safe correlation IDs", () => {
   assert.deepEqual(parseHostRequest({ requestId: "123_test-1", action: "bootstrap" }), {
      requestId: "123_test-1", action: "bootstrap"
   });
   for (const value of [
      null,
      [],
      { requestId: 1, action: "bootstrap" },
      { requestId: "with space", action: "bootstrap" },
      { requestId: "x".repeat(129), action: "bootstrap" },
      { requestId: "one", action: "create-room" },
      { requestId: "one", action: "bootstrap", extra: true }
   ]) {
      assert.throws(() => parseHostRequest(value));
   }

   assert.equal(requestIdFromUnknown({ requestId: "one" }), "one");
   assert.equal(requestIdFromUnknown({ requestId: "invalid\nvalue" }), "invalid-request");
});

test("stdio errors never echo private payloads or exception messages", () => {
   const error = new Error("private source path and shared text");

   assert.equal(responseError(error), "request-failed");
   assert.equal(responseError(new TypeError("private invalid token")), "invalid-payload");
   assert.equal(responseError({ statusCode: 401, message: "private token" }), "request-failed-401");
   assert.equal(responseError(new HostRequestError("inactive-room")), "inactive-room");

   const encoded = encodeHostResponse({ requestId: "one", ok: true, result: "x".repeat(maxProtocolLineBytes) });

   assert.deepEqual(JSON.parse(encoded), { requestId: "one", ok: false, error: "response-too-large" });
   assert.equal(encoded.endsWith("\n"), true);
});
