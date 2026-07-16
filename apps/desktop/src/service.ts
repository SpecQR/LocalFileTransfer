import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
   durableUploadProtocol,
   parseDesktopSourceFiles,
   parseRoomId,
   parseRoomItemId,
   parseRoomToken,
   type RoomDiagnosticSnapshot
} from "../../../packages/protocol/src/index.ts";
import { buildApp } from "../../server/src/app.ts";
import { lanCandidates, lanOrigins, type ServerConfig } from "../../server/src/config.ts";
import { RoomStore } from "../../server/src/v2/roomStore.ts";
import { SourceHashPool } from "../../server/src/v2/sourceHashPool.ts";
import { SqliteRoomRepository } from "../../server/src/v2/sqliteRoomRepository.ts";
import { RotatingJsonLog } from "../../server/src/observability/rotatingLog.ts";
import type {
   ServiceAction,
   ServiceInitPayload,
   ServiceRequest,
   ServiceResponse,
   ServiceRoomResult,
   ServiceRuntime,
   ServiceTicketResult
} from "./serviceProtocol.ts";

interface ParentPort {
   on(event: "message", listener: (event: { data: unknown }) => void): void;
   postMessage(message: unknown): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

if (!parentPort) {
   throw new Error("Local transfer service must run as an Electron utility process");
}

let app: FastifyInstance | undefined;
let rooms: RoomStore | undefined;
let sourceHashes: SourceHashPool | undefined;
let structuredLog: RotatingJsonLog | undefined;
let structuredLogStatus: "ready" | "unavailable" = "unavailable";
const recentErrorCodes: string[] = [];
let runtime: ServiceRuntime | undefined;
let serviceVersion = "unknown";
let serviceRestarts = 0;
let serviceStartedAt = Date.now();

parentPort.on("message", (event) => {
   void handleMessage(event.data);
});

process.on("SIGTERM", () => {
   void closeService().finally(() => process.exit(0));
});

async function handleMessage(value: unknown): Promise<void> {
   let request: ServiceRequest | undefined;

   try {
      request = parseRequest(value);
      const result = await execute(request.action, request.payload);

      respond({
         requestId: request.requestId,
         ok: true,
         ...(result === undefined ? {} : { result })
      });

      if (request.action === "shutdown") {
         process.exit(0);
      }
   } catch (error) {
      const code = recordServiceError(error);

      writeServiceLog("error", "service-request-failed", {
         action: request?.action ?? "invalid-request",
         code,
         error
      });
      respond({
         requestId: request?.requestId ?? requestIdFromUnknown(value),
         ok: false,
         error: error instanceof Error ? error.message : "Service request failed"
      });
   }
}

async function execute(action: ServiceAction, payload: unknown): Promise<unknown> {
   if (action === "initialize") {
      if (runtime) {
         return runtime;
      }

      const input = parseInitPayload(payload);

      serviceVersion = input.version;
      serviceRestarts = input.serviceRestarts;
      serviceStartedAt = Date.now();
      runtime = await initializeService(input);
      return runtime;
   }

   const activeRooms = requireRooms();

   switch (action) {
      case "create-room": {
         const record = requireRecord(payload);
         const created = await activeRooms.createRoom(requireString(record.appBaseUrl, "appBaseUrl"));

         return roomResult(created.room.roomId, created.token, created.room.expiresAt);
      }
      case "resume-room": {
         const record = requireRecord(payload);
         const room = activeRooms.resumeRoom(
            parseRoomId(record.roomId),
            parseRoomToken(record.token),
            requireString(record.appBaseUrl, "appBaseUrl")
         );

         return roomResult(room.roomId, parseRoomToken(record.token), room.expiresAt);
      }
      case "issue-ticket": {
         const record = requireRecord(payload);
         const issued = activeRooms.issueTicket(
            parseRoomId(record.roomId),
            parseRoomToken(record.token)
         );
         const result: ServiceTicketResult = {
            ticket: issued.ticket,
            expiresAt: issued.expiresAt
         };

         return result;
      }
      case "add-files": {
         const record = requireRecord(payload);

         return activeRooms.addSourceFiles(
            parseRoomId(record.roomId),
            parseRoomToken(record.token),
            parseDesktopSourceFiles(record.files)
         );
      }
      case "reset-room": {
         const record = requireRecord(payload);
         const roomId = parseRoomId(record.roomId);
         const token = parseRoomToken(record.token);
         const appBaseUrl = requireString(record.appBaseUrl, "appBaseUrl");

         await activeRooms.deleteRoom(roomId, token);
         const created = await activeRooms.createRoom(appBaseUrl);

         return roomResult(created.room.roomId, created.token, created.room.expiresAt);
      }
      case "network-status": {
         if (!runtime) {
            throw new Error("Local transfer service is not initialized");
         }

         runtime = {
            ...runtime,
            lanUrls: lanOrigins(runtime.port)
         };
         return runtime;
      }
      case "diagnostics": {
         if (!runtime) {
            throw new Error("Local transfer service is not initialized");
         }

         return diagnosticSnapshot(activeRooms, runtime.port, sourceHashes);
      }
      case "completed-path": {
         const record = requireRecord(payload);
         const path = activeRooms.getCompletedPath(
            parseRoomId(record.roomId),
            parseRoomItemId(record.itemId)
         );

         if (!path) {
            throw new Error("The received file is not available");
         }

         return path;
      }
      case "shutdown":
         await closeService();
         return undefined;
      default:
         throw new Error(`Unsupported service action: ${action satisfies never}`);
   }
}

async function initializeService(input: ServiceInitPayload): Promise<ServiceRuntime> {
   let lastError: unknown;
   const logDir = join(input.storageDir, "logs");

   await initializeStructuredLog(logDir);
   const candidateHashes = new SourceHashPool({ maxWorkers: 2, maxCacheEntries: 256 });

   for (let offset = 0; offset < input.maxPortAttempts; offset += 1) {
      const port = input.portStart + offset;
      const candidateRooms = new RoomStore({
         repository: new SqliteRoomRepository(join(input.storageDir, "rooms.sqlite")),
         rootDir: join(input.storageDir, "v2"),
         receiveDir: input.receiveDir,
         ttlMs: input.ttlMs,
         hardTtlMs: input.hardTtlMs,
         limits: input.limits,
         sourceHasher: candidateHashes
      });
      const config: ServerConfig = {
         port,
         storageDir: join(input.storageDir, "v1"),
         sessionTtlMs: input.ttlMs,
         sessionHardTtlMs: input.hardTtlMs,
         limits: {
            maxFiles: input.limits.maxFiles,
            maxFileSize: input.limits.maxFileSize,
            maxSessionSize: input.limits.maxRoomSize,
            uploadChunkSize: input.limits.uploadChunkSize
         },
         staticRoot: input.staticRoot
      };
      const candidate = await buildApp({
         config,
         rooms: candidateRooms,
         getDiagnostics: () => diagnosticSnapshot(candidateRooms, port, candidateHashes),
         onError: (error, context) => {
            const code = recordServiceError(error, context.statusCode);

            writeServiceLog("error", "http-request-failed", { ...context, code, error });
         }
      });

      candidate.server.maxConnections = 128;
      candidate.server.headersTimeout = 30_000;
      candidate.server.requestTimeout = 120_000;
      candidate.server.keepAliveTimeout = 10_000;
      candidate.server.maxRequestsPerSocket = 1_000;

      try {
         await candidate.listen({
            port,
            host: "0.0.0.0"
         });
         app = candidate;
         rooms = candidateRooms;
         sourceHashes = candidateHashes;

         writeServiceLog("info", "service-ready", {
            port,
            version: serviceVersion,
            serviceRestarts
         });

         return {
            port,
            localUrl: `http://127.0.0.1:${port}`,
            lanUrls: lanOrigins(port),
            receiveDir: input.receiveDir,
            logDir
         };
      } catch (error) {
         lastError = error;
         await candidate.close();

         if (!isAddressInUse(error)) {
            break;
         }
      }
   }

   await candidateHashes.close();
   throw lastError instanceof Error ? lastError : new Error("Could not start the local transfer service");
}

async function diagnosticSnapshot(
   activeRooms: RoomStore,
   port: number,
   hashes: SourceHashPool | undefined
): Promise<RoomDiagnosticSnapshot> {
   return {
      version: serviceVersion,
      protocol: durableUploadProtocol,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - serviceStartedAt) / 1000)),
      port,
      serviceRestarts,
      ...(await activeRooms.diagnosticState()),
      sourceHash: hashes?.diagnostics() ?? {
         workers: 0,
         queued: 0,
         cacheEntries: 0,
         jobsStarted: 0
      },
      structuredLog: structuredLogStatus,
      recentErrorCodes: [...recentErrorCodes],
      lanCandidates: lanCandidates(port),
      generatedAt: Date.now()
   };
}

async function closeService(): Promise<void> {
   const activeApp = app;
   const activeSourceHashes = sourceHashes;
   const activeLog = structuredLog;

   app = undefined;
   rooms = undefined;
   sourceHashes = undefined;
   structuredLog = undefined;
   structuredLogStatus = "unavailable";
   runtime = undefined;

   if (activeApp) {
      await activeApp.close();
   }

   if (activeSourceHashes) {
      await activeSourceHashes.close();
   }

   if (activeLog) {
      await activeLog.write("info", "service-stopped").catch(() => undefined);
      await activeLog.close().catch(() => undefined);
   }
}

async function initializeStructuredLog(directory: string): Promise<void> {
   if (structuredLog) {
      return;
   }

   const candidate = new RotatingJsonLog(directory);

   try {
      await candidate.initialize();
      structuredLog = candidate;
      structuredLogStatus = "ready";
      await candidate.write("info", "service-starting", {
         version: serviceVersion,
         serviceRestarts
      });
   } catch {
      structuredLogStatus = "unavailable";
      recordErrorCode("log-unavailable");
   }
}

function writeServiceLog(
   level: "info" | "warn" | "error",
   event: string,
   details?: unknown
): void {
   if (!structuredLog) {
      return;
   }

   void structuredLog.write(level, event, details).catch(() => {
      structuredLogStatus = "unavailable";
      recordErrorCode("log-write-failed");
   });
}

function recordServiceError(error: unknown, explicitStatus?: number): string {
   const record = error && typeof error === "object"
      ? error as { statusCode?: unknown; code?: unknown }
      : {};
   const status = explicitStatus ?? record.statusCode;
   let code = "internal-error";

   if (typeof status === "number" && Number.isSafeInteger(status) && status >= 400 && status <= 599) {
      code = "http-" + status;
   } else if (typeof record.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(record.code)) {
      code = "node-" + record.code.toLowerCase().replaceAll("_", "-");
   }

   recordErrorCode(code);
   return code;
}

function recordErrorCode(code: string): void {
   const safeCode = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(code) ? code : "invalid-error-code";

   recentErrorCodes.push(safeCode);

   if (recentErrorCodes.length > 20) {
      recentErrorCodes.splice(0, recentErrorCodes.length - 20);
   }
}

function parseRequest(value: unknown): ServiceRequest {
   const record = requireRecord(value);
   const action = requireString(record.action, "action") as ServiceAction;
   const actions: ReadonlySet<string> = new Set([
      "initialize",
      "create-room",
      "resume-room",
      "issue-ticket",
      "add-files",
      "reset-room",
      "network-status",
      "diagnostics",
      "completed-path",
      "shutdown"
   ]);

   if (!actions.has(action)) {
      throw new Error("Unknown service action");
   }

   return {
      requestId: requireString(record.requestId, "requestId"),
      action,
      ...(record.payload === undefined ? {} : { payload: record.payload })
   };
}

function parseInitPayload(value: unknown): ServiceInitPayload {
   const record = requireRecord(value);
   const limits = requireRecord(record.limits);

   return {
      version: requireString(record.version, "version"),
      serviceRestarts: requireInteger(record.serviceRestarts, "serviceRestarts", 0, Number.MAX_SAFE_INTEGER),
      portStart: requireInteger(record.portStart, "portStart", 1, 65_535),
      maxPortAttempts: requireInteger(record.maxPortAttempts, "maxPortAttempts", 1, 100),
      storageDir: requireString(record.storageDir, "storageDir"),
      receiveDir: requireString(record.receiveDir, "receiveDir"),
      staticRoot: requireString(record.staticRoot, "staticRoot"),
      ttlMs: requireInteger(record.ttlMs, "ttlMs", 1_000, Number.MAX_SAFE_INTEGER),
      hardTtlMs: requireInteger(record.hardTtlMs, "hardTtlMs", 1_000, Number.MAX_SAFE_INTEGER),
      limits: {
         maxFiles: requireInteger(limits.maxFiles, "maxFiles", 1, 10_000),
         maxFileSize: requireInteger(limits.maxFileSize, "maxFileSize", 0, Number.MAX_SAFE_INTEGER),
         maxRoomSize: requireInteger(limits.maxRoomSize, "maxRoomSize", 0, Number.MAX_SAFE_INTEGER),
         uploadChunkSize: requireInteger(limits.uploadChunkSize, "uploadChunkSize", 1, 64 * 1024 * 1024)
      }
   };
}

function roomResult(roomId: string, token: string, expiresAt: number): ServiceRoomResult {
   return {
      roomId,
      token,
      expiresAt
   };
}

function requireRooms(): RoomStore {
   if (!rooms) {
      throw new Error("Local transfer service is not initialized");
   }

   return rooms;
}

function requireRecord(value: unknown): Record<string, unknown> {
   if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Service payload must be an object");
   }

   return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
   if (typeof value !== "string" || value.length === 0 || value.length > 32_767) {
      throw new Error(`Invalid ${name}`);
   }

   return value;
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
   if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      throw new Error(`Invalid ${name}`);
   }

   return value as number;
}

function requestIdFromUnknown(value: unknown): string {
   try {
      return requireString(requireRecord(value).requestId, "requestId");
   } catch {
      return "invalid-request";
   }
}

function respond(response: ServiceResponse): void {
   parentPort?.postMessage(response);
}

function isAddressInUse(error: unknown): boolean {
   return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "EADDRINUSE"
   );
}
