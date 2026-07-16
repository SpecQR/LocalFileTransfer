import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import type {
   CreateLocalSessionResponse,
   LocalFileRecord,
   LocalNetworkCandidate,
   LocalSessionView
} from "../../../../packages/protocol/src/index.ts";
import {
   authorizeSession,
   createSendSession,
   createUploadSession,
   deleteLocalSession,
   getLocalInfo,
   getUploadSession,
   subscribeSessionEvents,
   uploadedFileDownloadUrl,
   uploadSendFile
} from "../api/client.ts";
import { ProgressView } from "../ui/ProgressView.tsx";
import { QRPanel } from "../ui/QRPanel.tsx";
import { formatBytes } from "../utils/format.ts";

type Mode = "send" | "receive";
type WorkState = "idle" | "creating" | "uploading" | "ready" | "failed" | "cancelled";

export function SendPage(): JSX.Element {
   const shellRef = useRef<HTMLElement | null>(null);
   const isDesktop = Boolean(window.localFileTransfer);
   const [mode, setMode] = useState<Mode>("send");
   const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
   const [sendSession, setSendSession] = useState<CreateLocalSessionResponse>();
   const [sendState, setSendState] = useState<WorkState>("idle");
   const [sendMessage, setSendMessage] = useState("Drop files here or choose files");
   const [sendProgress, setSendProgress] = useState<Record<string, number>>({});
   const [sendStartedAt, setSendStartedAt] = useState<number>();
   const [uploadSession, setUploadSession] = useState<CreateLocalSessionResponse>();
   const [uploadView, setUploadView] = useState<LocalSessionView>();
   const [uploadMessage, setUploadMessage] = useState("Waiting for uploads");
   const [selectedOrigin, setSelectedOrigin] = useState("");
   const [networkDiagnostic, setNetworkDiagnostic] = useState<string>();
   const [connectionDiagnostic, setConnectionDiagnostic] = useState<string>();
   const [fileInputKey, setFileInputKey] = useState(0);
   const creatingUploadRef = useRef(false);

   const totalSelectedBytes = useMemo(
      () => selectedFiles.reduce((sum, file) => sum + file.size, 0),
      [selectedFiles]
   );
   const uploadedBytes = Object.values(sendProgress).reduce((sum, value) => sum + value, 0);
   const receivedFiles = uploadView?.files ?? [];
   const receivedBytes = receivedFiles.reduce((sum, file) => sum + file.receivedSize, 0);
   const qrOrigin = selectedOrigin;
   const diagnostic = networkDiagnostic ?? connectionDiagnostic;
   const hasDetails = mode === "send"
      ? sendState !== "idle" || selectedFiles.length > 0 || Boolean(diagnostic)
      : true;
   const hasQr = mode === "send" ? Boolean(sendSession?.url) : Boolean(uploadSession?.url);
   const visibleFileCount = mode === "send"
      ? sendSession?.files?.length ?? selectedFiles.length
      : receivedFiles.length;
   const desktopShellStyle = {
      "--transfer-auto-list-height": `${Math.max(1, Math.min(visibleFileCount, 3)) * 48}px`
   } as CSSProperties;

   useDesktopWindowHeight(shellRef);

   useEffect(() => {
      async function loadNetworkInfo(): Promise<void> {
         try {
            const info = await getLocalInfo();
            const preferred = preferredCandidate(info.lanCandidates);

            setSelectedOrigin(preferred?.origin ?? info.lanOrigins[0] ?? window.location.origin);
            setNetworkDiagnostic(
               !preferred || preferred.address === "localhost"
                  ? "No reachable LAN address was found. Connect Windows to Wi-Fi or Ethernet."
                  : preferred.warning
            );
         } catch {
            setSelectedOrigin(window.location.origin);
            setNetworkDiagnostic("The LAN address could not be detected. Check the Windows network connection.");
         }
      }

      void loadNetworkInfo();
   }, []);

   useEffect(() => {
      if (mode === "receive" && !uploadSession && !creatingUploadRef.current) {
         void regenerateUploadSession();
      }
   }, [mode, uploadSession]);

   useEffect(() => {
      if (!uploadSession) {
         return undefined;
      }

      const currentSession = uploadSession;
      let stopped = false;
      const applyView = (view: LocalSessionView): void => {
         if (!stopped) {
            setUploadView(view);
            setUploadMessage(view.files.length > 0 ? "Files received" : "Waiting for uploads");

            if (view.files.length > 0) {
               setConnectionDiagnostic(undefined);
            }
         }
      };
      const poll = async (): Promise<void> => {
         try {
            applyView(await getUploadSession(currentSession.sid));
         } catch (error) {
            if (!stopped) {
               setUploadMessage(error instanceof Error ? error.message : "Refresh failed");
            }
         }
      };
      const unsubscribe = subscribeSessionEvents(currentSession.sid, (event) => {
         if (event.session) {
            applyView(event.session);
         }

         if (event.t === "session-expired" || event.t === "session-deleted") {
            setUploadMessage("Receive session expired. Regenerate the QR code.");
         }
      });

      void poll();
      const id = window.setInterval(() => void poll(), 5_000);

      return () => {
         stopped = true;
         unsubscribe();
         window.clearInterval(id);
      };
   }, [uploadSession]);

   useEffect(() => {
      if (!sendSession) {
         return undefined;
      }

      return subscribeSessionEvents(sendSession.sid, (event) => {
         const eventSession = event.session;

         if (eventSession?.kind === "send") {
            setSendSession((current) => current ? { ...current, files: eventSession.files } : current);
         }

         if (event.t === "joined") {
            setConnectionDiagnostic(undefined);
            setSendMessage("Device connected");
         }

         if (event.t === "file-complete" && event.session?.files.every((file) => file.transferredSize === file.size)) {
            setSendMessage("Transfer complete");
         }
      });
   }, [sendSession?.sid]);

   useEffect(() => {
      const session = mode === "send" ? sendSession : uploadSession;

      if (!session) {
         return undefined;
      }

      const id = window.setTimeout(() => {
         setConnectionDiagnostic(
            "If the QR does not open, allow Local File Transfer through Windows Firewall and check Wi-Fi client isolation."
         );
      }, 12_000);

      return () => window.clearTimeout(id);
   }, [mode, sendSession?.sid, uploadSession?.sid]);

   async function chooseFiles(files: File[]): Promise<void> {
      if (files.length === 0) {
         return;
      }

      if (sendSession) {
         await deleteLocalSession(sendSession.sid, sendSession.token).catch(() => undefined);
      }

      setMode("send");
      setSelectedFiles(files);
      setSendSession(undefined);
      setSendState("creating");
      setSendMessage("Preparing QR");
      setSendProgress({});
      setSendStartedAt(undefined);
      setConnectionDiagnostic(undefined);

      try {
         const origin = selectedOrigin || (await resolvePreferredOrigin());
         const bridge = window.localFileTransfer;
         const session = bridge
            ? await bridge.prepareSendFiles(files, origin)
            : await createSendSession(files, origin);

         await authorizeSession(session.sid, session.token);
         setSendSession(session);
         setSendStartedAt(Date.now());

         if (bridge) {
            setSendProgress(Object.fromEntries((session.files ?? []).map((file) => [file.fileId, file.size])));
            setSendState("ready");
            setSendMessage("Ready to scan");
            return;
         }

         setSendState("uploading");
         setSendMessage("Preparing files");

         for (const [index, file] of files.entries()) {
            const record = session.files?.[index];

            if (!record) {
               throw new Error(`Missing file id for ${file.name}`);
            }

            await uploadSendFile(session.sid, record.fileId, file, (sent) => {
               setSendProgress((current) => ({ ...current, [record.fileId]: sent }));
            });
            setSendProgress((current) => ({ ...current, [record.fileId]: file.size }));
         }

         setSendState("ready");
         setSendMessage("Ready to scan");
      } catch (error) {
         setSendState("failed");
         setSendMessage(error instanceof Error ? error.message : "Transfer setup failed");
      }
   }

   async function resetSend(): Promise<void> {
      if (sendSession) {
         await deleteLocalSession(sendSession.sid, sendSession.token).catch(() => undefined);
      }

      setSelectedFiles([]);
      setSendSession(undefined);
      setSendState("idle");
      setSendMessage("Drop files here or choose files");
      setSendProgress({});
      setSendStartedAt(undefined);
      setFileInputKey((current) => current + 1);
   }

   async function regenerateUploadSession(): Promise<void> {
      if (creatingUploadRef.current) {
         return;
      }

      creatingUploadRef.current = true;
      setUploadMessage("Creating QR");
      setConnectionDiagnostic(undefined);

      try {
         if (uploadSession) {
            await deleteLocalSession(uploadSession.sid, uploadSession.token).catch(() => undefined);
         }

         const origin = selectedOrigin || (await resolvePreferredOrigin());
         const session = window.localFileTransfer
            ? await window.localFileTransfer.createUploadSession(origin)
            : await createUploadSession(origin);

         await authorizeSession(session.sid, session.token);
         setUploadSession(session);
         setUploadView({
            sid: session.sid,
            kind: "upload",
            createdAt: Date.now(),
            expiresAt: session.expiresAt,
            files: session.files ?? []
         });
         setUploadMessage("Waiting for uploads");
      } catch (error) {
         setUploadMessage(error instanceof Error ? error.message : "QR creation failed");
      } finally {
         creatingUploadRef.current = false;
      }
   }

   async function handleReset(): Promise<void> {
      if (mode === "send") {
         await resetSend();
         return;
      }

      await regenerateUploadSession();
   }

   return (
      <main
         ref={shellRef}
         className={`transfer-shell ${isDesktop ? "desktop-transfer-shell" : ""} ${hasDetails ? "has-details" : ""} ${hasQr ? "qr-active" : ""}`}
         style={isDesktop ? desktopShellStyle : undefined}
      >
         <section className="transfer-toolbar" aria-label="Transfer mode">
            <div className={`transfer-mode-switch ${mode}`} role="group">
               <button
                  className={mode === "send" ? "active" : ""}
                  aria-pressed={mode === "send"}
                  type="button"
                  onClick={() => setMode("send")}
               >
                  Send
               </button>
               <button
                  className={mode === "receive" ? "active" : ""}
                  aria-pressed={mode === "receive"}
                  type="button"
                  onClick={() => setMode("receive")}
               >
                  Receive
               </button>
            </div>
            <button
               aria-label={mode === "send" ? "Reset transfer" : "Regenerate receive QR"}
               className="transfer-action"
               title={mode === "send" ? "Reset transfer" : "Regenerate receive QR"}
               type="button"
               onClick={() => void handleReset()}
            >
               <RefreshCw aria-hidden="true" size={19} strokeWidth={2.4} />
            </button>
         </section>

         <section

            className={`transfer-stage ${mode === "send" && !sendSession ? "is-drop-target" : ""}`}
            onDragOver={(event) => {
               if (mode === "send") {
                  event.preventDefault();
               }
            }}
            onDrop={(event) => {
               if (mode !== "send") {
                  return;
               }

               event.preventDefault();
               void chooseFiles(Array.from(event.dataTransfer.files));
            }}
         >
            {mode === "send" ? (
               sendSession?.url ? (
                  <QRPanel url={sendSession.url} label="Download QR code" />
               ) : (
                  <label className="transfer-drop-target">
                     <span className="transfer-drop-mark" aria-hidden="true">up</span>
                     <strong>Drop files here</strong>
                     <span>or choose files</span>
                     <input
                        key={fileInputKey}
                        multiple
                        type="file"
                        onChange={(event) => {
                           void chooseFiles(Array.from(event.currentTarget.files ?? []));
                        }}
                     />
                  </label>
               )
            ) : (
               uploadSession?.url ? (
                  <QRPanel url={uploadSession.url} label="Upload QR code" />
               ) : (
                  <div className="stage-pending">Creating QR</div>
               )
            )}
         </section>

         {hasDetails ? (
            <section className="transfer-details" aria-label="Transfer details">
               {mode === "send" ? (
                  <SendDetails
                     files={sendSession?.files ?? selectedFiles.map(fileToRecord)}
                     message={sendMessage}
                     progressBytes={uploadedBytes}
                     startedAt={sendStartedAt}
                     state={sendState}
                     totalBytes={totalSelectedBytes}
                  />
               ) : (
                  <ReceiveDetails
                     files={receivedFiles}
                     message={uploadMessage}
                     progressBytes={receivedBytes}
                     session={uploadSession}
                  />
               )}
               {diagnostic ? (
                  <p className="transfer-diagnostic">{diagnostic}</p>
               ) : null}
            </section>
         ) : null}
      </main>
   );
}

function SendDetails({
   files,
   message,
   progressBytes,
   startedAt,
   state,
   totalBytes
}: {
   files: LocalFileRecord[];
   message: string;
   progressBytes: number;
   startedAt?: number | undefined;
   state: WorkState;
   totalBytes: number;
}): JSX.Element {
   if (state === "idle" && files.length === 0) {
      return <></>;
   }

   return (
      <>
         <p className={`transfer-status ${state}`}>{message}</p>
         {totalBytes > 0 ? (
            <ProgressView
               label="Prepared"
               confirmedBytes={progressBytes}
               totalBytes={totalBytes}
               startedAt={startedAt}
            />
         ) : null}
         <MiniFileList files={files} emptyLabel="No files selected" />
      </>
   );
}

function ReceiveDetails({
   files,
   message,
   progressBytes,
   session
}: {
   files: LocalFileRecord[];
   message: string;
   progressBytes: number;
   session: CreateLocalSessionResponse | undefined;
}): JSX.Element {
   return (
      <>
         <p className="transfer-status">{message}</p>
         {files.length > 0 ? (
            <ProgressView
               label="Received"
               confirmedBytes={progressBytes}
               totalBytes={Math.max(progressBytes, 1)}
            />
         ) : null}
         {files.length > 0 ? (
            <MiniFileList files={files} emptyLabel="No files received" session={session} />
         ) : null}
      </>
   );
}

function MiniFileList({
   files,
   emptyLabel,
   session
}: {
   files: LocalFileRecord[];
   emptyLabel: string;
   session?: CreateLocalSessionResponse | undefined;
}): JSX.Element {
   if (files.length === 0) {
      return <p className="subtle">{emptyLabel}</p>;
   }

   return (
      <ul className="transfer-file-list">
         {files.map((file) => (
            <li key={file.fileId}>
               <div>
                  <span>{file.name}</span>
                  <small>{formatBytes(file.ready ? file.size : file.receivedSize)}</small>
               </div>
               {session && file.ready ? (
                  window.localFileTransfer ? (
                     <button
                        aria-label={`Show ${file.name} in folder`}
                        className="transfer-download"
                        title="Show in folder"
                        type="button"
                        onClick={() => void window.localFileTransfer?.showReceivedFile(session.sid, file.fileId)}
                     >
                        <FolderOpen aria-hidden="true" size={16} />
                     </button>
                  ) : (
                     <a
                        className="transfer-download"
                        href={uploadedFileDownloadUrl(session.sid, file.fileId)}
                        download={file.name}
                     >
                        Download
                     </a>
                  )
               ) : null}
            </li>
         ))}
      </ul>
   );
}

function fileToRecord(file: File): LocalFileRecord {
   return {
      fileId: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      receivedSize: 0,
      lastModified: file.lastModified,
      createdAt: file.lastModified,
      ready: false,
      state: "pending"
   };
}

async function resolvePreferredOrigin(): Promise<string> {
   const info = await getLocalInfo();
   const preferred = preferredCandidate(info.lanCandidates);

   return preferred?.origin ?? info.lanOrigins[0] ?? window.location.origin;
}

function preferredCandidate(candidates: LocalNetworkCandidate[]): LocalNetworkCandidate | undefined {
   const nonLoopback = candidates.filter((candidate) => candidate.address !== "localhost");
   const clean = nonLoopback.find((candidate) => !candidate.warning);

   return clean ?? nonLoopback[0] ?? candidates[0];
}

function useDesktopWindowHeight(shellRef: RefObject<HTMLElement>): void {
   useEffect(() => {
      const bridge = window.localFileTransfer;
      const shell = shellRef.current;

      if (!bridge || !shell) {
         return undefined;
      }

      document.documentElement.classList.add("desktop-transfer-document");

      let frame = 0;
      const reportHeight = (): void => {
         window.cancelAnimationFrame(frame);
         frame = window.requestAnimationFrame(() => {
            // The desktop host owns the outer window; report rendered content.
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
         document.documentElement.classList.remove("desktop-transfer-document");
         window.cancelAnimationFrame(frame);
      };
   }, [shellRef]);
}