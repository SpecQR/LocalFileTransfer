import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface RotatingJsonLogOptions {
   maxBytes?: number;
   maxFiles?: number;
   now?: () => Date;
}

const sensitiveKey = /authorization|cookie|token|ticket|secret|password|credential|path|directory|dir|url|origin|roomid|itemid|fingerprint|filename|name|content|text|body|clipboard|draft/iu;

export class RotatingJsonLog {
   readonly directory: string;
   private readonly path: string;
   private readonly maxBytes: number;
   private readonly maxFiles: number;
   private readonly now: () => Date;
   private queue = Promise.resolve();
   private currentBytes = 0;
   private initialized = false;

   constructor(directory: string, options: RotatingJsonLogOptions = {}) {
      this.directory = directory;
      this.path = join(directory, "service.jsonl");
      this.maxBytes = positiveInteger(options.maxBytes ?? 2 * 1024 * 1024, "maxBytes");
      this.maxFiles = positiveInteger(options.maxFiles ?? 3, "maxFiles");
      this.now = options.now ?? (() => new Date());
   }

   async initialize(): Promise<void> {
      await mkdir(this.directory, { recursive: true });

      try {
         this.currentBytes = (await stat(this.path)).size;
      } catch (error) {
         if (!isMissing(error)) {
            throw error;
         }

         this.currentBytes = 0;
      }

      this.initialized = true;
   }

   write(level: LogLevel, event: string, details?: unknown): Promise<void> {
      const operation = this.queue.then(() => this.append(level, event, details));

      this.queue = operation.catch(() => undefined);
      return operation;
   }

   close(): Promise<void> {
      return this.queue;
   }

   private async append(level: LogLevel, event: string, details: unknown): Promise<void> {
      if (!this.initialized) {
         throw new Error("Structured log is not initialized");
      }

      const record = {
         time: this.now().toISOString(),
         level,
         event: /^[a-z0-9][a-z0-9-]{0,63}$/u.test(event) ? event : "invalid-event",
         ...(details === undefined ? {} : { details: sanitizeLogValue(details) })
      };
      const line = boundedJsonLine(record);
      const bytes = Buffer.byteLength(line);

      if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
         await this.rotate();
      }

      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      this.currentBytes += bytes;
   }

   private async rotate(): Promise<void> {
      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
         const source = index === 1 ? this.path : this.path + "." + (index - 1);
         const destination = this.path + "." + index;

         await rm(destination, { force: true });

         try {
            await rename(source, destination);
         } catch (error) {
            if (!isMissing(error)) {
               throw error;
            }
         }
      }

      this.currentBytes = 0;
   }
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
   if (depth > 4) {
      return "<depth-limit>";
   }

   if (value === null || typeof value === "boolean" || typeof value === "number") {
      return value;
   }

   if (typeof value === "string") {
      return redactString(value).slice(0, 1_024);
   }

   if (value instanceof Error) {
      return {
         type: value.name.slice(0, 80),
         message: redactString(value.message).slice(0, 1_024)
      };
   }

   if (Array.isArray(value)) {
      return value.slice(0, 20).map((entry) => sanitizeLogValue(entry, depth + 1));
   }

   if (typeof value === "object") {
      const output: Record<string, unknown> = {};

      for (const [key, entry] of Object.entries(value).slice(0, 50)) {
         output[key] = sensitiveKey.test(key)
            ? "<redacted>"
            : sanitizeLogValue(entry, depth + 1);
      }

      return output;
   }

   return "<unsupported>";
}

function redactString(value: string): string {
   return value
      .replace(/Bearer\s+[^\s]+/giu, "Bearer <redacted>")
      .replace(/([?&](?:token|ticket|key|secret|authorization)=)[^&\s]+/giu, "$1<redacted>")
      .replace(/((?:https?|file):\/\/[^\s#]+)#[^\s]*/giu, "$1#<redacted>")
      .replace(/[A-Za-z]:\\[^\r\n]*/gu, "<redacted-path>")
      .replace(/\\\\[^\r\n]*/gu, "<redacted-path>");
}

function boundedJsonLine(value: unknown): string {
   const serialized = JSON.stringify(value);

   if (Buffer.byteLength(serialized) <= 32 * 1024) {
      return serialized + "\n";
   }

   return JSON.stringify({
      time: new Date(0).toISOString(),
      level: "warn",
      event: "oversized-log-entry"
   }) + "\n";
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(name + " must be a positive integer");
   }

   return value;
}

function isMissing(error: unknown): boolean {
   return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
