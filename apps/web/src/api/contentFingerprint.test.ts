import assert from "node:assert/strict";
import test from "node:test";
import {
   checkpointChecksum,
   checkpointIdempotencyKey,
   computeUploadFingerprint
} from "./contentFingerprint.ts";
import { prepareUploadSource } from "./uploadSource.ts";

test("content fingerprints are stable and include sampled file content", async () => {
   const metadata = { name: "photo.jpeg", size: 6, lastModified: 1234 };
   const first = await computeUploadFingerprint(metadata, await prepareUploadSource(new Blob(["abcdef"])));
   const repeated = await computeUploadFingerprint(metadata, await prepareUploadSource(new Blob(["abcdef"])));
   const changed = await computeUploadFingerprint(metadata, await prepareUploadSource(new Blob(["abcdeg"])));

   assert.equal(first, repeated);
   assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
   assert.notEqual(first, changed);
});

test("checkpoint checksums and idempotency keys have protocol encodings", async () => {
   const checksum = await checkpointChecksum(new Blob(["checkpoint"]));
   const key = checkpointIdempotencyKey("room_12345678", "item_12345678", 0, 10, checksum);

   assert.match(checksum, /^[A-Za-z0-9+/]{43}=$/u);
   assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
   assert.equal(key, checkpointIdempotencyKey("room_12345678", "item_12345678", 0, 10, checksum));
});
