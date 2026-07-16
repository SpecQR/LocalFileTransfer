import assert from "node:assert/strict";
import test from "node:test";
import {
   nextChunkRange,
   parseByteRange,
   parseContentRange,
   uploadChunkSize
} from "./transfer.ts";

test("parses closed, open, and suffix download ranges", () => {
   assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5, length: 4 });
   assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9, length: 3 });
   assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9, length: 3 });
});

test("rejects invalid and unsatisfiable download ranges", () => {
   assert.throws(() => parseByteRange("bytes=10-20", 10), RangeError);
   assert.throws(() => parseByteRange("bytes=1-2,4-5", 10), RangeError);
   assert.throws(() => parseByteRange("items=1-2", 10), RangeError);
});

test("parses upload Content-Range", () => {
   assert.deepEqual(parseContentRange("bytes 0-3/10"), {
      start: 0,
      end: 3,
      total: 10,
      length: 4
   });
   assert.throws(() => parseContentRange("bytes 4-3/10"), RangeError);
   assert.throws(() => parseContentRange("bytes 0-10/10"), RangeError);
});

test("plans bounded upload chunks", () => {
   assert.deepEqual(nextChunkRange(uploadChunkSize + 7, 0), {
      start: 0,
      end: uploadChunkSize - 1,
      total: uploadChunkSize + 7,
      length: uploadChunkSize
   });
   assert.deepEqual(nextChunkRange(uploadChunkSize + 7, uploadChunkSize), {
      start: uploadChunkSize,
      end: uploadChunkSize + 6,
      total: uploadChunkSize + 7,
      length: 7
   });
   assert.equal(nextChunkRange(10, 10), undefined);
});