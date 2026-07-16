import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
   mkdtemp,
   readFile,
   rm,
   stat,
   truncate
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
   checkpointIdempotencyKey,
   RoomStore,
   type UploadCheckpointFaultInjector,
   type UploadCheckpointFaultPhase
} from "./roomStore.ts";
import {
   SqliteRoomRepository,
   type UploadCommitFaultPhase
} from "./sqliteRoomRepository.ts";

const allCheckpointPhases: UploadCheckpointFaultPhase[] = [
   "before-write",
   "after-write-before-fsync",
   "after-fsync-before-commit",
   "after-commit-before-ack"
];

test("visits upload checkpoint durability boundaries in order", async (t) => {
   const seen: UploadCheckpointFaultPhase[] = [];
   const harness = await createHarness(t, {
      checkpointFault: (phase) => {
         seen.push(phase);
      }
   });
   const item = await harness.rooms.registerUpload(
      harness.room,
      uploadMetadata("ordered.bin", 2, "O")
   );
   const checkpoint = checkpointFor(harness.room.roomId, item.itemId, 0, "x", 2);

   await harness.rooms.appendCheckpoint(
      harness.room,
      item.itemId,
      checkpoint.range,
      checkpoint.options,
      checkpoint.body
   );

   assert.deepEqual(seen, allCheckpointPhases);
});

for (const faultPhase of [
   "after-write-before-fsync",
   "after-fsync-before-commit"
] as const) {
   test(`startup truncates bytes left by a crash at ${faultPhase}`, async (t) => {
      let armed = true;
      const harness = await createHarness(t, {
         checkpointFault: (phase) => {
            if (armed && phase === faultPhase) {
               armed = false;
               throw new Error(`fault:${phase}`);
            }
         }
      });
      const item = await harness.rooms.registerUpload(
         harness.room,
         uploadMetadata(`${faultPhase}.bin`, 2, faultPhase)
      );
      const checkpoint = checkpointFor(harness.room.roomId, item.itemId, 0, "x", 2);

      await assert.rejects(
         harness.rooms.appendCheckpoint(
            harness.room,
            item.itemId,
            checkpoint.range,
            checkpoint.options,
            checkpoint.body
         ),
         new RegExp(`fault:${faultPhase}`, "u")
      );

      const partialPath = harness.rooms.item(harness.room.roomId, item.itemId).partialPath;

      assert.ok(partialPath);
      assert.equal((await stat(partialPath)).size, 1);
      assert.equal(harness.rooms.item(harness.room.roomId, item.itemId).confirmedBytes, 0);

      const restarted = await harness.restart();
      const resumedRoom = restarted.rooms.requireAuthorized(
         harness.room.roomId,
         { token: harness.token }
      );
      const diagnostics = await restarted.rooms.diagnosticState();

      assert.equal((await stat(partialPath)).size, 0);
      assert.equal(diagnostics.recovery.startupTruncations, 1);
      assert.equal(diagnostics.recovery.startupTruncatedBytes, 1);

      const resumed = await restarted.rooms.appendCheckpoint(
         resumedRoom,
         item.itemId,
         checkpoint.range,
         checkpoint.options,
         checkpoint.body
      );

      assert.equal(resumed.confirmedBytes, 1);
      assert.equal((await readFile(partialPath)).toString("utf8"), "x");
   });
}

for (const faultPhase of [
   "after-item-update",
   "before-commit"
] as const satisfies UploadCommitFaultPhase[]) {
   test(`SQLite rollback and file rollback keep the checkpoint retryable at ${faultPhase}`, async (t) => {
      let armed = true;
      const harness = await createHarness(t, {
         repositoryFault: (phase) => {
            if (armed && phase === faultPhase) {
               armed = false;
               throw new Error(`sqlite-fault:${phase}`);
            }
         }
      });
      const item = await harness.rooms.registerUpload(
         harness.room,
         uploadMetadata(`${faultPhase}.bin`, 2, faultPhase)
      );
      const checkpoint = checkpointFor(harness.room.roomId, item.itemId, 0, "x", 2);

      await assert.rejects(
         harness.rooms.appendCheckpoint(
            harness.room,
            item.itemId,
            checkpoint.range,
            checkpoint.options,
            checkpoint.body
         ),
         new RegExp(`sqlite-fault:${faultPhase}`, "u")
      );

      const stored = harness.rooms.item(harness.room.roomId, item.itemId);

      assert.ok(stored.partialPath);
      assert.equal((await stat(stored.partialPath)).size, 0);
      assert.equal(stored.confirmedBytes, 0);
      assert.equal(
         harness.repository.getUploadCommit(item.itemId, checkpoint.options.idempotencyKey),
         undefined
      );
      assert.equal(
         (await harness.rooms.diagnosticState()).recovery.checkpointRollbacks,
         1
      );

      const retried = await harness.rooms.appendCheckpoint(
         harness.room,
         item.itemId,
         checkpoint.range,
         checkpoint.options,
         checkpoint.body
      );

      assert.equal(retried.confirmedBytes, 1);
      assert.ok(
         harness.repository.getUploadCommit(item.itemId, checkpoint.options.idempotencyKey)
      );
   });
}

test("idempotent replay completes a final checkpoint whose ACK was lost", async (t) => {
   let armed = true;
   const harness = await createHarness(t, {
      checkpointFault: (phase) => {
         if (armed && phase === "after-commit-before-ack") {
            armed = false;
            throw new Error("fault:ack-lost");
         }
      }
   });
   const item = await harness.rooms.registerUpload(
      harness.room,
      uploadMetadata("ack-lost.bin", 1, "A")
   );
   const checkpoint = checkpointFor(harness.room.roomId, item.itemId, 0, "x", 1);

   await assert.rejects(
      harness.rooms.appendCheckpoint(
         harness.room,
         item.itemId,
         checkpoint.range,
         checkpoint.options,
         checkpoint.body
      ),
      /fault:ack-lost/u
   );

   const committed = harness.rooms.item(harness.room.roomId, item.itemId);

   assert.equal(committed.confirmedBytes, 1);
   assert.equal(committed.state, "transferring");
   assert.ok(committed.partialPath);
   assert.equal((await stat(committed.partialPath)).size, 1);

   const replayed = await harness.rooms.appendCheckpoint(
      harness.room,
      item.itemId,
      checkpoint.range,
      checkpoint.options,
      checkpoint.body
   );
   const completedPath = harness.rooms.getCompletedPath(harness.room.roomId, item.itemId);
   const diagnostics = await harness.rooms.diagnosticState();

   assert.equal(replayed.state, "ready");
   assert.ok(completedPath);
   assert.equal((await readFile(completedPath)).toString("utf8"), "x");
   assert.equal(diagnostics.recovery.idempotentReplays, 1);
   assert.equal(diagnostics.recovery.recoveredCompletions, 1);
});

test("startup rewinds a database offset when the partial file is shorter", async (t) => {
   const harness = await createHarness(t);
   const item = await harness.rooms.registerUpload(
      harness.room,
      uploadMetadata("rewind.bin", 2, "W")
   );
   const checkpoint = checkpointFor(harness.room.roomId, item.itemId, 0, "x", 2);

   await harness.rooms.appendCheckpoint(
      harness.room,
      item.itemId,
      checkpoint.range,
      checkpoint.options,
      checkpoint.body
   );

   const partialPath = harness.rooms.item(harness.room.roomId, item.itemId).partialPath;

   assert.ok(partialPath);
   harness.rooms.close();
   await truncate(partialPath, 0);

   const restarted = await harness.restart();
   const stored = restarted.rooms.item(harness.room.roomId, item.itemId);
   const diagnostics = await restarted.rooms.diagnosticState();

   assert.equal(stored.confirmedBytes, 0);
   assert.equal(diagnostics.recovery.startupRewinds, 1);
   assert.equal(diagnostics.recovery.startupRewoundBytes, 1);
   assert.equal(
      restarted.repository.getUploadCommit(item.itemId, checkpoint.options.idempotencyKey),
      undefined
   );
});

interface HarnessOptions {
   checkpointFault?: UploadCheckpointFaultInjector;
   repositoryFault?: (
      phase: UploadCommitFaultPhase,
      context: { itemId: string; endOffset: number }
   ) => void;
}

async function createHarness(t: TestContext, options: HarnessOptions = {}) {
   const root = await mkdtemp(join(tmpdir(), "lft-upload-recovery-"));
   const stores: RoomStore[] = [];
   const create = async (nextOptions: HarnessOptions = {}) => {
      const repository = new SqliteRoomRepository(join(root, "rooms.sqlite"), {
         ...(nextOptions.repositoryFault
            ? { uploadCommitFault: nextOptions.repositoryFault }
            : {})
      });
      const rooms = new RoomStore({
         repository,
         rootDir: join(root, "state"),
         receiveDir: join(root, "received"),
         ttlMs: 60_000,
         hardTtlMs: 120_000,
         limits: {
            maxFiles: 100,
            maxFileSize: 1024 * 1024,
            maxRoomSize: 10 * 1024 * 1024,
            uploadChunkSize: 1024
         },
         availableBytes: async () => Number.MAX_SAFE_INTEGER,
         ...(nextOptions.checkpointFault
            ? { uploadCheckpointFault: nextOptions.checkpointFault }
            : {})
      });

      await rooms.initialize();
      stores.push(rooms);
      return { repository, rooms };
   };
   const initial = await create(options);
   const created = await initial.rooms.createRoom("http://127.0.0.1:8787");

   t.after(async () => {
      for (const store of stores) {
         store.close();
      }

      await rm(root, { recursive: true, force: true });
   });

   return {
      ...initial,
      room: created.room,
      token: created.token,
      async restart() {
         initial.rooms.close();
         return create();
      }
   };
}

function checkpointFor(
   roomId: string,
   itemId: string,
   start: number,
   value: string,
   total: number
) {
   const body = Buffer.from(value, "utf8");
   const checksum = createHash("sha256").update(body).digest("base64");

   return {
      body,
      range: {
         start,
         end: start + body.length - 1,
         total,
         length: body.length
      },
      options: {
         checksum,
         idempotencyKey: checkpointIdempotencyKey(
            roomId,
            itemId,
            start,
            body.length,
            checksum
         )
      }
   };
}

function uploadMetadata(name: string, size: number, suffix: string) {
   return {
      name,
      type: "application/octet-stream",
      size,
      lastModified: 1,
      fingerprint: createHash("sha256").update(`fingerprint:${suffix}`).digest("base64url")
   };
}
