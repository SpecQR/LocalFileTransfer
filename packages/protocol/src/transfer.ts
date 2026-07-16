export const uploadChunkSize = 4 * 1024 * 1024;

export interface ByteRange {
   start: number;
   end: number;
   length: number;
}

export interface ContentRange extends ByteRange {
   total: number;
}

export function parseByteRange(value: string, size: number): ByteRange {
   if (!Number.isSafeInteger(size) || size <= 0 || !value.startsWith("bytes=") || value.includes(",")) {
      throw new RangeError("Invalid byte range");
   }

   const match = /^bytes=(\d*)-(\d*)$/u.exec(value);

   if (!match || (!match[1] && !match[2])) {
      throw new RangeError("Invalid byte range");
   }

   let start: number;
   let end: number;

   if (!match[1]) {
      const suffixLength = Number(match[2]);

      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
         throw new RangeError("Invalid byte range");
      }

      start = Math.max(0, size - suffixLength);
      end = size - 1;
   } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
   }

   if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      throw new RangeError("Byte range is not satisfiable");
   }

   end = Math.min(end, size - 1);

   return {
      start,
      end,
      length: end - start + 1
   };
}

export function parseContentRange(value: string): ContentRange {
   const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);

   if (!match) {
      throw new RangeError("Invalid Content-Range");
   }

   const start = Number(match[1]);
   const end = Number(match[2]);
   const total = Number(match[3]);

   if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || !Number.isSafeInteger(total)
      || start < 0
      || end < start
      || total <= end
   ) {
      throw new RangeError("Invalid Content-Range");
   }

   return {
      start,
      end,
      total,
      length: end - start + 1
   };
}

export function nextChunkRange(total: number, offset: number, chunkSize = uploadChunkSize): ContentRange | undefined {
   if (
      !Number.isSafeInteger(total)
      || !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(chunkSize)
      || total < 0
      || offset < 0
      || offset > total
      || chunkSize <= 0
   ) {
      throw new RangeError("Invalid chunk bounds");
   }

   if (offset === total) {
      return undefined;
   }

   const end = Math.min(total, offset + chunkSize) - 1;

   return {
      start: offset,
      end,
      total,
      length: end - offset + 1
   };
}