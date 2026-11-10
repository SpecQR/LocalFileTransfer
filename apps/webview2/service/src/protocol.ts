import type { RoomDiagnosticSnapshot, RoomView } from "../../../../packages/protocol/src/index.ts";
import type { DesktopRoomBootstrap, ServiceRuntime } from "../../../desktop/src/serviceProtocol.ts";

// Includes the terminating LF, matching the native host's bounded reader.
export const maxProtocolLineBytes = 1024 * 1024;

export type HostAction =
   | "initialize"
   | "bootstrap"
   | "add-files"
   | "reset-room"
   | "diagnostics"
   | "completed-path"
   | "shutdown";

export interface HostRequest {
   requestId: string;
   action: HostAction;
   payload?: unknown;
}

export interface HostResponse {
   requestId: string;
   ok: boolean;
   result?: unknown;
   error?: string;
}

export interface RoomCredential {
   roomId: string;
   token: string;
}

export interface HostSnapshot {
   runtime: ServiceRuntime;
   bootstrap: DesktopRoomBootstrap;
   // Private owner transport only. The native host persists this with DPAPI
   // and does not expose this field through renderer commands.
   credential: RoomCredential;
   transferActive: boolean;
}

export type HostResult = HostSnapshot | RoomDiagnosticSnapshot | RoomView | string | undefined;

export class HostRequestError extends Error {
   readonly code: string;

   constructor(code: string) {
      super(code);
      this.code = code;
   }
}

const actions: ReadonlySet<string> = new Set([
   "initialize",
   "bootstrap",
   "add-files",
   "reset-room",
   "diagnostics",
   "completed-path",
   "shutdown"
]);

export function parseHostRequest(value: unknown): HostRequest {
   const record = requireRecord(value);

   if (!validRequestId(record.requestId)
      || typeof record.action !== "string"
      || !actions.has(record.action)
      || Object.keys(record).some((key) => !["requestId", "action", "payload"].includes(key))) {
      throw new HostRequestError("invalid-request");
   }

   return {
      requestId: record.requestId,
      action: record.action as HostAction,
      ...(record.payload === undefined ? {} : { payload: record.payload })
   };
}

export function requestIdFromUnknown(value: unknown): string {
   if (value && typeof value === "object" && "requestId" in value && validRequestId(value.requestId)) {
      return value.requestId;
   }

   return "invalid-request";
}

export function responseError(error: unknown): string {
   if (error instanceof HostRequestError) {
      return error.code;
   }

   if (error instanceof TypeError) {
      return "invalid-payload";
   }

   if (error instanceof SyntaxError) {
      return "invalid-request";
   }

   if (error && typeof error === "object" && "statusCode" in error
      && typeof error.statusCode === "number" && Number.isSafeInteger(error.statusCode)
      && error.statusCode >= 400 && error.statusCode <= 599) {
      return "request-failed-" + error.statusCode;
   }

   // Filesystem and database errors can contain source paths or user content.
   // Only fixed codes cross the transport or reach stderr.
   return "request-failed";
}

export function encodeHostResponse(response: HostResponse): string {
   const serialized = JSON.stringify(response);

   if (Buffer.byteLength(serialized, "utf8") + 1 > maxProtocolLineBytes) {
      return JSON.stringify({ requestId: response.requestId, ok: false, error: "response-too-large" }) + "\n";
   }

   return serialized + "\n";
}

export function requireRecord(value: unknown): Record<string, unknown> {
   if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HostRequestError("invalid-payload");
   }

   return value as Record<string, unknown>;
}

// Byte framing avoids splitting UTF-8 characters and caps a partial line before
// decoding it. The caller consumes each batch before reading the next chunk.
export class ProtocolLineReader {
   private readonly buffer = Buffer.allocUnsafe(maxProtocolLineBytes);
   private bytes = 0;

   push(chunk: Buffer): Buffer[] {
      const lines: Buffer[] = [];
      let start = 0;

      while (start < chunk.length) {
         const newline = chunk.indexOf(0x0a, start);
         const end = newline === -1 ? chunk.length : newline;
         const part = chunk.subarray(start, end);

         if (this.bytes + part.length + 1 > maxProtocolLineBytes) {
            this.bytes = 0;
            throw new HostRequestError("request-too-large");
         }

         if (part.length > 0) {
            part.copy(this.buffer, this.bytes);
            this.bytes += part.length;
         }

         if (newline === -1) {
            break;
         }

         const line = Buffer.from(this.buffer.subarray(0, this.bytes));

         lines.push(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
         this.bytes = 0;
         start = newline + 1;
      }

      return lines;
   }

   finish(): void {
      if (this.bytes !== 0) {
         this.bytes = 0;
         throw new HostRequestError("incomplete-request");
      }
   }
}

function validRequestId(value: unknown): value is string {
   return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
