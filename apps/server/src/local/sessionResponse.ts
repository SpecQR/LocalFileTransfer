import type { CreateLocalSessionResponse } from "../../../../packages/protocol/src/index.ts";
import type { LocalLanSessionStore } from "./localSessionStore.ts";
import type { LocalSession } from "./types.ts";

export function responseForSession(
   sessions: LocalLanSessionStore,
   session: LocalSession,
   token: string,
   pathPrefix: "r" | "u"
): CreateLocalSessionResponse {
   const url = new URL(`/${pathPrefix}/${encodeURIComponent(session.sid)}`, session.appBaseUrl);

   url.hash = `t=${encodeURIComponent(token)}`;

   return {
      sid: session.sid,
      token,
      expiresAt: session.expiresAt,
      url: url.toString(),
      files: sessions.publicView(session).files
   };
}