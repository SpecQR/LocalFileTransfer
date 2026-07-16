import { sha256 } from "@noble/hashes/sha2.js";
import type { PreparedUploadSource } from "./uploadSource.ts";

const fingerprintSampleSize = 64 * 1024;
const encoder = new TextEncoder();

export interface UploadFingerprintMetadata {
   name: string;
   size: number;
   lastModified: number;
}

export async function computeUploadFingerprint(
   metadata: UploadFingerprintMetadata,
   source: PreparedUploadSource
): Promise<string> {
   const firstLength = Math.min(source.size, fingerprintSampleSize);
   const lastStart = Math.max(firstLength, source.size - fingerprintSampleSize);
   const first = await blobBytes(await source.readChunk(0, firstLength));
   const last = lastStart < source.size
      ? await blobBytes(await source.readChunk(lastStart, source.size))
      : new Uint8Array();
   const digest = sha256(
      concatBytes(
         encoder.encode("lft-fingerprint-v1\u0000"),
         encoder.encode(metadata.name),
         new Uint8Array([0]),
         uint64(metadata.size),
         uint64(metadata.lastModified),
         first,
         last
      )
   );

   return bytesToBase64Url(digest);
}

export async function checkpointChecksum(payload: Blob): Promise<string> {
   return bytesToBase64(sha256(await blobBytes(payload)));
}

export function checkpointIdempotencyKey(
   roomId: string,
   itemId: string,
   offset: number,
   length: number,
   checksum: string
): string {
   return bytesToBase64Url(sha256(encoder.encode([
      "lft-checkpoint-v1",
      roomId,
      itemId,
      String(offset),
      String(length),
      checksum
   ].join("\n"))));
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
   const withBytes = blob as Blob & { bytes?: () => Promise<Uint8Array> };

   if (typeof withBytes.bytes === "function") {
      return withBytes.bytes();
   }

   return new Uint8Array(await blob.arrayBuffer());
}

function uint64(value: number): Uint8Array {
   if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Fingerprint metadata must be a non-negative safe integer");
   }

   const bytes = new Uint8Array(8);
   const view = new DataView(bytes.buffer);

   view.setBigUint64(0, BigInt(value), false);
   return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
   const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
   let offset = 0;

   for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
   }

   return result;
}

function bytesToBase64(bytes: Uint8Array): string {
   let binary = "";

   for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
   }

   return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
   return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
