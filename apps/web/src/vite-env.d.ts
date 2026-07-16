/// <reference types="vite/client" />

interface StorageManager {
   getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
   getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
}

interface FileSystemFileHandle {
   createWritable(): Promise<FileSystemWritableFileStream>;
   getFile(): Promise<File>;
}

interface FileSystemWritableFileStream extends WritableStream {
   seek(position: number): Promise<void>;
   write(data: BufferSource | Blob | string): Promise<void>;
   close(): Promise<void>;
}

interface Window {
   localFileTransfer?: {
      prepareSendFiles(files: File[], preferredOrigin?: string): Promise<import("../../../packages/protocol/src/index.ts").CreateLocalSessionResponse>;
      createUploadSession(preferredOrigin?: string): Promise<import("../../../packages/protocol/src/index.ts").CreateLocalSessionResponse>;
      resizeToContent(size: { height: number }): void;
      roomBootstrap(): Promise<import("../../../apps/desktop/src/serviceProtocol.ts").DesktopRoomBootstrap>;
      addFiles(files: File[]): Promise<import("../../../packages/protocol/src/index.ts").RoomView>;
      resetRoom(): Promise<import("../../../apps/desktop/src/serviceProtocol.ts").DesktopRoomBootstrap>;
      setTransferActive(active: boolean): void;
      showReceivedFile(roomId: string, itemId: string): Promise<void>;
      openReceiveFolder(): Promise<void>;
      getDiagnostics(): Promise<import("../../../packages/protocol/src/index.ts").RoomDiagnosticSnapshot>;
      openLogFolder(): Promise<void>;
   };
}
