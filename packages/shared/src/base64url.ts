const base64UrlAlphabet = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
   let binary = "";

   for (const byte of bytes) {
      binary += String.fromCharCode(byte);
   }

   if (typeof btoa !== "function") {
      throw new Error("btoa is required");
   }

   const base64 = btoa(binary);

   return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
   if (!base64UrlAlphabet.test(value)) {
      throw new Error("Invalid base64url string");
   }

   const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
   const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
   if (typeof atob !== "function") {
      throw new Error("atob is required");
   }

   const binary = atob(base64);
   const bytes = new Uint8Array(binary.length);

   for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
   }

   return bytes;
}

export function stringToBase64Url(value: string): string {
   return bytesToBase64Url(new TextEncoder().encode(value));
}

export function base64UrlToString(value: string): string {
   return new TextDecoder().decode(base64UrlToBytes(value));
}

export function randomBase64Url(byteLength: number, cryptoSource = globalThis.crypto): string {
   if (!cryptoSource?.getRandomValues) {
      throw new Error("crypto.getRandomValues is required");
   }

   const bytes = new Uint8Array(byteLength);
   cryptoSource.getRandomValues(bytes);

   return bytesToBase64Url(bytes);
}
