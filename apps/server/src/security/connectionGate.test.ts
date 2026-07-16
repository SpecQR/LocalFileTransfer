import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionGate } from "./connectionGate.ts";

test("enforces per-key and global connection limits with idempotent release", () => {
   const gate = new ConnectionGate(3, 2);
   const first = gate.acquire("one");
   const second = gate.acquire("one");
   const third = gate.acquire("two");

   assert.ok(first);
   assert.ok(second);
   assert.ok(third);
   assert.equal(gate.acquire("one"), undefined);
   assert.equal(gate.acquire("three"), undefined);
   assert.deepEqual(gate.diagnostics(), { total: 3, keys: 2 });

   first();
   first();
   assert.ok(gate.acquire("three"));
});
