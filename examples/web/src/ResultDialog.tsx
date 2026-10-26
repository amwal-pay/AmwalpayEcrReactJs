import { ApiError, useEcrClient, type UseTransaction } from '@amwalpay/ecr-react';
import { useEffect, useRef, useState } from 'react';
import { copyText, Text } from './ui';

/** SVG has no `hidden` property in React's types; the attribute still works (the stylesheet makes it stick). */
const svgHidden = (hidden: boolean) => (hidden ? { hidden: '' } : {}) as Record<string, string>;

/**
 * How a transaction ended. Closing it by any route (button, Escape) means "the operator
 * has read the result". A close made because the run moved on (the look-up offered
 * here) must not reset anything under it.
 */
export function ResultDialog({ transaction, onAcknowledged }: { transaction: UseTransaction; onAcknowledged(): void }) {
  const client = useEcrClient();
  const { run } = transaction;
  const d = run?.isResult ? run.dialog : null;
  const key = run ? `${run.id}:${run.state}` : null;

  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const silent = useRef(false);
  const acknowledged = useRef(onAcknowledged);
  acknowledged.current = onAcknowledged;

  // Per-result UI state: a new result (id or state) starts fresh, a poll does not.
  const [rawOpen, setRawOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [closeReceiptStatus, setCloseReceiptStatus] = useState('');
  const [inquiring, setInquiring] = useState(false);
  const [requestingReceipt, setRequestingReceipt] = useState(false);
  const [closingReceipt, setClosingReceipt] = useState(false);
  useEffect(() => {
    setRawOpen(false);
    setCopyStatus('');
    setCloseReceiptStatus('');
    setInquiring(false);
  }, [key]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (d && !el.open) {
      el.showModal();
      closeButton.current?.focus();
    } else if (!d && el.open) {
      silent.current = true;
      el.close();
    }
  }, [d]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    const onClose = () => {
      const wasSilent = silent.current;
      silent.current = false;
      if (!wasSilent) acknowledged.current();
    };
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, []);

  const approved = d?.tone === 'approved';
  const receipt = d?.receipt;

  return (
    <dialog ref={dialog} id="dlg-result" className="modal" aria-labelledby="r-headline">
      <div className="modal-body">
        <svg id="r-icon-approved" className="r-icon approved" viewBox="0 0 24 24" aria-hidden="true" {...svgHidden(!approved)}>
          <path d="M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM10,17l-5,-5 1.41,-1.41L10,14.17l7.59,-7.59L19,8l-9,9z" />
        </svg>
        <svg id="r-icon-declined" className="r-icon declined" viewBox="0 0 24 24" aria-hidden="true" {...svgHidden(approved)}>
          <path d="M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM17,15.59L15.59,17 12,13.41 8.41,17 7,15.59 10.59,12 7,8.41 8.41,7 12,10.59 15.59,7 17,8.41 13.41,12 17,15.59z" />
        </svg>
        <h2 id="r-headline" className={`headline ${d?.tone ?? ''}`.trim()}>{d?.headline}</h2>
        <p id="r-amount" className="amount-line" hidden={!d || d.amount === ''}>
          <svg className="omr" viewBox="0 0 55 27" role="img" aria-label="Omani Rial">
            <path d="M17.627,15.622C17.579,11.823 18.511,8.255 20.389,4.986C23.171,0.142 26.225,-1.384 31.516,1.346C32.34,1.77 35.655,4.081 35.98,4.785C36.368,5.624 33.858,12.805 33.732,14.228C31.054,11.332 26.06,6.61 21.776,8.852C18.298,10.673 20.848,13.681 22.661,15.622H54.268L52.229,19.301H26.556C26.532,19.44 26.623,19.555 26.751,19.656C27.712,20.406 33.003,22.709 34.067,22.709H50.336L48.26,26.487H0L2.078,22.709H21.642L18.776,19.301H3.967L6.006,15.623H17.627V15.622Z" />
          </svg>
          <span id="r-amount-text">{d?.amount}</span>
        </p>
        <Text id="r-message" className="body center" text={d?.message} />
        <Text id="r-note" className="caption center" text={d?.note} />
        <dl id="r-fields" className="fields" hidden={!d || d.fields.length === 0}>
          {d?.fields.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
        </dl>
        <ul id="r-hints" className="hints" hidden={!d || d.hints.length === 0}>
          {d?.hints.map((hint, i) => <li key={i}>{hint}</li>)}
        </ul>

        {/* Unknown outcome: the only action offered is a look-up by reference. There is no retry. */}
        <div id="r-unknown" className="unknown" hidden={!d?.isUnknownOutcome}>
          <p id="r-warning" className="strong">{d?.unknownOutcomeWarning ?? ''}</p>
          <button
            id="r-inquire"
            type="button"
            className="outlined"
            disabled={inquiring}
            onClick={async () => {
              if (!d?.isUnknownOutcome) return;
              setInquiring(true);
              try {
                await transaction.inquire();
              } catch (error) {
                setInquiring(false);
                setCopyStatus(error instanceof ApiError ? error.message : 'Could not start the look-up');
              }
            }}
          >
            Inquire by reference
          </button>
          <div className="row spread">
            <code id="r-ref">{d?.inquirableReference ?? ''}</code>
            <button
              id="r-copy-ref"
              type="button"
              className="text compact"
              aria-label="Copy reference"
              onClick={async () => setCopyStatus((await copyText(d?.inquirableReference ?? '')) ? 'Reference copied to clipboard' : 'Could not copy: the clipboard is in use')}
            >
              Copy
            </button>
          </div>
        </div>

        {/* E-receipt: a button until it is asked for, then the QR itself. */}
        <div id="r-receipt" className="center" hidden={!d || !(d.offersReceipt || !!d.receiptNote)}>
          <button
            id="r-receipt-btn"
            type="button"
            className="outlined"
            hidden={!receipt?.showButton}
            disabled={requestingReceipt}
            onClick={async () => {
              setRequestingReceipt(true);
              try {
                await transaction.requestReceipt();
              } catch (error) {
                setCopyStatus(error instanceof ApiError ? error.message : 'Could not request the receipt');
              } finally {
                setRequestingReceipt(false);
              }
            }}
          >
            QR receipt
          </button>
          <p id="r-receipt-fetching" className="body" role="status" hidden={!receipt?.fetching}>
            <progress aria-hidden="true" /> Fetching the receipt…
          </p>
          <div id="r-qr" hidden={!receipt?.url}>
            <p className="body">Scan for the receipt</p>
            {receipt?.url ? <img id="r-qr-img" className="qr" width={200} height={200} alt="Receipt QR code" src={client.qrUrl(receipt.url)} /> : null}
            <input id="r-qr-url" className="mono small" type="text" readOnly aria-label="Receipt link" value={receipt?.url ?? ''} />
          </div>
          <Text id="r-receipt-problem" className="error" text={receipt?.problem} />
          <Text id="r-receipt-note" className="caption" text={d?.receiptNote} />
        </div>

        <details id="r-raw" hidden={!d?.rawPayload} open={rawOpen} onToggle={(e) => setRawOpen(e.currentTarget.open)}>
          <summary id="r-raw-summary">{rawOpen ? 'Hide raw response' : 'Show raw response'}</summary>
          <pre id="r-raw-text" tabIndex={0} aria-label="Raw response">{d?.rawPayload ?? ''}</pre>
          <button
            id="r-copy-raw"
            type="button"
            className="text compact"
            onClick={async () => setCopyStatus((await copyText(d?.rawPayload ?? '')) ? 'Copied to clipboard' : 'Could not copy: the clipboard is in use')}
          >
            Copy raw JSON
          </button>
        </details>
        <p id="r-copy-status" className="caption" role="status">{copyStatus}</p>
      </div>
      <Text id="r-close-receipt-status" className="caption" role="status" text={closeReceiptStatus} />
      <div className="modal-actions">
        <button
          id="r-close-receipt"
          type="button"
          className="outlined"
          hidden={!d?.canCloseReceipt}
          disabled={closingReceipt}
          onClick={async () => {
            if (!d?.canCloseReceipt) return;
            setClosingReceipt(true);
            try {
              const result = await transaction.closeReceipt();
              setCloseReceiptStatus(result?.message ?? 'Terminal is back on its idle screen');
            } catch (error) {
              setCloseReceiptStatus(error instanceof ApiError ? error.message : 'Could not close the receipt');
            } finally {
              setClosingReceipt(false);
            }
          }}
        >
          Close receipt
        </button>
        <button ref={closeButton} id="r-close" type="button" className="primary" onClick={() => dialog.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
