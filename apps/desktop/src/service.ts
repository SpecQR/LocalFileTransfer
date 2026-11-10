import { createLocalTransferService } from "./serviceRuntime.ts";

interface ParentPort {
   on(event: "message", listener: (event: { data: unknown }) => void): void;
   postMessage(message: unknown): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

if (!parentPort) {
   throw new Error("Local transfer service must run as an Electron utility process");
}

const service = createLocalTransferService();

parentPort.on("message", (event) => {
   void handleMessage(event.data);
});

process.on("SIGTERM", () => {
   void service.close().finally(() => process.exit(0));
});

async function handleMessage(value: unknown): Promise<void> {
   const response = await service.dispatch(value);

   parentPort?.postMessage(response);
   if (response.ok && value && typeof value === "object" && "action" in value && value.action === "shutdown") {
      process.exit(0);
   }
}
