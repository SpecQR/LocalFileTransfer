import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoomEvent } from "../../../../packages/protocol/src/index.ts";
import type {
   PersistedRoom,
   PersistedRoomItem,
   PersistedSharedTextCiphertext,
   PersistedUploadCommit,
   RoomRepository
} from "./types.ts";

const schemaVersion = 3;

export type UploadCommitFaultPhase = "after-item-update" | "before-commit";

export interface SqliteRoomRepositoryOptions {
   uploadCommitFault?: (
      phase: UploadCommitFaultPhase,
      context: { itemId: string; endOffset: number }
   ) => void;
}

export class SqliteRoomRepository implements RoomRepository {
   private readonly path: string;
   private readonly uploadCommitFault: SqliteRoomRepositoryOptions["uploadCommitFault"];
   private database: DatabaseSync | undefined;

   constructor(path: string, options: SqliteRoomRepositoryOptions = {}) {
      this.path = path;
      this.uploadCommitFault = options.uploadCommitFault;
   }

   async initialize(): Promise<void> {
      await mkdir(dirname(this.path), { recursive: true });
      const database = new DatabaseSync(this.path, {
         timeout: 5_000
      });

      database.exec("PRAGMA journal_mode=WAL");
      database.exec("PRAGMA foreign_keys=ON");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA busy_timeout=5000");
      const row = database.prepare("PRAGMA user_version").get() as { user_version: number };

      if (row.user_version > schemaVersion) {
         database.close();
         throw new Error(`Room database version ${row.user_version} is newer than supported version ${schemaVersion}`);
      }

      if (row.user_version < 1) {
         database.exec("BEGIN IMMEDIATE");

         try {
            database.exec(`
               CREATE TABLE rooms (
                  room_id TEXT PRIMARY KEY,
                  token_hash TEXT NOT NULL,
                  app_base_url TEXT NOT NULL,
                  destination_dir TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  last_activity_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  hard_expires_at INTEGER NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'expired')),
                  event_id INTEGER NOT NULL DEFAULT 0
               ) STRICT;

               CREATE TABLE room_items (
                  item_id TEXT PRIMARY KEY,
                  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
                  direction TEXT NOT NULL CHECK(direction IN ('windows_to_device', 'device_to_windows')),
                  name TEXT NOT NULL,
                  type TEXT NOT NULL,
                  size INTEGER NOT NULL,
                  last_modified INTEGER NOT NULL,
                  confirmed_bytes INTEGER NOT NULL,
                  sha256 TEXT,
                  state TEXT NOT NULL CHECK(state IN ('pending', 'transferring', 'ready', 'failed', 'cancelled')),
                  error TEXT,
                  source_path TEXT,
                  source_modified_ms INTEGER,
                  partial_path TEXT,
                  final_path TEXT,
                  created_at INTEGER NOT NULL,
                  completed_at INTEGER
               ) STRICT;

               CREATE INDEX room_items_room_created
                  ON room_items(room_id, created_at, item_id);

               CREATE TABLE room_tickets (
                  ticket_hash TEXT PRIMARY KEY,
                  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
                  expires_at INTEGER NOT NULL
               ) STRICT;

               CREATE INDEX room_tickets_room
                  ON room_tickets(room_id, expires_at);

               CREATE TABLE room_events (
                  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
                  event_id INTEGER NOT NULL,
                  event_json TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  PRIMARY KEY(room_id, event_id)
               ) STRICT;

               PRAGMA user_version=1;
            `);
            database.exec("COMMIT");
         } catch (error) {
            database.exec("ROLLBACK");
            database.close();
            throw error;
         }
      }

      if (row.user_version < 2) {
         database.exec("BEGIN IMMEDIATE");

         try {
            database.exec(`
               ALTER TABLE room_items ADD COLUMN fingerprint TEXT;
               ALTER TABLE room_items ADD COLUMN last_chunk_digest TEXT;
               ALTER TABLE room_items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

               UPDATE room_items SET updated_at = created_at WHERE updated_at = 0;

               CREATE INDEX room_items_room_fingerprint
                  ON room_items(room_id, direction, fingerprint);

               CREATE TABLE upload_commits (
                  item_id TEXT NOT NULL REFERENCES room_items(item_id) ON DELETE CASCADE,
                  idempotency_key TEXT NOT NULL,
                  start_offset INTEGER NOT NULL,
                  end_offset INTEGER NOT NULL,
                  checksum TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  PRIMARY KEY(item_id, idempotency_key)
               ) STRICT;

               CREATE INDEX upload_commits_item_offset
                  ON upload_commits(item_id, end_offset);

               PRAGMA user_version=2;
            `);
            database.exec("COMMIT");
         } catch (error) {
            database.exec("ROLLBACK");
            database.close();
            throw error;
         }
      }

      if (row.user_version < 3) {
         database.exec("BEGIN IMMEDIATE");

         try {
            database.exec(`
               CREATE TABLE room_shared_text (
                  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
                  revision INTEGER NOT NULL CHECK(revision > 0),
                  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
                  ciphertext BLOB NOT NULL,
                  auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
                  updated_at INTEGER NOT NULL
               ) STRICT;

               PRAGMA user_version=3;
            `);
            database.exec("COMMIT");
         } catch (error) {
            database.exec("ROLLBACK");
            database.close();
            throw error;
         }
      }

      const defensiveDatabase = database as DatabaseSync & { enableDefensive?: (active: boolean) => void };

      defensiveDatabase.enableDefensive?.(true);
      this.database = database;
   }

   close(): void {
      this.database?.close();
      this.database = undefined;
   }

   createRoom(room: PersistedRoom): void {
      this.db().prepare(`
         INSERT INTO rooms (
            room_id, token_hash, app_base_url, destination_dir, created_at,
            last_activity_at, expires_at, hard_expires_at, status, event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
         room.roomId,
         room.tokenHash,
         room.appBaseUrl,
         room.destinationDir,
         room.createdAt,
         room.lastActivityAt,
         room.expiresAt,
         room.hardExpiresAt,
         room.status,
         room.eventId
      );
   }

   updateRoom(room: PersistedRoom): void {
      this.db().prepare(`
         UPDATE rooms SET
            token_hash = ?,
            app_base_url = ?,
            destination_dir = ?,
            last_activity_at = ?,
            expires_at = ?,
            hard_expires_at = ?,
            status = ?,
            event_id = ?
         WHERE room_id = ?
      `).run(
         room.tokenHash,
         room.appBaseUrl,
         room.destinationDir,
         room.lastActivityAt,
         room.expiresAt,
         room.hardExpiresAt,
         room.status,
         room.eventId,
         room.roomId
      );
   }

   getRoom(roomId: string): PersistedRoom | undefined {
      return mapRoom(this.db().prepare("SELECT * FROM rooms WHERE room_id = ?").get(roomId));
   }

   getLatestActiveRoom(now: number): PersistedRoom | undefined {
      return mapRoom(this.db().prepare(`
         SELECT * FROM rooms
         WHERE status = 'active' AND expires_at > ? AND hard_expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1
      `).get(now, now));
   }

   listActiveRooms(now: number): PersistedRoom[] {
      return this.db().prepare(`
         SELECT * FROM rooms
         WHERE status = 'active' AND expires_at > ? AND hard_expires_at > ?
         ORDER BY created_at
      `).all(now, now).map((row) => mapRoom(row) as PersistedRoom);
   }
   listExpiredRoomIds(now: number): string[] {
      return (this.db().prepare(`
         SELECT room_id FROM rooms
         WHERE status = 'active' AND (expires_at <= ? OR hard_expires_at <= ?)
      `).all(now, now) as Array<{ room_id: string }>).map((row) => row.room_id);
   }

   insertItem(item: PersistedRoomItem): void {
      this.db().prepare(`
         INSERT INTO room_items (
            item_id, room_id, direction, name, type, size, last_modified,
            confirmed_bytes, sha256, state, error, source_path, source_modified_ms,
            partial_path, final_path, created_at, completed_at, fingerprint,
            last_chunk_digest, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...itemValues(item));
   }

   updateItem(item: PersistedRoomItem): void {
      const values = itemValues(item);

      this.db().prepare(`
         UPDATE room_items SET
            room_id = ?, direction = ?, name = ?, type = ?, size = ?,
            last_modified = ?, confirmed_bytes = ?, sha256 = ?, state = ?,
            error = ?, source_path = ?, source_modified_ms = ?, partial_path = ?,
            final_path = ?, created_at = ?, completed_at = ?, fingerprint = ?,
            last_chunk_digest = ?, updated_at = ?
         WHERE item_id = ?
      `).run(...values.slice(1), item.itemId);
   }

   commitUploadCheckpoint(item: PersistedRoomItem, commit: PersistedUploadCommit): void {
      const database = this.db();

      database.exec("BEGIN IMMEDIATE");

      try {
         this.updateItem(item);
         this.uploadCommitFault?.("after-item-update", {
            itemId: item.itemId,
            endOffset: commit.endOffset
         });
         database.prepare(`
            INSERT INTO upload_commits(
               item_id, idempotency_key, start_offset, end_offset, checksum, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
         `).run(
            commit.itemId,
            commit.idempotencyKey,
            commit.startOffset,
            commit.endOffset,
            commit.checksum,
            commit.createdAt
         );
         this.uploadCommitFault?.("before-commit", {
            itemId: item.itemId,
            endOffset: commit.endOffset
         });
         database.exec("COMMIT");
      } catch (error) {
         database.exec("ROLLBACK");
         throw error;
      }
   }

   getUploadCommit(itemId: string, idempotencyKey: string): PersistedUploadCommit | undefined {
      const row = this.db().prepare(`
         SELECT * FROM upload_commits
         WHERE item_id = ? AND idempotency_key = ?
      `).get(itemId, idempotencyKey) as UploadCommitRow | undefined;

      return row ? mapUploadCommit(row) : undefined;
   }

   deleteUploadCommitsAfter(itemId: string, offset: number): void {
      this.db().prepare(`
         DELETE FROM upload_commits WHERE item_id = ? AND end_offset > ?
      `).run(itemId, offset);
   }

   deleteUploadCommitsBefore(cutoff: number): void {
      this.db().prepare("DELETE FROM upload_commits WHERE created_at < ?").run(cutoff);
   }

   trimUploadCommits(itemId: string, keep: number): void {
      this.db().prepare(`
         DELETE FROM upload_commits
         WHERE item_id = ? AND idempotency_key NOT IN (
            SELECT idempotency_key FROM upload_commits
            WHERE item_id = ?
            ORDER BY end_offset DESC, created_at DESC
            LIMIT ?
         )
      `).run(itemId, itemId, keep);
   }
   getItem(roomId: string, itemId: string): PersistedRoomItem | undefined {
      return mapItem(this.db().prepare(`
         SELECT * FROM room_items WHERE room_id = ? AND item_id = ?
      `).get(roomId, itemId));
   }

   listItems(roomId: string): PersistedRoomItem[] {
      return this.db().prepare(`
         SELECT * FROM room_items
         WHERE room_id = ?
         ORDER BY created_at, item_id
      `).all(roomId).map(mapItem);
   }

   getSharedText(roomId: string): PersistedSharedTextCiphertext | undefined {
      const row = this.db().prepare(`
         SELECT * FROM room_shared_text WHERE room_id = ?
      `).get(roomId) as SharedTextRow | undefined;

      return row ? mapSharedText(row) : undefined;
   }

   replaceSharedText(value: PersistedSharedTextCiphertext, expectedRevision: number): boolean {
      const database = this.db();

      database.exec("BEGIN IMMEDIATE");

      try {
         const current = database.prepare(`
            SELECT revision FROM room_shared_text WHERE room_id = ?
         `).get(value.roomId) as { revision: number } | undefined;

         if ((current?.revision ?? 0) !== expectedRevision) {
            database.exec("ROLLBACK");
            return false;
         }

         database.prepare(`
            INSERT INTO room_shared_text(
               room_id, revision, nonce, ciphertext, auth_tag, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(room_id) DO UPDATE SET
               revision = excluded.revision,
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               auth_tag = excluded.auth_tag,
               updated_at = excluded.updated_at
         `).run(
            value.roomId,
            value.revision,
            value.nonce,
            value.ciphertext,
            value.authTag,
            value.updatedAt
         );
         database.exec("COMMIT");
         return true;
      } catch (error) {
         database.exec("ROLLBACK");
         throw error;
      }
   }

   saveTicket(roomId: string, ticketHash: string, expiresAt: number): void {
      this.db().prepare(`
         INSERT INTO room_tickets(ticket_hash, room_id, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ticket_hash) DO UPDATE SET expires_at = excluded.expires_at
      `).run(ticketHash, roomId, expiresAt);
   }

   hasTicket(roomId: string, ticketHash: string, now: number): boolean {
      const result = this.db().prepare(`
         SELECT 1 AS valid FROM room_tickets
         WHERE room_id = ? AND ticket_hash = ? AND expires_at > ?
      `).get(roomId, ticketHash, now) as { valid: number } | undefined;

      return result?.valid === 1;
   }

   appendEvent(roomId: string, event: RoomEvent): void {
      this.db().prepare(`
         INSERT INTO room_events(room_id, event_id, event_json, created_at)
         VALUES (?, ?, ?, ?)
      `).run(roomId, event.id, JSON.stringify(event), event.createdAt);
   }

   listEventsAfter(roomId: string, eventId: number, limit: number): RoomEvent[] {
      return (this.db().prepare(`
         SELECT event_json FROM room_events
         WHERE room_id = ? AND event_id > ?
         ORDER BY event_id
         LIMIT ?
      `).all(roomId, eventId, limit) as Array<{ event_json: string }>).map((row) => (
         JSON.parse(row.event_json) as RoomEvent
      ));
   }

   trimEvents(roomId: string, keep: number): void {
      this.db().prepare(`
         DELETE FROM room_events
         WHERE room_id = ? AND event_id <= (
            SELECT COALESCE(MAX(event_id) - ?, -1)
            FROM room_events
            WHERE room_id = ?
         )
      `).run(roomId, keep, roomId);
   }

   deleteRoom(roomId: string): void {
      this.db().prepare("DELETE FROM rooms WHERE room_id = ?").run(roomId);
   }

   private db(): DatabaseSync {
      if (!this.database) {
         throw new Error("Room repository is not initialized");
      }

      return this.database;
   }
}

interface RoomRow {
   room_id: string;
   token_hash: string;
   app_base_url: string;
   destination_dir: string;
   created_at: number;
   last_activity_at: number;
   expires_at: number;
   hard_expires_at: number;
   status: PersistedRoom["status"];
   event_id: number;
}

interface ItemRow {
   item_id: string;
   room_id: string;
   direction: PersistedRoomItem["direction"];
   name: string;
   type: string;
   size: number;
   last_modified: number;
   confirmed_bytes: number;
   sha256: string | null;
   state: PersistedRoomItem["state"];
   error: string | null;
   source_path: string | null;
   source_modified_ms: number | null;
   partial_path: string | null;
   final_path: string | null;
   created_at: number;
   completed_at: number | null;
   fingerprint: string | null;
   last_chunk_digest: string | null;
   updated_at: number;
}

interface SharedTextRow {
   room_id: string;
   revision: number;
   nonce: Uint8Array;
   ciphertext: Uint8Array;
   auth_tag: Uint8Array;
   updated_at: number;
}

interface UploadCommitRow {
   item_id: string;
   idempotency_key: string;
   start_offset: number;
   end_offset: number;
   checksum: string;
   created_at: number;
}

function mapRoom(value: unknown): PersistedRoom | undefined {
   const row = value as RoomRow | undefined;

   return row ? {
      roomId: row.room_id,
      tokenHash: row.token_hash,
      appBaseUrl: row.app_base_url,
      destinationDir: row.destination_dir,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      hardExpiresAt: row.hard_expires_at,
      status: row.status,
      eventId: row.event_id
   } : undefined;
}

function mapItem(value: unknown): PersistedRoomItem {
   const row = value as ItemRow;

   return {
      itemId: row.item_id,
      roomId: row.room_id,
      direction: row.direction,
      name: row.name,
      type: row.type,
      size: row.size,
      lastModified: row.last_modified,
      confirmedBytes: row.confirmed_bytes,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
      ...(row.last_chunk_digest ? { lastChunkDigest: row.last_chunk_digest } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.source_path ? { sourcePath: row.source_path } : {}),
      ...(row.source_modified_ms === null ? {} : { sourceModifiedMs: row.source_modified_ms }),
      ...(row.partial_path ? { partialPath: row.partial_path } : {}),
      ...(row.final_path ? { finalPath: row.final_path } : {}),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
   };
}

function mapSharedText(row: SharedTextRow): PersistedSharedTextCiphertext {
   return {
      roomId: row.room_id,
      revision: row.revision,
      nonce: Buffer.from(row.nonce),
      ciphertext: Buffer.from(row.ciphertext),
      authTag: Buffer.from(row.auth_tag),
      updatedAt: row.updated_at
   };
}

function mapUploadCommit(row: UploadCommitRow): PersistedUploadCommit {
   return {
      itemId: row.item_id,
      idempotencyKey: row.idempotency_key,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      checksum: row.checksum,
      createdAt: row.created_at
   };
}

function itemValues(item: PersistedRoomItem): Array<string | number | null> {
   return [
      item.itemId,
      item.roomId,
      item.direction,
      item.name,
      item.type,
      item.size,
      item.lastModified,
      item.confirmedBytes,
      item.sha256 ?? null,
      item.state,
      item.error ?? null,
      item.sourcePath ?? null,
      item.sourceModifiedMs ?? null,
      item.partialPath ?? null,
      item.finalPath ?? null,
      item.createdAt,
      item.completedAt ?? null,
      item.fingerprint ?? null,
      item.lastChunkDigest ?? null,
      item.updatedAt ?? item.createdAt
   ];
}
