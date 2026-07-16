export const eagerUploadMaterializeLimit = 64 * 1024 * 1024;

export interface PreparedUploadSource {
   size: number;
   materialized: boolean;
   readChunk: (start: number, end: number) => Promise<Blob>;
}

type BlobWithBytes = Blob & { bytes?: Blob["bytes"] };

export async function prepareUploadSource(
   source: Blob,
   eagerLimit = eagerUploadMaterializeLimit
): Promise<PreparedUploadSource> {
   if (!Number.isSafeInteger(eagerLimit) || eagerLimit < 0) {
      throw new RangeError("Upload materialize limit must be a non-negative integer");
   }

   if (source.size <= eagerLimit) {
      const bytes = await readBlobBytes(source);

      assertExpectedSize(bytes, source.size);
      return {
         size: source.size,
         materialized: true,
         readChunk: async (start, end) => inMemoryChunk(bytes, source.size, start, end)
      };
   }

   return {
      size: source.size,
      materialized: false,
      readChunk: async (start, end) => {
         assertChunkRange(source.size, start, end);
         const bytes = await readBlobBytes(source.slice(start, end));

         assertExpectedSize(bytes, end - start);
         return bytesToBlob(bytes);
      }
   };
}

async function inMemoryChunk(bytes: Uint8Array, size: number, start: number, end: number): Promise<Blob> {
   assertChunkRange(size, start, end);
   return bytesToBlob(bytes.slice(start, end));
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
   const withBytes = blob as BlobWithBytes;

   if (typeof withBytes.bytes === "function") {
      return withBytes.bytes();
   }

   return new Uint8Array(await blob.arrayBuffer());
}

function bytesToBlob(bytes: Uint8Array): Blob {
   const copy = new Uint8Array(bytes.byteLength);

   copy.set(bytes);
   return new Blob([copy.buffer], { type: "application/octet-stream" });
}

function assertExpectedSize(bytes: Uint8Array, expected: number): void {
   if (bytes.byteLength !== expected) {
      throw new Error(`Expected ${expected} source bytes but read ${bytes.byteLength}`);
   }
}

function assertChunkRange(size: number, start: number, end: number): void {
   if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end > size
   ) {
      throw new RangeError("Invalid upload source range");
   }
}