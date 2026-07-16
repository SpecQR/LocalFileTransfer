import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
   durableUploadProtocol,
   type RoomDiagnosticSnapshot
} from "../../../packages/protocol/src/index.ts";
import { lanCandidates, loadConfig, type ServerConfig } from "./config.ts";
import {
   LocalLanSessionStore,
   LocalSessionError
} from "./local/localSessionStore.ts";
import { registerLocalRoutes } from "./local/routes.ts";
import { registerStaticRoutes } from "./local/staticFiles.ts";
import { registerRoomRoutes } from "./v2/routes.ts";
import { parseRequestHostname } from "./security/requestGuards.ts";
import { RoomError, RoomStore } from "./v2/roomStore.ts";
import { SqliteRoomRepository } from "./v2/sqliteRoomRepository.ts";

export interface AppDeps {
   config?: ServerConfig;
   sessions?: LocalLanSessionStore;
   rooms?: RoomStore;
   enableLegacyRoutes?: boolean;
   onError?: (error: unknown, context: { method: string; statusCode: number }) => void;
   getDiagnostics?: () => Promise<RoomDiagnosticSnapshot>;
}

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
   const config = deps.config ?? loadConfig();
   const app = Fastify({
      logger: {
         redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie"
         ]
      },
      bodyLimit: config.limits.uploadChunkSize + 64 * 1024,
      disableRequestLogging: true
   });
   const rooms = deps.rooms ?? new RoomStore({
      repository: new SqliteRoomRepository(join(config.storageDir, "rooms.sqlite")),
      rootDir: join(config.storageDir, "v2"),
      receiveDir: join(config.storageDir, "received"),
      ttlMs: config.sessionTtlMs,
      hardTtlMs: config.sessionHardTtlMs,
      limits: {
         maxFiles: config.limits.maxFiles,
         maxFileSize: config.limits.maxFileSize,
         maxRoomSize: config.limits.maxSessionSize,
         uploadChunkSize: config.limits.uploadChunkSize
      }
   });

   await rooms.initialize();

   app.addHook("onRequest", async (request) => {
      validateHost(request, new Set([
         "localhost",
         "127.0.0.1",
         "::1",
         ...lanCandidates(config.port).map((candidate) => candidate.address)
      ]));
   });

   app.addHook("onSend", async (_request, reply, payload) => {
      reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      reply.header("cross-origin-opener-policy", "same-origin");
      reply.header("cross-origin-resource-policy", "same-origin");
      reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");

      return payload;
   });

   app.addContentTypeParser(["application/octet-stream", "application/offset+octet-stream"], (_request, payload, done) => {
      done(null, payload);
   });

   app.get("/healthz", async () => ({ ok: true }));

   if (deps.enableLegacyRoutes) {
      const sessions = deps.sessions ?? new LocalLanSessionStore({
         rootDir: config.storageDir,
         ttlMs: config.sessionTtlMs,
         hardTtlMs: config.sessionHardTtlMs,
         limits: config.limits
      });

      await registerLocalRoutes(app, { config, sessions });
   }

   const getDiagnostics = deps.getDiagnostics ?? (async (): Promise<RoomDiagnosticSnapshot> => ({
      version: "development",
      protocol: durableUploadProtocol,
      uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
      port: config.port,
      serviceRestarts: 0,
      ...(await rooms.diagnosticState()),
      sourceHash: {
         workers: 0,
         queued: 0,
         cacheEntries: 0,
         jobsStarted: 0
      },
      structuredLog: "unavailable",
      recentErrorCodes: [],
      lanCandidates: lanCandidates(config.port),
      generatedAt: Date.now()
   }));

   await registerRoomRoutes(app, {
      rooms,
      getDiagnostics,
      onStreamError: (error) => deps.onError?.(error, { method: "GET", statusCode: 500 })
   });
   await registerStaticRoutes(app, config.staticRoot);

   app.setErrorHandler((error, request, reply) => {
      const statusCode = error instanceof LocalSessionError || error instanceof RoomError
         ? error.statusCode
         : error instanceof TypeError ? 400 : 500;

      deps.onError?.(error, { method: request.method, statusCode });

      if (error instanceof LocalSessionError || error instanceof RoomError) {
         return reply.code(error.statusCode).send({ error: error.message });
      }

      if (error instanceof TypeError) {
         return reply.code(400).send({ error: error.message });
      }

      app.log.error(error);
      return reply.code(500).send({
         error: error instanceof Error ? error.message : "Internal server error"
      });
   });

   app.addHook("onClose", async () => {
      rooms.close();
   });

   return app;
}

function validateHost(request: FastifyRequest, allowedHosts: ReadonlySet<string>): void {
   const host = request.headers.host;

   if (!host) {
      throw new LocalSessionError(400, "Host header is required");
   }

   const hostname = parseRequestHostname(host);

   if (!hostname) {
      throw new LocalSessionError(400, "Host header is invalid");
   }
   if (!allowedHosts.has(hostname)) {
      throw new LocalSessionError(421, "This host is not served by Local File Transfer");
   }
}
