import { Clipboard, FolderOpen, X } from "lucide-react";
import {
   useEffect,
   useRef,
   useState
} from "react";
import type {
   RoomDiagnosticSnapshot,
   UploadRecoveryDiagnostics
} from "../../../../packages/protocol/src/index.ts";
import type { MessageCatalog } from "../i18n/catalog.ts";
import { copyText } from "../utils/clipboard.ts";

interface DiagnosticsDialogProps {
   load: () => Promise<RoomDiagnosticSnapshot>;
   messages: MessageCatalog;
   onClose: () => void;
   onOpenLogFolder?: () => Promise<void>;
   open: boolean;
}

export function DiagnosticsDialog({
   load,
   messages,
   onClose,
   onOpenLogFolder,
   open
}: DiagnosticsDialogProps): JSX.Element | null {
   const panelRef = useRef<HTMLElement | null>(null);
   const closeRef = useRef<HTMLButtonElement | null>(null);
   const [snapshot, setSnapshot] = useState<RoomDiagnosticSnapshot>();
   const [error, setError] = useState<string>();
   const [copied, setCopied] = useState(false);

   useEffect(() => {
      if (!open) {
         return undefined;
      }

      let active = true;
      const previousFocus = document.activeElement instanceof HTMLElement
         ? document.activeElement
         : undefined;
      const handleKeyDown = (event: KeyboardEvent): void => {
         if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
         }

         if (event.key !== "Tab" || !panelRef.current) {
            return;
         }

         const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
         ));
         const first = focusable[0];
         const last = focusable.at(-1);

         if (!first || !last) {
            return;
         }

         if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
         } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
         }
      };

      setSnapshot(undefined);
      setError(undefined);
      setCopied(false);
      document.addEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => closeRef.current?.focus());
      void load()
         .then((next) => {
            if (active) {
               setSnapshot(next);
            }
         })
         .catch((loadError: unknown) => {
            if (active) {
               setError(loadError instanceof Error ? loadError.message : messages.diagnosticsUnavailable);
            }
         });

      return () => {
         active = false;
         document.removeEventListener("keydown", handleKeyDown);
         previousFocus?.focus();
      };
   }, [load, messages, onClose, open]);

   if (!open) {
      return null;
   }

   return (
      <div
         className="diagnostics-backdrop"
         onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
               onClose();
            }
         }}
      >
         <section
            aria-labelledby="diagnostics-title"
            aria-modal="true"
            className="diagnostics-dialog"
            ref={panelRef}
            role="dialog"
         >
            <header className="diagnostics-header">
               <h2 id="diagnostics-title">{messages.diagnosticsTitle}</h2>
               <button
                  aria-label={messages.close}
                  className="icon-button diagnostics-close"
                  ref={closeRef}
                  title={messages.close}
                  type="button"
                  onClick={onClose}
               >
                  <X aria-hidden="true" size={19} />
               </button>
            </header>

            <div aria-live="polite" className="diagnostics-content">
               {error ? <p className="diagnostics-error">{error}</p> : null}
               {!error && !snapshot ? <p>{messages.diagnosticsLoading}</p> : null}
               {snapshot ? (
                  <dl className="diagnostics-list">
                     <DiagnosticRow label={messages.diagnosticsVersion} value={snapshot.version} />
                     <DiagnosticRow label={messages.diagnosticsProtocol} value={snapshot.protocol} />
                     <DiagnosticRow label={messages.diagnosticsPort} value={String(snapshot.port)} />
                     <DiagnosticRow
                        label={messages.diagnosticsUptime}
                        value={messages.seconds(snapshot.uptimeSeconds)}
                     />
                     <DiagnosticRow
                        label={messages.diagnosticsRestarts}
                        value={String(snapshot.serviceRestarts)}
                     />
                     <DiagnosticRow
                        label={messages.diagnosticsRoomsItems}
                        value={messages.roomsItems(snapshot.rooms, snapshot.items)}
                     />
                     <DiagnosticRow
                        label={messages.diagnosticsActivity}
                        value={messages.activeCounts(snapshot.activeWrites, snapshot.activeReads)}
                     />
                     <DiagnosticRow
                        label={messages.diagnosticsRecovery}
                        value={formatRecovery(snapshot.recovery)}
                     />
                     <DiagnosticRow label={messages.diagnosticsDisk} value={snapshot.diskSpace} />
                     <DiagnosticRow label={messages.diagnosticsLog} value={snapshot.structuredLog} />
                     <DiagnosticRow
                        label={messages.diagnosticsErrors}
                        value={snapshot.recentErrorCodes.join(", ") || messages.noRecentErrors}
                     />
                  </dl>
               ) : null}
            </div>

            <footer className="diagnostics-actions">
               <button
                  className="diagnostics-action"
                  disabled={!snapshot}
                  type="button"
                  onClick={async () => {
                     if (!snapshot) {
                        return;
                     }

                     try {
                        await copyText(JSON.stringify(snapshot, null, 3));
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1_500);
                     } catch (copyError) {
                        setError(copyError instanceof Error ? copyError.message : messages.diagnosticsUnavailable);
                     }
                  }}
               >
                  <Clipboard aria-hidden="true" size={17} />
                  {copied ? messages.copied : messages.copyDiagnostics}
               </button>
               {onOpenLogFolder ? (
                  <button
                     className="diagnostics-action"
                     type="button"
                     onClick={() => {
                        void onOpenLogFolder().catch((openError: unknown) => {
                           setError(openError instanceof Error ? openError.message : messages.diagnosticsUnavailable);
                        });
                     }}
                  >
                     <FolderOpen aria-hidden="true" size={17} />
                     {messages.openLogFolder}
                  </button>
               ) : null}
            </footer>
         </section>
      </div>
   );
}

function formatRecovery(recovery: UploadRecoveryDiagnostics): string {
   return [
      `truncate=${recovery.startupTruncations}/${recovery.startupTruncatedBytes}B`,
      `rewind=${recovery.startupRewinds}/${recovery.startupRewoundBytes}B`,
      `rollback=${recovery.checkpointRollbacks}`,
      `replay=${recovery.idempotentReplays}`,
      `complete=${recovery.recoveredCompletions}`
   ].join("; ");
}

function DiagnosticRow({ label, value }: { label: string; value: string }): JSX.Element {
   return (
      <div>
         <dt>{label}</dt>
         <dd>{value}</dd>
      </div>
   );
}
