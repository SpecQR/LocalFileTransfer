import assert from "node:assert/strict";
import test from "node:test";
import {
   readCookie,
   sessionCookieName
} from "./auth.ts";

test("uses a session-specific cookie name", () => {
   assert.equal(sessionCookieName("abc_DEF-123"), "lft_abc_DEF-123");
});

test("reads only the requested encoded cookie", () => {
   assert.equal(readCookie("a=1; lft_sid=ticket%2Fvalue; b=2", "lft_sid"), "ticket/value");
   assert.equal(readCookie("a=1", "lft_sid"), undefined);
});