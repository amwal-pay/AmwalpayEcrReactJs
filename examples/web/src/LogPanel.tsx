import type { UseEcrLog } from '@amwalpay/ecr-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { copyText } from './ui';

/** The debug output panel: the SDK's diagnostics, last 500 lines. Polls while open. */
export function LogPanel({ log, open, onToggle }: { log: UseEcrLog; open: boolean; onToggle(open: boolean): void }) {
  const text = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState('');
  // Stay pinned to the newest line unless the reader has scrolled up.
  const pinned = useRef(true);
  const value = log.log?.text ?? '';

  useLayoutEffect(() => {
    const el = text.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [value]);

  return (
    <aside className="logbar" aria-label="Debug output">
      <details
        id="log-panel"
        open={open}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          if (isOpen) pinned.current = true;
          onToggle(isOpen);
        }}
      >
        <summary id="log-summary">{log.log ? `Debug output (${log.log.count} lines)` : 'Debug output'}</summary>
        <p className="caption">Requests and responses, including the masked card number: treat what you copy from here as transaction records.</p>
        <label htmlFor="log-text" className="sr-only">Debug output</label>
        <textarea
          ref={text}
          id="log-text"
          readOnly
          rows={10}
          wrap="off"
          spellCheck={false}
          value={value}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        />
        <div className="row">
          <button
            id="log-copy"
            type="button"
            className="outlined compact"
            onClick={async () => setStatus((await copyText(value)) ? 'Copied to clipboard' : 'Could not copy: the clipboard is in use')}
          >
            Copy log
          </button>
          <button
            id="log-clear"
            type="button"
            className="text compact"
            onClick={async () => {
              setStatus('');
              try {
                await log.clear();
              } catch {
                // The next tick shows what is there.
              }
            }}
          >
            Clear
          </button>
          <span id="log-status" className="caption" role="status">{status}</span>
        </div>
      </details>
    </aside>
  );
}
