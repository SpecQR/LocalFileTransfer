import assert from "node:assert/strict";
import test from "node:test";
import { isSameHttpOrigin, parseRequestHostname } from "./requestGuards.ts";

test("normalizes valid Host authorities and rejects smuggled components", () => {
   assert.equal(parseRequestHostname("LOCALHOST:8787"), "localhost");
   assert.equal(parseRequestHostname("[::1]:8787"), "::1");
   assert.equal(parseRequestHostname("user@127.0.0.1:8787"), undefined);
   assert.equal(parseRequestHostname("127.0.0.1:8787/path"), undefined);
   assert.equal(parseRequestHostname("127.0.0.1:8787\r\nx-test: yes"), undefined);
});

test("accepts only the exact normalized HTTP Origin for the validated Host", () => {
   assert.equal(isSameHttpOrigin(undefined, "192.168.1.2:8787"), true);
   assert.equal(isSameHttpOrigin("http://192.168.1.2:8787", "192.168.1.2:8787"), true);
   assert.equal(isSameHttpOrigin("http://192.168.1.2:8787/", "192.168.1.2:8787"), false);
   assert.equal(isSameHttpOrigin("https://192.168.1.2:8787", "192.168.1.2:8787"), false);
   assert.equal(isSameHttpOrigin("http://192.168.1.3:8787", "192.168.1.2:8787"), false);
   assert.equal(isSameHttpOrigin(["http://192.168.1.2:8787"], "192.168.1.2:8787"), false);
});
