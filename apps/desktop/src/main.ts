import {
   app,
   BrowserWindow,
   dialog,
   ipcMain,
   Menu,
   powerSaveBlocker,
   safeStorage,
   screen,
   session,
   shell,
   utilityProcess,
   type IpcMainInvokeEvent,
   type UtilityProcess
} from "electron";
import {
   mkdir,
   readFile,
   rename,
   stat,
   writeFile
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
   parseDesktopSourceFiles,
   uploadChunkSize,
   type DesktopSourceFile,
   type RoomDiagnosticSnapshot
} from "../../../packages/protocol/src/index.ts";
import type {
   DesktopRoomBootstrap,
   ServiceInitPayload,
   ServiceRequest,
   ServiceResponse,
   ServiceRoomResult,
   ServiceRuntime,
   ServiceTicketResult
} from "./serviceProtocol.ts";

const appName = "Local File Transfer";
const portStart = 8787;
const maxPortAttempts = 20;
const resizeChannel = "local-file-transfer:resize-content";
const bootstrapChannel = "local-file-transfer:room-bootstrap";
const addFilesChannel = "local-file-transfer:add-room-files";
const resetRoomChannel = "local-file-transfer:reset-room";
const transferActiveChannel = "local-file-transfer:transfer-active";
const showReceivedFileChannel = "local-file-transfer:show-received-file";
const openReceiveFolderChannel = "local-file-transfer:open-receive-folder";
const diagnosticsChannel = "local-file-transfer:diagnostics";
const openLogFolderChannel = "local-file-transfer:open-log-folder";
const contentWidth = 300;
const minContentWidth = 300;
const defaultContentHeight = 360;
const minContentHeight = 340;
const maxPreferredContentHeight = 780;
const serviceShutdownGraceMs = 3_000;
const serviceRequestTimeoutMs = 30_000;

let mainWindow: BrowserWindow | undefined;
let serviceClient: LocalServiceClient | undefined;
let serviceRuntime: ServiceRuntime | undefined;
let activeRoom: ServiceRoomResult | undefined;
let isApplyingContentResize = false;
let manualContentHeight: number | undefined;
let isQuitting = false;
let restartPromise: Promise<void> | undefined;
let networkRefreshPromise: Promise<void> | undefined;
let activeRoomOrigin: string | undefined;
let powerSaveBlockerId: number | undefined;
let serviceLaunchCount = 0;
let rendererTransferActive = false;
let serviceTransferActive = false;

interface DesktopFileInput {
   path: string;
   name: string;
   type: string;
   size: number;
   lastModified: number;
}

interface VaultRecord {
   roomId: string;
   encryptedToken: string;
}

interface CompletedPathPayload {
   roomId: string;
   itemId: string;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
   app.quit();
} else {
   app.on("second-instance", () => {
      if (mainWindow) {
         if (mainWindow.isMinimized()) {
            mainWindow.restore();
         }

         mainWindow.show();
         mainWindow.focus();
      }
   });
}

async function createMainWindow(): Promise<void> {
   const runtime = await ensureService();
   await ensureActiveRoom(runtime);

   Menu.setApplicationMenu(null);
   session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
   });

   mainWindow = new BrowserWindow({
      width: contentWidth,
      height: defaultContentHeight,
      minWidth: minContentWidth,
      maxWidth: contentWidth,
      minHeight: minContentHeight,
      useContentSize: true,
      title: appName,
      backgroundColor: "#f5f7f4",
      webPreferences: {
         contextIsolation: true,
         nodeIntegration: false,
         preload: preloadPath(),
         sandbox: true
      }
   });

   mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
         void shell.openExternal(url);
      }

      return { action: "deny" };
   });
   mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!isRuntimeUrl(url)) {
         event.preventDefault();
      }
   });
   mainWindow.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
   });

   mainWindow.on("will-resize", (_event, newBounds) => {
      if (!mainWindow || isApplyingContentResize) {
         return;
      }

      const frameHeight = mainWindow.getBounds().height - mainWindow.getContentBounds().height;
      manualContentHeight = Math.max(minContentHeight, newBounds.height - frameHeight);
   });

   mainWindow.on("closed", () => {
      mainWindow = undefined;
      manualContentHeight = undefined;
      setTransferPowerSave(false);
   });

   await mainWindow.loadURL(`${runtime.localUrl}/app`);

   console.info(`${appName} is running at ${runtime.localUrl}`);
   for (const lanUrl of runtime.lanUrls) {
      console.info(`LAN URL base: ${lanUrl}`);
   }
}

async function ensureService(): Promise<ServiceRuntime> {
   if (serviceClient && serviceRuntime) {
      return serviceRuntime;
   }

   const client = new LocalServiceClient(servicePath(), () => {
      if (!isQuitting) {
         scheduleServiceRecovery();
      }
   });
   const serviceRestarts = serviceLaunchCount;

   serviceLaunchCount += 1;
   const runtime = await client.request<ServiceRuntime>("initialize", serviceInitPayload(serviceRestarts));

   serviceClient = client;
   serviceRuntime = runtime;

   return runtime;
}

async function ensureActiveRoom(runtime: ServiceRuntime): Promise<ServiceRoomResult> {
   const client = requireService();
   const appBaseUrl = preferredLanOrigin(runtime);
   const saved = await readVault();
   let room: ServiceRoomResult | undefined;

   if (saved) {
      try {
         room = await client.request<ServiceRoomResult>("resume-room", {
            roomId: saved.roomId,
            token: saved.token,
            appBaseUrl
         });
      } catch {
         room = undefined;
      }
   }

   if (!room) {
      room = await client.request<ServiceRoomResult>("create-room", {
         appBaseUrl
      });
   }

   activeRoom = room;
   activeRoomOrigin = appBaseUrl;
   await writeVault(room);
   await installDesktopTicket(room, runtime);

   return room;
}

async function installDesktopTicket(room: ServiceRoomResult, runtime: ServiceRuntime): Promise<void> {
   const issued = await requireService().request<ServiceTicketResult>("issue-ticket", {
      roomId: room.roomId,
      token: room.token
   });

   await session.defaultSession.cookies.set({
      url: runtime.localUrl,
      name: roomCookieName(room.roomId),
      value: issued.ticket,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      expirationDate: Math.floor(issued.expiresAt / 1000)
   });
}

function roomBootstrap(): DesktopRoomBootstrap {
   const runtime = requireRuntime();
   const room = requireActiveRoom();

   return {
      roomId: room.roomId,
      joinUrl: `${preferredLanOrigin(runtime)}/room/${encodeURIComponent(room.roomId)}#t=${room.token}`,
      expiresAt: room.expiresAt
   };
}

async function refreshNetworkRoom(): Promise<void> {
   if (networkRefreshPromise) {
      return networkRefreshPromise;
   }

   networkRefreshPromise = (async () => {
      const currentRoom = activeRoom;
      const latest = await requireService().request<ServiceRuntime>("network-status");
      const nextOrigin = preferredLanOrigin(latest);

      serviceRuntime = latest;

      const diagnostics = await requireService().request<RoomDiagnosticSnapshot>("diagnostics");

      setServiceTransferPowerSave(
         diagnostics.activeWrites > 0
         || diagnostics.activeReads > 0
         || diagnostics.transferringItems > 0
      );

      if (currentRoom && activeRoomOrigin !== nextOrigin) {
         const resumed = await requireService().request<ServiceRoomResult>("resume-room", {
            roomId: currentRoom.roomId,
            token: currentRoom.token,
            appBaseUrl: nextOrigin
         });

         activeRoom = resumed;
         activeRoomOrigin = nextOrigin;
         await writeVault(resumed);
      }
   })().finally(() => {
      networkRefreshPromise = undefined;
   });

   return networkRefreshPromise;
}

function setTransferPowerSave(active: boolean): void {
   rendererTransferActive = active;
   updatePowerSaveBlocker();
}

function setServiceTransferPowerSave(active: boolean): void {
   serviceTransferActive = active;
   updatePowerSaveBlocker();
}

function updatePowerSaveBlocker(): void {
   const active = rendererTransferActive || serviceTransferActive;

   if (active) {
      if (powerSaveBlockerId === undefined || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
         powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      }

      return;
   }

   if (powerSaveBlockerId !== undefined && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
   }

   powerSaveBlockerId = undefined;
}
async function addRoomFiles(value: unknown): Promise<unknown> {
   const room = requireActiveRoom();
   const rawFiles = Array.isArray(value) ? value : [];
   const parsed = parseDesktopSourceFiles(rawFiles);
   const files = await Promise.all(parsed.map(validateDesktopFile));

   return requireService().request("add-files", {
      roomId: room.roomId,
      token: room.token,
      files
   });
}

async function validateDesktopFile(file: DesktopSourceFile): Promise<DesktopSourceFile> {
   if (!isAbsolute(file.path)) {
      throw new Error("A selected file does not have a readable local path");
   }

   const info = await stat(file.path);

   if (!info.isFile()) {
      throw new Error("Only regular files can be transferred");
   }

   return {
      path: file.path,
      name: basename(file.path),
      type: file.type || "application/octet-stream",
      size: info.size,
      lastModified: Math.trunc(info.mtimeMs)
   };
}

async function resetActiveRoom(): Promise<DesktopRoomBootstrap> {
   const room = requireActiveRoom();
   const runtime = requireRuntime();
   const next = await requireService().request<ServiceRoomResult>("reset-room", {
      roomId: room.roomId,
      token: room.token,
      appBaseUrl: preferredLanOrigin(runtime)
   });

   activeRoom = next;
   activeRoomOrigin = preferredLanOrigin(runtime);
   await writeVault(next);
   await installDesktopTicket(next, runtime);

   return roomBootstrap();
}

function scheduleServiceRecovery(): void {
   if (restartPromise || isQuitting) {
      return;
   }

   serviceClient = undefined;
   serviceRuntime = undefined;
   restartPromise = new Promise((resolve) => setTimeout(resolve, 500))
      .then(async () => {
         const runtime = await ensureService();

         await ensureActiveRoom(runtime);
         await mainWindow?.loadURL(`${runtime.localUrl}/app`);
      })
      .catch((error: unknown) => {
         const message = error instanceof Error ? error.message : "The transfer service could not restart.";

         void dialog.showMessageBox({
            type: "error",
            title: appName,
            message: "The local transfer service stopped.",
            detail: message
         });
      })
      .finally(() => {
         restartPromise = undefined;
      });
}

function serviceInitPayload(serviceRestarts: number): ServiceInitPayload {
   return {
      version: app.getVersion(),
      serviceRestarts,
      portStart,
      maxPortAttempts,
      storageDir: process.env.LFT_STORAGE_DIR ?? join(app.getPath("userData"), "transfers-v2"),
      receiveDir: process.env.LFT_RECEIVE_DIR ?? join(app.getPath("downloads"), appName),
      staticRoot: webStaticRoot(),
      ttlMs: 15 * 60 * 1000,
      hardTtlMs: 60 * 60 * 1000,
      limits: {
         maxFiles: 100,
         maxFileSize: 4 * 1024 * 1024 * 1024,
         maxRoomSize: 20 * 1024 * 1024 * 1024,
         uploadChunkSize
      }
   };
}

function preferredLanOrigin(runtime: ServiceRuntime): string {
   return runtime.lanUrls.find((url) => !url.includes("localhost")) ?? runtime.localUrl;
}

function webStaticRoot(): string {
   if (app.isPackaged) {
      return join(process.resourcesPath, "web");
   }

   return resolve(app.getAppPath(), "..", "web", "dist");
}

function preloadPath(): string {
   return join(app.getAppPath(), "dist", "preload.cjs");
}

function servicePath(): string {
   return join(app.getAppPath(), "dist", "service.cjs");
}

function maxContentHeightForWindow(window: BrowserWindow): number {
   const display = screen.getDisplayMatching(window.getBounds());
   const screenLimitedHeight = display.workArea.height - 96;

   return Math.max(defaultContentHeight, Math.min(maxPreferredContentHeight, screenLimitedHeight));
}

function resizeMainWindowToContent(height: number): void {
   if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) {
      return;
   }

   const automaticHeight = Math.max(
      defaultContentHeight,
      Math.min(Math.round(height), maxContentHeightForWindow(mainWindow))
   );
   const nextHeight = Math.max(automaticHeight, manualContentHeight ?? 0);
   const currentHeight = mainWindow.getContentSize()[1] ?? defaultContentHeight;

   if (Math.abs(currentHeight - nextHeight) < 8) {
      return;
   }

   isApplyingContentResize = true;
   mainWindow.setContentSize(contentWidth, nextHeight);
   isApplyingContentResize = false;
}

function requireTrustedIpc(event: IpcMainInvokeEvent): void {
   if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Rejected IPC from an unknown renderer");
   }
}

function requireService(): LocalServiceClient {
   if (!serviceClient) {
      throw new Error("The local transfer service is not ready");
   }

   return serviceClient;
}

function requireRuntime(): ServiceRuntime {
   if (!serviceRuntime) {
      throw new Error("The local transfer runtime is not ready");
   }

   return serviceRuntime;
}

function requireActiveRoom(): ServiceRoomResult {
   if (!activeRoom) {
      throw new Error("The transfer room is not ready");
   }

   return activeRoom;
}

function isRuntimeUrl(value: string): boolean {
   try {
      return new URL(value).origin === requireRuntime().localUrl;
   } catch {
      return false;
   }
}

function isSafeExternalUrl(value: string): boolean {
   try {
      const url = new URL(value);

      return (url.protocol === "http:" || url.protocol === "https:")
         && !url.username
         && !url.password
         && value.length <= 4_096;
   } catch {
      return false;
   }
}

function roomCookieName(roomId: string): string {
   return `lft_${roomId.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function vaultPath(): string {
   return join(app.getPath("userData"), "room-credential.json");
}

async function readVault(): Promise<{ roomId: string; token: string } | undefined> {
   if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
   }

   try {
      const record = JSON.parse(await readFile(vaultPath(), "utf8")) as Partial<VaultRecord>;

      if (typeof record.roomId !== "string" || typeof record.encryptedToken !== "string") {
         return undefined;
      }

      return {
         roomId: record.roomId,
         token: safeStorage.decryptString(Buffer.from(record.encryptedToken, "base64"))
      };
   } catch {
      return undefined;
   }
}

async function writeVault(room: ServiceRoomResult): Promise<void> {
   if (!safeStorage.isEncryptionAvailable()) {
      return;
   }

   const path = vaultPath();
   const temporary = `${path}.tmp`;
   const record: VaultRecord = {
      roomId: room.roomId,
      encryptedToken: safeStorage.encryptString(room.token).toString("base64")
   };

   await mkdir(app.getPath("userData"), { recursive: true });
   await writeFile(temporary, JSON.stringify(record), "utf8");
   await rename(temporary, path);
}

class LocalServiceClient {
   private readonly child: UtilityProcess;
   private readonly pending = new Map<string, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
   }>();
   private nextRequestId = 1;
   private expectedExit = false;

   constructor(path: string, onUnexpectedExit: () => void) {
      this.child = utilityProcess.fork(path, [], {
         serviceName: "Local File Transfer Service",
         stdio: "pipe"
      });
      this.child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
      this.child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      this.child.on("message", (response: ServiceResponse) => {
         this.handleResponse(response);
      });
      this.child.on("exit", () => {
         const error = new Error("Local transfer service exited");

         for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
         }

         this.pending.clear();

         if (!this.expectedExit) {
            onUnexpectedExit();
         }
      });
   }

   request<T = unknown>(action: ServiceRequest["action"], payload?: unknown): Promise<T> {
      const requestId = String(this.nextRequestId++);
      const request: ServiceRequest = {
         requestId,
         action,
         ...(payload === undefined ? {} : { payload })
      };

      return new Promise<T>((resolve, reject) => {
         const timeout = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error(`Service request timed out: ${action}`));
         }, serviceRequestTimeoutMs);

         timeout.unref();
         this.pending.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
            timeout
         });
         this.child.postMessage(request);
      });
   }

   async stop(): Promise<void> {
      this.expectedExit = true;

      try {
         await Promise.race([
            this.request("shutdown"),
            new Promise((resolve) => setTimeout(resolve, serviceShutdownGraceMs))
         ]);
      } finally {
         this.child.kill();
      }
   }

   private handleResponse(response: ServiceResponse): void {
      const pending = this.pending.get(response.requestId);

      if (!pending) {
         return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(response.requestId);

      if (response.ok) {
         pending.resolve(response.result);
      } else {
         pending.reject(new Error(response.error ?? "Service request failed"));
      }
   }
}

ipcMain.on(transferActiveChannel, (event, active: unknown) => {
   if (!mainWindow || event.sender !== mainWindow.webContents || typeof active !== "boolean") {
      return;
   }

   setTransferPowerSave(active);
});
ipcMain.on(resizeChannel, (event, payload: unknown) => {
   if (!mainWindow || event.sender !== mainWindow.webContents) {
      return;
   }

   if (
      !payload
      || typeof payload !== "object"
      || !("height" in payload)
      || typeof (payload as { height?: unknown }).height !== "number"
      || !Number.isFinite((payload as { height: number }).height)
   ) {
      return;
   }

   resizeMainWindowToContent((payload as { height: number }).height);
});

ipcMain.handle(bootstrapChannel, async (event) => {
   requireTrustedIpc(event);
   await refreshNetworkRoom();
   return roomBootstrap();
});

ipcMain.handle(addFilesChannel, async (event, payload: unknown) => {
   requireTrustedIpc(event);
   return addRoomFiles(payload);
});

ipcMain.handle(resetRoomChannel, async (event) => {
   requireTrustedIpc(event);
   return resetActiveRoom();
});

ipcMain.handle(showReceivedFileChannel, async (event, payload: unknown) => {
   requireTrustedIpc(event);

   if (!payload || typeof payload !== "object") {
      throw new Error("Invalid received file");
   }

   const input = payload as Partial<CompletedPathPayload>;
   const room = requireActiveRoom();

   if (input.roomId !== room.roomId || typeof input.itemId !== "string") {
      throw new Error("The received file does not belong to the active room");
   }

   const path = await requireService().request<string>("completed-path", {
      roomId: room.roomId,
      itemId: input.itemId
   });

   shell.showItemInFolder(path);
});

ipcMain.handle(openReceiveFolderChannel, async (event) => {
   requireTrustedIpc(event);
   const error = await shell.openPath(requireRuntime().receiveDir);

   if (error) {
      throw new Error(error);
   }
});

ipcMain.handle(diagnosticsChannel, async (event) => {
   requireTrustedIpc(event);
   return requireService().request<RoomDiagnosticSnapshot>("diagnostics");
});

ipcMain.handle(openLogFolderChannel, async (event) => {
   requireTrustedIpc(event);
   const error = await shell.openPath(requireRuntime().logDir);

   if (error) {
      throw new Error(error);
   }
});

if (hasSingleInstanceLock) {
   app.whenReady()
      .then(createMainWindow)
      .catch((error: unknown) => {
         const message = error instanceof Error ? error.message : "The app could not start.";

         void dialog.showMessageBox({
            type: "error",
            title: appName,
            message: "Could not start the local transfer app.",
            detail: message
         });
         app.quit();
      });
}

app.on("activate", () => {
   if (!mainWindow && hasSingleInstanceLock) {
      void createMainWindow();
   }
});

app.on("before-quit", (event) => {
   if (isQuitting || !serviceClient) {
      return;
   }

   event.preventDefault();
   isQuitting = true;
   const client = serviceClient;

   serviceClient = undefined;
   void client.stop().finally(() => {
      app.exit(0);
   });
});

app.on("window-all-closed", () => {
   if (process.platform !== "darwin") {
      app.quit();
   }
});
