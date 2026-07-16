import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
   availableFilePath,
   sanitizeFileName
} from "./fileNames.ts";

test("sanitizes traversal, reserved names, controls, and trailing dots", () => {
   assert.equal(sanitizeFileName("../report?.pdf"), ".._report_.pdf");
   assert.equal(sanitizeFileName("CON.txt"), "_CON.txt");
   assert.equal(sanitizeFileName("photo. "), "photo");
   assert.equal(sanitizeFileName("bad\u0000name.txt"), "bad_name.txt");
   assert.equal(sanitizeFileName("   "), "file");
});

test("allocates a non-destructive collision filename", async (t) => {
   const directory = await mkdtemp(join(tmpdir(), "lft-names-"));

   t.after(() => rm(directory, { recursive: true, force: true }));
   await mkdir(directory, { recursive: true });
   await writeFile(join(directory, "photo.jpg"), "existing");
   const reserved = new Set([join(directory, "photo (1).jpg")]);
   const selected = await availableFilePath(directory, "photo.jpg", reserved);

   assert.equal(basename(selected), "photo (2).jpg");
});