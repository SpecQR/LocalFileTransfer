import type { FastifyReply, FastifyRequest } from "fastify";
import type { LocalLanSessionStore, SessionCredential } from "./localSessionStore.ts";
import { LocalSessionError } from "./localSessionStore.ts";

const cookiePrefix = "lft_";

export function sessionCookieName(sid: string): string {
   return `${cookiePrefix}${sid.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

export function credentialFromRequest(request: FastifyRequest, sid: string): SessionCredential {
   const authorization = request.headers.authorization;

   if (authorization?.startsWith("Bearer ")) {
      return { token: authorization.slice("Bearer ".length) };
   }

   const ticket = readCookie(request.headers.cookie, sessionCookieName(sid));

   return ticket ? { ticket } : {};
}

export function masterTokenFromRequest(request: FastifyRequest): string {
   const authorization = request.headers.authorization;

   if (!authorization?.startsWith("Bearer ")) {
      throw new LocalSessionError(401, "A session capability token is required");
   }

   return authorization.slice("Bearer ".length);
}

export function authorizeRequest(
   sessions: LocalLanSessionStore,
   request: FastifyRequest,
   sid: string
) {
   return sessions.requireAuthorized(sid, credentialFromRequest(request, sid));
}

export function setBrowserTicketCookie(
   reply: FastifyReply,
   sid: string,
   ticket: string,
   expiresAt: number,
   now = Date.now()
): void {
   const maxAge = Math.max(0, Math.ceil((expiresAt - now) / 1000));

   reply.header(
      "set-cookie",
      `${sessionCookieName(sid)}=${encodeURIComponent(ticket)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
   );
}

export function clearBrowserTicketCookie(reply: FastifyReply, sid: string): void {
   reply.header(
      "set-cookie",
      `${sessionCookieName(sid)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
   );
}

export function readCookie(header: string | undefined, name: string): string | undefined {
   for (const part of header?.split(";") ?? []) {
      const separator = part.indexOf("=");

      if (separator < 0 || part.slice(0, separator).trim() !== name) {
         continue;
      }

      try {
         return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
         return undefined;
      }
   }

   return undefined;
}