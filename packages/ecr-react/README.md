# @amwalpay/ecr-react

React hooks and components for an Amwal ECR till: POS-style amount entry, the terminal list,
write-only signing-key settings, and a transaction that runs **on your server** and is watched from
the page.

Version **1.0.0-rc.1**, SIT release candidate. It goes with `@amwalpay/ecr-js` of the same version.

## The server does the payment, the browser watches it

A browser cannot open a TCP connection to a terminal, and a signing key in front-end code is a key
anyone can read. So the terminal I/O, the keys and the payment-safety guard stay on a Node.js server
built on `@amwalpay/ecr-js`. The browser talks to that server's JSON API. It only starts a
transaction (`202`) and then polls it, so a closed tab never cancels a payment. The browser never
holds a key: the API reports only whether a key is configured.

This package is a typed client and hooks for that API: the 21-route contract of the Amwal ECR web
sample, which the example server in [`examples/server`](../../examples/server) implements.

| Route | Purpose |
|---|---|
| `GET /api/meta` | Operations (SDK flags, per-combination field layouts), modes, environments, amount limits, today |
| `GET/POST /api/terminals`, `PUT/DELETE /api/terminals/{serial}` | Terminals, keyed by serial |
| `GET /api/terminals/{serial}/config[?announce=true]` | What the SDK plan makes of the terminal, before paying |
| `GET /api/settings`, `PUT /api/settings/environment` | Environment; never a key |
| `PUT/DELETE /api/settings/keys/{wifi\|webService}` | Replace or clear a key (write-only) |
| `GET/POST /api/transactions` | Unacknowledged runs (newest first); start one (`202`, `422`, `409`) |
| `GET /api/transactions/{id}` | Poll the state |
| `POST /api/transactions/{id}/cancel` \| `/inquire` \| `/receipt` \| `/close-receipt` | Stop waiting; look up an unknown outcome; fetch the e-receipt; close the receipt |
| `DELETE /api/transactions/{id}` | The operator has read the result (`409` while running) |
| `GET /api/qr?text=` | `image/svg+xml` |
| `GET/DELETE /api/log` | The last 500 SDK log lines; clear |

Mutating calls always send `Content-Type: application/json` (`{}` when there is nothing to say):
the server refuses anything else, which stops another site's form from driving it.

## Install

```powershell
npm install @amwalpay/ecr-react@1.0.0-rc.1
```

React 18 or later. Until the package is published, install the built artifact:
`npm install ../dist/amwalpay-ecr-react-1.0.0-rc.1.tgz`.

## Exports

### `createEcrClient(options?)` and `ApiError`

```tsx
import { createEcrClient, ApiError } from '@amwalpay/ecr-react';

const client = createEcrClient({ baseUrl: '' });          // same origin; `fetch` can be injected
try {
  const run = await client.start({ terminalSerial: 'SN-WIFI-0001', type: 'Sale', amountDigits: '1234',
    receiptNumber: '', originalTerminalId: '', originalDate: '2026-10-25', useOtherTerminal: false,
    lookUpByReference: false, originalReference: '', merchantReference: 'ORDER-1001-1' });
} catch (error) {
  if (error instanceof ApiError && error.status === 422) showFieldErrors(error.fields);  // { amount: 'Required field' }
  else if (error instanceof ApiError && error.status === 0) show('The app could not be reached. Nothing was sent.');
}
```

Every route has a method: `meta`, `terminals`, `addTerminal`, `saveTerminal`, `deleteTerminal`,
`config`, `settings`, `setEnvironment`, `setKey`, `clearKey`, `pending`, `start`, `transaction`,
`cancel`, `inquire`, `receipt`, `closeReceipt`, `acknowledge` (sent with `keepalive`), `log`,
`clearLog`, and `qrUrl(text)`. A 204 resolves to `null`. `ApiError.status` is `0` when the server could
not be reached; `ApiError.fields` holds a 422's per-field messages. `qrUrl(text)` is also exported on
its own.

### `<EcrProvider>` and `useEcrClient()`

```tsx
import { EcrProvider } from '@amwalpay/ecr-react';

createRoot(el).render(<EcrProvider><App /></EcrProvider>);   // or <EcrProvider client={myClient}>
```

All hooks below read the client from the nearest provider.

### Amount helpers and `<AmountInput>`

The POS amount field: three decimals shown, typed digits shift in from the right (`1` → `0.001`,
`1234` → `1.234`), Backspace shifts them out, Escape clears. The keyed digits are the source of truth
and go to the server as `amountDigits`; the amount never passes through a JavaScript number.

```tsx
import { AmountInput, formatAmount, keyedDigits, appendDigit, backspaceDigit, FRACTION_DIGITS } from '@amwalpay/ecr-react';

const [digits, setDigits] = useState('');
const amount = useRef<AmountInputHandle>(null);

<AmountInput ref={amount} id="f-amount" className="amount" maxDigits={meta.amount.maxDigits}
  digits={digits} onDigitsChange={setDigits} aria-describedby="e-amount" />

amount.current?.focus();          // moves focus here and keeps the amount
formatAmount('1234');             // '1.234'
keyedDigits('01,2a3', 9);         // '123'
appendDigit('12', '3', 9);        // '123'
backspaceDigit('123');            // '12'
```

Focusing the field from another control starts a fresh amount (there is no caret to place); the
`focus()` of the handle does not.

### `useMeta()`

```tsx
const { meta, error, loading } = useMeta();
if (error) return <p role="alert">The app could not be reached. Is it still running?</p>;
const op = meta?.operations.find((o) => o.value === form.type);
const shown = op?.layouts[`${form.useOtherTerminal ? 1 : 0}${form.lookUpByReference ? 1 : 0}`];
```

The layouts come from the same form state the server validates with, so a field that is shown and a
field that is required cannot disagree.

### `useTerminals()`

```tsx
const { terminals, notice, loaded, refresh, add, save, remove } = useTerminals();
await add({ name: 'Till 1', serialNumber: 'SN-WIFI-0001', ecrMode: 2, ipAddress: '192.168.1.50', port: '9100', terminalId: '', merchantId: '' });
await save('SN-WIFI-0001', { ...form, ipAddress: '192.168.1.51' });   // 422 → ApiError.fields
await remove('SN-WIFI-0001');
```

### `useSettings()`

```tsx
const { settings, notice, setEnvironment, setKey, clearKey } = useSettings();
settings?.wifi.configured;                    // true / false: the key itself is never returned
await setKey('wifi', typedHexKey);            // 422 → error.fields.value; wipe the input once saved
await setEnvironment('UAT');
await clearKey('webService');
```

### `useTerminalConfig(serial, { announce })`

```tsx
const { config, reload } = useTerminalConfig(selectedSerial, { announce: userPickedIt });
const canStart = config?.isReady === true;    // show config.issues when it is not
```

`announce: true` makes the server log the selection; `reload(false)` refreshes without logging.

### `useTransaction(options?)`

The run lifecycle: start, then poll every 500 ms while busy or while a receipt is being fetched. A
poll answer older than the one shown (by `version`) is ignored; a failed poll sets `linkLost` and keeps
trying; a 404 forgets the run. On mount it adopts the newest unacknowledged run, so a reload never loses
a running payment or an unread result. While busy it asks before the page is closed. A run that comes
back `idle` (cancelled before anything was sent) is acknowledged by itself.

```tsx
const tx = useTransaction({
  onStateChange: () => log.refresh(),
  onStopped: () => announce('Stopped. No money was moved.'),
});

await tx.start({ terminalSerial, ...form });   // 409 adopts the run already going on that terminal
tx.run?.busy;                                   // show the busy panel
tx.run?.isResult && tx.run.dialog;              // show the result
await tx.cancel();                              // stops waiting; a sent sale becomes an unknown outcome
await tx.inquire();                             // the only follow-up to an unknown outcome: never a retry
await tx.requestReceipt();                      // Wi-Fi e-receipt; dialog.receipt.url → <img src={client.qrUrl(url)}>
const { message } = await tx.closeReceipt();    // the cashier's Close receipt button, never automatic
tx.acknowledge();                               // the operator has read the result
```

### `useCountdown(run)`

```tsx
const countdown = useCountdown(tx.run);
{countdown.visible && <p className="countdown">{countdown.text}</p>}   // '1:58', 'remaining of 120 s timeout'
```

The server counts the budget (120 s Wi-Fi, 130 s Web Service) and reports what is left on every poll;
the hook only ticks between polls.

### `useEcrLog({ open, pollMs })`

```tsx
const [open, setOpen] = useState(false);
const { log, refresh, clear } = useEcrLog({ open, pollMs: 1000 });
<textarea readOnly value={log?.text ?? ''} />   // masked card numbers only; treat as transaction records
```

Polls only while `open` and the page is visible.

### Types

Every API shape is exported: `MetaView`, `OperationView`, `FieldLayout`, `ModeView`, `TerminalView`,
`TerminalListView`, `TerminalForm`, `ConfigView`, `SettingsView`, `KeyView`, `KeyKind`,
`TransactionForm`, `TransactionView`, `TransactionState`, `DialogView`, `ReceiptView`,
`CloseReceiptView`, `LogView`.

## The example

[`examples/web`](../../examples/web) is the Amwal ECR web sample's page rebuilt with these hooks:
same markup, ids, classes, wording and behaviour, served by the Node example server.

## Develop

```powershell
npm run build -w @amwalpay/ecr-react
npm run test -w @amwalpay/ecr-react
```
