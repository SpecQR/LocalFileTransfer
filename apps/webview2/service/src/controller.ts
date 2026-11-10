import { isAbsolute } from "node:path";
import {
   parseDesktopSourceFiles,
   parseRoomId,
   parseRoomItemId,
   parseRoomToken,
   uploadChunkSize,
   type RoomDiagnosticSnapshot,
   type RoomView
} from "../../../../packages/protocol/src/index.ts";
import { createLocalTransferService, type LocalTransferService } from "../../../desktop/src/serviceRuntime.ts";
import type { ServiceInitPayload, ServiceRoomResult, ServiceRuntime } from "../../../desktop/src/serviceProtocol.ts";
import {
   HostRequestError,
   requireRecord,
   type HostAction,
   type HostResult,
   type HostSnapshot,
   type RoomCredential
} from "./protocol.ts";

interface InitializePayload {
   storageDir: string;
   receiveDir: string;
   staticRoot: string;
   version: string;
   serviceRestarts: number;
   credential?: RoomCredential;
}

export interface HostController {
   execute(action: HostAction, payload?: unknown): Promise<HostResult>;
   close(): Promise<void>;
}

interface HostControllerOptions {
   service?: Pick<LocalTransferService, "execute" | "close">;
   now?: () => number;
}

export function createHostController(options: HostControllerOptions = {}): HostController {
   const service = options.service ?? createLocalTransferService({
      httpLogging: false,
      denyFrames: true,
      disconnectOnClose: true
   });
   const now = options.now ?? Date.now;
   let runtime: ServiceRuntime | undefined;
   let activeRoom: ServiceRoomResult | undefined;
   let roomOrigin: string | undefined;
   let queue: Promise<unknown> = Promise.resolve();
   let closing = false;
   let closure: Promise<void> | undefined;

   return { execute, close };

   function execute(action: HostAction, payload?: unknown): Promise<HostResult> {
      if (action === "shutdown") {
         return close().then(() => undefined);
      }

      if (closing) {
         return Promise.reject(new HostRequestError("service-closing"));
      }

      const pending = queue.then(async () => {
         if (closing) {
            throw new HostRequestError("service-closing");
         }

         return dispatch(action, payload);
      });

      queue = pending.catch(() => undefined);
      return pending;
   }

   function close(): Promise<void> {
      if (!closure) {
         closing = true;
         closure = queue.then(() => service.close()).finally(() => {
            runtime = undefined;
            activeRoom = undefined;
            roomOrigin = undefined;
         });
      }

      return closure;
   }

   async function dispatch(action: Exclude<HostAction, "shutdown">, payload: unknown): Promise<HostResult> {
      if (action === "initialize") {
         if (runtime && activeRoom) {
            return snapshot();
         }

         const input = parseInitializePayload(payload);
         const configuration: ServiceInitPayload = {
            version: input.version,
            serviceRestarts: input.serviceRestarts,
            storageDir: input.storageDir,
            receiveDir: input.receiveDir,
            staticRoot: input.staticRoot,
            portStart: 8787,
            maxPortAttempts: 20,
            ttlMs: 15 * 60 * 1000,
            hardTtlMs: 60 * 60 * 1000,
            limits: {
               maxFiles: 100,
               maxFileSize: 4 * 1024 * 1024 * 1024,
               maxRoomSize: 20 * 1024 * 1024 * 1024,
               uploadChunkSize
            }
         };

         runtime = await service.execute<ServiceRuntime>("initialize", configuration);
         const origin = preferredLanOrigin(runtime);

         // ensure-room rotates only a missing/expired room. An invalid token
         // must not be hidden by silently replacing the user's active room.
         activeRoom = input.credential
            ? await service.execute<ServiceRoomResult>("ensure-room", { ...input.credential, appBaseUrl: origin })
            : await service.execute<ServiceRoomResult>("create-room", { appBaseUrl: origin });
         roomOrigin = origin;
         return snapshot();
      }

      requireActiveRoom();

      switch (action) {
         case "bootstrap":
            await refreshRoom();
            return snapshot();
         case "reset-room": {
            runtime = await service.execute<ServiceRuntime>("network-status");
            const room = requireActiveRoom();
            const origin = preferredLanOrigin(requireRuntime());

            activeRoom = await service.execute<ServiceRoomResult>("reset-room", {
               roomId: room.roomId,
               token: room.token,
               appBaseUrl: origin
            });
            roomOrigin = origin;
            return snapshot();
         }
         case "add-files": {
            const files = parseDesktopSourceFiles(requireRecord(payload).files);

            if (files.length > 100 || files.some((file) => !isAbsolute(file.path) || file.path.includes("\0"))) {
               throw new HostRequestError("invalid-payload");
            }

            const room = requireActiveRoom();

            return service.execute<RoomView>("add-files", { roomId: room.roomId, token: room.token, files });
         }
         case "diagnostics":
            return service.execute<RoomDiagnosticSnapshot>("diagnostics");
         case "completed-path": {
            const record = requireRecord(payload);
            const roomId = parseRoomId(record.roomId);
            const itemId = parseRoomItemId(record.itemId);

            if (roomId !== requireActiveRoom().roomId) {
               throw new HostRequestError("inactive-room");
            }

            return service.execute<string>("completed-path", { roomId, itemId });
         }
         default:
            throw new HostRequestError("unsupported-action");
      }
   }

   async function refreshRoom(): Promise<void> {
      const room = requireActiveRoom();

      runtime = await service.execute<ServiceRuntime>("network-status");
      const origin = preferredLanOrigin(runtime);

      if (roomOrigin !== origin || room.expiresAt <= now()) {
         activeRoom = await service.execute<ServiceRoomResult>("ensure-room", {
            roomId: room.roomId,
            token: room.token,
            appBaseUrl: origin
         });
         roomOrigin = origin;
      }
   }

   async function snapshot(): Promise<HostSnapshot> {
      const currentRuntime = requireRuntime();
      const room = requireActiveRoom();
      const diagnostics = await service.execute<RoomDiagnosticSnapshot>("diagnostics");

      return {
         runtime: currentRuntime,
         bootstrap: {
            roomId: room.roomId,
            joinUrl: `${preferredLanOrigin(currentRuntime)}/room/${encodeURIComponent(room.roomId)}#t=${room.token}`,
            expiresAt: room.expiresAt
         },
         credential: { roomId: room.roomId, token: room.token },
         transferActive: diagnostics.activeWrites > 0 || diagnostics.activeReads > 0 || diagnostics.transferringItems > 0
      };
   }

   function requireActiveRoom(): ServiceRoomResult {
      if (!runtime || !activeRoom) {
         throw new HostRequestError("not-initialized");
      }

      return activeRoom;
   }

   function requireRuntime(): ServiceRuntime {
      if (!runtime) {
         throw new HostRequestError("not-initialized");
      }

      return runtime;
   }
}

function parseInitializePayload(value: unknown): InitializePayload {
   const record = requireRecord(value);
   const version = record.version;
   const serviceRestarts = record.serviceRestarts ?? 0;

   if (typeof version !== "string" || !/^[A-Za-z0-9.+_-]{1,64}$/u.test(version)
      || !Number.isSafeInteger(serviceRestarts) || (serviceRestarts as number) < 0) {
      throw new HostRequestError("invalid-payload");
   }

   let credential: RoomCredential | undefined;

   if (record.credential !== undefined && record.credential !== null) {
      const saved = requireRecord(record.credential);

      credential = { roomId: parseRoomId(saved.roomId), token: parseRoomToken(saved.token) };
   }

   return {
      storageDir: absolutePath(record.storageDir),
      receiveDir: absolutePath(record.receiveDir),
      staticRoot: absolutePath(record.staticRoot),
      version,
      serviceRestarts: serviceRestarts as number,
      ...(credential ? { credential } : {})
   };
}

function absolutePath(value: unknown): string {
   if (typeof value !== "string" || value.length > 32_767 || value.includes("\0") || !isAbsolute(value)) {
      throw new HostRequestError("invalid-payload");
   }

   return value;
}

function preferredLanOrigin(runtime: ServiceRuntime): string {
   return runtime.lanUrls.find((url) => !url.includes("localhost")) ?? runtime.localUrl;
}
