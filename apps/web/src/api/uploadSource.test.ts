import assert from "node:assert/strict";
import test from "node:test";
import {
   eagerUploadMaterializeLimit,
   prepareUploadSource
} from "./uploadSource.ts";

test("eagerly materializes camera-sized files before network upload", async () => {
   let readable = true;
   let readCount = 0;
   const original = {
      size: 6,
      bytes: async () => {
         readCount += 1;

         if (!readable) {
            throw new Error("The original iPhone file reference expired");
         }

         return new Uint8Array([1, 2, 3, 4, 5, 6]);
      }
   } as unknown as Blob;
   const prepared = await prepareUploadSource(original);

   readable = false;
   const first = new Uint8Array(await (await prepared.readChunk(0, 3)).arrayBuffer());
   const second = new Uint8Array(await (await prepared.readChunk(3, 6)).arrayBuffer());

   assert.equal(prepared.materialized, true);
   assert.equal(readCount, 1);
   assert.deepEqual([...first], [1, 2, 3]);
   assert.deepEqual([...second], [4, 5, 6]);
});

test("materializes each large-file slice before handing it to XHR", async () => {
   const original = new Blob([new Uint8Array([10, 11, 12, 13, 14, 15])]);
   const prepared = await prepareUploadSource(original, 0);
   const chunk = new Uint8Array(await (await prepared.readChunk(2, 5)).arrayBuffer());

   assert.equal(prepared.materialized, false);
   assert.deepEqual([...chunk], [12, 13, 14]);
});

test("uses a 64 MiB eager materialization ceiling", () => {
   assert.equal(eagerUploadMaterializeLimit, 64 * 1024 * 1024);
});