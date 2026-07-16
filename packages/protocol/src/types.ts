export type LocalSessionKind = "send" | "upload";
export type LocalTransferDirection = "windows_to_device" | "device_to_windows";
export type LocalFileState = "pending" | "transferring" | "ready" | "failed";

export interface LocalFileRecord {
   fileId: string;
   name: string;
   type: string;
   size: number;
   lastModified: number;
   receivedSize: number;
   transferredSize?: number;
   sha256?: string;
   ready: boolean;
   state: LocalFileState;
   error?: string;
   createdAt: number;
   storedAt?: number;
}

export interface LocalSessionView {
   sid: string;
   kind: LocalSessionKind;
   createdAt: number;
   expiresAt: number;
   files: LocalFileRecord[];
}

export interface LocalTransferLimits {
   maxFiles: number;
   maxFileSize: number;
   maxSessionSize: number;
   uploadChunkSize: number;
}

export interface LocalInfoResponse {
   port: number;
   lanOrigins: string[];
   lanCandidates: LocalNetworkCandidate[];
   sessionTtlMs: number;
   limits?: LocalTransferLimits;
}

export interface LocalNetworkCandidate {
   origin: string;
   address: string;
   interfaceName: string;
   label: string;
   priority: number;
   warning?: string;
}

export interface CreateSendSessionRequest {
   appBaseUrl: string;
   files: Array<{
      name: string;
      type?: string;
      size: number;
      lastModified?: number;
   }>;
}

export interface CreateUploadSessionRequest {
   appBaseUrl: string;
}

export interface CreateLocalSessionResponse {
   sid: string;
   token: string;
   expiresAt: number;
   url: string;
   files?: LocalFileRecord[];
}

export interface RegisterUploadFileRequest {
   name: string;
   type?: string;
   size: number;
   lastModified?: number;
}

export interface RegisterUploadFileResponse {
   file: LocalFileRecord;
}

export type LocalSessionEventType =
   | "joined"
   | "upload-progress"
   | "download-progress"
   | "file-complete"
   | "session-expired"
   | "session-deleted"
   | "error";

export interface LocalSessionEvent {
   t: LocalSessionEventType;
   session?: LocalSessionView;
   fileId?: string;
   message?: string;
}