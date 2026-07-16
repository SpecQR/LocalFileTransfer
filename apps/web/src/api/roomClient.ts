import {
   nextChunkRange,
   type DurableUploadStatus,
   type RegisterRoomUploadResponse,
   type RoomDiagnosticSnapshot,
   type RoomEvent,
   type RoomItemState,
   type RoomItemView,
   type RoomSharedText,
   type RoomView,
   type SharedTextConflictResponse,
   type UpdateRoomSharedTextRequest
} from "../../../../packages/protocol/src/index.ts";
import {
   checkpointChecksum,
   checkpointIdempotencyKey,
   computeUploadFingerprint
} from "./contentFingerprint.ts";
import {
   createUploadResumeStore,
   type UploadResumeStore
} from "./resumeStore.ts";
import { prepareUploadSource } from "./uploadSource.ts";
import {
   browserUploadChunkSize,
   UploadPausedError,
   xhrUploadCheckpoint
} from "./uploadRequest.ts";

export type RoomUploadProgress = (confirmedBytes: number, totalBytes: number) => void;
export type RoomUploadPhase = (phase: "preparing" | "uploading") => void;

export interface RoomUploadOptions {
   signal?: AbortSignal;
   resumeStore?: UploadResumeStore;
}

export async function authorizeRoom(roomId: string, token: string): Promise<void> {
   const response = await fetch(`/api/v2/rooms/${encodeURIComponent(roomId)}/authorize`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
         "content-type": "application/json"
      },
      body: JSON.stringify({ token })
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   clearRoomTokenFragment();
}

export async function getRoom(roomId: string): Promise<RoomView> {
   const response = await fetch(`/api/v2/rooms/${encodeURIComponent(roomId)}`, {
      credentials: "same-origin",
      cache: "no-store"
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   return response.json() as Promise<RoomView>;
}

export class SharedTextConflictClientError extends Error {
   readonly current: RoomSharedText;

   constructor(message: string, current: RoomSharedText) {
      super(message);
      this.name = "SharedTextConflictClientError";
      this.current = current;
   }
}

export async function getSharedText(roomId: string): Promise<RoomSharedText> {
   const response = await fetch(sharedTextUrl(roomId), {
      credentials: "same-origin",
      cache: "no-store"
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   return parseSharedTextResponse(await response.json());
}

export async function updateSharedText(
   roomId: string,
   update: UpdateRoomSharedTextRequest
): Promise<RoomSharedText> {
   const response = await fetch(sharedTextUrl(roomId), {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
         "content-type": "application/json"
      },
      body: JSON.stringify(update)
   });

   if (response.status === 409) {
      const conflict = await response.json() as SharedTextConflictResponse;

      throw new SharedTextConflictClientError(
         typeof conflict.error === "string" ? conflict.error : "Shared text changed",
         parseSharedTextResponse(conflict.current)
      );
   }

   if (!response.ok) {
      throw await responseError(response);
   }

   return parseSharedTextResponse(await response.json());
}

export async function getRoomDiagnostics(roomId: string): Promise<RoomDiagnosticSnapshot> {
   const response = await fetch(
      "/api/v2/rooms/" + encodeURIComponent(roomId) + "/diagnostics",
      {
         credentials: "same-origin",
         cache: "no-store"
      }
   );

   if (!response.ok) {
      throw await responseError(response);
   }

   return response.json() as Promise<RoomDiagnosticSnapshot>;
}

export function subscribeRoom(
   roomId: string,
   onEvent: (event: RoomEvent) => void,
   onError?: () => void
): () => void {
   const source = new EventSource(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/events`,
      { withCredentials: true }
   );

   source.onmessage = (event) => {
      try {
         onEvent(JSON.parse(event.data) as RoomEvent);
      } catch {
         onError?.();
      }
   };
   source.onerror = () => onError?.();

   return () => source.close();
}

export async function uploadRoomFile(
   roomId: string,
   file: File,
   onProgress?: RoomUploadProgress,
   onPhase?: RoomUploadPhase,
   options: RoomUploadOptions = {}
): Promise<RoomItemView> {
   onPhase?.("preparing");
   const source = await prepareUploadSource(file);
   throwIfPaused(options.signal);
   const fingerprint = await computeUploadFingerprint(file, source);
   const resumeStore = options.resumeStore ?? createUploadResumeStore();
   const saved = await resumeStore.get(roomId, fingerprint);
   let item: RoomItemView | undefined;
   let status: DurableUploadStatus | undefined;

   if (saved) {
      try {
         status = await getUploadStatus(roomId, saved.itemId, options.signal);
         assertUploadIdentity(status, fingerprint, source.size);

         if (status.state === "failed" || status.state === "cancelled") {
            throw new Error("Saved upload is no longer active");
         }

         item = (await getRoom(roomId)).items.find((candidate) => candidate.itemId === saved.itemId);

         if (!item) {
            throw new Error("Saved upload is no longer in the room");
         }
      } catch (error) {
         if (error instanceof UploadPausedError || options.signal?.aborted) {
            throw new UploadPausedError();
         }

         await resumeStore.delete(roomId, fingerprint);
         item = undefined;
         status = undefined;
      }
   }

   onPhase?.("uploading");

   if (!item || !status) {
      item = await registerRoomUpload(roomId, file, fingerprint, options.signal);
      status = await getUploadStatus(roomId, item.itemId, options.signal);
      assertUploadIdentity(status, fingerprint, source.size);
   }

   let offset = status.offset;
   const report = (value: number) => onProgress?.(Math.min(file.size, value), file.size);

   report(offset);
   await resumeStore.put({
      roomId,
      fingerprint,
      itemId: item.itemId,
      offset,
      updatedAt: Date.now()
   });

   while (offset < source.size) {
      throwIfPaused(options.signal);
      const range = nextChunkRange(source.size, offset, browserUploadChunkSize);

      if (!range) {
         break;
      }

      let attempt = 0;

      while (true) {
         try {
            const payload = await source.readChunk(range.start, range.end + 1);
            throwIfPaused(options.signal);
            const checksum = await checkpointChecksum(payload);
            const response = await xhrUploadCheckpoint(
               uploadStatusUrl(roomId, item.itemId),
               payload,
               {
                  offset: range.start,
                  total: source.size,
                  checksum,
                  idempotencyKey: checkpointIdempotencyKey(
                     roomId,
                     item.itemId,
                     range.start,
                     payload.size,
                     checksum
                  ),
                  signal: options.signal
               }
            );

            assertUploadIdentity(response, fingerprint, source.size);
            offset = response.offset;
            report(offset);
            await resumeStore.put({
               roomId,
               fingerprint,
               itemId: item.itemId,
               offset,
               updatedAt: Date.now()
            });
            break;
         } catch (error) {
            if (error instanceof UploadPausedError || options.signal?.aborted) {
               throw new UploadPausedError();
            }

            attempt += 1;
            const remote = await getUploadStatus(roomId, item.itemId, options.signal).catch(() => undefined);

            if (remote?.state === "failed" || remote?.state === "cancelled") {
               throw new Error("Upload stopped for " + file.name);
            }

            if (remote) {
               assertUploadIdentity(remote, fingerprint, source.size);
            }

            if (remote && remote.offset !== offset) {
               offset = remote.offset;
               report(offset);
               await resumeStore.put({
                  roomId,
                  fingerprint,
                  itemId: item.itemId,
                  offset,
                  updatedAt: Date.now()
               });
               break;
            }

            if (attempt >= 3) {
               throw error;
            }

            await delay(250 * (2 ** (attempt - 1)));
         }
      }
   }

   await resumeStore.delete(roomId, fingerprint);
   const finalRoom = await getRoom(roomId);
   return finalRoom.items.find((candidate) => candidate.itemId === item.itemId) ?? item;
}

export async function getUploadStatus(
   roomId: string,
   itemId: string,
   signal?: AbortSignal
): Promise<DurableUploadStatus> {
   const response = await fetch(uploadStatusUrl(roomId, itemId), {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ?? null
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   return {
      itemId,
      offset: responseInteger(response, "upload-offset"),
      length: responseInteger(response, "upload-length"),
      fingerprint: responseHeader(response, "upload-fingerprint"),
      state: responseState(response.headers.get("upload-state"))
   };
}
export async function cancelRoomItem(roomId: string, itemId: string): Promise<void> {
   const response = await fetch(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}`,
      {
         method: "DELETE",
         credentials: "same-origin"
      }
   );

   if (!response.ok) {
      throw await responseError(response);
   }
}

export function roomDownloadUrl(roomId: string, itemId: string): string {
   return `/api/v2/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(itemId)}/content`;
}

export function roomArchiveUrl(roomId: string): string {
   return "/api/v2/rooms/" + encodeURIComponent(roomId) + "/files/archive";
}

export function roomTokenFromHash(hash = window.location.hash): string {
   const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
   const token = params.get("t");

   if (!token) {
      throw new Error("QR link is missing the room capability");
   }

   return token;
}

export function clearRoomTokenFragment(): void {
   if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
   }
}

async function registerRoomUpload(
   roomId: string,
   file: File,
   fingerprint: string,
   signal?: AbortSignal
): Promise<RoomItemView> {
   const response = await fetch("/api/v2/rooms/" + encodeURIComponent(roomId) + "/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: {
         "content-type": "application/json"
      },
      signal: signal ?? null,
      body: JSON.stringify({
         name: file.name,
         type: file.type || "application/octet-stream",
         size: file.size,
         lastModified: file.lastModified,
         fingerprint
      })
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   return ((await response.json()) as RegisterRoomUploadResponse).item;
}

function sharedTextUrl(roomId: string): string {
   return "/api/v2/rooms/" + encodeURIComponent(roomId) + "/shared-text";
}

function parseSharedTextResponse(value: unknown): RoomSharedText {
   if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid Shared text response");
   }

   const record = value as Partial<RoomSharedText>;

   if (
      typeof record.content !== "string"
      || !Number.isSafeInteger(record.revision)
      || (record.revision as number) < 0
      || !Number.isSafeInteger(record.updatedAt)
      || (record.updatedAt as number) < 0
   ) {
      throw new Error("Invalid Shared text response");
   }

   return {
      content: record.content,
      revision: record.revision as number,
      updatedAt: record.updatedAt as number
   };
}

function uploadStatusUrl(roomId: string, itemId: string): string {
   return "/api/v2/rooms/" + encodeURIComponent(roomId) + "/uploads/" + encodeURIComponent(itemId);
}

function responseInteger(response: Response, name: string): number {
   const value = response.headers.get(name);
   const parsed = value === null ? Number.NaN : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error("Invalid " + name + " response header");
   }

   return parsed;
}

function responseHeader(response: Response, name: string): string {
   const value = response.headers.get(name);

   if (!value) {
      throw new Error("Missing " + name + " response header");
   }

   return value;
}

function responseState(value: string | null): RoomItemState {
   if (
      value !== "pending"
      && value !== "transferring"
      && value !== "ready"
      && value !== "failed"
      && value !== "cancelled"
   ) {
      throw new Error("Invalid upload-state response header");
   }

   return value;
}

function assertUploadIdentity(
   status: { length: number; fingerprint?: string | undefined },
   fingerprint: string,
   expectedLength: number
): void {
   if (status.length !== expectedLength || status.fingerprint !== fingerprint) {
      throw new Error("The resumable upload does not match the selected file");
   }
}

function throwIfPaused(signal?: AbortSignal): void {
   if (signal?.aborted) {
      throw new UploadPausedError();
   }
}
async function responseError(response: Response): Promise<Error> {
   try {
      const body = await response.json() as { error?: string };

      return new Error(body.error ?? `Request failed with HTTP ${response.status}`);
   } catch {
      return new Error(`Request failed with HTTP ${response.status}`);
   }
}

function delay(ms: number): Promise<void> {
   return new Promise((resolve) => window.setTimeout(resolve, ms));
}
