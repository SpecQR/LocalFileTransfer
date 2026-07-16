import type {
   DesktopSourceFile,
   RoomBootstrap,
   RoomLimits,
   RoomView
} from "../../../packages/protocol/src/index.ts";

export interface ServiceInitPayload {
   version: string;
   serviceRestarts: number;
   portStart: number;
   maxPortAttempts: number;
   storageDir: string;
   receiveDir: string;
   staticRoot: string;
   ttlMs: number;
   hardTtlMs: number;
   limits: RoomLimits;
}

export interface ServiceRuntime {
   port: number;
   localUrl: string;
   lanUrls: string[];
   receiveDir: string;
   logDir: string;
}

export type ServiceAction =
   | "initialize"
   | "create-room"
   | "resume-room"
   | "issue-ticket"
   | "add-files"
   | "reset-room"
   | "network-status"
   | "diagnostics"
   | "completed-path"
   | "shutdown";

export interface ServiceRequest {
   requestId: string;
   action: ServiceAction;
   payload?: unknown;
}

export interface ServiceResponse {
   requestId: string;
   ok: boolean;
   result?: unknown;
   error?: string;
}

export interface ServiceRoomResult {
   roomId: string;
   token: string;
   expiresAt: number;
}

export interface ServiceTicketResult {
   ticket: string;
   expiresAt: number;
}

export interface AddFilesPayload {
   roomId: string;
   token: string;
   files: DesktopSourceFile[];
}

export interface ResumeRoomPayload {
   roomId: string;
   token: string;
   appBaseUrl: string;
}

export interface CreateRoomPayload {
   appBaseUrl: string;
}

export interface ResetRoomPayload extends ResumeRoomPayload {}

export interface CompletedPathPayload {
   roomId: string;
   itemId: string;
}

export interface DesktopRoomBootstrap extends Omit<RoomBootstrap, "token"> {
   view?: RoomView;
}
