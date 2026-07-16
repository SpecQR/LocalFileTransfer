const databaseName = "local-file-transfer";
const databaseVersion = 1;
const storeName = "upload-resume";
const localStorageKey = "lft-upload-resume-v1";
const maximumRecords = 64;
const maximumAgeMs = 24 * 60 * 60 * 1000;

export interface UploadResumeRecord {
   roomId: string;
   fingerprint: string;
   itemId: string;
   offset: number;
   updatedAt: number;
}

export interface UploadResumeStore {
   get(roomId: string, fingerprint: string): Promise<UploadResumeRecord | undefined>;
   put(record: UploadResumeRecord): Promise<void>;
   delete(roomId: string, fingerprint: string): Promise<void>;
   prune(now?: number): Promise<void>;
}

export function createUploadResumeStore(): UploadResumeStore {
   if (typeof indexedDB !== "undefined") {
      return new IndexedDbUploadResumeStore();
   }

   return new LocalUploadResumeStore();
}

export class MemoryUploadResumeStore implements UploadResumeStore {
   protected readonly records = new Map<string, UploadResumeRecord>();

   async get(roomId: string, fingerprint: string): Promise<UploadResumeRecord | undefined> {
      const record = this.records.get(recordKey(roomId, fingerprint));

      return record ? { ...record } : undefined;
   }

   async put(record: UploadResumeRecord): Promise<void> {
      assertRecord(record);
      this.records.set(recordKey(record.roomId, record.fingerprint), { ...record });
      await this.prune(record.updatedAt);
   }

   async delete(roomId: string, fingerprint: string): Promise<void> {
      this.records.delete(recordKey(roomId, fingerprint));
   }

   async prune(now = Date.now()): Promise<void> {
      const current = [...this.records.values()]
         .filter((record) => now - record.updatedAt <= maximumAgeMs)
         .sort((left, right) => right.updatedAt - left.updatedAt)
         .slice(0, maximumRecords);

      this.records.clear();

      for (const record of current) {
         this.records.set(recordKey(record.roomId, record.fingerprint), record);
      }
   }
}

class LocalUploadResumeStore extends MemoryUploadResumeStore {
   constructor() {
      super();
      this.load();
   }

   override async put(record: UploadResumeRecord): Promise<void> {
      await super.put(record);
      this.save();
   }

   override async delete(roomId: string, fingerprint: string): Promise<void> {
      await super.delete(roomId, fingerprint);
      this.save();
   }

   override async prune(now = Date.now()): Promise<void> {
      await super.prune(now);
      this.save();
   }

   private load(): void {
      try {
         const value = globalThis.localStorage?.getItem(localStorageKey);
         const records = value ? JSON.parse(value) as unknown : [];

         if (!Array.isArray(records)) {
            return;
         }

         for (const record of records) {
            assertRecord(record);
            this.records.set(recordKey(record.roomId, record.fingerprint), record);
         }
      } catch {
         this.records.clear();
      }
   }

   private save(): void {
      try {
         globalThis.localStorage?.setItem(localStorageKey, JSON.stringify([...this.records.values()]));
      } catch {
         // Resume metadata is a convenience; upload correctness never depends on local storage.
      }
   }
}

class IndexedDbUploadResumeStore implements UploadResumeStore {
   async get(roomId: string, fingerprint: string): Promise<UploadResumeRecord | undefined> {
      const database = await openDatabase();

      try {
         return await requestResult<UploadResumeRecord | undefined>(
            database.transaction(storeName).objectStore(storeName).get(recordKey(roomId, fingerprint))
         );
      } finally {
         database.close();
      }
   }

   async put(record: UploadResumeRecord): Promise<void> {
      assertRecord(record);
      const database = await openDatabase();

      try {
         await transactionDone(database, "readwrite", (store) => store.put({
            ...record,
            key: recordKey(record.roomId, record.fingerprint)
         }));
      } finally {
         database.close();
      }

      await this.prune(record.updatedAt);
   }

   async delete(roomId: string, fingerprint: string): Promise<void> {
      const database = await openDatabase();

      try {
         await transactionDone(database, "readwrite", (store) => store.delete(recordKey(roomId, fingerprint)));
      } finally {
         database.close();
      }
   }

   async prune(now = Date.now()): Promise<void> {
      const database = await openDatabase();

      try {
         const records = await requestResult<Array<UploadResumeRecord & { key: string }>>(
            database.transaction(storeName).objectStore(storeName).getAll()
         );
         const keep = new Set(records
            .filter((record) => now - record.updatedAt <= maximumAgeMs)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, maximumRecords)
            .map((record) => record.key));

         await transactionDone(database, "readwrite", (store) => {
            for (const record of records) {
               if (!keep.has(record.key)) {
                  store.delete(record.key);
               }
            }
         });
      } finally {
         database.close();
      }
   }
}

function openDatabase(): Promise<IDBDatabase> {
   return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);

      request.onupgradeneeded = () => {
         if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName, { keyPath: "key" });
         }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open upload resume storage"));
   });
}

function transactionDone(
   database: IDBDatabase,
   mode: IDBTransactionMode,
   operation: (store: IDBObjectStore) => IDBRequest | void
): Promise<void> {
   return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);

      operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Upload resume storage failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Upload resume storage was aborted"));
   });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
   return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Upload resume storage request failed"));
   });
}

function recordKey(roomId: string, fingerprint: string): string {
   return `${roomId}:${fingerprint}`;
}

function assertRecord(value: unknown): asserts value is UploadResumeRecord {
   const record = value as Partial<UploadResumeRecord> | undefined;

   if (
      !record
      || typeof record.roomId !== "string"
      || typeof record.fingerprint !== "string"
      || typeof record.itemId !== "string"
      || !Number.isSafeInteger(record.offset)
      || (record.offset ?? -1) < 0
      || !Number.isSafeInteger(record.updatedAt)
   ) {
      throw new TypeError("Invalid upload resume record");
   }
}
