import type { LocalNetworkCandidate } from "./types.ts";

export const durableUploadProtocol = "lft-resume-v1";
export const sha256Base64UrlLength = 43;
export const sharedTextMaxBytes = 64 * 1024;

export type RoomItemDirection = "windows_to_device" | "device_to_windows";
export type RoomItemState = "pending" | "transferring" | "ready" | "failed" | "cancelled";
export type RoomEventType =
   | "snapshot"
   | "peer-joined"
   | "item-added"
   | "item-progress"
   | "item-complete"
   | "item-failed"
   | "item-cancelled"
   | "shared-text-updated"
   | "room-reset"
   | "room-expired";

export interface RoomItemView {
   itemId: string;
   direction: RoomItemDirection;
   name: string;
   type: string;
   size: number;
   lastModified: number;
   confirmedBytes: number;
   sha256?: string;
   state: RoomItemState;
   error?: string;
   createdAt: number;
   completedAt?: number;
   fingerprint?: string;
   updatedAt?: number;
}

export interface RoomView {
   roomId: string;
   createdAt: number;
   expiresAt: number;
   hardExpiresAt: number;
   eventId: number;
   sharedTextRevision: number;
   items: RoomItemView[];
}

export interface RoomEvent {
   id: number;
   t: RoomEventType;
   room?: RoomView;
   itemId?: string;
   sharedTextRevision?: number;
   message?: string;
   createdAt: number;
}

export interface RoomSharedText {
   content: string;
   revision: number;
   updatedAt: number;
}

export interface UpdateRoomSharedTextRequest {
   content: string;
   expectedRevision: number;
}

export interface SharedTextConflictResponse {
   error: string;
   current: RoomSharedText;
}

export interface RoomBootstrap {
   roomId: string;
   token: string;
   joinUrl: string;
   expiresAt: number;
}

export interface RoomFileMetadata {
   name: string;
   type: string;
   size: number;
   lastModified: number;
}

export interface RegisterRoomUploadRequest extends RoomFileMetadata {
   fingerprint: string;
}

export interface DesktopSourceFile extends RoomFileMetadata {
   path: string;
}

export interface RegisterRoomUploadResponse {
   item: RoomItemView;
}

export interface UploadChunkResponse {
   item: RoomItemView;
   confirmedOffset: number;
}

export interface DurableUploadStatus {
   itemId: string;
   fingerprint: string;
   offset: number;
   length: number;
   state: RoomItemState;
}

export interface UploadRecoveryDiagnostics {
   startupTruncations: number;
   startupTruncatedBytes: number;
   startupRewinds: number;
   startupRewoundBytes: number;
   checkpointRollbacks: number;
   idempotentReplays: number;
   recoveredCompletions: number;
}

export interface RoomDiagnosticSnapshot {
   version: string;
   protocol: typeof durableUploadProtocol;
   uptimeSeconds: number;
   port: number;
   serviceRestarts: number;
   rooms: number;
   items: number;
   transferringItems: number;
   activeWrites: number;
   activeReads: number;
   diskSpace: "ok" | "low" | "unavailable";
   recovery: UploadRecoveryDiagnostics;
   sourceHash: {
      workers: number;
      queued: number;
      cacheEntries: number;
      jobsStarted: number;
   };
   structuredLog: "ready" | "unavailable";
   recentErrorCodes: string[];
   lanCandidates: LocalNetworkCandidate[];
   generatedAt: number;
}

export interface RoomLimits {
   maxFiles: number;
   maxFileSize: number;
   maxRoomSize: number;
   uploadChunkSize: number;
}

const roomIdPattern = /^[A-Za-z0-9_-]{12,128}$/u;
const itemIdPattern = roomIdPattern;

export function parseRoomId(value: unknown): string {
   if (typeof value !== "string" || !roomIdPattern.test(value)) {
      throw new TypeError("Invalid room id");
   }

   return value;
}

export function parseRoomItemId(value: unknown): string {
   if (typeof value !== "string" || !itemIdPattern.test(value)) {
      throw new TypeError("Invalid item id");
   }

   return value;
}

export function parseRoomToken(value: unknown): string {
   if (typeof value !== "string" || !roomIdPattern.test(value) || value.length < 32) {
      throw new TypeError("Invalid room capability");
   }

   return value;
}

export function parseRoomFileMetadata(value: unknown): RoomFileMetadata {
   const record = requireRecord(value);
   const name = stringField(record, "name", 1, 255);
   const type = optionalStringField(record, "type", 255) ?? "application/octet-stream";
   const size = integerField(record, "size", 0, Number.MAX_SAFE_INTEGER);
   const lastModified = optionalIntegerField(record, "lastModified", 0, Number.MAX_SAFE_INTEGER) ?? Date.now();

   return {
      name,
      type,
      size,
      lastModified
   };
}

export function parseRegisterRoomUploadRequest(value: unknown): RegisterRoomUploadRequest {
   const record = requireRecord(value);

   return {
      ...parseRoomFileMetadata(record),
      fingerprint: parseUploadFingerprint(record.fingerprint)
   };
}

export function parseUploadFingerprint(value: unknown): string {
   if (
      typeof value !== "string"
      || value.length !== sha256Base64UrlLength
      || !/^[A-Za-z0-9_-]+$/u.test(value)
   ) {
      throw new TypeError("Invalid upload fingerprint");
   }

   return value;
}

export function parseSha256Base64(value: unknown): string {
   if (
      typeof value !== "string"
      || value.length !== 44
      || !/^[A-Za-z0-9+/]{43}=$/u.test(value)
   ) {
      throw new TypeError("Invalid SHA-256 checksum");
   }

   return value;
}

export function parseDesktopSourceFiles(value: unknown): DesktopSourceFile[] {
   if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError("Choose at least one file");
   }

   return value.map((candidate) => {
      const record = requireRecord(candidate);
      const metadata = parseRoomFileMetadata(record);

      return {
         ...metadata,
         path: stringField(record, "path", 1, 32_767)
      };
   });
}

export function parseAuthorizeRoomRequest(value: unknown): { token: string } {
   const record = requireRecord(value);

   return {
      token: parseRoomToken(record.token)
   };
}

export function parseUpdateRoomSharedTextRequest(value: unknown): UpdateRoomSharedTextRequest {
   const record = requireRecord(value);
   const rawContent = stringField(record, "content", 0, sharedTextMaxBytes);
   const content = rawContent.replace(/\r\n?/gu, "\n");

   if (utf8ByteLength(content) > sharedTextMaxBytes) {
      throw new TypeError("Shared text exceeds the 64 KiB limit");
   }

   return {
      content,
      expectedRevision: integerField(record, "expectedRevision", 0, Number.MAX_SAFE_INTEGER)
   };
}

export function utf8ByteLength(value: string): number {
   return new TextEncoder().encode(value).byteLength;
}

function requireRecord(value: unknown): Record<string, unknown> {
   if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
   }

   return value as Record<string, unknown>;
}

function stringField(
   record: Record<string, unknown>,
   field: string,
   minimumLength: number,
   maximumLength: number
): string {
   const value = record[field];

   if (
      typeof value !== "string"
      || value.length < minimumLength
      || value.length > maximumLength
      || value.includes("\u0000")
   ) {
      throw new TypeError(`Invalid ${field}`);
   }

   return value;
}

function optionalStringField(
   record: Record<string, unknown>,
   field: string,
   maximumLength: number
): string | undefined {
   return record[field] === undefined
      ? undefined
      : stringField(record, field, 0, maximumLength);
}

function integerField(
   record: Record<string, unknown>,
   field: string,
   minimum: number,
   maximum: number
): number {
   const value = record[field];

   if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      throw new TypeError(`Invalid ${field}`);
   }

   return value as number;
}

function optionalIntegerField(
   record: Record<string, unknown>,
   field: string,
   minimum: number,
   maximum: number
): number | undefined {
   return record[field] === undefined
      ? undefined
      : integerField(record, field, minimum, maximum);
}
