import assert from "node:assert/strict";
import test from "node:test";
import {
   base64UrlToBytes,
   base64UrlToString,
   bytesToBase64Url,
   stringToBase64Url
} from "./base64url.ts";

test("base64url encodes without padding or unsafe URL characters", () => {
   const encoded = bytesToBase64Url(new Uint8Array([251, 255, 255, 0, 1, 2]));

   assert.equal(encoded.includes("+"), false);
   assert.equal(encoded.includes("/"), false);
   assert.equal(encoded.includes("="), false);
   assert.deepEqual(base64UrlToBytes(encoded), new Uint8Array([251, 255, 255, 0, 1, 2]));
});

test("base64url roundtrips UTF-8 strings", () => {
   const value = "Local File Transfer";
   const encoded = stringToBase64Url(value);

   assert.equal(base64UrlToString(encoded), value);
});

test("base64url rejects invalid characters", () => {
   assert.throws(() => base64UrlToBytes("not+url-safe"));
});
