import { ApiError, useSettings, type KeyKind, type KeyView, type MetaView, type UseSettings } from '@amwalpay/ecr-react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { afterRender, Text, useAnnounce, useConfirm } from './ui';

export interface SettingsHandle {
  refresh(): void;
}

/**
 * Environment and signing keys, embedded on the Terminals screen (Android ECR-simulator /
 * WPF SettingsView above the terminal list). Two mode-specific secrets, not per-terminal.
 *
 * Keys are write-only here. The server never returns a stored key, so where the WPF app
 * has Show / Hide this page has "Configured", Replace and Clear. A typed key lives in the
 * input only until it is saved, and is wiped from it the moment the server has it.
 */
export const SettingsCards = forwardRef<SettingsHandle, { meta: MetaView }>(function SettingsCards({ meta }, ref) {
  const settings = useSettings();
  const announce = useAnnounce();
  useImperativeHandle(ref, () => ({ refresh: () => void settings.refresh() }), [settings.refresh]);
  const current = settings.settings;

  return (
    <>
      <Text id="settings-notice" className="banner error" role="status" text={settings.notice} />

      {/* Global credentials: two mode-specific keys (not per terminal). */}
      <section className="card" aria-labelledby="h-lan">
        <h3 id="h-lan">Wi‑Fi settings</h3>
        <p className="caption">Signing key for Wi‑Fi, USB cable, and Bluetooth ECR (sorted key=value HMAC).</p>
        <div className="keybox" id="key-wifi">
          {current ? <KeyBox kind="wifi" keyView={current.wifi} settings={settings} /> : null}
        </div>
      </section>

      <section className="card" aria-labelledby="h-web">
        <h3 id="h-web">Web Service settings</h3>
        <p className="caption">Target environment and signing key for Web Service ECR (JSON body HMAC). This is a different secret from the Wi‑Fi key.</p>
        <fieldset className="plain radios" id="env-group">
          <legend>Environment</legend>
          {meta.environments.map((name) => (
            <label key={name} className="radio">
              <input
                type="radio"
                name="environment"
                value={name}
                checked={current?.environment === name}
                onChange={async () => {
                  try {
                    await settings.setEnvironment(name);
                    announce(`Environment set to ${name}`);
                  } catch (error) {
                    settings.setNotice(error instanceof Error ? error.message : String(error));
                  }
                }}
              />
              <span>{name}</span>
            </label>
          ))}
        </fieldset>
        <div className="keybox" id="key-webService">
          {current ? <KeyBox kind="webService" keyView={current.webService} settings={settings} /> : null}
        </div>
      </section>

      <p className="caption">
        Keys are stored encrypted by the Node server (AES-256-GCM, with the key in the data folder's keys/ folder). Unlike the Windows sample there is no Show button: the server never sends a stored key back to the browser, so a key can be replaced or cleared but not read.
      </p>
    </>
  );
});

function KeyBox({ kind, keyView, settings }: { kind: KeyKind; keyView: KeyView; settings: UseSettings }) {
  const announce = useAnnounce();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const inputId = `k-${kind}`;
  const errorId = `e-k-${kind}`;

  // Nothing to keep to: a key not yet set goes straight to the input.
  const showInput = editing || !keyView.configured;

  const status = (
    <p className="body" id={`s-k-${kind}`}>
      <strong>{keyView.label}</strong>: {keyView.configured ? 'Configured ✓' : 'Not configured'}
    </p>
  );

  async function save() {
    try {
      await settings.setKey(kind, value);
      setValue('');
      setError('');
      setEditing(false);
      announce(`${keyView.label} saved`);
      afterRender(() => document.getElementById(`key-${kind}`)?.querySelector('button')?.focus());
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setError(e.fields.value ?? e.message);
        input.current?.focus();
      } else {
        settings.setNotice(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function clear() {
    const yes = await confirm({
      title: 'Clear key',
      message: `Clear the ${keyView.label}? Terminals that use it cannot run transactions until a new one is set.`,
      action: 'Clear',
    });
    if (!yes) return;
    try {
      await settings.clearKey(kind);
      announce(`${keyView.label} cleared`);
    } catch (e) {
      settings.setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  if (!showInput) {
    return (
      <>
        {status}
        <div className="row">
          <button
            type="button"
            className="outlined compact"
            aria-describedby={`s-k-${kind}`}
            onClick={() => {
              setEditing(true);
              afterRender(() => input.current?.focus());
            }}
          >
            Replace
          </button>
          <button type="button" className="danger compact" aria-describedby={`s-k-${kind}`} onClick={clear}>Clear</button>
        </div>
      </>
    );
  }

  return (
    <>
      {status}
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor={inputId}>{`${keyView.label} ${keyView.configured ? '(enter a new key to replace it)' : ''}`.trim()}</label>
        <input
          ref={input}
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={`${errorId} h-${inputId}`}
          aria-invalid={error ? 'true' : 'false'}
          value={value}
          onChange={(e) => {
            // Hex only, as in the WPF field.
            setValue(e.target.value.replace(/[^0-9a-fA-F]/g, ''));
            setError('');
          }}
        />
        <Text className="error" id={errorId} text={error} />
        <p className="caption" id={`h-${inputId}`}>An even-length hex string of at least 16 characters. It is stored encrypted and cannot be shown again.</p>
        <div className="row">
          <button type="submit" className="primary compact">Save key</button>
          {keyView.configured ? (
            <button
              type="button"
              className="outlined compact"
              onClick={() => {
                setValue('');
                setError('');
                setEditing(false);
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </>
  );
}
