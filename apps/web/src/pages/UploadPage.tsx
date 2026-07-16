import { FileUp, Send } from "lucide-react";
import { useEffect, useState } from "react";
import {
   authorizeSession,
   tokenFromHash,
   uploadFileToWindows
} from "../api/client.ts";
import { ProgressView } from "../ui/ProgressView.tsx";
import { formatBytes } from "../utils/format.ts";

type UploadState = "authorizing" | "idle" | "uploading" | "complete" | "failed";

export function UploadPage({ sid }: { sid: string }): JSX.Element {
   const [files, setFiles] = useState<File[]>([]);
   const [progress, setProgress] = useState<Record<string, number>>({});
   const [state, setState] = useState<UploadState>("authorizing");
   const [message, setMessage] = useState("Opening local transfer...");
   const [startedAt, setStartedAt] = useState<number>();
   const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
   const sentBytes = Object.values(progress).reduce((sum, value) => sum + value, 0);

   useEffect(() => {
      let stopped = false;

      async function open(): Promise<void> {
         try {
            if (window.location.hash) {
               await authorizeSession(sid, tokenFromHash());
            }

            if (!stopped) {
               setState("idle");
               setMessage("Choose files to upload");
            }
         } catch (error) {
            if (!stopped) {
               setState("failed");
               setMessage(error instanceof Error ? error.message : "Could not authorize this upload");
            }
         }
      }

      void open();
      return () => {
         stopped = true;
      };
   }, [sid]);

   async function sendFiles(selectedFiles = files): Promise<void> {
      if (selectedFiles.length === 0 || state === "authorizing") {
         return;
      }

      setState("uploading");
      setStartedAt(Date.now());
      setMessage("Uploading...");

      try {
         for (const [index, file] of selectedFiles.entries()) {
            const key = fileKey(file, index);
            await uploadFileToWindows(sid, file, (sent) => {
               setProgress((current) => ({ ...current, [key]: sent }));
            }, (phase) => {
               const action = phase === "preparing" ? "Preparing" : "Uploading";

               setMessage(`${action} ${index + 1} of ${selectedFiles.length}...`);
            });
            setProgress((current) => ({ ...current, [key]: file.size }));
         }

         setState("complete");
         setMessage("Upload complete. Files were saved on Windows.");
      } catch (error) {
         setState("failed");
         setMessage(error instanceof Error ? error.message : "Upload failed. Tap Upload to resume.");
      }
   }

   return (
      <main className="app-shell receiver-shell upload-page">
         <section className="topbar">
            <div>
               <p className="eyebrow">Local transfer</p>
               <h1>Upload files</h1>
            </div>
         </section>

         <section className="panel receive-panel">
            <h2 aria-live="polite">{message}</h2>
            <p className="subtle">Use only on a trusted local network.</p>
            <label className="drop-zone compact-drop">
               <FileUp size={28} />
               <strong>Choose files</strong>
               <input
                  multiple
                  type="file"
                  disabled={state === "authorizing" || state === "uploading"}
                  onChange={(event) => {
                     const selected = Array.from(event.currentTarget.files ?? []);

                     setFiles(selected);
                     setProgress({});
                     setState("idle");
                     setMessage(selected.length > 0 ? `${selected.length} file(s) selected` : "Choose files to upload");
                  }}
               />
            </label>

            {files.length > 0 ? (
               <ul className="file-list">
                  {files.map((file, index) => (
                     <li key={fileKey(file, index)}>
                        <span>{file.name}</span>
                        <span>{formatBytes(file.size)}</span>
                     </li>
                  ))}
               </ul>
            ) : null}

            <ProgressView
               label="Upload"
               confirmedBytes={sentBytes}
               totalBytes={totalBytes}
               startedAt={startedAt}
            />

            {files.length > 0 ? (
               <div className="mobile-upload-actions">
                  <button
                     className="primary-button wide"
                     disabled={files.length === 0 || state === "uploading" || state === "authorizing"}
                     type="button"
                     onClick={() => void sendFiles()}
                  >
                     <Send size={18} />
                     {state === "failed" ? "Resume upload" : "Upload"}
                  </button>
               </div>
            ) : null}
         </section>
      </main>
   );
}

function fileKey(file: File, index: number): string {
   return `${index}:${file.name}:${file.size}:${file.lastModified}`;
}
