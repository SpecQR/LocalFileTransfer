import { buildApp } from "./app.ts";
import { lanOrigins, loadConfig } from "./config.ts";

const config = loadConfig();
const app = await buildApp({
   config
});

await app.listen({
   port: config.port,
   host: "0.0.0.0"
});

for (const origin of lanOrigins(config.port)) {
   app.log.info(`LAN UI available at ${origin}`);
}
