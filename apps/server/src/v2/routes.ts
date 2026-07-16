import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
   durableUploadProtocol,
   parseAuthorizeRoomRequest,
   parseContentRange,
   parseRegisterRoomUploadRequest,
   parseRoomId,
   parseRoomItemId,
   parseSha256Base64,
   parseUpdateRoomSharedTextRequest,
   parseUploadFingerprint,
   type RoomDiagnosticSnapshot,
   type RoomEvent,
   type RoomItemView
} from "../../../../packages/protocol/src/index.ts";
import { readCookie, sessionCookieName, setBrowserTicketCookie } from "../local/auth.ts";
import { MemoryRateLimiter } from "../local/rateLimiter.ts";
import { ConnectionGate } from "../security/connectionGate.ts";
import { isSameHttpOrigin } from "../security/requestGuards.ts";
import { sendRoomArchive } from "./roomArchive.ts";
import { sendRoomItem } from "./roomDownload.ts";
import {
   checkpointIdempotencyKey,
   publicItem,
   RoomError,
   SharedTextConflictError,
   RoomStore
} from "./roomStore.ts";

interface RoomRoutesDeps {
   rooms: RoomStore;
   getDiagnostics: () => Promise<RoomDiagnosticSnapshot>;
   onStreamError?: (error: unknown) => void;
}

interface RoomParams {
   roomId: string;
}

interface ItemParams extends RoomParams {
   itemId: string;
}

export async function registerRoomRoutes(app: FastifyInstance, deps: RoomRoutesDeps): Promise<void> {
   const limiter = new MemoryRateLimiter();
   const eventStreams = new ConnectionGate(32, 4);
   let nextSweepAt = 0;

   app.addHook("onRequest", async () => {
      const now = Date.now();

      if (now >= nextSweepAt) {
         nextSweepAt = now + 30_000;
         await deps.rooms.sweepExpired();
      }
   });

   app.post("/api/v2/rooms/:roomId/authorize", async (request, reply) => {
      assertSameOrigin(request);
      const roomId = parseRoomId((request.params as RoomParams).roomId);

      enforceRateLimit(reply, limiter, `v2-authorize:${request.ip}`, 30, 60_000);
      const { token } = parseAuthorizeRoomRequest(request.body);
      const issued = deps.rooms.issueTicket(roomId, token);

      setBrowserTicketCookie(reply, roomId, issued.ticket, issued.expiresAt);
      return reply.code(204).send();
   });

   app.get("/api/v2/rooms/:roomId", async (request) => {
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);

      return deps.rooms.view(room);
   });

   app.get("/api/v2/rooms/:roomId/shared-text", async (request, reply) => {
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);

      enforceRateLimit(reply, limiter, "v2-shared-text-read:" + request.ip, 120, 60_000);
      reply.header("cache-control", "no-store");
      return deps.rooms.getSharedText(room);
   });

   app.put("/api/v2/rooms/:roomId/shared-text", async (request, reply) => {
      assertSameOrigin(request);
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);
      const update = parseUpdateRoomSharedTextRequest(request.body);

      enforceRateLimit(reply, limiter, "v2-shared-text-write:" + request.ip, 120, 60_000);
      reply.header("cache-control", "no-store");

      try {
         return deps.rooms.updateSharedText(room, update);
      } catch (error) {
         if (error instanceof SharedTextConflictError) {
            return reply.code(409).send({
               error: error.message,
               current: error.current
            });
         }

         throw error;
      }
   });

   app.get("/api/v2/rooms/:roomId/diagnostics", async (request, reply) => {
      const roomId = parseRoomId((request.params as RoomParams).roomId);

      authorizeRoom(deps.rooms, request, roomId);
      enforceRateLimit(reply, limiter, "v2-diagnostics:" + request.ip, 30, 60_000);
      reply.header("cache-control", "no-store");
      return deps.getDiagnostics();
   });

   app.get("/api/v2/rooms/:roomId/events", async (request, reply) => {
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);
      const requestedEventId = parseEventId(request.headers["last-event-id"]);
      const raw = reply.raw;
      const releaseEventStream = eventStreams.acquire(request.ip);

      if (!releaseEventStream) {
         throw new RoomError(503, "Too many live room connections");
      }

      reply.hijack();
      raw.writeHead(200, {
         "cache-control": "no-cache, no-store",
         connection: "keep-alive",
         "content-type": "text/event-stream; charset=utf-8",
         "referrer-policy": "no-referrer",
         "x-accel-buffering": "no",
         "x-content-type-options": "nosniff"
      });

      let lastSentId = requestedEventId;
      const send = (event: RoomEvent): void => {
         if (raw.destroyed || event.id <= lastSentId) {
            return;
         }

         lastSentId = event.id;
         raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = deps.rooms.subscribe(roomId, send);

      for (const event of deps.rooms.eventsAfter(roomId, requestedEventId)) {
         send(event);
      }

      if (lastSentId < room.eventId) {
         send({
            id: room.eventId,
            t: "snapshot",
            room: deps.rooms.view(room),
            createdAt: Date.now()
         });
      }

      const heartbeat = setInterval(() => {
         if (!raw.destroyed) {
            raw.write(": keep-alive\n\n");
         }
      }, 15_000);
      const close = (): void => {
         clearInterval(heartbeat);
         unsubscribe();
         releaseEventStream();
      };

      raw.on("close", close);
      raw.on("error", close);
   });

   app.post("/api/v2/rooms/:roomId/uploads", async (request, reply) => {
      assertSameOrigin(request);
      enforceRateLimit(reply, limiter, "v2-register:" + request.ip, 60, 60_000);
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);
      const metadata = parseRegisterRoomUploadRequest(request.body);
      const item = await deps.rooms.registerUpload(room, metadata);

      return reply.code(201).send({
         item: publicItem(item)
      });
   });

   app.route({
      method: "HEAD",
      url: "/api/v2/rooms/:roomId/uploads/:itemId",
      handler: async (request, reply) => {
         const params = request.params as ItemParams;
         const roomId = parseRoomId(params.roomId);
         const itemId = parseRoomItemId(params.itemId);
         const room = authorizeRoom(deps.rooms, request, roomId);
         const item = publicItem(deps.rooms.item(room.roomId, itemId));

         setUploadStatusHeaders(reply, item);
         return reply.code(204).send();
      }
   });

   app.patch("/api/v2/rooms/:roomId/uploads/:itemId", async (request, reply) => {
      assertSameOrigin(request);
      enforceRateLimit(reply, limiter, "v2-checkpoint:" + request.ip, 600, 60_000);
      const params = request.params as ItemParams;
      const roomId = parseRoomId(params.roomId);
      const itemId = parseRoomItemId(params.itemId);
      const room = authorizeRoom(deps.rooms, request, roomId);
      const item = deps.rooms.item(room.roomId, itemId);
      const contentType = firstHeader(request.headers["content-type"])?.split(";", 1)[0];

      if (contentType !== "application/offset+octet-stream") {
         throw new RoomError(415, "Durable upload checkpoints require application/offset+octet-stream");
      }

      if (!item.fingerprint) {
         throw new RoomError(409, "This upload predates durable resume support");
      }

      const offset = integerHeader(request.headers["upload-offset"], "Upload-Offset", 0);
      const length = integerHeader(request.headers["content-length"], "Content-Length", 1);

      if (length > deps.rooms.limits.uploadChunkSize) {
         throw new RoomError(413, "Upload checkpoint exceeds the configured chunk size");
      }

      const rawChecksum = firstHeader(request.headers["upload-checksum"]);
      const checksumParts = rawChecksum?.split(" ");

      if (checksumParts?.length !== 2 || checksumParts[0] !== "sha256") {
         throw new RoomError(400, "Upload-Checksum must use sha256");
      }

      const checksum = parseSha256Base64(checksumParts[1]);
      const idempotencyKey = parseUploadFingerprint(firstHeader(request.headers["idempotency-key"]));

      if (
         idempotencyKey !== checkpointIdempotencyKey(roomId, itemId, offset, length, checksum)
      ) {
         throw new RoomError(400, "Invalid checkpoint idempotency key");
      }

      if (offset + length > item.size) {
         throw new RoomError(400, "Upload checkpoint extends beyond the registered file");
      }

      const updated = await deps.rooms.appendCheckpoint(
         room,
         itemId,
         {
            start: offset,
            end: offset + length - 1,
            total: item.size,
            length
         },
         { checksum, idempotencyKey },
         request.body
      );

      setUploadStatusHeaders(reply, publicItem(updated));
      return reply.code(204).send();
   });

   app.get("/api/v2/rooms/:roomId/files/archive", async (request, reply) => {
      const roomId = parseRoomId((request.params as RoomParams).roomId);
      const room = authorizeRoom(deps.rooms, request, roomId);

      enforceRateLimit(reply, limiter, "v2-archive:" + request.ip, 30, 60_000);
      await sendRoomArchive(deps.rooms, room, request, reply, deps.onStreamError);
   });

   app.route({
      method: ["GET", "HEAD"],
      url: "/api/v2/rooms/:roomId/files/:itemId/content",
      handler: async (request, reply) => {
         const params = request.params as ItemParams;
         const roomId = parseRoomId(params.roomId);
         const itemId = parseRoomItemId(params.itemId);
         const room = authorizeRoom(deps.rooms, request, roomId);

         enforceRateLimit(reply, limiter, "v2-download:" + request.ip, 120, 60_000);
         await sendRoomItem(deps.rooms, room, itemId, request, reply);
      }
   });

   app.delete("/api/v2/rooms/:roomId/items/:itemId", async (request, reply) => {
      assertSameOrigin(request);
      const params = request.params as ItemParams;
      const roomId = parseRoomId(params.roomId);
      const itemId = parseRoomItemId(params.itemId);
      const room = authorizeRoom(deps.rooms, request, roomId);

      await deps.rooms.cancelItem(room, itemId);
      return reply.code(204).send();
   });
}

function authorizeRoom(rooms: RoomStore, request: FastifyRequest, roomId: string) {
   const authorization = request.headers.authorization;
   const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
   const ticket = readCookie(request.headers.cookie, sessionCookieName(roomId));

   return rooms.requireAuthorized(roomId, {
      ...(token ? { token } : {}),
      ...(ticket ? { ticket } : {})
   });
}

function contentRangeFromRequest(request: FastifyRequest) {
   const rawValue = request.headers["content-range"];
   const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;

   if (!value) {
      throw new RoomError(400, "Content-Range is required");
   }

   try {
      const range = parseContentRange(value);
      const rawLength = request.headers["content-length"];
      const contentLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);

      if (Number.isFinite(contentLength) && contentLength !== range.length) {
         throw new RoomError(400, "Content-Length does not match Content-Range");
      }

      return range;
   } catch (error) {
      if (error instanceof RoomError) {
         throw error;
      }

      throw new RoomError(400, "Invalid Content-Range");
   }
}

function setUploadStatusHeaders(reply: FastifyReply, item: RoomItemView): void {
   if (!item.fingerprint) {
      throw new RoomError(409, "This upload predates durable resume support");
   }

   reply.header("cache-control", "no-store");
   reply.header("upload-protocol", durableUploadProtocol);
   reply.header("upload-offset", String(item.confirmedBytes));
   reply.header("upload-length", String(item.size));
   reply.header("upload-fingerprint", item.fingerprint);
   reply.header("upload-state", item.state);
}

function integerHeader(
   value: string | string[] | undefined,
   name: string,
   minimum: number
): number {
   const parsed = Number(firstHeader(value));

   if (!Number.isSafeInteger(parsed) || parsed < minimum) {
      throw new RoomError(400, name + " is invalid");
   }

   return parsed;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
   return Array.isArray(value) ? value[0] : value;
}

function parseEventId(value: string | string[] | undefined): number {
   const raw = Array.isArray(value) ? value[0] : value;
   const parsed = Number(raw ?? 0);

   return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function assertSameOrigin(request: FastifyRequest): void {
   if (!isSameHttpOrigin(request.headers.origin, request.headers.host)) {
      throw new RoomError(403, "Request origin is not allowed");
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
      throw new RoomError(429, "Too many requests");
   }
}
