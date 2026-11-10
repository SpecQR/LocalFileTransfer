import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { RoomDiagnosticSnapshot } from "../../../../packages/protocol/src/index.ts";
import type { ServiceAction, ServiceRoomResult, ServiceRuntime } from "../../../desktop/src/serviceProtocol.ts";
import { createHostController } from "./controller.ts";
import type { HostSnapshot } from "./protocol.ts";

const initialization = {
   storageDir: resolve("test-storage"),
   receiveDir: resolve("test-receive"),
   staticRoot: resolve("test-web"),
   version: "2.0.1-preview"
};

function fakeService() {
   const calls: { action: ServiceAction; payload: unknown }[] = [];
   let closed = 0;
   let nextRoom = 0;
   let failEnsure = false;
   let runtime: ServiceRuntime = {
      port: 8787,
      localUrl: "http://127.0.0.1:8787",
      lanUrls: ["http://192.168.1.20:8787"],
      receiveDir: initialization.receiveDir,
      logDir: resolve("test-storage/logs")
   };
   const diagnostics = { activeWrites: 0, activeReads: 0, transferringItems: 0 } as RoomDiagnosticSnapshot;
   let room: ServiceRoomResult = {
      roomId: "room_000000000000",
      token: "a".repeat(43),
      expiresAt: 100
   };
   let beforeInitialize: () => Promise<void> = async () => undefined;

   return {
      calls,
      diagnostics,
      get closed() { return closed; },
      setBeforeInitialize(callback: () => Promise<void>) { beforeInitialize = callback; },
      setRuntime(value: ServiceRuntime) { runtime = value; },
      setFailEnsure() { failEnsure = true; },
      service: {
         async execute<T>(action: ServiceAction, payload?: unknown): Promise<T> {
            calls.push({ action, payload });
            let result: unknown;

            switch (action) {
               case "initialize":
                  await beforeInitialize();
                  result = runtime;
                  break;
               case "network-status":
                  result = runtime;
                  break;
               case "create-room":
                  result = room;
                  break;
               case "ensure-room":
                  if (failEnsure) {
                     throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
                  }

                  room = { ...room, expiresAt: 500 };
                  result = room;
                  break;
               case "reset-room":
                  nextRoom += 1;
                  room = { ...room, roomId: `room_00000000000${nextRoom}`, expiresAt: 500 };
                  result = room;
                  break;
               case "diagnostics":
                  result = diagnostics;
                  break;
               case "completed-path":
                  result = resolve("test-receive/completed.txt");
                  break;
               default:
                  result = undefined;
            }

            return result as T;
         },
         async close() { closed += 1; }
      }
   };
}

test("controller serializes initialization and resets while retaining the default transfer limits", async () => {
   const fake = fakeService();
   const controller = createHostController({ service: fake.service, now: () => 1 });
   const [first, second] = await Promise.all([
      controller.execute("initialize", initialization),
      controller.execute("initialize", initialization)
   ]) as HostSnapshot[];

   assert.equal(fake.calls.filter((call) => call.action === "initialize").length, 1);
   assert.equal(first!.credential.roomId, second!.credential.roomId);
   assert.equal(first!.bootstrap.joinUrl, `http://192.168.1.20:8787/room/${first!.credential.roomId}#t=${first!.credential.token}`);
   assert.equal("token" in first!.bootstrap, false);
   const configuration = fake.calls.find((call) => call.action === "initialize")!.payload as Record<string, unknown>;

   assert.equal(configuration.ttlMs, 15 * 60 * 1000);
   assert.equal(configuration.hardTtlMs, 60 * 60 * 1000);
   assert.deepEqual(configuration.limits, {
      maxFiles: 100, maxFileSize: 4 * 1024 ** 3, maxRoomSize: 20 * 1024 ** 3, uploadChunkSize: 4 * 1024 ** 2
   });
   const resets = await Promise.all([controller.execute("reset-room"), controller.execute("reset-room")]) as HostSnapshot[];

   assert.notEqual(resets[0]!.credential.roomId, resets[1]!.credential.roomId);
   const resetCalls = fake.calls.filter((call) => call.action === "reset-room");

   assert.equal((resetCalls[1]!.payload as { roomId: string }).roomId, resets[0]!.credential.roomId);
   await controller.close();
   await controller.close();
   assert.equal(fake.closed, 1);
   await assert.rejects(controller.execute("bootstrap"), /service-closing/u);
});

test("controller refreshes expired room and network origin without hiding an authentication failure", async () => {
   const fake = fakeService();
   let now = 1;
   const controller = createHostController({ service: fake.service, now: () => now });

   await controller.execute("initialize", initialization);
   await controller.execute("bootstrap");
   assert.equal(fake.calls.filter((call) => call.action === "ensure-room").length, 0);
   now = 100;
   fake.diagnostics.activeReads = 1;
   const refreshed = await controller.execute("bootstrap") as HostSnapshot;

   assert.equal(refreshed.bootstrap.expiresAt, 500);
   assert.equal(refreshed.transferActive, true);
   fake.setRuntime({ ...refreshed.runtime, lanUrls: ["http://192.168.1.21:8787"] });
   const migrated = await controller.execute("bootstrap") as HostSnapshot;

   assert.ok(migrated.bootstrap.joinUrl.startsWith("http://192.168.1.21:8787/room/"));
   fake.setFailEnsure();
   now = 500;
   await assert.rejects(controller.execute("bootstrap"), { statusCode: 401 });
   assert.equal(fake.calls.filter((call) => call.action === "create-room").length, 1);
   await controller.close();

   const savedFailure = fakeService();

   savedFailure.setFailEnsure();
   const savedController = createHostController({ service: savedFailure.service });

   await assert.rejects(savedController.execute("initialize", { ...initialization, credential: refreshed.credential }), { statusCode: 401 });
   assert.equal(savedFailure.calls.some((call) => call.action === "create-room"), false);
   await savedController.close();
});

test("completed paths are restricted to the current room and invalid input cannot start the service", async () => {
   const fake = fakeService();
   const controller = createHostController({ service: fake.service, now: () => 1 });

   await assert.rejects(controller.execute("bootstrap"), /not-initialized/u);
   await assert.rejects(controller.execute("initialize", { ...initialization, storageDir: "relative-path" }), /invalid-payload/u);
   assert.equal(fake.calls.length, 0);
   const initialized = await controller.execute("initialize", initialization) as HostSnapshot;

   await assert.rejects(controller.execute("completed-path", { roomId: "other_0000000000", itemId: "item_00000000000" }), /inactive-room/u);
   assert.equal(fake.calls.some((call) => call.action === "completed-path"), false);
   await controller.execute("completed-path", { roomId: initialized.credential.roomId, itemId: "item_00000000000" });
   assert.equal(fake.calls.filter((call) => call.action === "completed-path").length, 1);
   await controller.close();
});

test("close waits for in-flight initialization and rejects queued lifecycle changes", async () => {
   const fake = fakeService();
   let release!: () => void;
   let started!: () => void;
   const initializeStarted = new Promise<void>((resolve) => { started = resolve; });
   const initializeGate = new Promise<void>((resolve) => { release = resolve; });

   fake.setBeforeInitialize(async () => {
      started();
      await initializeGate;
   });
   const controller = createHostController({ service: fake.service });
   const initialized = controller.execute("initialize", initialization);

   await initializeStarted;
   const queued = controller.execute("reset-room");
   const rejected = assert.rejects(queued, /service-closing/u);
   const closed = controller.close();

   assert.equal(fake.closed, 0);
   release();
   await initialized;
   await rejected;
   await closed;
   assert.equal(fake.closed, 1);
   assert.equal(fake.calls.some((call) => call.action === "reset-room"), false);
});
