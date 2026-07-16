import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRateLimiter } from "./rateLimiter.ts";

test("rate limits within a window and resets afterward", () => {
   let now = 1000;
   const limiter = new MemoryRateLimiter(() => now);

   assert.equal(limiter.check("client", 2, 1000).allowed, true);
   assert.equal(limiter.check("client", 2, 1000).allowed, true);
   assert.equal(limiter.check("client", 2, 1000).allowed, false);
   now = 2001;
   assert.equal(limiter.check("client", 2, 1000).allowed, true);
});