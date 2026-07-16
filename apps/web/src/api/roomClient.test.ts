import assert from "node:assert/strict";
import test from "node:test";
import {
   clearRoomTokenFragment,
   getSharedText,
   roomDownloadUrl,
   roomTokenFromHash,
   SharedTextConflictClientError,
   updateSharedText
} from "./roomClient.ts";

test("room capability is parsed from a fragment and never added to download URLs", () => {
   assert.equal(roomTokenFromHash("#t=abc_123"), "abc_123");
   assert.equal(roomDownloadUrl("room_abc", "item_xyz"), "/api/v2/rooms/room_abc/files/item_xyz/content");
   assert.equal(roomDownloadUrl("room_abc", "item_xyz").includes("abc_123"), false);
});

test("room capability parser rejects links without a token", () => {
   assert.throws(() => roomTokenFromHash("#v=2"), /capability/u);
});

test("fragment clearing preserves only path and query", () => {
   const originalWindow = globalThis.window;
   let replacement = "";
   const fakeWindow = {
      location: {
         hash: "#t=secret",
         pathname: "/room/id",
         search: "?view=1"
      },
      history: {
         replaceState: (_state: unknown, _title: string, value: string) => {
            replacement = value;
         }
      }
   };

   Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow
   });

   try {
      clearRoomTokenFragment();
      assert.equal(replacement, "/room/id?view=1");
   } finally {
      Object.defineProperty(globalThis, "window", {
         configurable: true,
         value: originalWindow
      });
   }
});

test("shared text client uses same-origin no-store requests", async () => {
   const originalFetch = globalThis.fetch;
   const calls: Array<{ input: string; init?: RequestInit }> = [];

   globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
         content: "hello 共有",
         revision: 3,
         updatedAt: 10
      }), {
         status: 200,
         headers: { "content-type": "application/json" }
      });
   }) as typeof fetch;

   try {
      assert.equal((await getSharedText("room_abc")).revision, 3);
      const updated = await updateSharedText("room_abc", {
         content: "next",
         expectedRevision: 3
      });

      assert.equal(updated.content, "hello 共有");
      assert.equal(calls[0]?.input, "/api/v2/rooms/room_abc/shared-text");
      assert.equal(calls[0]?.init?.credentials, "same-origin");
      assert.equal(calls[0]?.init?.cache, "no-store");
      assert.equal(calls[1]?.init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
         content: "next",
         expectedRevision: 3
      });
   } finally {
      globalThis.fetch = originalFetch;
   }
});

test("shared text client exposes the current value on revision conflict", async () => {
   const originalFetch = globalThis.fetch;
   const current = {
      content: "newer",
      revision: 8,
      updatedAt: 12
   };

   globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "changed",
      current
   }), {
      status: 409,
      headers: { "content-type": "application/json" }
   })) as typeof fetch;

   try {
      await assert.rejects(
         updateSharedText("room_abc", { content: "draft", expectedRevision: 7 }),
         (error: unknown) => (
            error instanceof SharedTextConflictClientError
            && error.current.content === "newer"
            && error.current.revision === 8
         )
      );
   } finally {
      globalThis.fetch = originalFetch;
   }
});