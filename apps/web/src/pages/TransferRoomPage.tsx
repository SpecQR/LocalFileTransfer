import {
   ArrowDown,
   ArrowUp,
   Copy,
   Download,
   FolderOpen,
   Info,
   MessageSquareText,
   Pause,
   Play,
   Plus,
   RefreshCw,
   Upload,
   X
} from "lucide-react";
import {
   type CSSProperties,
   type RefObject,
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState
} from "react";
import type {
   RoomItemView,
   RoomView
} from "../../../../packages/protocol/src/index.ts";
import {
   authorizeRoom,
   cancelRoomItem,
   getRoom,
   getRoomDiagnostics,
   roomArchiveUrl,
   roomDownloadUrl,
   roomTokenFromHash,
   subscribeRoom,
   uploadRoomFile
} from "../api/roomClient.ts";
import { type MessageCatalog, useLocale } from "../i18n/catalog.ts";
import { DiagnosticsDialog } from "../ui/DiagnosticsDialog.tsx";
import { QRPanel } from "../ui/QRPanel.tsx";
import { SharedTextDialog } from "../ui/SharedTextDialog.tsx";
import { copyText } from "../utils/clipboard.ts";
import { formatBytes } from "../utils/format.ts";

interface RoomPageProps {
   roomId?: string;
}

type UploadState = "idle" | "preparing" | "uploading" | "paused" | "failed" | "complete";
type RoomConnectionState = "opening" | "connected" | "reconnecting" | "offline" | "ended";

export function TransferRoomPage({ roomId: routeRoomId }: RoomPageProps): JSX.Element {
   const { messages } = useLocale();
   const shellRef = useRef<HTMLElement | null>(null);
   const fileInputRef = useRef<HTMLInputElement | null>(null);
   const uploadAbortRef = useRef<AbortController | null>(null);
   const sharedTextOpenRef = useRef(false);
   const sharedTextRevisionRef = useRef(0);
   const isDesktop = Boolean(window.localFileTransfer);
   const [roomId, setRoomId] = useState(routeRoomId);
   const [joinUrl, setJoinUrl] = useState("");
   const [room, setRoom] = useState<RoomView>();
   const [status, setStatus] = useState(messages.openingRoom);
   const [error, setError] = useState<string>();
   const [connectionState, setConnectionState] = useState<RoomConnectionState>("opening");
   const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
   const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
   const [uploadState, setUploadState] = useState<UploadState>("idle");
   const [copied, setCopied] = useState(false);
   const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
   const [sharedTextOpen, setSharedTextOpen] = useState(false);
   const [sharedTextUnread, setSharedTextUnread] = useState(false);
   const [sharedTextRevision, setSharedTextRevision] = useState(0);
   const observeSharedTextRevision = useCallback((revision: number): void => {
      if (revision <= sharedTextRevisionRef.current) {
         return;
      }

      sharedTextRevisionRef.current = revision;
      setSharedTextRevision(revision);

      if (!sharedTextOpenRef.current) {
         setSharedTextUnread(true);
      }
   }, []);
   const visibleItems = useMemo(
      () => room?.items.filter((item) => item.state !== "cancelled") ?? [],
      [room]
   );
   const downloadableItems = useMemo(
      () => visibleItems.filter((item) => (
         item.direction === "windows_to_device" && item.state === "ready"
      )),
      [visibleItems]
   );
   const uploadActive = uploadState === "preparing" || uploadState === "uploading";
   const shellStyle = {
      "--room-auto-list-height": `${Math.max(1, Math.min(visibleItems.length, 3)) * 58}px`
   } as CSSProperties;

   useDesktopWindowHeight(shellRef, isDesktop);
   useUploadWakeLock(
      uploadActive || visibleItems.some((item) => item.state === "transferring")
   );

   useEffect(() => {
      let stopped = false;

      async function openRoom(): Promise<void> {
         try {
            let resolvedRoomId = routeRoomId;

            if (isDesktop) {
               const bootstrap = await window.localFileTransfer?.roomBootstrap();

               if (!bootstrap) {
                  throw new Error(messages.desktopRoomUnavailable);
               }

               resolvedRoomId = bootstrap.roomId;
               setJoinUrl(bootstrap.joinUrl);
            } else if (resolvedRoomId && window.location.hash) {
               await authorizeRoom(resolvedRoomId, roomTokenFromHash());
            }

            if (!resolvedRoomId) {
               throw new Error(messages.missingRoomId);
            }

            const view = await getRoom(resolvedRoomId);

            if (!stopped) {
               setRoomId(resolvedRoomId);
               setRoom(view);
               setStatus(messages.connected);
               setConnectionState("connected");
               setError(undefined);
            }
         } catch (openError) {
            if (!stopped) {
               setConnectionState(navigator.onLine ? "reconnecting" : "offline");
               setStatus(navigator.onLine ? messages.reconnecting : messages.offline);
               setError(openError instanceof Error ? openError.message : messages.openingFailed);
            }
         }
      }

      void openRoom();
      return () => {
         stopped = true;
      };
   }, [isDesktop, messages, routeRoomId]);

   useEffect(() => {
      if (!isDesktop) {
         return undefined;
      }

      let stopped = false;
      const refreshBootstrap = async (): Promise<void> => {
         try {
            const bootstrap = await window.localFileTransfer?.roomBootstrap();

            if (!bootstrap || stopped) {
               return;
            }

            setJoinUrl(bootstrap.joinUrl);

            if (bootstrap.roomId !== roomId) {
               setRoomId(bootstrap.roomId);
               setRoom(await getRoom(bootstrap.roomId));
               setStatus(messages.connected);
               setConnectionState("connected");
               setError(undefined);
            }
         } catch {
            // The service supervisor owns restart reporting; the current QR remains usable meanwhile.
         }
      };
      const interval = window.setInterval(() => void refreshBootstrap(), 2_500);

      void refreshBootstrap();
      return () => {
         stopped = true;
         window.clearInterval(interval);
      };
   }, [isDesktop, messages, roomId]);

   useEffect(() => {
      sharedTextOpenRef.current = false;
      sharedTextRevisionRef.current = 0;
      setSharedTextOpen(false);
      setSharedTextUnread(false);
      setSharedTextRevision(0);
   }, [roomId]);

   useEffect(() => {
      if (room) {
         observeSharedTextRevision(room.sharedTextRevision);
      }
   }, [observeSharedTextRevision, room]);

   useEffect(() => {
      if (!roomId) {
         return undefined;
      }

      let stopped = false;
      const apply = (view: RoomView): void => {
         if (!stopped) {
            setRoom(view);
            setStatus(messages.connected);
            setConnectionState("connected");
            setError(undefined);
         }
      };
      const markDisconnected = (): void => {
         if (!stopped) {
            const offline = !navigator.onLine;

            setConnectionState(offline ? "offline" : "reconnecting");
            setStatus(offline ? messages.offline : messages.reconnecting);
         }
      };
      const load = async (): Promise<void> => {
         try {
            apply(await getRoom(roomId));
         } catch {
            markDisconnected();
         }
      };
      const unsubscribe = subscribeRoom(roomId, (event) => {
         if (event.room) {
            apply(event.room);
         }

         if (event.t === "shared-text-updated") {
            observeSharedTextRevision(
               event.sharedTextRevision ?? sharedTextRevisionRef.current + 1
            );
         }

         if (event.t === "room-expired" || event.t === "room-reset") {
            setConnectionState("ended");
            setError(messages.roomEnded);
         }
      }, markDisconnected, () => {
         if (!stopped) {
            setConnectionState("connected");
            setStatus(messages.connected);
         }
      });
      const fallback = window.setInterval(() => void load(), 5_000);
      const refresh = (): void => {
         if (document.visibilityState === "visible") {
            void load();
         }
      };
      const online = (): void => {
         setConnectionState("reconnecting");
         setStatus(messages.reconnecting);
         void load();
      };
      const offline = (): void => {
         setConnectionState("offline");
         setStatus(messages.offline);
      };

      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      window.addEventListener("pageshow", refresh);
      document.addEventListener("visibilitychange", refresh);

      return () => {
         stopped = true;
         unsubscribe();
         window.clearInterval(fallback);
         window.removeEventListener("online", online);
         window.removeEventListener("offline", offline);
         window.removeEventListener("pageshow", refresh);
         document.removeEventListener("visibilitychange", refresh);
      };
   }, [messages, observeSharedTextRevision, roomId]);

   const totals = useMemo(() => ({
      bytes: visibleItems.reduce((sum, item) => sum + item.size, 0),
      confirmed: visibleItems.reduce(
         (sum, item) => sum + Math.min(item.size, item.confirmedBytes),
         0
      )
   }), [visibleItems]);

   const closeDiagnostics = useCallback(() => setDiagnosticsOpen(false), []);
   const closeSharedText = useCallback(() => {
      sharedTextOpenRef.current = false;
      setSharedTextOpen(false);
   }, []);
   const markSharedTextSeen = useCallback(() => setSharedTextUnread(false), []);
   const loadDiagnostics = useCallback(async () => {
      if (window.localFileTransfer) {
         return window.localFileTransfer.getDiagnostics();
      }

      if (!roomId) {
         throw new Error(messages.missingRoomId);
      }

      return getRoomDiagnostics(roomId);
   }, [messages.missingRoomId, roomId]);
   const openLogFolder = useCallback(async () => {
      await window.localFileTransfer?.openLogFolder();
   }, []);

   async function addDesktopFiles(files: File[]): Promise<void> {
      if (files.length === 0 || !window.localFileTransfer) {
         return;
      }

      setStatus(messages.addingFiles);

      try {
         const next = await window.localFileTransfer.addFiles(files);

         setRoom(next);
         setStatus(messages.ready);
         setError(undefined);
      } catch (addError) {
         setError(addError instanceof Error ? addError.message : messages.addFilesFailed);
      }
   }

   async function resetRoom(): Promise<void> {
      if (!window.localFileTransfer) {
         return;
      }

      setStatus(messages.creatingRoom);

      try {
         const bootstrap = await window.localFileTransfer.resetRoom();

         setRoomId(bootstrap.roomId);
         setJoinUrl(bootstrap.joinUrl);
         setRoom(await getRoom(bootstrap.roomId));
         setSelectedFiles([]);
         setUploadProgress({});
         setUploadState("idle");
         sharedTextOpenRef.current = false;
         sharedTextRevisionRef.current = 0;
         setSharedTextOpen(false);
         setSharedTextUnread(false);
         setSharedTextRevision(0);
         setStatus(messages.ready);
         setConnectionState("connected");
         setError(undefined);
      } catch (resetError) {
         setError(resetError instanceof Error ? resetError.message : messages.resetFailed);
      }
   }

   async function retryConnection(): Promise<void> {
      if (!roomId) {
         return;
      }

      setConnectionState("reconnecting");
      setStatus(messages.reconnecting);

      try {
         const next = await getRoom(roomId);

         setRoom(next);
         setStatus(messages.connected);
         setConnectionState("connected");
         setError(undefined);
      } catch (retryError) {
         const offline = !navigator.onLine;

         setConnectionState(offline ? "offline" : "reconnecting");
         setStatus(offline ? messages.offline : messages.reconnecting);
         setError(retryError instanceof Error ? retryError.message : messages.refreshFailed);
      }
   }

   async function uploadSelected(): Promise<void> {
      if (!roomId || selectedFiles.length === 0 || uploadAbortRef.current) {
         return;
      }

      const queue = [...selectedFiles];
      const controller = new AbortController();
      const failed: string[] = [];
      let paused = false;

      uploadAbortRef.current = controller;
      setUploadState("preparing");
      setError(undefined);

      try {
         for (const [index, file] of queue.entries()) {
            const key = fileKey(file);

            try {
               await uploadRoomFile(roomId, file, (confirmed) => {
                  setUploadProgress((current) => ({
                     ...current,
                     [key]: confirmed
                  }));
               }, (phase) => {
                  setUploadState(phase);
                  setStatus(phase === "preparing"
                     ? messages.preparingFile(index + 1, queue.length)
                     : messages.uploadingFile(index + 1, queue.length));
               }, {
                  signal: controller.signal
               });
               setSelectedFiles((current) => current.filter((candidate) => candidate !== file));
               setUploadProgress((current) => {
                  const next = { ...current };

                  delete next[key];
                  return next;
               });
            } catch (uploadError) {
               if (controller.signal.aborted) {
                  paused = true;
                  break;
               }

               failed.push(file.name);
            }
         }
      } finally {
         if (uploadAbortRef.current === controller) {
            uploadAbortRef.current = null;
         }
      }

      if (paused) {
         setUploadState("paused");
         setStatus(messages.uploadPaused);
         setError(undefined);
         return;
      }

      if (failed.length > 0) {
         setUploadState("failed");
         setStatus(messages.filesNeedRetry(failed.length));
         setError(messages.retryExplanation);
         return;
      }

      setUploadState("complete");
      setStatus(messages.uploadComplete);
      setUploadProgress({});
   }

   function pauseUpload(): void {
      setStatus(messages.pausing);
      uploadAbortRef.current?.abort();
   }

   async function cancel(item: RoomItemView): Promise<void> {
      if (!roomId) {
         return;
      }

      try {
         await cancelRoomItem(roomId, item.itemId);
         setRoom(await getRoom(roomId));
      } catch (cancelError) {
         setError(cancelError instanceof Error ? cancelError.message : messages.cancelFailed);
      }
   }

   const sharedText = (
      <SharedTextDialog
         messages={messages}
         onClose={closeSharedText}
         onSeen={markSharedTextSeen}
         open={sharedTextOpen}
         revisionSignal={sharedTextRevision}
         roomId={roomId}
      />
   );
   const recoveryNotice = (
      connectionState === "reconnecting" || connectionState === "offline"
   ) ? (
      <section className="room-recovery" role="status">
         <span>
            {connectionState === "offline" ? messages.offline : messages.reconnecting}
         </span>
         <button type="button" onClick={() => void retryConnection()}>
            <RefreshCw aria-hidden="true" size={16} />
            {messages.retryConnection}
         </button>
      </section>
   ) : null;
   const diagnostics = (
      <DiagnosticsDialog
         load={loadDiagnostics}
         messages={messages}
         onClose={closeDiagnostics}
         open={diagnosticsOpen}
         {...(isDesktop ? { onOpenLogFolder: openLogFolder } : {})}
      />
   );

   if (!isDesktop) {
      return (
         <>
            <main className="room-mobile">
               <header className="room-mobile-header">
                  <div>
                     <p className="room-kicker">{messages.appName}</p>
                     <h1 aria-atomic="true" aria-live="polite">{error ?? status}</h1>
                  </div>
                  <div className="room-mobile-tools">
                     <button
                        aria-label={sharedTextUnread ? messages.sharedTextUnread : messages.sharedText}
                        className="icon-button shared-text-tool"
                        data-testid="shared-text-open"
                        disabled={!roomId}
                        title={messages.sharedText}
                        type="button"
                        onClick={() => {
                           sharedTextOpenRef.current = true;
                           setSharedTextOpen(true);
                           setSharedTextUnread(false);
                        }}
                     >
                        <MessageSquareText aria-hidden="true" size={20} />
                        {sharedTextUnread ? <span aria-hidden="true" className="shared-text-unread" /> : null}
                     </button>
                     <button
                        aria-label={messages.diagnostics}
                        className="icon-button"
                        title={messages.diagnostics}
                        type="button"
                        onClick={() => setDiagnosticsOpen(true)}
                     >
                        <Info aria-hidden="true" size={20} />
                     </button>
                     <button
                        aria-label={messages.refreshRoom}
                        className="icon-button"
                        title={messages.refreshRoom}
                        type="button"
                        onClick={() => roomId && void getRoom(roomId).then(setRoom)}
                     >
                        <RefreshCw aria-hidden="true" size={20} />
                     </button>
                  </div>
               </header>

               {recoveryNotice}

               <section className="room-mobile-actions">
                  <label className="room-file-picker">
                     <Upload aria-hidden="true" size={22} />
                     <span>{messages.chooseFiles}</span>
                     <input
                        multiple
                        type="file"
                        disabled={uploadActive}
                        onChange={(event) => {
                           setSelectedFiles(Array.from(event.currentTarget.files ?? []));
                           setUploadProgress({});
                           setUploadState("idle");
                           event.currentTarget.value = "";
                        }}
                     />
                  </label>
                  {selectedFiles.length > 0 ? (
                     <button
                        className="room-primary-action"
                        type="button"
                        onClick={() => {
                           if (uploadActive) {
                              pauseUpload();
                           } else {
                              void uploadSelected();
                           }
                        }}
                     >
                        {uploadActive
                           ? <Pause aria-hidden="true" size={19} />
                           : uploadState === "paused" || uploadState === "failed"
                              ? <Play aria-hidden="true" size={19} />
                              : <ArrowUp aria-hidden="true" size={19} />}
                        {uploadActive
                           ? messages.pause
                           : uploadState === "paused" || uploadState === "failed"
                              ? messages.resume
                              : messages.uploadCount(selectedFiles.length)}
                     </button>
                  ) : null}
               </section>

               {selectedFiles.length > 0 ? (
                  <section className="room-selected-list" aria-label={messages.selectedFiles}>
                     {selectedFiles.map((file, index) => {
                        const confirmed = uploadProgress[fileKey(file)] ?? 0;

                        return (
                           <div className="room-selected-row" key={fileKey(file) + ":" + index}>
                              <div>
                                 <span>{file.name}</span>
                                 <small>{formatBytes(confirmed)} / {formatBytes(file.size)}</small>
                              </div>
                              <button
                                 aria-label={messages.removeSelectedFile(file.name)}
                                 className="icon-button room-selected-remove"
                                 disabled={uploadActive}
                                 title={messages.cancel}
                                 type="button"
                                 onClick={() => {
                                    setSelectedFiles((current) => current.filter(
                                       (candidate, candidateIndex) => candidate !== file || candidateIndex !== index
                                    ));
                                 }}
                              >
                                 <X aria-hidden="true" size={18} />
                              </button>
                           </div>
                        );
                     })}
                  </section>
               ) : null}

               {downloadableItems.length >= 2 && roomId ? (
                  <a
                     className="room-download-all"
                     download={messages.downloadAllName}
                     href={roomArchiveUrl(roomId)}
                  >
                     <Download aria-hidden="true" size={19} />
                     {messages.downloadAll(downloadableItems.length)}
                  </a>
               ) : null}

               <RoomQueue
                  isDesktop={false}
                  items={visibleItems}
                  messages={messages}
                  roomId={roomId}
                  onCancel={cancel}
               />
            </main>
            {diagnostics}
            {sharedText}
         </>
      );
   }

   return (
      <>
         <main
            className="room-desktop"
            ref={shellRef}
            style={shellStyle}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
               event.preventDefault();
               void addDesktopFiles(Array.from(event.dataTransfer.files));
            }}
         >
            <header className="room-toolbar">
               <div className="room-status" aria-atomic="true" aria-live="polite">
                  <span className={
                     error
                        ? "status-dot status-dot-error"
                        : connectionState === "reconnecting" || connectionState === "offline"
                           ? "status-dot status-dot-warning"
                           : "status-dot"
                  } />
                  <span>{error ?? status}</span>
               </div>
               <div className="room-tools">
                  <button
                     aria-label={messages.addFiles}
                     className="icon-button"
                     title={messages.addFiles}
                     type="button"
                     onClick={() => fileInputRef.current?.click()}
                  >
                     <Plus aria-hidden="true" size={21} />
                  </button>
                  <button
                     aria-label={messages.copyRoomLink}
                     className="icon-button"
                     title={messages.copyLink}
                     type="button"
                     onClick={async () => {
                        await copyText(joinUrl);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1_500);
                     }}
                  >
                     <Copy aria-hidden="true" size={19} />
                  </button>
                  <button
                     aria-label={sharedTextUnread ? messages.sharedTextUnread : messages.sharedText}
                     className="icon-button shared-text-tool"
                     data-testid="shared-text-open"
                     disabled={!roomId}
                     title={messages.sharedText}
                     type="button"
                     onClick={() => {
                        sharedTextOpenRef.current = true;
                        setSharedTextOpen(true);
                        setSharedTextUnread(false);
                     }}
                  >
                     <MessageSquareText aria-hidden="true" size={19} />
                     {sharedTextUnread ? <span aria-hidden="true" className="shared-text-unread" /> : null}
                  </button>
                  <button
                     aria-label={messages.diagnostics}
                     className="icon-button"
                     title={messages.diagnostics}
                     type="button"
                     onClick={() => setDiagnosticsOpen(true)}
                  >
                     <Info aria-hidden="true" size={19} />
                  </button>
                  <button
                     aria-label={messages.resetRoom}
                     className="icon-button"
                     title={messages.resetRoom}
                     type="button"
                     onClick={() => void resetRoom()}
                  >
                     <RefreshCw aria-hidden="true" size={21} />
                  </button>
                  <input
                     ref={fileInputRef}
                     className="visually-hidden"
                     multiple
                     type="file"
                     onChange={(event) => {
                        void addDesktopFiles(Array.from(event.currentTarget.files ?? []));
                        event.currentTarget.value = "";
                     }}
                  />
               </div>
            </header>

            {recoveryNotice}

            {joinUrl ? (
               <section className="room-qr-square">
                  <QRPanel compact label={messages.roomQr} url={joinUrl} />
               </section>
            ) : (
               <section className="room-qr-square room-qr-loading">{messages.openingRoom}</section>
            )}

            <section className="room-summary">
               <strong>
                  {visibleItems.length === 0
                     ? messages.readyToConnect
                     : messages.filesCount(visibleItems.length)}
               </strong>
               {visibleItems.length > 0 ? (
                  <span>{formatBytes(totals.confirmed)} / {formatBytes(totals.bytes)}</span>
               ) : null}
               {copied ? <span className="room-copied">{messages.copied}</span> : null}
            </section>

            <RoomQueue
               isDesktop
               items={visibleItems}
               messages={messages}
               roomId={roomId}
               onCancel={cancel}
            />
         </main>
         {diagnostics}
         {sharedText}
      </>
   );
}

interface RoomQueueProps {
   roomId: string | undefined;
   items: RoomItemView[];
   isDesktop: boolean;
   messages: MessageCatalog;
   onCancel: (item: RoomItemView) => Promise<void>;
}

function RoomQueue({ roomId, items, isDesktop, messages, onCancel }: RoomQueueProps): JSX.Element {
   if (items.length === 0) {
      return <div className="room-empty" />;
   }

   return (
      <section className="room-queue" aria-label={messages.transfers}>
         {items.map((item) => {
            const incoming = isDesktop
               ? item.direction === "device_to_windows"
               : item.direction === "windows_to_device";
            const progress = item.size === 0
               ? 100
               : Math.round((Math.min(item.confirmedBytes, item.size) / item.size) * 100);
            const canCancel = item.state === "pending" || item.state === "transferring";

            return (
               <article
                  aria-label={(incoming ? messages.incoming : messages.outgoing) + ": " + item.name}
                  className="room-item"
                  key={item.itemId}
               >
                  <div
                     aria-hidden="true"
                     className="room-item-direction"
                     title={incoming ? messages.incoming : messages.outgoing}
                  >
                     {incoming ? <ArrowDown size={18} /> : <ArrowUp size={18} />}
                  </div>
                  <div className="room-item-body">
                     <strong title={item.name}>{item.name}</strong>
                     <small>
                        {formatBytes(item.size)} - {item.state === "transferring"
                           ? `${progress}%`
                           : stateLabel(item, messages)}
                     </small>
                     {item.state === "transferring" ? (
                        <span
                           aria-label={item.name}
                           aria-valuemax={100}
                           aria-valuemin={0}
                           aria-valuenow={progress}
                           className="room-item-progress"
                           role="progressbar"
                        >
                           <span style={{ width: `${progress}%` }} />
                        </span>
                     ) : null}
                  </div>
                  <div className="room-item-actions">
                     {!isDesktop && incoming && item.state === "ready" && roomId ? (
                        <a
                           aria-label={messages.downloadFile(item.name)}
                           className="icon-button room-action-button"
                           download={item.name}
                           href={roomDownloadUrl(roomId, item.itemId)}
                           title={messages.download}
                        >
                           <Download aria-hidden="true" size={19} />
                        </a>
                     ) : null}
                     {isDesktop && incoming && item.state === "ready" && roomId ? (
                        <button
                           aria-label={messages.showInFolderFile(item.name)}
                           className="icon-button room-action-button"
                           title={messages.showInFolder}
                           type="button"
                           onClick={() => void window.localFileTransfer?.showReceivedFile(roomId, item.itemId)}
                        >
                           <FolderOpen aria-hidden="true" size={19} />
                        </button>
                     ) : null}
                     {canCancel ? (
                        <button
                           aria-label={messages.cancelFile(item.name)}
                           className="icon-button room-action-button"
                           title={messages.cancel}
                           type="button"
                           onClick={() => void onCancel(item)}
                        >
                           <X aria-hidden="true" size={18} />
                        </button>
                     ) : null}
                  </div>
               </article>
            );
         })}
      </section>
   );
}

function stateLabel(item: RoomItemView, messages: MessageCatalog): string {
   switch (item.state) {
      case "ready":
         return item.direction === "windows_to_device" && item.confirmedBytes < item.size
            ? messages.stateReady
            : messages.stateComplete;
      case "failed":
         return messages.stateFailed;
      case "cancelled":
         return messages.stateCancelled;
      case "pending":
         return messages.stateWaiting;
      default:
         return item.state;
   }
}

function fileKey(file: File): string {
   return [file.name, file.type, file.size, file.lastModified].join(":");
}

function useUploadWakeLock(active: boolean): void {
   useEffect(() => {
      const wakeLockNavigator = navigator as Navigator & {
         wakeLock?: {
            request(type: "screen"): Promise<{ released: boolean; release(): Promise<void> }>;
         };
      };
      let stopped = false;
      let sentinel: { released: boolean; release(): Promise<void> } | undefined;
      const acquire = async (): Promise<void> => {
         if (!active || stopped || document.visibilityState !== "visible" || sentinel) {
            return;
         }

         try {
            sentinel = await wakeLockNavigator.wakeLock?.request("screen");
         } catch {
            sentinel = undefined;
         }
      };
      const refresh = (): void => {
         if (sentinel?.released) {
            sentinel = undefined;
         }

         void acquire();
      };

      document.addEventListener("visibilitychange", refresh);
      void acquire();
      void window.localFileTransfer?.setTransferActive(active);

      return () => {
         stopped = true;
         document.removeEventListener("visibilitychange", refresh);
         void sentinel?.release();
         void window.localFileTransfer?.setTransferActive(false);
      };
   }, [active]);
}

function useDesktopWindowHeight(shellRef: RefObject<HTMLElement>, enabled: boolean): void {
   useEffect(() => {
      const bridge = window.localFileTransfer;
      const shell = shellRef.current;

      if (!enabled || !bridge || !shell) {
         return undefined;
      }

      let frame = 0;
      const reportHeight = (): void => {
         window.cancelAnimationFrame(frame);
         frame = window.requestAnimationFrame(() => {
            bridge.resizeToContent({
               height: Math.ceil(Math.max(shell.scrollHeight, shell.getBoundingClientRect().height))
            });
         });
      };
      const observer = new ResizeObserver(reportHeight);

      observer.observe(shell);
      reportHeight();

      return () => {
         observer.disconnect();
         window.cancelAnimationFrame(frame);
      };
   }, [enabled, shellRef]);
}
