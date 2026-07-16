import { Worker } from "node:worker_threads";

const digestPattern = /^[a-f0-9]{64}$/u;
const defaultWorkerLimit = 2;
const defaultCacheLimit = 256;

export interface SourceHashPoolOptions {
   maxWorkers?: number;
   maxCacheEntries?: number;
}

interface HashTask {
   key: string;
   path: string;
   size: number;
   modifiedMs: number;
   resolve: (digest: string) => void;
   reject: (error: Error) => void;
}

export class SourceHashPool {
   private readonly maxWorkers: number;
   private readonly maxCacheEntries: number;
   private readonly cache = new Map<string, string>();
   private readonly inFlight = new Map<string, Promise<string>>();
   private readonly queue: HashTask[] = [];
   private readonly workers = new Set<Worker>();
   private active = 0;
   private started = 0;
   private closed = false;

   constructor(options: SourceHashPoolOptions = {}) {
      this.maxWorkers = positiveInteger(options.maxWorkers ?? defaultWorkerLimit, "maxWorkers");
      this.maxCacheEntries = positiveInteger(
         options.maxCacheEntries ?? defaultCacheLimit,
         "maxCacheEntries"
      );
   }

   hash(path: string, size: number, modifiedMs: number): Promise<string> {
      if (this.closed) {
         return Promise.reject(new Error("Source hash pool is closed"));
      }

      assertSource(path, size, modifiedMs);
      const key = cacheKey(path, size, modifiedMs);
      const cached = this.cache.get(key);

      if (cached) {
         this.cache.delete(key);
         this.cache.set(key, cached);
         return Promise.resolve(cached);
      }

      const existing = this.inFlight.get(key);

      if (existing) {
         return existing;
      }

      const pending = new Promise<string>((resolve, reject) => {
         this.queue.push({
            key,
            path,
            size,
            modifiedMs,
            resolve,
            reject
         });
         this.drain();
      }).finally(() => {
         this.inFlight.delete(key);
      });

      this.inFlight.set(key, pending);
      return pending;
   }

   diagnostics(): {
      workers: number;
      queued: number;
      cacheEntries: number;
      jobsStarted: number;
   } {
      return {
         workers: this.active,
         queued: this.queue.length,
         cacheEntries: this.cache.size,
         jobsStarted: this.started
      };
   }

   async close(): Promise<void> {
      if (this.closed) {
         return;
      }

      this.closed = true;

      for (const task of this.queue.splice(0)) {
         task.reject(new Error("Source hash pool is closed"));
      }

      await Promise.all([...this.workers].map((worker) => worker.terminate().then(() => undefined)));
      this.cache.clear();
   }

   private drain(): void {
      while (!this.closed && this.active < this.maxWorkers) {
         const task = this.queue.shift();

         if (!task) {
            return;
         }

         this.active += 1;
         this.started += 1;
         void this.run(task).finally(() => {
            this.active -= 1;
            this.drain();
         });
      }
   }

   private async run(task: HashTask): Promise<void> {
      try {
         const digest = await this.runWorker(task);

         if (!digestPattern.test(digest)) {
            throw new Error("Source hash worker returned an invalid digest");
         }

         this.cache.set(task.key, digest);
         this.trimCache();
         task.resolve(digest);
      } catch (error) {
         task.reject(error instanceof Error ? error : new Error("Source hashing failed"));
      }
   }

   private runWorker(task: HashTask): Promise<string> {
      return new Promise((resolve, reject) => {
         const worker = new Worker(workerSource, {
            eval: true,
            workerData: {
               path: task.path,
               size: task.size,
               modifiedMs: task.modifiedMs
            }
         });
         let settled = false;
         const finish = (callback: () => void): void => {
            if (settled) {
               return;
            }

            settled = true;
            this.workers.delete(worker);
            callback();
         };

         this.workers.add(worker);
         worker.once("message", (message: unknown) => {
            finish(() => {
               const result = message as { digest?: unknown; error?: unknown };

               if (typeof result.digest === "string") {
                  resolve(result.digest);
               } else {
                  reject(new Error(typeof result.error === "string" ? result.error : "Source hashing failed"));
               }
            });
         });
         worker.once("error", (error) => finish(() => reject(error)));
         worker.once("exit", (code) => {
            if (code !== 0) {
               finish(() => reject(new Error("Source hash worker exited with code " + code)));
            }
         });
      });
   }

   private trimCache(): void {
      while (this.cache.size > this.maxCacheEntries) {
         const oldest = this.cache.keys().next().value as string | undefined;

         if (!oldest) {
            return;
         }

         this.cache.delete(oldest);
      }
   }
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(name + " must be a positive integer");
   }

   return value;
}

function assertSource(path: string, size: number, modifiedMs: number): void {
   if (
      path.length === 0
      || !Number.isSafeInteger(size)
      || size < 0
      || !Number.isSafeInteger(modifiedMs)
      || modifiedMs < 0
   ) {
      throw new TypeError("Invalid source hash request");
   }
}

function cacheKey(path: string, size: number, modifiedMs: number): string {
   return [path, String(size), String(modifiedMs)].join("\u0000");
}

const workerSource = [
   "const { createHash } = require('node:crypto');",
   "const { createReadStream } = require('node:fs');",
   "const { stat } = require('node:fs/promises');",
   "const { parentPort, workerData } = require('node:worker_threads');",
   "async function run() {",
   "  const before = await stat(workerData.path);",
   "  if (!before.isFile() || before.size !== workerData.size || Math.trunc(before.mtimeMs) !== workerData.modifiedMs) throw new Error('Source file changed before hashing');",
   "  const hash = createHash('sha256');",
   "  for await (const chunk of createReadStream(workerData.path)) hash.update(chunk);",
   "  const after = await stat(workerData.path);",
   "  if (!after.isFile() || after.size !== workerData.size || Math.trunc(after.mtimeMs) !== workerData.modifiedMs) throw new Error('Source file changed while hashing');",
   "  parentPort.postMessage({ digest: hash.digest('hex') });",
   "}",
   "run().catch((error) => parentPort.postMessage({ error: error instanceof Error ? error.message : 'Source hashing failed' }));"
].join("\n");
