export type BytesLike = Uint8Array | ArrayBuffer;

export function asUint8Array(value: BytesLike): Uint8Array {
   return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
   const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
   const output = new Uint8Array(totalLength);
   let offset = 0;

   for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
   }

   return output;
}

export function utf8Bytes(value: string): Uint8Array {
   return new TextEncoder().encode(value);
}

export function uint32Be(value: number): Uint8Array {
   if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("uint32 value out of range");
   }

   const bytes = new Uint8Array(4);
   new DataView(bytes.buffer).setUint32(0, value);
   return bytes;
}

export function uint64Be(value: number | bigint): Uint8Array {
   const bigintValue = typeof value === "bigint" ? value : BigInt(value);

   if (bigintValue < 0n || bigintValue > 0xffffffffffffffffn) {
      throw new Error("uint64 value out of range");
   }

   const bytes = new Uint8Array(8);
   new DataView(bytes.buffer).setBigUint64(0, bigintValue);
   return bytes;
}

export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
   return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function splitBytes(bytes: Uint8Array, fragmentSize: number): Uint8Array[] {
   if (!Number.isInteger(fragmentSize) || fragmentSize <= 0) {
      throw new Error("fragmentSize must be a positive integer");
   }

   const fragments: Uint8Array[] = [];

   for (let offset = 0; offset < bytes.byteLength; offset += fragmentSize) {
      fragments.push(bytes.slice(offset, offset + fragmentSize));
   }

   return fragments;
}
