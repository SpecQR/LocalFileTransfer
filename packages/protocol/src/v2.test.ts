import assert from "node:assert/strict";
import test from "node:test";
import {
   durableUploadProtocol,
   parseAuthorizeRoomRequest,
   parseDesktopSourceFiles,
   parseRegisterRoomUploadRequest,
   parseRoomFileMetadata,
   parseRoomId,
   parseSha256Base64,
   parseUpdateRoomSharedTextRequest,
   parseUploadFingerprint,
   sharedTextMaxBytes,
   utf8ByteLength
} from "./v2.ts";

test("v2 room validators accept normalized metadata", () => {
   assert.deepEqual(parseRoomFileMetadata({
      name: "photo.jpg",
      size: 15,
      type: "image/jpeg",
      lastModified: 123
   }), {
      name: "photo.jpg",
      size: 15,
      type: "image/jpeg",
      lastModified: 123
   });
   assert.deepEqual(parseAuthorizeRoomRequest({ token: "a".repeat(43) }), {
      token: "a".repeat(43)
   });
});

test("v2 room validators reject malformed boundaries", () => {
   assert.throws(() => parseRoomId("../room"), TypeError);
   assert.throws(() => parseRoomFileMetadata({ name: "", size: 1 }), TypeError);
   assert.throws(() => parseRoomFileMetadata({ name: "x", size: -1 }), TypeError);
   assert.throws(() => parseDesktopSourceFiles([]), TypeError);
});

test("desktop source validation retains paths only in the IPC contract", () => {
   assert.deepEqual(parseDesktopSourceFiles([{
      path: "C:\\Users\\test\\photo.jpg",
      name: "photo.jpg",
      type: "image/jpeg",
      size: 20,
      lastModified: 100
   }]), [{
      path: "C:\\Users\\test\\photo.jpg",
      name: "photo.jpg",
      type: "image/jpeg",
      size: 20,
      lastModified: 100
   }]);
});

test("durable upload validators accept fixed SHA-256 encodings", () => {
   const fingerprint = "A".repeat(43);
   const checksum = `${"B".repeat(43)}=`;

   assert.equal(durableUploadProtocol, "lft-resume-v1");
   assert.equal(parseUploadFingerprint(fingerprint), fingerprint);
   assert.equal(parseSha256Base64(checksum), checksum);
   assert.deepEqual(parseRegisterRoomUploadRequest({
      name: "camera.jpg",
      type: "image/jpeg",
      size: 15,
      lastModified: 123,
      fingerprint
   }), {
      name: "camera.jpg",
      type: "image/jpeg",
      size: 15,
      lastModified: 123,
      fingerprint
   });
});

test("durable upload validators reject malformed digests", () => {
   assert.throws(() => parseUploadFingerprint("short"), /fingerprint/u);
   assert.throws(() => parseUploadFingerprint(`${"A".repeat(42)}+`), /fingerprint/u);
   assert.throws(() => parseSha256Base64("A".repeat(44)), /checksum/u);
});

test("shared text parser normalizes line endings and enforces UTF-8 bytes", () => {
   assert.deepEqual(parseUpdateRoomSharedTextRequest({
      content: "first\r\nsecond\rthird",
      expectedRevision: 4
   }), {
      content: "first\nsecond\nthird",
      expectedRevision: 4
   });
   assert.equal(utf8ByteLength("共有🙂"), 10);
   assert.equal(utf8ByteLength("a".repeat(sharedTextMaxBytes)), sharedTextMaxBytes);
   assert.throws(() => parseUpdateRoomSharedTextRequest({
      content: "あ".repeat(Math.floor(sharedTextMaxBytes / 3) + 1),
      expectedRevision: 0
   }), /64 KiB/u);
   assert.throws(() => parseUpdateRoomSharedTextRequest({
      content: "bad\u0000text",
      expectedRevision: 0
   }), /content/u);
   assert.throws(() => parseUpdateRoomSharedTextRequest({
      content: "ok",
      expectedRevision: -1
   }), /expectedRevision/u);
});