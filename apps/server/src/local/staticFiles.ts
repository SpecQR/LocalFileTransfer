import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const defaultWebDist = resolve(process.cwd(), "..", "web", "dist");

const contentTypes: Record<string, string> = {
   ".css": "text/css; charset=utf-8",
   ".html": "text/html; charset=utf-8",
   ".js": "text/javascript; charset=utf-8",
   ".json": "application/json; charset=utf-8",
   ".png": "image/png",
   ".svg": "image/svg+xml",
   ".webp": "image/webp"
};

export async function registerStaticRoutes(app: FastifyInstance, staticRoot = defaultWebDist): Promise<void> {
   const webDist = resolve(staticRoot);

   if (!existsSync(join(webDist, "index.html"))) {
      app.log.info("web dist was not found; Vite dev server should serve the UI");
      return;
   }

   for (const route of ["/", "/app", "/room/:roomId", "/send", "/r/:sid", "/u/:sid"]) {
      app.get(route, async (_request, reply) => {
         await sendFile(reply, join(webDist, "index.html"));
      });
   }

   app.get("/*", async (request, reply) => {
      const params = request.params as { "*": string };
      const requested = params["*"] || "index.html";
      const target = resolve(webDist, requested);
      const relativeTarget = relative(webDist, target);

      if (relativeTarget.startsWith("..") || resolve(webDist, relativeTarget) !== target || !existsSync(target)) {
         return reply.code(404).send("Not found");
      }

      await sendFile(reply, target);
   });
}

async function sendFile(reply: FastifyReply, filePath: string): Promise<void> {
   const info = await stat(filePath);
   const extension = extname(filePath);

   reply.header("content-type", contentTypes[extension] ?? "application/octet-stream");
   reply.header("content-length", String(info.size));
   reply.header("cache-control", extension === ".html" ? "no-store" : "public, max-age=31536000, immutable");

   await reply.send(createReadStream(filePath));
}