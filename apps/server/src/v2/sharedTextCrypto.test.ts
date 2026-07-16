import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSharedText } from "../../../../packages/protocol/src/index.ts";
import {
   decryptSharedText,
   deriveSharedTextKey,
   encryptSharedText,
   zeroizeKey
} from "./sharedTextCrypto.ts";

const roomId = "room_shared_text_1";
const token = "A".repeat(43);

test("shared text AES-256-GCM roundtrips Unicode with unique nonces", () => {
   const key = deriveSharedTextKey(roomId, token);
   const value: RoomSharedText = {
      content: "日本語🙂\n<script>alert('safe text')</script>",
      revision: 7,
      updatedAt: 123_456
   };
   const first = encryptSharedText(key, roomId, value);
   const second = encryptSharedText(key, roomId, value);

   assert.equal(key.byteLength, 32);
   assert.equal(first.nonce.byteLength, 12);
   assert.equal(first.authTag.byteLength, 16);
   assert.notDeepEqual(first.nonce, second.nonce);
   assert.deepEqual(decryptSharedText(key, first), value);
   assert.equal(first.ciphertext.includes(Buffer.from(value.content, "utf8")), false);
   zeroizeKey(key);
   assert.deepEqual(key, Buffer.alloc(32));
});

test("shared text authentication rejects the wrong capability and modified metadata", () => {
   const key = deriveSharedTextKey(roomId, token);
   const wrongKey = deriveSharedTextKey(roomId, "B".repeat(43));
   const encrypted = encryptSharedText(key, roomId, {
      content: "private value",
      revision: 1,
      updatedAt: 99
   });

   assert.throws(() => decryptSharedText(wrongKey, encrypted));
   assert.throws(() => decryptSharedText(key, {
      ...encrypted,
      revision: 2
   }));
   zeroizeKey(key);
   zeroizeKey(wrongKey);
});
