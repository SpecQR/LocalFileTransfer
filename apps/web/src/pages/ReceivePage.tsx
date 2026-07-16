import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { LocalSessionView } from "../../../../packages/protocol/src/index.ts";
import {
   authorizeSession,
   getSendSession,
   sendFileDownloadUrl,
   subscribeSessionEvents,
   tokenFromHash
} from "../api/client.ts";
import { ProgressView } from "../ui/ProgressView.tsx";
import { formatBytes } from "../utils/format.ts";

export function ReceivePage({ sid }: { sid: string }): JSX.Element {
   const [session, setSession] = useState<LocalSessionView>();
   const [message, setMessage] = useState("Opening local transfer...");
   const [error, setError] = useState<string>();
   const [authorized, setAuthorized] = useState(false);
   const totalBytes = session?.files.reduce((sum, file) => sum + file.size, 0) ?? 0;
   const readyBytes = session?.files.reduce((sum, file) => sum + (file.ready ? file.size : 0), 0) ?? 0;

   async function load(): Promise<void> {
      try {
         const view = await getSendSession(sid);

         setSession(view);
         setError(undefined);
         setAuthorized(true);
         setMessage(view.files.every((file) => file.ready)
            ? "Files are ready to download."
            : "Files are still preparing.");
      } catch (loadError) {
         setError(loadError instanceof Error ? loadError.message : "Failed to load local transfer");
      }
   }

   useEffect(() => {
      let stopped = false;

      async function open(): Promise<void> {
         try {
            if (window.location.hash) {
               await authorizeSession(sid, tokenFromHash());
            }

            if (!stopped) {
               await load();
            }
         } catch (openError) {
            if (!stopped) {
               setError(openError instanceof Error ? openError.message : "Could not authorize this transfer");
            }
         }
      }

      void open();
      return () => {
         stopped = true;
      };
   }, [sid]);

   useEffect(() => {
      if (!authorized) {
         return undefined;
      }

      const unsubscribe = subscribeSessionEvents(sid, (event) => {
         if (event.session) {
            setSession(event.session);
            setMessage(event.session.files.every((file) => file.ready)
               ? "Files are ready to download."
               : "Files are still preparing.");
         }

         if (event.t === "session-expired" || event.t === "session-deleted") {
            setError("This transfer has expired. Scan a new QR code.");
         }
      });
      const fallback = window.setInterval(() => void load(), 5_000);

      return () => {
         unsubscribe();
         window.clearInterval(fallback);
      };
   }, [authorized, sid]);

   return (
      <main className="app-shell receiver-shell">
         <section className="topbar">
            <div>
               <p className="eyebrow">Local transfer</p>
               <h1>Receive files?</h1>
            </div>
         </section>

         <section className="panel receive-panel">
            <div className="panel-heading">
               <h2 aria-live="polite">{error ?? message}</h2>
               <button className="secondary-button" type="button" onClick={() => void load()}>
                  <RefreshCw size={16} />
                  Refresh
               </button>
            </div>

            {session ? (
               <>
                  <div className="manifest-summary">
                     <span>{session.files.length} file(s)</span>
                     <span>{formatBytes(totalBytes)}</span>
                  </div>
                  <ProgressView label="Available" confirmedBytes={readyBytes} totalBytes={totalBytes} />
                  <div className="save-list">
                     {session.files.map((file) => (
                        <div className="save-row" key={file.fileId}>
                           <div>
                              <strong>{file.name}</strong>
                              <p className="subtle">{formatBytes(file.size)} - {file.ready ? "ready" : file.state}</p>
                           </div>
                           {file.ready ? (
                              <a
                                 className="primary-link"
                                 href={sendFileDownloadUrl(sid, file.fileId)}
                                 download={file.name}
                              >
                                 <Download size={16} />
                                 Download
                              </a>
                           ) : null}
                        </div>
                     ))}
                  </div>
               </>
            ) : (
               <p className="subtle">Scan a current QR code while both devices are on the same trusted network.</p>
            )}
         </section>
      </main>
   );
}