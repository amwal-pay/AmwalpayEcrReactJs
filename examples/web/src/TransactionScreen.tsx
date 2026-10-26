import {
  AmountInput, ApiError, useCountdown, useTerminalConfig, useTerminals, useTransaction,
  type AmountInputHandle, type MetaView, type TransactionForm,
} from '@amwalpay/ecr-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ResultDialog } from './ResultDialog';
import { Text, useAnnounce } from './ui';

type FormState = Omit<TransactionForm, 'terminalSerial'>;

export interface ScreenHandle {
  refresh(): void;
  focus(): void;
}

const ERROR_FIELDS = ['amount', 'merchantReference', 'originalReference', 'receiptNumber', 'originalTerminalId', 'type', 'terminal'] as const;
type ErrorField = (typeof ERROR_FIELDS)[number];

/**
 * The transaction screen: the port of TransactionView / TransactionViewModel.
 *
 * Which fields exist comes from /api/meta (the SDK's transaction-type flags, laid out by
 * Core's TransactionFormState); nothing about the rules is decided here. The server
 * validates what is sent and answers with per-field messages, shown under the fields.
 *
 * A transaction runs on the server, not in the request, so this page only starts it and
 * then watches it. Closing the tab does not stop a payment.
 */
export const TransactionScreen = forwardRef<ScreenHandle, { meta: MetaView; active: boolean; onFinished(): void }>(
  function TransactionScreen({ meta, active, onFinished }, ref) {
    const announce = useAnnounce();
    const operations = new Map(meta.operations.map((op) => [op.value, op]));

    // Switching type resets the choices that no longer apply, so a terminal id or
    // reference left over cannot travel with the next operation.
    const newForm = useCallback((type: string): FormState => ({
      type,
      amountDigits: '',
      receiptNumber: '',
      originalTerminalId: '',
      originalDate: meta.today,
      useOtherTerminal: false,
      lookUpByReference: false,
      originalReference: '',
      merchantReference: '',
    }), [meta.today]);

    const [form, setForm] = useState<FormState>(() => newForm('Sale'));
    const [errors, setErrors] = useState<Partial<Record<ErrorField, string>>>({});
    const [message, setMessage] = useState('');
    const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
    const [announceConfig, setAnnounceConfig] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    const { terminals, refresh: refreshTerminals } = useTerminals();
    const { config, reload: reloadConfig } = useTerminalConfig(selectedSerial, { announce: announceConfig });
    const transaction = useTransaction({
      onStateChange: () => onFinished(),
      onStopped: () => announce('Stopped. No money was moved.'),
    });
    const { run, linkLost, starting } = transaction;
    const countdown = useCountdown(run);

    const amountRef = useRef<AmountInputHandle>(null);
    const typeRef = useRef<HTMLSelectElement>(null);
    const inputs = {
      merchantReference: useRef<HTMLInputElement>(null),
      originalReference: useRef<HTMLInputElement>(null),
      receiptNumber: useRef<HTMLInputElement>(null),
      originalTerminalId: useRef<HTMLInputElement>(null),
      terminal: useRef<HTMLSelectElement>(null),
    };
    const busyStatus = useRef<HTMLParagraphElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);

    // The selected terminal follows the list: a terminal that is gone gives way to the first.
    useEffect(() => {
      if (!terminals.some((t) => t.serialNumber === selectedSerial)) {
        setAnnounceConfig(false);
        setSelectedSerial(terminals[0]?.serialNumber ?? null);
      }
    }, [terminals, selectedSerial]);

    /** Re-reads the terminals and the selected terminal's plan: keys or terminals may have changed elsewhere. */
    const refresh = useCallback(() => {
      void refreshTerminals().then(() => reloadConfig(false));
    }, [refreshTerminals, reloadConfig]);

    useImperativeHandle(ref, () => ({ refresh, focus: () => heading.current?.focus() }), [refresh]);

    const op = operations.get(form.type) ?? meta.operations[0]!;
    const shown = op.layouts[`${form.useOtherTerminal ? 1 : 0}${form.lookUpByReference ? 1 : 0}`]!;
    const busy = run?.busy === true;

    /** Editing a field clears that field's own error, so a stale message does not sit next to a fixed value. */
    const edit = <K extends keyof FormState>(name: K, value: FormState[K], errorKey: ErrorField | null = name as ErrorField) => {
      setForm((f) => ({ ...f, [name]: value }));
      if (errorKey && errors[errorKey]) {
        setErrors((e) => {
          const next = { ...e };
          delete next[errorKey];
          return next;
        });
      }
    };

    // Only a ready plan may start: the operator sees what is missing before paying.
    const canStart = !starting && !busy && config?.isReady === true;

    // The busy panel takes focus when a run starts.
    const wasBusy = useRef(false);
    useEffect(() => {
      if (busy && !wasBusy.current) busyStatus.current?.focus();
      wasBusy.current = busy;
    }, [busy]);
    useEffect(() => setCancelling(false), [run?.id, run?.version]);

    const focusError = (name: ErrorField) => {
      if (name === 'amount') amountRef.current?.focus();
      else if (name === 'type') typeRef.current?.focus();
      else inputs[name].current?.focus();
    };

    async function submit(event: React.FormEvent) {
      event.preventDefault();
      if (!canStart || !selectedSerial) return;
      setMessage('');
      try {
        await transaction.start({ terminalSerial: selectedSerial, ...form });
      } catch (error) {
        if (!(error instanceof ApiError)) {
          setMessage(error instanceof Error ? error.message : String(error));
          return;
        }
        if (error.status === 422) {
          const fields = { ...error.fields } as Partial<Record<ErrorField, string>>;
          setErrors(fields);
          setMessage(error.body?.message ?? '');
          const first = ERROR_FIELDS.find((name) => fields[name]);
          const count = Object.keys(fields).length;
          if (first) {
            setTimeout(() => focusError(first), 0);
            announce(`${count === 1 ? 'One field needs' : `${count} fields need`} attention. ${fields[first]}`);
          } else if (error.body?.message) {
            announce(error.body.message);
          }
        } else if (error.status === 409 && error.body?.transactionId) {
          // Already running on this terminal (another tab, or a double click): that one is shown.
          setMessage(error.message);
        } else {
          setMessage(error.status === 0 ? 'The app could not be reached. Nothing was sent to the terminal.' : error.message);
        }
      }
    }

    /** The operator has read the result: back to idle, and the next transaction starts fresh. */
    const onAcknowledged = () => {
      transaction.acknowledge();
      // Amount and references are per transaction and must not linger into the next sale.
      setForm((f) => ({ ...f, amountDigits: '', merchantReference: '', originalReference: '' }));
      setTimeout(() => {
        if (!shown.amount) typeRef.current?.focus();
        else amountRef.current?.focus();
      }, 0);
    };

    const amountHelp = errors.amount ? '' : op.amountHelp;
    const invalid = (name: ErrorField) => (errors[name] ? 'true' : 'false');

    return (
      <section id="view-transaction" className="view" aria-labelledby="h-transaction" hidden={!active}>
        <h2 ref={heading} id="h-transaction" className="sr-only" tabIndex={-1}>Transaction</h2>

        <form id="txn-form" noValidate onSubmit={submit}>
          <fieldset id="txn-fields" className="plain" disabled={busy}>
            <legend className="sr-only">Transaction details</legend>

            <div className="field" data-field="type">
              <label htmlFor="f-type">Transaction type</label>
              <select
                ref={typeRef}
                id="f-type"
                value={form.type}
                aria-invalid={invalid('type')}
                onChange={(e) => {
                  setForm(newForm(e.target.value));
                  setErrors({});
                  setMessage('');
                }}
              >
                {meta.operations.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <Text className="error" id="e-type" text={errors.type} />
            </div>

            <div className="field" data-field="amount">
              <label htmlFor="f-amount">Amount (OMR)</label>
              <AmountInput
                ref={amountRef}
                id="f-amount"
                className="amount"
                maxDigits={meta.amount.maxDigits}
                digits={form.amountDigits}
                onDigitsChange={(digits) => edit('amountDigits', digits, 'amount')}
                // Dimmed, with the reason, when the type does not take an amount.
                disabled={!shown.amount}
                aria-describedby="e-amount h-amount"
                aria-invalid={invalid('amount')}
              />
              <Text className="error" id="e-amount" text={errors.amount} />
              <Text className="caption" id="h-amount" text={amountHelp} />
            </div>

            <div className="field" data-field="merchantReference" hidden={!shown.merchantReference}>
              <label htmlFor="f-merchantReference">Merchant reference</label>
              <input
                ref={inputs.merchantReference}
                id="f-merchantReference"
                type="text"
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="e-merchantReference h-merchantReference"
                aria-invalid={invalid('merchantReference')}
                value={form.merchantReference}
                onChange={(e) => edit('merchantReference', e.target.value)}
              />
              <Text className="error" id="e-merchantReference" text={errors.merchantReference} />
              <p className="caption" id="h-merchantReference">Optional. Your order or basket id; leave blank to auto-generate</p>
            </div>

            <div className="field" data-field="referenceSwitch" hidden={!shown.referenceSwitch}>
              <label className="check">
                <input
                  id="f-lookUpByReference"
                  type="checkbox"
                  checked={form.lookUpByReference}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setForm((f) => ({ ...f, lookUpByReference: checked, receiptNumber: '', originalReference: '' }));
                    setErrors({});
                  }}
                />
                {' '}Look up by reference
              </label>
            </div>

            <div className="field" data-field="originalReference" hidden={!shown.originalReference}>
              <label htmlFor="f-originalReference">Merchant reference</label>
              <input
                ref={inputs.originalReference}
                id="f-originalReference"
                type="text"
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="e-originalReference h-originalReference"
                aria-invalid={invalid('originalReference')}
                value={form.originalReference}
                onChange={(e) => edit('originalReference', e.target.value)}
              />
              <Text className="error" id="e-originalReference" text={errors.originalReference} />
              <p className="caption" id="h-originalReference">The reference the transaction was sent with</p>
            </div>

            <div className="field" data-field="receiptNumber" hidden={!shown.receiptNumber}>
              <label htmlFor="f-receiptNumber">Receipt number</label>
              <input
                ref={inputs.receiptNumber}
                id="f-receiptNumber"
                type="text"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                aria-describedby="e-receiptNumber h-receiptNumber"
                aria-invalid={invalid('receiptNumber')}
                value={form.receiptNumber}
                onChange={(e) => edit('receiptNumber', e.target.value.replace(/[^0-9]/g, '').slice(0, meta.receiptNumberMaxLength))}
              />
              <Text className="error" id="e-receiptNumber" text={errors.receiptNumber} />
              <p className="caption" id="h-receiptNumber">Receipt number printed on the receipt</p>
            </div>

            <div className="field" data-field="originalDate" hidden={!shown.originalDate}>
              <label htmlFor="f-originalDate">Original transaction date</label>
              <input
                id="f-originalDate"
                type="date"
                aria-describedby="h-originalDate"
                max={meta.today}
                value={form.originalDate}
                onChange={(e) => {
                  // A cleared date keeps the previous one; the original cannot be in the future.
                  const picked = e.target.value;
                  setForm((f) => ({ ...f, originalDate: picked && picked <= meta.today ? picked : picked ? meta.today : f.originalDate }));
                }}
              />
              <p className="caption" id="h-originalDate">The day the original transaction was taken</p>
            </div>

            <div className="field" data-field="otherTerminalSwitch" hidden={!shown.otherTerminalSwitch}>
              <label className="check">
                <input
                  id="f-useOtherTerminal"
                  type="checkbox"
                  checked={form.useOtherTerminal}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setForm((f) => ({ ...f, useOtherTerminal: checked, originalTerminalId: '' }));
                  }}
                />
                {' '}Different terminal
              </label>
            </div>

            <div className="field" data-field="originalTerminal" hidden={!shown.originalTerminal}>
              <label htmlFor="f-originalTerminalId">Original terminal ID</label>
              <input
                ref={inputs.originalTerminalId}
                id="f-originalTerminalId"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-describedby="e-originalTerminalId h-originalTerminalId"
                aria-invalid={invalid('originalTerminalId')}
                value={form.originalTerminalId}
                onChange={(e) => edit('originalTerminalId', e.target.value.replace(/[^0-9]/g, ''))}
              />
              <Text className="error" id="e-originalTerminalId" text={errors.originalTerminalId} />
              <p className="caption" id="h-originalTerminalId">The terminal the original transaction was taken on</p>
            </div>

            <p id="no-terminals" className="body" hidden={terminals.length !== 0}>
              No terminals registered yet. <a href="#terminals">Add one from the Terminals screen.</a>
            </p>

            <div id="terminal-picker" className="field" hidden={terminals.length === 0}>
              <label htmlFor="f-terminal">POS terminal</label>
              <select
                ref={inputs.terminal}
                id="f-terminal"
                aria-describedby="e-terminal"
                aria-invalid={invalid('terminal')}
                value={selectedSerial ?? ''}
                onChange={(e) => {
                  setAnnounceConfig(true);
                  setSelectedSerial(e.target.value);
                  setErrors((er) => {
                    const next = { ...er };
                    delete next.terminal;
                    return next;
                  });
                }}
              >
                {terminals.map((t) => <option key={t.serialNumber} value={t.serialNumber}>{t.displayName}</option>)}
              </select>
              <Text className="error" id="e-terminal" text={errors.terminal} />

              {/* What the SDK plan makes of the selected terminal, before anyone pays. */}
              <section id="config-card" className={`card config${config && !config.isReady ? ' not-ready' : ''}`} aria-labelledby="cfg-title" hidden={config === null}>
                <h3 id="cfg-title">Active terminal config</h3>
                <dl className="kv">
                  <div><dt>ECR mode:</dt> <dd id="cfg-mode">{config?.modeLabel}</dd></div>
                  <div><dt>Transport:</dt> <dd id="cfg-transport">{config?.transportLabel}</dd></div>
                  <div><dt>Connection:</dt> <dd id="cfg-connection">{config?.connectionSummary}</dd></div>
                  <div><dt id="cfg-key-label">{config ? `${config.keyLabel}:` : ''}</dt> <dd id="cfg-key-status">{config?.keyStatus}</dd></div>
                </dl>
                <ul id="cfg-issues" className="issues" hidden={!config || config.issues.length === 0}>
                  {config?.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                </ul>
              </section>
            </div>

            <Text className="error block" id="form-message" role="alert" text={message} />

            <button id="btn-start" type="submit" className="primary" aria-describedby="config-card" disabled={!canStart}>
              {op.startButtonText}
            </button>
          </fieldset>
        </form>

        {/* While running. Cancel stops waiting; it cannot un-send a request, and if the request
            already reached the terminal the sale can still complete, so it never claims otherwise. */}
        <div id="busy" className="busy" hidden={!busy}>
          <progress aria-label="Transaction in progress" />
          <p ref={busyStatus} id="busy-status" className="body" tabIndex={-1} role="status">{busy ? run?.statusText : ''}</p>
          {/* Counted down from the configured response timeout (130 s on Web Service). */}
          <p id="busy-countdown" className="countdown" aria-live="off" hidden={!countdown.visible}>{countdown.text}</p>
          <p id="busy-countdown-caption" className="caption" hidden={!countdown.visible}>{countdown.caption}</p>
          <button
            id="btn-cancel"
            type="button"
            className="outlined"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await transaction.cancel();
              } catch {
                setCancelling(false);
              }
            }}
          >
            Cancel
          </button>
          <p id="busy-note" className="caption" hidden={run?.state !== 'inProgress'}>
            Cancel only stops waiting here. If the request has already reached the terminal, the transaction may still complete on it.
          </p>
        </div>
        <p id="link-lost" className="banner error" role="status" hidden={!linkLost}>
          The connection to the app was lost. Still trying; the transaction carries on regardless.
        </p>

        <ResultDialog transaction={transaction} onAcknowledged={onAcknowledged} />
      </section>
    );
  },
);
