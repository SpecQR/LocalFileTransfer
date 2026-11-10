import { createHostController } from "./controller.ts";
import {
   encodeHostResponse,
   parseHostRequest,
   ProtocolLineReader,
   requestIdFromUnknown,
   responseError,
   type HostResponse
} from "./protocol.ts";

const controller = createHostController();
const lines = new ProtocolLineReader();
const decoder = new TextDecoder("utf-8", { fatal: true });
let stopping = false;
let stopPromise: Promise<void> | undefined;

process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
process.stdin.on("end", () => { void stop(); });
process.stdin.on("error", () => { void stop(1); });
process.stdout.on("error", () => { void stop(); });
process.on("uncaughtException", () => { void stop(1); });
process.on("unhandledRejection", () => { void stop(1); });

void run();

async function run(): Promise<void> {
   let exitCode = 0;

   try {
      for await (const chunk of process.stdin) {
         if (stopping) {
            break;
         }

         for (const line of lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
            if (stopping) {
               break;
            }

            let value: unknown;
            let shutdown = false;
            let response: HostResponse;

            try {
               value = JSON.parse(decoder.decode(line));
               const request = parseHostRequest(value);
               const result = await controller.execute(request.action, request.payload);

               shutdown = request.action === "shutdown";
               response = { requestId: request.requestId, ok: true, ...(result === undefined ? {} : { result }) };
            } catch (error) {
               response = { requestId: requestIdFromUnknown(value), ok: false, error: responseError(error) };
            }

            await writeResponse(response);
            if (shutdown) {
               await stop();
               return;
            }
         }
      }

      lines.finish();
   } catch {
      // No input, request, response, path, or exception message is logged.
      exitCode = 1;
   } finally {
      await stop(exitCode);
   }
}

async function writeResponse(response: HostResponse): Promise<void> {
   const line = encodeHostResponse(response);

   await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve());
   });
}

function stop(exitCode = 0): Promise<void> {
   if (!stopPromise) {
      stopping = true;
      // The native host also owns the child in a Windows Job Object. This
      // fallback bounds cleanup if the parent pipe disappears during a hash or
      // filesystem operation; persisted transfer checkpoints remain authoritative.
      const deadline = setTimeout(() => process.exit(1), 5_000);

      deadline.unref();
      stopPromise = controller.close()
         .catch(() => { exitCode = 1; })
         .finally(() => {
            clearTimeout(deadline);
            process.exit(exitCode);
         });
   }

   return stopPromise;
}
