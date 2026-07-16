import {
   nextChunkRange,
   type CreateLocalSessionResponse,
   type CreateSendSessionRequest,
   type CreateUploadSessionRequest,
   type LocalFileRecord,
   type LocalInfoResponse,
   type LocalSessionEvent,
   type LocalSessionView,
   type RegisterUploadFileResponse
} from "../../../../packages/protocol/src/index.ts";
import {
   browserUploadChunkSize,
   xhrUploadChunk
} from "./uploadRequest.ts";
import {
   prepareUploadSource,
   type PreparedUploadSource
} from "./uploadSource.ts";

export type UploadProgressHandler = (sentBytes: number, totalBytes: number) => void;
export type UploadPhaseHandler = (phase: "preparing" | "uploading") => void;

const fileReadyPollIntervalMs = 250;
const fileReadyPollAttempts = 120;

export async function getLocalInfo(): Promise<LocalInfoResponse> {
   return jsonFetch<LocalInfoResponse>("/api/local/info");
}

export async function resolveAppBaseUrl(preferredOrigin?: string): Promise<string> {
   if (preferredOrigin) {
      return normalizeOrigin(preferredOrigin);
   }

   const info = await getLocalInfo();
   const current = new URL(window.location.href);
   const isLoopback = current.hostname === "localhost" || current.hostname === "127.0.0.1";
   const lanOrigin = bestLanOrigin(info);

   if (!isLoopback || !lanOrigin) {
      return window.location.origin;
   }

   const publicUrl = new URL(lanOrigin);

   publicUrl.protocol = current.protocol;
   publicUrl.port = current.port || publicUrl.port;

   return publicUrl.origin;
}

export async function createSendSession(files: File[], preferredOrigin?: string): Promise<CreateLocalSessionResponse> {
   const body: CreateSendSessionRequest = {
      appBaseUrl: await resolveAppBaseUrl(preferredOrigin),
      files: files.map(fileMetadata)
   };

   return jsonFetch<CreateLocalSessionResponse>("/api/local/send-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
   });
}

export async function createUploadSession(preferredOrigin?: string): Promise<CreateLocalSessionResponse> {
   const body: CreateUploadSessionRequest = {
      appBaseUrl: await resolveAppBaseUrl(preferredOrigin)
   };

   return jsonFetch<CreateLocalSessionResponse>("/api/local/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
   });
}

export async function authorizeSession(sid: string, token: string): Promise<void> {
   const response = await fetch(`/api/local/sessions/${encodeURIComponent(sid)}/authorize`, {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders(token)
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   clearTokenFragment();
}

export async function uploadSendFile(
   sid: string,
   fileId: string,
   file: File,
   onProgress?: UploadProgressHandler
): Promise<LocalFileRecord> {
   const source = await prepareUploadSource(file);

   return uploadFileChunks(
      sid,
      fileId,
      source,
      `/api/local/send-sessions/${encodeURIComponent(sid)}/files/${encodeURIComponent(fileId)}/chunks`,
      onProgress
   );
}

export async function uploadFileToWindows(
   sid: string,
   file: File,
   onProgress?: UploadProgressHandler,
   onPhase?: UploadPhaseHandler
): Promise<LocalFileRecord> {
   onPhase?.("preparing");
   const source = await prepareUploadSource(file);

   onPhase?.("uploading");
   const registered = await jsonFetch<RegisterUploadFileResponse>(
      `/api/local/upload-sessions/${encodeURIComponent(sid)}/files`,
      {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify(fileMetadata(file))
      }
   );

   if (registered.file.ready) {
      onProgress?.(file.size, file.size);
      return registered.file;
   }

   return uploadFileChunks(
      sid,
      registered.file.fileId,
      source,
      `/api/local/upload-sessions/${encodeURIComponent(sid)}/files/${encodeURIComponent(registered.file.fileId)}/chunks`,
      onProgress,
      registered.file.receivedSize
   );
}

export async function getSendSession(sid: string, token?: string): Promise<LocalSessionView> {
   return jsonFetch<LocalSessionView>(`/api/local/send-sessions/${encodeURIComponent(sid)}`, token ? { headers: authHeaders(token) } : undefined);
}

export async function getUploadSession(sid: string, token?: string): Promise<LocalSessionView> {
   return jsonFetch<LocalSessionView>(`/api/local/upload-sessions/${encodeURIComponent(sid)}`, token ? { headers: authHeaders(token) } : undefined);
}

export function sendFileDownloadUrl(sid: string, fileId: string): string {
   return `/api/local/send-sessions/${encodeURIComponent(sid)}/files/${encodeURIComponent(fileId)}`;
}

export function uploadedFileDownloadUrl(sid: string, fileId: string): string {
   return `/api/local/upload-sessions/${encodeURIComponent(sid)}/files/${encodeURIComponent(fileId)}`;
}

export function subscribeSessionEvents(
   sid: string,
   onEvent: (event: LocalSessionEvent) => void,
   onError?: () => void
): () => void {
   const source = new EventSource(`/api/local/sessions/${encodeURIComponent(sid)}/events`, {
      withCredentials: true
   });

   source.onmessage = (message) => {
      try {
         onEvent(JSON.parse(message.data) as LocalSessionEvent);
      } catch {
         onError?.();
      }
   };
   source.onerror = () => onError?.();

   return () => source.close();
}

export async function deleteLocalSession(sid: string, token: string): Promise<void> {
   const response = await fetch(`/api/local/sessions/${encodeURIComponent(sid)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: authHeaders(token)
   });

   if (!response.ok) {
      throw await responseError(response);
   }
}

export function tokenFromHash(hash = window.location.hash): string {
   const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
   const token = params.get("t");

   if (!token) {
      throw new Error("QR link is missing the local session token");
   }

   return token;
}

export function clearTokenFragment(): void {
   if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
   }
}

async function uploadFileChunks(
   sid: string,
   fileId: string,
   source: PreparedUploadSource,
   url: string,
   onProgress?: UploadProgressHandler,
   initialOffset = 0
): Promise<LocalFileRecord> {
   let offset = initialOffset;
   let latest: LocalFileRecord | undefined;
   let reportedOffset = initialOffset;
   const reportProgress = (sentBytes: number) => {
      reportedOffset = Math.max(reportedOffset, Math.min(source.size, sentBytes));
      onProgress?.(reportedOffset, source.size);
   };

   while (offset < source.size) {
      const range = nextChunkRange(source.size, offset, browserUploadChunkSize);

      if (!range) {
         break;
      }

      let attempt = 0;

      while (true) {
         try {
            const payload = await source.readChunk(range.start, range.end + 1);
            const uploaded = await xhrUploadChunk<RegisterUploadFileResponse>(
               url,
               payload,
               range,
               (chunkBytes) => reportProgress(range.start + chunkBytes)
            ).then((response) => response.file);

            latest = uploaded;
            offset = uploaded.receivedSize;
            reportProgress(offset);
            break;
         } catch (error) {
            attempt += 1;
            const session = await getSessionForUpload(sid, url).catch(() => undefined);
            const remote = session?.files.find((candidate) => candidate.fileId === fileId);

            if (remote?.state === "failed") {
               throw new Error(remote.error || `Upload failed for ${remote.name}`);
            }

            if (remote && (remote.receivedSize > offset || remote.ready)) {
               offset = remote.receivedSize;
               latest = remote;
               reportProgress(offset);
               break;
            }

            if (attempt >= 3) {
               throw error;
            }

            await delay(250 * (2 ** (attempt - 1)));
         }
      }
   }

   if (latest?.ready) {
      return latest;
   }

   return waitForFileReady(sid, fileId, url);
}

async function waitForFileReady(sid: string, fileId: string, url: string): Promise<LocalFileRecord> {
   for (let attempt = 0; attempt < fileReadyPollAttempts; attempt += 1) {
      const session = await getSessionForUpload(sid, url);
      const file = session.files.find((candidate) => candidate.fileId === fileId);

      if (!file) {
         throw new Error("Uploaded file was not found in the session");
      }

      if (file.ready) {
         return file;
      }

      if (file.state === "failed") {
         throw new Error(file.error || `Upload failed for ${file.name}`);
      }

      await delay(fileReadyPollIntervalMs);
   }

   throw new Error("Windows did not finish saving the file. Tap Resume upload to continue.");
}

function getSessionForUpload(sid: string, url: string): Promise<LocalSessionView> {
   return url.includes("/upload-sessions/") ? getUploadSession(sid) : getSendSession(sid);
}

function fileMetadata(file: File): CreateSendSessionRequest["files"][number] {
   return {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified
   };
}

function bestLanOrigin(info: LocalInfoResponse): string | undefined {
   const candidates = [...(info.lanCandidates ?? [])]
      .filter((candidate) => !isLoopbackHost(candidate.address))
      .sort((left, right) => left.priority - right.priority);

   return candidates[0]?.origin ?? info.lanOrigins.find((origin) => !isLoopbackHost(new URL(origin).hostname));
}

function normalizeOrigin(value: string): string {
   const trimmed = value.trim();
   const withProtocol = /^https?:\/\//u.test(trimmed) ? trimmed : `http://${trimmed}`;

   return new URL(withProtocol).origin;
}

function isLoopbackHost(hostname: string): boolean {
   return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function authHeaders(token: string): Record<string, string> {
   return { authorization: `Bearer ${token}` };
}

async function jsonFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
   const response = await fetch(input, {
      credentials: "same-origin",
      ...init
   });

   if (!response.ok) {
      throw await responseError(response);
   }

   return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<Error> {
   let detail = "";

   try {
      const body = await response.json() as { error?: string };

      detail = body.error ? `: ${body.error}` : "";
   } catch {
      detail = "";
   }

   return new Error(`HTTP ${response.status}${detail}`);
}

function delay(ms: number): Promise<void> {
   return new Promise((resolve) => window.setTimeout(resolve, ms));
}