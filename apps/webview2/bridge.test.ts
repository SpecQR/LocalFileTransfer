import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const source = transformSync(await readFile(new URL("./bridge.ts", import.meta.url), "utf8"), {
   loader: "ts",
   format: "iife",
   target: "es2022"
}).code;
const bootstrap = { roomId: "preview-room", joinUrl: "http://192.0.2.1:8787/r/preview-room#t=test-capability", expiresAt: 42 };

interface Bridge {
   roomBootstrap(): Promise<typeof bootstrap>;
   resetRoom(): Promise<typeof bootstrap>;
   addFiles(files: unknown[]): Promise<never>;
}

function createWindow(options: {
   url?: string;
   subframe?: boolean;
   authorize?: () => boolean;
} = {}): {
   bridge: Bridge | undefined;
   requests: { url: string; options: RequestInit }[];
   commands: string[];
} {
   const requests: { url: string; options: RequestInit }[] = [];
   const commands: string[] = [];
   const window = {
      location: new URL(options.url ?? "http://127.0.0.1:8787/app"),
      top: null as unknown,
      __TAURI__: {
         core: {
            async invoke(command: string): Promise<typeof bootstrap> {
               commands.push(command);
               return bootstrap;
            }
         }
      }
   } as { localFileTransfer?: Bridge } & Record<string, unknown>;
   window.top = options.subframe ? {} : window;
   runInNewContext(source, {
      window,
      URL,
      URLSearchParams,
      fetch: async (url: string, init: RequestInit): Promise<{ ok: boolean }> => {
         requests.push({ url, options: init });
         return { ok: options.authorize?.() ?? true };
      }
   });
   return { bridge: window.localFileTransfer, requests, commands };
}

test("preview bridge is absent from LAN pages, room pages and child frames", () => {
   for (const options of [
      { url: "http://192.0.2.1:8787/app" },
      { url: "http://127.0.0.1:8787/r/preview-room" },
      { url: "https://example.com/app" },
      { subframe: true }
   ]) {
      assert.equal(createWindow(options).bridge, undefined);
   }
});

test("concurrent bootstrap uses one cookie exchange and never sends the capability in a URL", async () => {
   const { bridge, requests, commands } = createWindow();
   assert.ok(bridge);
   const [first, second] = await Promise.all([bridge.roomBootstrap(), bridge.roomBootstrap()]);
   assert.equal(first.roomId, bootstrap.roomId);
   assert.equal(second.roomId, bootstrap.roomId);
   assert.equal(commands.length, 1);
   assert.equal(requests.length, 1);
   assert.equal(requests[0]?.url, "/api/v2/rooms/preview-room/authorize");
   assert.equal(requests[0]?.options.credentials, "same-origin");
   assert.deepEqual(JSON.parse(requests[0]?.options.body as string), { token: "test-capability" });
   await bridge.roomBootstrap();
   assert.equal(requests.length, 1);
});

test("failed authorization can recover on the next bootstrap", async () => {
   let allowed = false;
   const { bridge, requests } = createWindow({ authorize: () => allowed });
   assert.ok(bridge);
   await assert.rejects(bridge.roomBootstrap(), /could not be authorized/u);
   allowed = true;
   assert.equal((await bridge.roomBootstrap()).roomId, bootstrap.roomId);
   assert.equal(requests.length, 2);
});

test("renderer File objects cannot become privileged native source paths", async () => {
   const { bridge, commands } = createWindow();
   assert.ok(bridge);
   await assert.rejects(bridge.addFiles([{ path: "untrusted-path" }]), /native file picker/u);
   assert.deepEqual(commands, []);
});
