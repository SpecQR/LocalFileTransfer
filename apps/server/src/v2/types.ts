import type {
   RoomEvent,
   RoomItemDirection,
   RoomItemState
} from "../../../../packages/protocol/src/index.ts";

export interface PersistedRoom {
   roomId: string;
   tokenHash: string;
   appBaseUrl: string;
   destinationDir: string;
   createdAt: number;
   lastActivityAt: number;
   expiresAt: number;
   hardExpiresAt: number;
   status: "active" | "closed" | "expired";
   eventId: number;
}

export interface PersistedRoomItem {
   itemId: string;
   roomId: string;
   direction: RoomItemDirection;
   name: string;
   type: string;
   size: number;
   lastModified: number;
   confirmedBytes: number;
   sha256?: string;
   state: RoomItemState;
   error?: string;
   sourcePath?: string;
   sourceModifiedMs?: number;
   partialPath?: string;
   finalPath?: string;
   createdAt: number;
   completedAt?: number;
   fingerprint?: string;
   lastChunkDigest?: string;
   updatedAt?: number;
}

export interface PersistedSharedTextCiphertext {
   roomId: string;
   revision: number;
   nonce: Buffer;
   ciphertext: Buffer;
   authTag: Buffer;
   updatedAt: number;
}

export interface PersistedUploadCommit {
   itemId: string;
   idempotencyKey: string;
   startOffset: number;
   endOffset: number;
   checksum: string;
   createdAt: number;
}

export interface RoomRepository {
   initialize(): Promise<void>;
   close(): void;
   createRoom(room: PersistedRoom): void;
   updateRoom(room: PersistedRoom): void;
   getRoom(roomId: string): PersistedRoom | undefined;
   getLatestActiveRoom(now: number): PersistedRoom | undefined;
   listActiveRooms(now: number): PersistedRoom[];
   listExpiredRoomIds(now: number): string[];
   insertItem(item: PersistedRoomItem): void;
   updateItem(item: PersistedRoomItem): void;
   commitUploadCheckpoint(item: PersistedRoomItem, commit: PersistedUploadCommit): void;
   getUploadCommit(itemId: string, idempotencyKey: string): PersistedUploadCommit | undefined;
   deleteUploadCommitsAfter(itemId: string, offset: number): void;
   deleteUploadCommitsBefore(cutoff: number): void;
   trimUploadCommits(itemId: string, keep: number): void;
   getItem(roomId: string, itemId: string): PersistedRoomItem | undefined;
   listItems(roomId: string): PersistedRoomItem[];
   getSharedText(roomId: string): PersistedSharedTextCiphertext | undefined;
   replaceSharedText(value: PersistedSharedTextCiphertext, expectedRevision: number): boolean;
   saveTicket(roomId: string, ticketHash: string, expiresAt: number): void;
   hasTicket(roomId: string, ticketHash: string, now: number): boolean;
   appendEvent(roomId: string, event: RoomEvent): void;
   listEventsAfter(roomId: string, eventId: number, limit: number): RoomEvent[];
   trimEvents(roomId: string, keep: number): void;
   deleteRoom(roomId: string): void;
}
