import type { DesktopRoomBootstrap } from "../desktop/src/serviceProtocol.ts";
import type { RoomDiagnosticSnapshot, RoomView } from "../../packages/protocol/src/index.ts";

interface NativeWindow extends Window {
   __TAURI__?: {
      core: {
         invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
   };
}

// Only the native host's main /app page receives the desktop bridge. The native
// command handlers independently validate the window and exact active origin.
if (
   window.top === window
   && window.location.protocol === "http:"
   && window.location.hostname === "127.0.0.1"
   && window.location.pathname === "/app"
) {
   const nativeWindow = window as NativeWindow;
   let authorization: { roomId: string; token: string; promise: Promise<void> } | undefined;
   let bootstrapRequest: Promise<DesktopRoomBootstrap> | undefined;

   function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const native = nativeWindow.__TAURI__?.core;

      if (!native) {
         return Promise.reject(new Error("The native window is unavailable"));
      }

      return native.invoke<T>(command, args);
   }

   async function authorize(bootstrap: DesktopRoomBootstrap): Promise<DesktopRoomBootstrap> {
      const joinUrl = new URL(bootstrap.joinUrl);
      const token = new URLSearchParams(joinUrl.hash.slice(1)).get("t");

      if (!token) {
         throw new Error("The room capability is unavailable");
      }

      if (authorization?.roomId !== bootstrap.roomId || authorization.token !== token) {
         const previous = authorization?.promise;
         const current = {
            roomId: bootstrap.roomId,
            token,
            promise: Promise.resolve()
         };

         current.promise = (async () => {
            // A reset and the periodic bootstrap refresh may overlap. Preserve
            // cookie exchange order without exposing the credential in a URL.
            await previous?.catch(() => undefined);
            const response = await fetch(
               `/api/v2/rooms/${encodeURIComponent(bootstrap.roomId)}/authorize`,
               {
                  method: "POST",
                  credentials: "same-origin",
                  cache: "no-store",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ token })
               }
            );

            if (!response.ok) {
               throw new Error("The room could not be authorized");
            }
         })();
         authorization = current;
         void current.promise.catch(() => {
            if (authorization === current) {
               authorization = undefined;
            }
         });
      }

      await authorization.promise;
      return bootstrap;
   }

   const bridge = Object.freeze({
      nativeFileDrop: true,
      roomBootstrap(): Promise<DesktopRoomBootstrap> {
         if (!bootstrapRequest) {
            bootstrapRequest = invoke<DesktopRoomBootstrap>("room_bootstrap")
               .then(authorize)
               .finally(() => {
                  bootstrapRequest = undefined;
               });
         }

         return bootstrapRequest;
      },
      resetRoom(): Promise<DesktopRoomBootstrap> {
         return invoke<DesktopRoomBootstrap>("reset_room").then(authorize);
      },
      chooseFiles(): Promise<RoomView | null> {
         return invoke("choose_files");
      },
      addFiles(): Promise<never> {
         return Promise.reject(new Error("Use the native file picker or drop files on the window"));
      },
      resizeToContent(size: { height: number }): void {
         void invoke("resize_to_content", { height: size.height }).catch(() => undefined);
      },
      setTransferActive(active: boolean): void {
         void invoke("set_transfer_active", { active }).catch(() => undefined);
      },
      showReceivedFile(roomId: string, itemId: string): Promise<void> {
         return invoke("show_received_file", { roomId, itemId });
      },
      openReceiveFolder(): Promise<void> {
         return invoke("open_receive_folder");
      },
      getDiagnostics(): Promise<RoomDiagnosticSnapshot> {
         return invoke("get_diagnostics");
      },
      openLogFolder(): Promise<void> {
         return invoke("open_log_folder");
      }
   });

   Object.defineProperty(window, "localFileTransfer", {
      value: bridge,
      configurable: false,
      writable: false
   });
}
