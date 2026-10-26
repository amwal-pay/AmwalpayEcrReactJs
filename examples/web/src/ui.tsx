// Page-wide helpers: the screen-reader announcer, the confirm dialog, the clipboard.
// Everything the page renders from the server is React text, never parsed markup, so
// nothing a terminal or a reference contains can become markup.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Announce = (message: string) => void;
const AnnounceContext = createContext<Announce>(() => {});

/** Says something to screen readers without moving focus. */
export const useAnnounce = () => useContext(AnnounceContext);

export interface ConfirmOptions {
  title: string;
  message: string;
  action: string;
}
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async () => false);

/** A small modal confirm, in place of window.confirm: styled, focus-trapped, and safe by default. */
export const useConfirm = () => useContext(ConfirmContext);

export function PageServices({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState('');
  const announceTimer = useRef<ReturnType<typeof setTimeout>>();
  const announce = useCallback<Announce>((message) => {
    // Clearing first makes the same message be read twice in a row.
    setAnnouncement('');
    clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => setAnnouncement(message), 30);
  }, []);

  const dialog = useRef<HTMLDialogElement>(null);
  const noButton = useRef<HTMLButtonElement>(null);
  const [asked, setAsked] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const answer = useRef(false);

  const confirm = useCallback<Confirm>((options) => new Promise<boolean>((resolve) => {
    answer.current = false;
    resolver.current = resolve;
    setAsked(options);
  }), []);

  useEffect(() => {
    const el = dialog.current;
    if (asked && el && !el.open) {
      el.showModal();
      // Default focus is the safe choice, like the WPF message box.
      noButton.current?.focus();
    }
  }, [asked]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const onClose = () => {
      resolver.current?.(answer.current);
      resolver.current = null;
      setAsked(null);
    };
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, []);

  return (
    <AnnounceContext.Provider value={announce}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <div id="announcer" className="sr-only" role="status" aria-live="polite">{announcement}</div>

        {/* Confirm. Default focus is the safe choice, like the WPF message box. */}
        <dialog ref={dialog} id="dlg-confirm" className="modal narrow" aria-labelledby="c-title" aria-describedby="c-message">
          <div className="modal-body">
            <h2 id="c-title" className="title">{asked?.title}</h2>
            <p id="c-message" className="body">{asked?.message}</p>
          </div>
          <div className="modal-actions">
            <button ref={noButton} id="c-no" type="button" className="outlined" onClick={() => dialog.current?.close()}>Cancel</button>
            <button
              id="c-yes"
              type="button"
              className="danger"
              onClick={() => {
                answer.current = true;
                dialog.current?.close();
              }}
            >
              {asked?.action}
            </button>
          </div>
        </dialog>
      </ConfirmContext.Provider>
    </AnnounceContext.Provider>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A paragraph that is hidden while it has no text (the page's `setText`). */
export function Text({ as: Tag = 'p', text, ...props }: { as?: 'p' | 'span'; text: string | null | undefined } & Record<string, unknown>) {
  const value = text ?? '';
  return <Tag {...props} hidden={value === ''}>{value}</Tag>;
}

/** Runs `work` after React has put the latest render on the page (to move focus there). */
export function afterRender(work: () => void): void {
  setTimeout(work, 0);
}
