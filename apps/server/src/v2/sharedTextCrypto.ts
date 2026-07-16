import {
   createCipheriv,
   createDecipheriv,
   hkdfSync,
   randomBytes
} from "node:crypto";
import type { RoomSharedText } from "../../../../packages/protocol/src/index.ts";
import type { PersistedSharedTextCiphertext } from "./types.ts";

const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;
const keyInfo = Buffer.from("local-file-transfer shared-text key v1", "utf8");

export function deriveSharedTextKey(roomId: string, token: string): Buffer {
   return Buffer.from(hkdfSync(
      "sha256",
      Buffer.from(token, "base64url"),
      Buffer.from(roomId, "utf8"),
      keyInfo,
      keyLength
   ));
}

export function encryptSharedText(
   key: Buffer,
   roomId: string,
   value: RoomSharedText
): PersistedSharedTextCiphertext {
   assertKey(key);
   const nonce = randomBytes(nonceLength);
   const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength
   });

   cipher.setAAD(additionalData(roomId, value.revision, value.updatedAt));
   const ciphertext = Buffer.concat([
      cipher.update(value.content, "utf8"),
      cipher.final()
   ]);

   return {
      roomId,
      revision: value.revision,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
      updatedAt: value.updatedAt
   };
}

export function decryptSharedText(
   key: Buffer,
   value: PersistedSharedTextCiphertext
): RoomSharedText {
   assertKey(key);
   const decipher = createDecipheriv("aes-256-gcm", key, value.nonce, {
      authTagLength
   });

   decipher.setAAD(additionalData(value.roomId, value.revision, value.updatedAt));
   decipher.setAuthTag(value.authTag);
   const plaintext = Buffer.concat([
      decipher.update(value.ciphertext),
      decipher.final()
   ]);

   return {
      content: plaintext.toString("utf8"),
      revision: value.revision,
      updatedAt: value.updatedAt
   };
}

export function zeroizeKey(key: Buffer): void {
   key.fill(0);
}

function additionalData(roomId: string, revision: number, updatedAt: number): Buffer {
   return Buffer.from([
      "local-file-transfer-shared-text-v1",
      roomId,
      String(revision),
      String(updatedAt)
   ].join("\u0000"), "utf8");
}

function assertKey(key: Buffer): void {
   if (key.byteLength !== keyLength) {
      throw new RangeError("Shared text key must be 256 bits");
   }
}
