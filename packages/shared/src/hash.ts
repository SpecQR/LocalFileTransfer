import { bytesToBase64Url } from "./base64url.ts";
import { asUint8Array, toExactArrayBuffer, utf8Bytes, type BytesLike } from "./bytes.ts";

export async function sha256Bytes(value: BytesLike | string): Promise<Uint8Array> {
   if (!globalThis.crypto?.subtle) {
      throw new Error("crypto.subtle is required");
   }

   const bytes = typeof value === "string" ? utf8Bytes(value) : asUint8Array(value);
   const digest = await globalThis.crypto.subtle.digest("SHA-256", toExactArrayBuffer(bytes));

   return new Uint8Array(digest);
}

export async function sha256Base64Url(value: BytesLike | string): Promise<string> {
   return bytesToBase64Url(await sha256Bytes(value));
}
