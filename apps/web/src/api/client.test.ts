import assert from "node:assert/strict";
import test from "node:test";
import {
   sendFileDownloadUrl,
   tokenFromHash
} from "./client.ts";

test("reads local session token from URL fragment", () => {
   assert.equal(tokenFromHash("#t=abc123"), "abc123");
});

test("requires local session token in URL fragment", () => {
   assert.throws(() => tokenFromHash("#"), /missing the local session token/u);
});

test("download URLs never contain the master token", () => {
   const url = sendFileDownloadUrl("session", "file");

   assert.equal(url, "/api/local/send-sessions/session/files/file");
   assert.equal(url.includes("token"), false);
   assert.equal(url.includes("?"), false);
});