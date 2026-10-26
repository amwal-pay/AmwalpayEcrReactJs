import { ApiError, useTerminals, type MetaView, type TerminalForm, type TerminalView } from '@amwalpay/ecr-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { SettingsCards, type SettingsHandle } from './SettingsCards';
import type { ScreenHandle } from './TransactionScreen';
import { afterRender, Text, useAnnounce, useConfirm } from './ui';

type Inputs = 'name' | 'serial' | 'ip' | 'port' | 'merchantId' | 'terminalId';
const ERROR_KEYS = ['name', 'serial', 'mode', 'ip', 'port', 'merchantId', 'terminalId'] as const;
type ErrorKey = (typeof ERROR_KEYS)[number];
type Errors = Partial<Record<ErrorKey, string>>;

const byEdit = (serial: string) => document.querySelector<HTMLButtonElement>(`#terminal-list [data-edit="${CSS.escape(serial)}"]`);

/**
 * Registered terminals: list, add, edit, delete — the port of TerminalsView and
 * TerminalEditWindow — with the signing settings above them. The rules and the
 * messages are Core's TerminalValidator; the server answers with per-field errors
 * and they are shown under the fields.
 */
export const TerminalsScreen = forwardRef<ScreenHandle, { meta: MetaView; active: boolean }>(function TerminalsScreen({ meta, active }, ref) {
  const announce = useAnnounce();
  const confirm = useConfirm();
  const { terminals, notice: listNotice, loaded, refresh, add, save, remove } = useTerminals();
  const [notice, setNotice] = useState<string | null>(null);
  const settingsRef = useRef<SettingsHandle>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    refresh: () => {
      setNotice(null);
      void refresh();
      settingsRef.current?.refresh();
    },
    focus: () => heading.current?.focus(),
  }), [refresh]);

  // Editor -------------------------------------------------------------------------------
  const dialog = useRef<HTMLDialogElement>(null);
  const inputs: Record<Inputs, React.RefObject<HTMLInputElement>> = {
    name: useRef<HTMLInputElement>(null),
    serial: useRef<HTMLInputElement>(null),
    ip: useRef<HTMLInputElement>(null),
    port: useRef<HTMLInputElement>(null),
    merchantId: useRef<HTMLInputElement>(null),
    terminalId: useRef<HTMLInputElement>(null),
  };
  const defaultMode = meta.modes.find((m) => m.ipBased)?.value ?? meta.modes[0]!.value;
  const [editing, setEditing] = useState<{ original: string | null; title: string }>({ original: null, title: '' });
  const [values, setValues] = useState<Record<Inputs, string>>({ name: '', serial: '', ip: '', port: '', merchantId: '', terminalId: '' });
  const [mode, setMode] = useState<number>(defaultMode);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const modeView = meta.modes.find((m) => m.value === mode);

  function openEditor(existing: TerminalView | null, trigger: HTMLElement) {
    opener.current = trigger;
    setEditing({ original: existing?.serialNumber ?? null, title: existing ? 'Terminal' : 'Add terminal' });
    setValues({
      name: existing?.name ?? '',
      serial: existing?.serialNumber ?? '',
      ip: existing?.ipAddress ?? '',
      // A new terminal starts on the standard port; an existing one shows what it has.
      port: existing ? (existing.port > 0 ? String(existing.port) : '') : String(meta.defaultPort),
      merchantId: existing?.merchantId ?? '',
      terminalId: existing?.terminalId ?? '',
    });
    setMode(existing?.ecrMode ?? defaultMode);
    setErrors({});
    dialog.current?.showModal();
    inputs.name.current?.focus();
  }

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    // Focus goes back to where the editor was opened, unless the list was rebuilt.
    const onClose = () => {
      if (opener.current?.isConnected) opener.current.focus();
      opener.current = null;
    };
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, []);

  /** A field being edited loses its own message. */
  const edit = (key: Inputs, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    const errorKey: ErrorKey = key;
    if (errors[errorKey]) setErrors((e) => ({ ...e, [errorKey]: undefined }));
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body: TerminalForm = {
      name: values.name,
      serialNumber: values.serial,
      ecrMode: mode,
      ipAddress: values.ip,
      port: values.port,
      terminalId: values.terminalId,
      merchantId: values.merchantId,
    };
    setSaving(true);
    try {
      const saved = editing.original == null ? await add(body) : await save(editing.original, body);
      opener.current = null;
      dialog.current?.close();
      announce(`Terminal ${saved.name} saved`);
      afterRender(() => (byEdit(saved.serialNumber) ?? addButton.current)?.focus());
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 422) {
        setErrors({ serial: error instanceof Error ? error.message : String(error) });
        return;
      }
      const fields = error.fields as Errors;
      setErrors(fields);
      const visible: Inputs[] = ['name', 'serial', 'ip', 'port', 'merchantId', 'terminalId'];
      const first = visible.find((k) => fields[k] && !inputs[k].current?.closest('[hidden]'));
      if (first) inputs[first].current?.focus();
      announce(Object.values(fields).find(Boolean) ?? 'The terminal could not be saved');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(t: TerminalView) {
    const yes = await confirm({ title: 'Delete terminal', message: `Delete “${t.name}”? This cannot be undone.`, action: 'Delete' });
    if (!yes) {
      afterRender(() => (byEdit(t.serialNumber)?.nextElementSibling as HTMLElement | null)?.focus());
      return;
    }
    let failure: string | null = null;
    try {
      await remove(t.serialNumber);
      announce(`${t.name} deleted`);
    } catch (error) {
      failure = `Could not delete the terminal: ${error instanceof Error ? error.message : String(error)}`;
    }
    setNotice(failure);
    afterRender(() => addButton.current?.focus());
  }

  const invalid = (key: ErrorKey) => (errors[key] ? 'true' : 'false');
  const field = (key: Inputs, label: string, extra: React.InputHTMLAttributes<HTMLInputElement>, hint?: string) => (
    <div className="field">
      <label htmlFor={`t-${key}`}>{label}</label>
      <input
        ref={inputs[key]}
        id={`t-${key}`}
        type="text"
        autoComplete="off"
        aria-describedby={hint ? `e-t-${key} h-t-${key}` : `e-t-${key}`}
        aria-invalid={invalid(key)}
        value={values[key]}
        onChange={(e) => edit(key, e.target.value)}
        {...extra}
      />
      <Text className="error" id={`e-t-${key}`} text={errors[key]} />
      {hint ? <p className="caption" id={`h-t-${key}`}>{hint}</p> : null}
    </div>
  );

  return (
    <section id="view-terminals" className="view" aria-labelledby="h-terminals" hidden={!active}>
      <h2 id="h-settings" className="sr-only" tabIndex={-1}>Terminals and settings</h2>
      <SettingsCards ref={settingsRef} meta={meta} />

      <div className="row spread terminals-heading">
        <h2 ref={heading} id="h-terminals" tabIndex={-1}>Registered terminals</h2>
        <button ref={addButton} id="btn-add-terminal" type="button" className="primary compact" onClick={(e) => openEditor(null, e.currentTarget)}>
          Add terminal
        </button>
      </div>
      <Text id="terminals-notice" className="banner error" role="status" text={notice ?? listNotice} />
      <p id="terminals-empty" className="body center" hidden={!loaded || terminals.length !== 0}>
        No terminals yet.<br />Click “Add terminal” to register a POS terminal.
      </p>
      <ul id="terminal-list" className="cards">
        {terminals.map((t) => (
          <li key={t.serialNumber} className="card">
            <h3>{t.name}</h3>
            <p className="mode">{t.modeLabel}</p>
            <p className="mono">{`S/N ${t.serialNumber}`}</p>
            <p className="mono">{t.connectionSummary}</p>
            <div className="actions">
              <button type="button" className="text compact" aria-label={`Edit ${t.name}`} data-edit={t.serialNumber} onClick={(e) => openEditor(t, e.currentTarget)}>Edit</button>
              <button type="button" className="danger compact" aria-label={`Delete ${t.name}`} onClick={() => void onDelete(t)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>

      {/* Add / edit terminal. */}
      <dialog ref={dialog} id="dlg-terminal" className="modal" aria-labelledby="t-title">
        <form id="terminal-form" noValidate onSubmit={submit}>
          <div className="modal-body">
            <h2 id="t-title" className="title">{editing.title}</h2>

            {field('name', 'Terminal name', {})}
            {field('serial', 'Serial number', { spellCheck: false })}

            <fieldset className="plain radios" id="t-modes">
              <legend>ECR mode</legend>
              {meta.modes.map((m) => {
                const hintId = `t-mode-hint-${m.value}`;
                return (
                  <label key={m.value} className="radio">
                    <input
                      type="radio"
                      name="t-mode"
                      value={m.value}
                      aria-describedby={m.hint ? hintId : undefined}
                      checked={mode === m.value}
                      onChange={() => setMode(m.value)}
                    />
                    <span>
                      {m.label}
                      {m.hint ? <span className="caption" id={hintId}><br />{m.hint}</span> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <Text className="error" id="e-t-mode" text={errors.mode} />

            <div id="t-wifi" hidden={!modeView?.ipBased}>
              {field('ip', 'IP address', { inputMode: 'decimal', spellCheck: false },
                'Use the IP shown on the POS terminal under the card logos. Default port is 9100. On the same PC (tools/fake-pos-server.mjs), try 127.0.0.1.')}
              {field('port', 'Port', { inputMode: 'numeric' }, 'Optional. Blank means 9100.')}
            </div>

            <div id="t-web" hidden={mode !== 4}>
              {field('merchantId', 'Merchant ID', { inputMode: 'numeric' })}
              {field('terminalId', 'Terminal ID', { inputMode: 'numeric' })}
            </div>

            <Text id="t-note" className="caption" text={modeView?.note} />
          </div>
          <div className="modal-actions">
            <button id="t-cancel" type="button" className="outlined" onClick={() => dialog.current?.close()}>Cancel</button>
            <button id="t-save" type="submit" className="primary" disabled={saving}>Save</button>
          </div>
        </form>
      </dialog>
    </section>
  );
});
