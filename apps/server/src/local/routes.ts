import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseContentRange } from "../../../../packages/protocol/src/index.ts";
import { lanCandidates, lanOrigins, type ServerConfig } from "../config.ts";
import {
   authorizeRequest,
   clearBrowserTicketCookie,
   credentialFromRequest,
   masterTokenFromRequest,
   setBrowserTicketCookie
} from "./auth.ts";
import {
   LocalLanSessionStore,
   LocalSessionError
} from "./localSessionStore.ts";
import { sendSessionFile } from "./rangeDownload.ts";
import { MemoryRateLimiter } from "./rateLimiter.ts";
import { responseForSession } from "./sessionResponse.ts";
import type {
   CreateSendSessionRequest,
   CreateUploadSessionRequest,
   LocalFileRecord,
   LocalInfoResponse,
   RegisterUploadFileRequest
} from "./types.ts";
import { appendUploadChunk } from "./uploadStorage.ts";

interface LocalRoutesDeps {
   config: ServerConfig;
   sessions: LocalLanSessionStore;
}

interface SidParams {
   sid: string;
}

interface FileParams extends SidParams {
   fileId: string;
}

export async function registerLocalRoutes(app: FastifyInstance, deps: LocalRoutesDeps): Promise<void> {
   const limiter = new MemoryRateLimiter();
   let nextSweepAt = 0;

   app.addHook("onRequest", async () => {
      const now = Date.now();

      if (now >= nextSweepAt) {
         nextSweepAt = now + 30_000;
         await deps.sessions.sweepExpired();
      }
   });

   app.get("/api/local/info", async (): Promise<LocalInfoResponse> => ({
      port: deps.config.port,
      lanOrigins: lanOrigins(deps.config.port),
      lanCandidates: lanCandidates(deps.config.port),
      sessionTtlMs: deps.config.sessionTtlMs,
      limits: deps.config.limits
   }));

   app.post("/api/local/send-sessions", async (request, reply) => {
      assertLoopbackRequest(request);
      enforceRateLimit(reply, limiter, `create:${request.ip}`, 20, 60_000);
      const body = request.body as CreateSendSessionRequest;

      validateAppBaseUrl(body?.appBaseUrl, deps.config.port);

      if (!Array.isArray(body.files) || body.files.length === 0) {
         throw new LocalSessionError(400, "At least one file is required");
      }

      const created = await deps.sessions.create({
         kind: "send",
         appBaseUrl: body.appBaseUrl,
         files: body.files.map(validateIncomingFile)
      });

      return reply.code(201).send(responseForSession(deps.sessions, created.session, created.token, "r"));
   });

   app.put("/api/local/send-sessions/:sid/files/:fileId/chunks", async (request, reply) => {
      const { sid, fileId } = request.params as FileParams;
      const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "send");
      const file = deps.sessions.getFile(session, fileId);

      if (!file) {
         throw new LocalSessionError(404, "File was not registered for this session");
      }

      const range = contentRangeFromRequest(request);
      const stored = await appendUploadChunk(deps.sessions, session, file, range, request.body);

      return reply.send({ file: deps.sessions.publicView(session).files.find((entry) => entry.fileId === stored.fileId) });
   });

   app.get("/api/local/send-sessions/:sid", async (request) => {
      const { sid } = request.params as SidParams;
      const session = authorizeRequest(deps.sessions, request, sid);

      if (session.kind !== "send") {
         throw new LocalSessionError(404, "Session type does not match this route");
      }

      return deps.sessions.publicView(session);
   });

   app.route({
      method: ["GET", "HEAD"],
      url: "/api/local/send-sessions/:sid/files/:fileId",
      handler: async (request, reply) => {
         const { sid, fileId } = request.params as FileParams;
         const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "send");

         await sendSessionFile(deps.sessions, session, fileId, request, reply);
      }
   });

   app.post("/api/local/upload-sessions", async (request, reply) => {
      assertLoopbackRequest(request);
      enforceRateLimit(reply, limiter, `create:${request.ip}`, 20, 60_000);
      const body = request.body as CreateUploadSessionRequest;

      validateAppBaseUrl(body?.appBaseUrl, deps.config.port);
      const created = await deps.sessions.create({
         kind: "upload",
         appBaseUrl: body.appBaseUrl
      });

      return reply.code(201).send(responseForSession(deps.sessions, created.session, created.token, "u"));
   });

   app.post("/api/local/upload-sessions/:sid/files", async (request, reply) => {
      const { sid } = request.params as SidParams;
      const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "upload");
      const metadata = validateIncomingFile(request.body as RegisterUploadFileRequest);
      const file = await deps.sessions.addUploadedFile(session, metadata);
      const publicFile = deps.sessions.publicView(session).files.find((entry) => entry.fileId === file.fileId);

      return reply.code(201).send({ file: publicFile });
   });

   app.put("/api/local/upload-sessions/:sid/files/:fileId/chunks", async (request, reply) => {
      const { sid, fileId } = request.params as FileParams;
      const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "upload");
      const file = deps.sessions.getFile(session, fileId);

      if (!file) {
         throw new LocalSessionError(404, "File was not registered for this session");
      }

      const range = contentRangeFromRequest(request);
      const stored = await appendUploadChunk(deps.sessions, session, file, range, request.body);
      const publicFile = deps.sessions.publicView(session).files.find((entry) => entry.fileId === stored.fileId);

      return reply.send({ file: publicFile });
   });

   app.get("/api/local/upload-sessions/:sid", async (request) => {
      const { sid } = request.params as SidParams;
      const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "upload");

      return deps.sessions.publicView(session);
   });

   app.route({
      method: ["GET", "HEAD"],
      url: "/api/local/upload-sessions/:sid/files/:fileId",
      handler: async (request, reply) => {
         const { sid, fileId } = request.params as FileParams;
         const session = deps.sessions.requireAuthorized(sid, credentialFromRequest(request, sid), "upload");

         await sendSessionFile(deps.sessions, session, fileId, request, reply);
      }
   });

   app.post("/api/local/sessions/:sid/authorize", async (request, reply) => {
      const { sid } = request.params as SidParams;

      enforceRateLimit(reply, limiter, `authorize:${request.ip}`, 30, 60_000);
      const issued = deps.sessions.issueBrowserTicket(sid, masterTokenFromRequest(request));

      setBrowserTicketCookie(reply, sid, issued.ticket, issued.expiresAt);
      return reply.code(204).send();
   });

   app.get("/api/local/sessions/:sid/events", async (request, reply) => {
      const { sid } = request.params as SidParams;
      const session = authorizeRequest(deps.sessions, request, sid);
      const raw = reply.raw;

      reply.hijack();
      raw.writeHead(200, {
         "cache-control": "no-cache, no-store",
         connection: "keep-alive",
         "content-type": "text/event-stream; charset=utf-8",
         "referrer-policy": "no-referrer",
         "x-accel-buffering": "no",
         "x-content-type-options": "nosniff"
      });

      const send = (event: unknown): void => {
         if (!raw.destroyed) {
            raw.write(`data: ${JSON.stringify(event)}\n\n`);
         }
      };
      const unsubscribe = deps.sessions.subscribe(sid, send);
      const heartbeat = setInterval(() => {
         if (!raw.destroyed) {
            raw.write(": keep-alive\n\n");
         }
      }, 15_000);
      const close = (): void => {
         clearInterval(heartbeat);
         unsubscribe();
      };

      raw.on("close", close);
      send({
         t: "joined",
         session: deps.sessions.publicView(session)
      });
   });

   app.delete("/api/local/sessions/:sid", async (request, reply) => {
      const { sid } = request.params as SidParams;

      await deps.sessions.delete(sid, masterTokenFromRequest(request));
      clearBrowserTicketCookie(reply, sid);
      return reply.code(204).send();
   });

}

function contentRangeFromRequest(request: FastifyRequest) {
   const value = firstHeader(request.headers["content-range"]);

   if (!value) {
      throw new LocalSessionError(400, "Content-Range is required");
   }

   try {
      const range = parseContentRange(value);
      const contentLength = Number(firstHeader(request.headers["content-length"]));

      if (Number.isFinite(contentLength) && contentLength !== range.length) {
         throw new LocalSessionError(400, "Content-Length does not match Content-Range");
      }

      return range;
   } catch (error) {
      if (error instanceof LocalSessionError) {
         throw error;
      }

      throw new LocalSessionError(400, "Invalid Content-Range");
   }
}

function validateIncomingFile(input: unknown): Pick<LocalFileRecord, "name" | "type" | "size" | "lastModified"> {
   if (!input || typeof input !== "object") {
      throw new LocalSessionError(400, "Invalid file metadata");
   }

   const file = input as Record<string, unknown>;
   const name = String(file.name ?? "").trim();
   const type = String(file.type ?? "application/octet-stream");
   const size = Number(file.size);
   const lastModified = Number(file.lastModified ?? Date.now());

   if (
      !name
      || name.length > 1_024
      || type.length > 255
      || !Number.isSafeInteger(size)
      || size < 0
      || !Number.isFinite(lastModified)
   ) {
      throw new LocalSessionError(400, "Invalid file metadata");
   }

   return { name, type, size, lastModified };
}

function validateAppBaseUrl(value: unknown, port: number): asserts value is string {
   if (typeof value !== "string") {
      throw new LocalSessionError(400, "appBaseUrl is required");
   }

   const url = new URL(value);
   const allowedHosts = new Set([
      "localhost",
      "127.0.0.1",
      "::1",
      ...lanCandidates(port).map((candidate) => candidate.address)
   ]);

   if ((url.protocol !== "http:" && url.protocol !== "https:") || !allowedHosts.has(url.hostname)) {
      throw new LocalSessionError(400, "appBaseUrl must use an address owned by this Windows device");
   }
}

function assertLoopbackRequest(request: FastifyRequest): void {
   const address = request.ip.replace(/^::ffff:/u, "");

   if (address !== "127.0.0.1" && address !== "::1") {
      throw new LocalSessionError(403, "Only the desktop app can create transfer sessions");
   }
}

function enforceRateLimit(
   reply: FastifyReply,
   limiter: MemoryRateLimiter,
   key: string,
   limit: number,
   windowMs: number
): void {
   const result = limiter.check(key, limit, windowMs);

   if (!result.allowed) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw new LocalSessionError(429, "Too many requests. Try again shortly.");
   }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
   return Array.isArray(value) ? value[0] : value;
}