import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceHashPool } from "./sourceHashPool.ts";

test("hashes source files in a bounded worker and deduplicates cached work", async () => {
   const root = await mkdtemp(join(tmpdir(), "lft-source-hash-"));
   const path = join(root, "source.bin");
   const content = Buffer.alloc((3 * 1024 * 1024) + 19, 0x5a);
   const pool = new SourceHashPool({ maxWorkers: 1, maxCacheEntries: 2 });

   try {
      await writeFile(path, content);
      const info = await stat(path);
      const modifiedMs = Math.trunc(info.mtimeMs);
      const [first, second] = await Promise.all([
         pool.hash(path, info.size, modifiedMs),
         pool.hash(path, info.size, modifiedMs)
      ]);

      assert.equal(first, createHash("sha256").update(content).digest("hex"));
      assert.equal(second, first);
      assert.equal(pool.diagnostics().jobsStarted, 1);
      assert.equal(await pool.hash(path, info.size, modifiedMs), first);
      assert.equal(pool.diagnostics().jobsStarted, 1);
   } finally {
      await pool.close();
      await rm(root, { recursive: true, force: true });
   }
});

test("rejects a source whose expected metadata changed", async () => {
   const root = await mkdtemp(join(tmpdir(), "lft-source-change-"));
   const path = join(root, "source.bin");
   const pool = new SourceHashPool();

   try {
      await writeFile(path, "changed");
      const info = await stat(path);

      await assert.rejects(pool.hash(path, info.size + 1, Math.trunc(info.mtimeMs)), /changed/u);
   } finally {
      await pool.close();
      await rm(root, { recursive: true, force: true });
   }
});
