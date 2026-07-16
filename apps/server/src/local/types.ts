import type { Hash } from "node:crypto";
import type {
   CreateSendSessionRequest,
   CreateUploadSessionRequest,
   LocalFileRecord,
   LocalInfoResponse,
   LocalNetworkCandidate,
   LocalSessionEvent,
   LocalSessionEventType,
   LocalSessionKind,
   LocalSessionView,
   LocalTransferLimits,
   RegisterUploadFileRequest
} from "../../../../packages/protocol/src/index.ts";

export type {
   CreateSendSessionRequest,
   CreateUploadSessionRequest,
   LocalFileRecord,
   LocalInfoResponse,
   LocalNetworkCandidate,
   LocalSessionEvent,
   LocalSessionEventType,
   LocalSessionKind,
   LocalSessionView,
   LocalTransferLimits,
   RegisterUploadFileRequest
};

export interface InternalLocalFileRecord extends LocalFileRecord {
   sourcePath?: string;
   sourceModifiedMs?: number;
   storedPath?: string;
   partialPath?: string;
   finalPath?: string;
   temporaryOwned?: boolean;
   uploadHash?: Hash;
}

export interface LocalSession {
   sid: string;
   tokenHash: string;
   kind: LocalSessionKind;
   createdAt: number;
   lastActivityAt: number;
   expiresAt: number;
   hardExpiresAt: number;
   appBaseUrl: string;
   destinationDir: string;
   files: InternalLocalFileRecord[];
   browserTicketHashes: Map<string, number>;
   abortController: AbortController;
}

export type PublicLocalSession = LocalSessionView;