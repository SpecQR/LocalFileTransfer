export const browserUploadChunkSize = 1024 * 1024;

interface UploadRange {
   start: number;
   end: number;
   total: number;
}

interface UploadRequestOptions {
   createRequest?: () => XMLHttpRequest;
}

export interface DurableUploadCheckpoint {
   offset: number;
   total: number;
   checksum: string;
   idempotencyKey: string;
   signal?: AbortSignal | undefined;
}

export interface DurableUploadCheckpointResponse {
   offset: number;
   length: number;
   fingerprint?: string | undefined;
   state?: string | undefined;
}

export class UploadPausedError extends Error {
   constructor() {
      super("Upload paused");
      this.name = "UploadPausedError";
   }
}

export function xhrUploadChunk<T>(
   url: string,
   payload: Blob,
   range: UploadRange,
   onProgress?: (chunkBytes: number) => void,
   options: UploadRequestOptions = {}
): Promise<T> {
   return new Promise((resolve, reject) => {
      const xhr = options.createRequest?.() ?? new XMLHttpRequest();
      let settled = false;

      const succeed = (value: T) => {
         if (settled) {
            return;
         }

         settled = true;
         resolve(value);
      };
      const fail = (error: Error) => {
         if (settled) {
            return;
         }

         settled = true;
         reject(error);
      };

      xhr.open("PUT", url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader("content-range", `bytes ${range.start}-${range.end}/${range.total}`);
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
      xhr.onload = () => {
         if (xhr.status < 200 || xhr.status >= 300) {
            fail(new Error(`Upload failed with HTTP ${xhr.status}`));
            return;
         }

         try {
            succeed(JSON.parse(xhr.responseText) as T);
         } catch (error) {
            fail(error instanceof Error ? error : new Error("Invalid upload response"));
         }
      };
      xhr.onerror = () => fail(new Error("Upload failed. Check the LAN connection and try again."));
      xhr.onabort = () => fail(new Error("Upload was cancelled"));

      try {
         xhr.send(payload);
      } catch (error) {
         fail(error instanceof Error ? error : new Error("Upload request could not start"));
      }
   });
}
export function xhrUploadCheckpoint(
   url: string,
   payload: Blob,
   checkpoint: DurableUploadCheckpoint,
   onProgress?: (chunkBytes: number) => void,
   options: UploadRequestOptions = {}
): Promise<DurableUploadCheckpointResponse> {
   return new Promise((resolve, reject) => {
      const xhr = options.createRequest?.() ?? new XMLHttpRequest();
      let settled = false;
      let paused = checkpoint.signal?.aborted ?? false;
      const cleanup = () => checkpoint.signal?.removeEventListener("abort", pause);
      const succeed = (value: DurableUploadCheckpointResponse) => {
         if (settled) {
            return;
         }

         settled = true;
         cleanup();
         resolve(value);
      };
      const fail = (error: Error) => {
         if (settled) {
            return;
         }

         settled = true;
         cleanup();
         reject(error);
      };
      const pause = () => {
         paused = true;
         xhr.abort();
      };

      if (paused) {
         fail(new UploadPausedError());
         return;
      }

      xhr.open("PATCH", url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/offset+octet-stream");
      xhr.setRequestHeader("upload-offset", String(checkpoint.offset));
      xhr.setRequestHeader("upload-checksum", "sha256 " + checkpoint.checksum);
      xhr.setRequestHeader("idempotency-key", checkpoint.idempotencyKey);
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
      xhr.onload = () => {
         if (xhr.status < 200 || xhr.status >= 300) {
            fail(new Error("Upload failed with HTTP " + xhr.status));
            return;
         }

         try {
            succeed({
               offset: parseResponseInteger(xhr, "upload-offset"),
               length: parseResponseInteger(xhr, "upload-length"),
               fingerprint: xhr.getResponseHeader("upload-fingerprint") ?? undefined,
               state: xhr.getResponseHeader("upload-state") ?? undefined
            });
         } catch (error) {
            fail(error instanceof Error ? error : new Error("Invalid upload response"));
         }
      };
      xhr.onerror = () => fail(new Error("Upload failed. Check the LAN connection and try again."));
      xhr.onabort = () => fail(paused ? new UploadPausedError() : new Error("Upload was cancelled"));
      checkpoint.signal?.addEventListener("abort", pause, { once: true });

      try {
         xhr.send(payload);
      } catch (error) {
         fail(error instanceof Error ? error : new Error("Upload request could not start"));
      }
   });
}

function parseResponseInteger(xhr: XMLHttpRequest, name: string): number {
   const value = xhr.getResponseHeader(name);
   const parsed = value === null ? Number.NaN : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error("Invalid " + name + " response header");
   }

   return parsed;
}