import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUploadResumeStore } from "./resumeStore.ts";

test("resume records are copied, updated, and deleted without secrets", async () => {
   const store = new MemoryUploadResumeStore();
   const record = {
      roomId: "room_12345678",
      fingerprint: "f".repeat(43),
      itemId: "item_12345678",
      offset: 1024,
      updatedAt: 1000
   };

   await store.put(record);
   const loaded = await store.get(record.roomId, record.fingerprint);

   assert.deepEqual(loaded, record);
   assert.equal("token" in (loaded ?? {}), false);
   if (loaded) {
      loaded.offset = 2048;
   }
   assert.equal((await store.get(record.roomId, record.fingerprint))?.offset, 1024);

   await store.delete(record.roomId, record.fingerprint);
   assert.equal(await store.get(record.roomId, record.fingerprint), undefined);
});

test("resume storage remains bounded to the 64 newest records", async () => {
   const store = new MemoryUploadResumeStore();

   for (let index = 0; index < 65; index += 1) {
      await store.put({
         roomId: "room_12345678",
         fingerprint: index.toString().padStart(43, "0"),
         itemId: "item_" + index.toString().padStart(8, "0"),
         offset: index,
         updatedAt: 10_000 + index
      });
   }

   assert.equal(await store.get("room_12345678", "0".repeat(43)), undefined);
   assert.equal((await store.get("room_12345678", "64".padStart(43, "0")))?.offset, 64);
});
