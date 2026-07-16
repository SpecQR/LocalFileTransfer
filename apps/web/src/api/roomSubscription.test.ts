import assert from "node:assert/strict";
import test from "node:test";
import { subscribeRoom } from "./roomClient.ts";

test("room subscription reports open, messages, errors, and close", () => {
   const original = globalThis.EventSource;
   const events: string[] = [];
   let receivedType = "";
   let source: FakeEventSource | undefined;

   Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: class extends FakeEventSource {
         constructor(url: string | URL, options?: EventSourceInit) {
            super(url, options);
            source = this;
         }
      }
   });

   try {
      const unsubscribe = subscribeRoom(
         "room_abc",
         (event) => {
            receivedType = event.t;
         },
         () => events.push("error"),
         () => events.push("open")
      );

      assert.ok(source);
      assert.equal(source.url, "/api/v2/rooms/room_abc/events");
      assert.equal(source.withCredentials, true);

      source.onopen?.(new Event("open"));
      source.onmessage?.(new MessageEvent("message", {
         data: JSON.stringify({
            id: 1,
            t: "snapshot",
            createdAt: 10
         })
      }));
      source.onerror?.(new Event("error"));
      source.onmessage?.(new MessageEvent("message", { data: "not-json" }));

      assert.equal(receivedType, "snapshot");
      assert.deepEqual(events, ["open", "error", "error"]);

      unsubscribe();
      assert.equal(source.closed, true);
   } finally {
      Object.defineProperty(globalThis, "EventSource", {
         configurable: true,
         value: original
      });
   }
});

class FakeEventSource {
   onerror: ((this: EventSource, event: Event) => unknown) | null = null;
   onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
   onopen: ((this: EventSource, event: Event) => unknown) | null = null;
   readonly url: string;
   readonly withCredentials: boolean;
   closed = false;

   constructor(url: string | URL, options?: EventSourceInit) {
      this.url = String(url);
      this.withCredentials = options?.withCredentials ?? false;
   }

   close(): void {
      this.closed = true;
   }
}
