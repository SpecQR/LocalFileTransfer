import assert from "node:assert/strict";
import test from "node:test";
import { sha256Base64Url } from "./hash.ts";

test("sha256Base64Url matches known digest", async () => {
   const digest = await sha256Base64Url("abc");

   assert.equal(digest, "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});
