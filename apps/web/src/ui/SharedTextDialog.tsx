import {
   Clipboard,
   Eraser,
   Send,
   X
} from "lucide-react";
import {
   useEffect,
   useMemo,
   useRef,
   useState
} from "react";
import {
   sharedTextMaxBytes,
   utf8ByteLength,
   type RoomSharedText
} from "../../../../packages/protocol/src/index.ts";
import {
   getSharedText,
   SharedTextConflictClientError,
   updateSharedText
} from "../api/roomClient.ts";
import type { MessageCatalog } from "../i18n/catalog.ts";
import { copyText } from "../utils/clipboard.ts";

interface SharedTextDialogProps {
   messages: MessageCatalog;
   onClose: () => void;
   onSeen: () => void;
   open: boolean;
   revisionSignal: number;
   roomId: string | undefined;
}

type Activity = "idle" | "loading" | "saving" | "shared" | "copied" | "error";

const emptySharedText: RoomSharedText = {
   content: "",
   revision: 0,
   updatedAt: 0
};

export function SharedTextDialog({
   messages,
   onClose,
   onSeen,
   open,
   revisionSignal,
   roomId
}: SharedTextDialogProps): JSX.Element | null {
   const panelRef = useRef<HTMLElement | null>(null);
   const textareaRef = useRef<HTMLTextAreaElement | null>(null);
   const baseRef = useRef<RoomSharedText>(emptySharedText);
   const draftRef = useRef("");
   const fetchedRevisionRef = useRef(-1);
   const initializingRef = useRef(false);
   const copyTimerRef = useRef<number>();
   const [base, setBase] = useState<RoomSharedText>();
   const [draft, setDraft] = useState("");
   const [conflict, setConflict] = useState<RoomSharedText>();
   const [activity, setActivity] = useState<Activity>("idle");
   const [error, setError] = useState<string>();
   const [composing, setComposing] = useState(false);
   const byteCount = useMemo(() => utf8ByteLength(draft), [draft]);
   const tooLarge = byteCount > sharedTextMaxBytes;
   const dirty = Boolean(base && draft !== base.content);

   useEffect(() => {
      baseRef.current = base ?? emptySharedText;
   }, [base]);

   useEffect(() => {
      draftRef.current = draft;
   }, [draft]);

   useEffect(() => {
      if (!open || !roomId) {
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
            "button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
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

      initializingRef.current = true;
      fetchedRevisionRef.current = -1;
      setBase(undefined);
      setDraft("");
      setConflict(undefined);
      setError(undefined);
      setActivity("loading");
      document.addEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      void getSharedText(roomId)
         .then((current) => {
            if (!active) {
               return;
            }

            fetchedRevisionRef.current = current.revision;
            baseRef.current = current;
            draftRef.current = current.content;
            setBase(current);
            setDraft(current.content);
            setActivity("idle");
            onSeen();
         })
         .catch((loadError: unknown) => {
            if (active) {
               setError(loadError instanceof Error ? loadError.message : messages.sharedTextUnavailable);
               setActivity("error");
            }
         })
         .finally(() => {
            initializingRef.current = false;
         });

      return () => {
         active = false;
         initializingRef.current = false;
         document.removeEventListener("keydown", handleKeyDown);
         window.clearTimeout(copyTimerRef.current);
         previousFocus?.focus();
      };
   }, [messages.sharedTextUnavailable, onClose, onSeen, open, roomId]);

   useEffect(() => {
      if (
         !open
         || !roomId
         || initializingRef.current
         || revisionSignal <= fetchedRevisionRef.current
      ) {
         return undefined;
      }

      let active = true;

      void getSharedText(roomId)
         .then((current) => {
            if (!active) {
               return;
            }

            fetchedRevisionRef.current = current.revision;
            const hasDraft = draftRef.current !== baseRef.current.content;

            if (hasDraft && current.revision > baseRef.current.revision) {
               setConflict(current);
            } else {
               baseRef.current = current;
               draftRef.current = current.content;
               setBase(current);
               setDraft(current.content);
               setConflict(undefined);
               setActivity("idle");
            }

            onSeen();
         })
         .catch((loadError: unknown) => {
            if (active) {
               setError(loadError instanceof Error ? loadError.message : messages.sharedTextUnavailable);
               setActivity("error");
            }
         });

      return () => {
         active = false;
      };
   }, [messages.sharedTextUnavailable, onSeen, open, revisionSignal, roomId]);

   if (!open) {
      return null;
   }

   const share = async (expectedRevision: number): Promise<void> => {
      if (!roomId || !base || tooLarge || composing) {
         return;
      }

      setActivity("saving");
      setError(undefined);

      try {
         const updated = await updateSharedText(roomId, {
            content: draft,
            expectedRevision
         });

         fetchedRevisionRef.current = updated.revision;
         baseRef.current = updated;
         draftRef.current = updated.content;
         setBase(updated);
         setDraft(updated.content);
         setConflict(undefined);
         setActivity("shared");
         onSeen();
      } catch (shareError) {
         if (shareError instanceof SharedTextConflictClientError) {
            fetchedRevisionRef.current = Math.max(
               fetchedRevisionRef.current,
               shareError.current.revision
            );
            setConflict(shareError.current);
            setActivity("idle");
            onSeen();
            return;
         }

         setError(shareError instanceof Error ? shareError.message : messages.sharedTextUnavailable);
         setActivity("error");
      }
   };
   const status = statusMessage(activity, dirty, conflict, error, messages);

   return (
      <div
         className="shared-text-backdrop"
         onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
               onClose();
            }
         }}
      >
         <section
            aria-describedby="shared-text-status"
            aria-labelledby="shared-text-title"
            aria-modal="true"
            className="shared-text-dialog"
            ref={panelRef}
            role="dialog"
         >
            <header className="shared-text-header">
               <h2 id="shared-text-title">{messages.sharedTextTitle}</h2>
               <button
                  aria-label={messages.close}
                  className="icon-button shared-text-close"
                  title={messages.close}
                  type="button"
                  onClick={onClose}
               >
                  <X aria-hidden="true" size={19} />
               </button>
            </header>

            <div className="shared-text-body">
               <textarea
                  aria-label={messages.sharedTextAreaLabel}
                  data-testid="shared-text-input"
                  dir="auto"
                  disabled={!base || activity === "loading"}
                  placeholder={messages.sharedTextPlaceholder}
                  ref={textareaRef}
                  spellCheck
                  value={draft}
                  onChange={(event) => {
                     setDraft(event.currentTarget.value);
                     setActivity("idle");
                     setError(undefined);
                  }}
                  onCompositionEnd={() => setComposing(false)}
                  onCompositionStart={() => setComposing(true)}
               />

               <div className="shared-text-meta">
                  <span
                     aria-atomic="true"
                     aria-live="polite"
                     id="shared-text-status"
                  >
                     {status}
                  </span>
                  <span className={tooLarge ? "shared-text-limit-error" : undefined}>
                     {messages.sharedTextByteCount(byteCount, sharedTextMaxBytes)}
                  </span>
               </div>
               {tooLarge ? (
                  <p className="shared-text-error" role="alert">{messages.sharedTextTooLarge}</p>
               ) : null}

               {conflict ? (
                  <section className="shared-text-conflict" role="alert">
                     <strong>{messages.sharedTextConflictTitle}</strong>
                     <p>{messages.sharedTextConflictMessage}</p>
                     <div>
                        <button
                           data-testid="shared-text-use-latest"
                           type="button"
                           onClick={() => {
                              baseRef.current = conflict;
                              draftRef.current = conflict.content;
                              setBase(conflict);
                              setDraft(conflict.content);
                              setConflict(undefined);
                              setActivity("idle");
                           }}
                        >
                           {messages.sharedTextUseLatest}
                        </button>
                        <button
                           className="shared-text-conflict-replace"
                           data-testid="shared-text-replace"
                           disabled={tooLarge || composing}
                           type="button"
                           onClick={() => void share(conflict.revision)}
                        >
                           {messages.sharedTextReplace}
                        </button>
                     </div>
                  </section>
               ) : null}
            </div>

            <footer className="shared-text-actions">
               <div>
                  <button
                     aria-label={messages.sharedTextCopy}
                     className="icon-button"
                     disabled={!base}
                     title={messages.sharedTextCopy}
                     type="button"
                     onClick={() => {
                        void copyText(draft)
                           .then(() => {
                              setActivity("copied");
                              window.clearTimeout(copyTimerRef.current);
                              copyTimerRef.current = window.setTimeout(() => setActivity("idle"), 1_500);
                           })
                           .catch((copyError: unknown) => {
                              setError(copyError instanceof Error
                                 ? copyError.message
                                 : messages.sharedTextUnavailable);
                              setActivity("error");
                           });
                     }}
                  >
                     <Clipboard aria-hidden="true" size={18} />
                  </button>
                  <button
                     aria-label={messages.sharedTextClear}
                     className="icon-button"
                     disabled={!base || draft.length === 0}
                     title={messages.sharedTextClear}
                     type="button"
                     onClick={() => {
                        setDraft("");
                        setActivity("idle");
                        setError(undefined);
                        textareaRef.current?.focus();
                     }}
                  >
                     <Eraser aria-hidden="true" size={18} />
                  </button>
               </div>
               <button
                  className="shared-text-share"
                  data-testid="shared-text-share"
                  disabled={!base || !dirty || tooLarge || composing || activity === "saving"}
                  type="button"
                  onClick={() => {
                     if (base) {
                        void share(base.revision);
                     }
                  }}
               >
                  <Send aria-hidden="true" size={17} />
                  {messages.sharedTextShare}
               </button>
            </footer>
         </section>
      </div>
   );
}

function statusMessage(
   activity: Activity,
   dirty: boolean,
   conflict: RoomSharedText | undefined,
   error: string | undefined,
   messages: MessageCatalog
): string {
   if (error) {
      return error;
   }

   if (conflict) {
      return messages.sharedTextConflictTitle;
   }

   switch (activity) {
      case "loading":
         return messages.sharedTextLoading;
      case "saving":
         return messages.sharedTextSaving;
      case "shared":
         return messages.sharedTextShared;
      case "copied":
         return messages.sharedTextCopied;
      case "error":
         return messages.sharedTextUnavailable;
      default:
         return dirty ? messages.sharedTextUnsaved : messages.sharedTextUpToDate;
   }
}
