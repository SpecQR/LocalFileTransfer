import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RotatingJsonLog, sanitizeLogValue } from "./rotatingLog.ts";

test("redacts credentials, URLs, local paths, identifiers, and file names", () => {
   const sanitized = sanitizeLogValue({
      authorization: "Bearer capability",
      roomId: "room-secret",
      fileName: "private.jpg",
      content: "private shared note",
      draft: "unshared draft",
      error: "failed at C:\\Users\\person\\private.jpg",
      message: "open http://192.168.1.2/room#t=secret"
   });

   assert.deepEqual(sanitized, {
      authorization: "<redacted>",
      roomId: "<redacted>",
      fileName: "<redacted>",
      content: "<redacted>",
      draft: "<redacted>",
      error: "failed at <redacted-path>",
      message: "open http://192.168.1.2/room#<redacted>"
   });
});

test("rotates bounded JSONL files and keeps valid structured records", async (t) => {
   const root = await mkdtemp(join(tmpdir(), "lft-log-"));
   const log = new RotatingJsonLog(root, {
      maxBytes: 220,
      maxFiles: 3,
      now: () => new Date("2026-07-15T00:00:00.000Z")
   });

   t.after(async () => {
      await log.close();
      await rm(root, { recursive: true, force: true });
   });

   await log.initialize();

   for (let index = 0; index < 12; index += 1) {
      await log.write("info", "test-entry", { index, message: "x".repeat(40) });
   }

   const files = (await readdir(root)).sort();

   assert.deepEqual(files, ["service.jsonl", "service.jsonl.1", "service.jsonl.2"]);

   for (const file of files) {
      const lines = (await readFile(join(root, file), "utf8")).trim().split("\n");

      for (const line of lines) {
         const record = JSON.parse(line) as { event: string; time: string };

         assert.equal(record.event, "test-entry");
         assert.equal(record.time, "2026-07-15T00:00:00.000Z");
      }
   }
});
