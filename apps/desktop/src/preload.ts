import {
   contextBridge,
   ipcRenderer,
   webUtils
} from "electron";
import type {
   RoomView
} from "../../../packages/protocol/src/index.ts";
import type { DesktopRoomBootstrap } from "./serviceProtocol.ts";

const resizeChannel = "local-file-transfer:resize-content";
const bootstrapChannel = "local-file-transfer:room-bootstrap";
const addFilesChannel = "local-file-transfer:add-room-files";
const resetRoomChannel = "local-file-transfer:reset-room";
const transferActiveChannel = "local-file-transfer:transfer-active";
const showReceivedFileChannel = "local-file-transfer:show-received-file";
const openReceiveFolderChannel = "local-file-transfer:open-receive-folder";
const diagnosticsChannel = "local-file-transfer:diagnostics";
const openLogFolderChannel = "local-file-transfer:open-log-folder";

contextBridge.exposeInMainWorld("localFileTransfer", {
   resizeToContent(size: { height: number }): void {
      if (!Number.isFinite(size.height)) {
         return;
      }

      ipcRenderer.send(resizeChannel, {
         height: Math.round(size.height)
      });
   },

   roomBootstrap(): Promise<DesktopRoomBootstrap> {
      return ipcRenderer.invoke(bootstrapChannel) as Promise<DesktopRoomBootstrap>;
   },

   addFiles(files: File[]): Promise<RoomView> {
      const selected = files.map((file) => {
         const path = webUtils.getPathForFile(file);

         if (!path) {
            throw new Error(`Could not resolve the local path for ${file.name}`);
         }

         return {
            path,
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            lastModified: file.lastModified
         };
      });

      return ipcRenderer.invoke(addFilesChannel, selected) as Promise<RoomView>;
   },

   resetRoom(): Promise<DesktopRoomBootstrap> {
      return ipcRenderer.invoke(resetRoomChannel) as Promise<DesktopRoomBootstrap>;
   },

   setTransferActive(active: boolean): void {
      ipcRenderer.send(transferActiveChannel, active === true);
   },

   showReceivedFile(roomId: string, itemId: string): Promise<void> {
      return ipcRenderer.invoke(showReceivedFileChannel, {
         roomId,
         itemId
      }) as Promise<void>;
   },

   openReceiveFolder(): Promise<void> {
      return ipcRenderer.invoke(openReceiveFolderChannel) as Promise<void>;
   },

   getDiagnostics(): Promise<import("../../../packages/protocol/src/index.ts").RoomDiagnosticSnapshot> {
      return ipcRenderer.invoke(diagnosticsChannel) as Promise<import("../../../packages/protocol/src/index.ts").RoomDiagnosticSnapshot>;
   },

   openLogFolder(): Promise<void> {
      return ipcRenderer.invoke(openLogFolderChannel) as Promise<void>;
   }
});
