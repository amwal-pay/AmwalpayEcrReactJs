# Amwal ECR - Node.js and React web sample

The JavaScript port of the Amwal ECR web sample
([AmwalpayEcrWindowsExample / AmwalECR-Web-Example](https://github.com/amwal-pay/AmwalpayEcrWindowsExample),
and its PHP port in `amwalpay/ecr-php`): register POS terminals, key an amount in the browser, pick a
terminal, run a sale, void, refund or inquiry over **Wi-Fi** or the **ECR Web Service**. The page is
the web sample's page rebuilt in React on `@amwalpay/ecr-react`: the same markup, ids, styles, wording
and behaviour. Behind it, the same 21-route JSON API is written in Node.js, along with a port of the
samples' shared Core (terminal store, form rules, transaction engine, outcome classification, result
wording), so behaviour and wording match the Windows and PHP samples.

It installs `@amwalpay/ecr-js` and `@amwalpay/ecr-react` **from the built package artifacts**
(`../dist/*.tgz`), never from the packages' source folders, so it runs exactly what ships.

- How it is built: [docs/implementation.md](docs/implementation.md)
- SDK copy-paste snippets: [cli/wifi-quickstart.mjs](cli/wifi-quickstart.mjs), [cli/webservice-quickstart.mjs](cli/webservice-quickstart.mjs)

> **This sample has no authentication.** Anyone who can reach it can take payments and replace
> signing keys. It accepts loopback host names only; read [Security](#security) before changing that.

## Run it

Needs Node.js 18.18 or later. From the repository root:

```powershell
npm install
npm run pack:artifacts         # dist/amwalpay-ecr-js-1.0.0-rc.1.tgz, dist/amwalpay-ecr-react-1.0.0-rc.1.tgz
cd examples
npm install                    # installs both tarballs (and qrcode for the e-receipt QR)
npm run verify-artifact        # "OK: the example runs on the built artifacts"
npm run build:web              # builds the React page into web/dist
npm run serve                  # http://127.0.0.1:5080
```

Open <http://127.0.0.1:5080>. A second instance on another port and data folder:

```powershell
$env:AMWAL_ECR_EXAMPLE_DATA = "$env:TEMP\ecr-scratch"
$env:AMWAL_ECR_EXAMPLE_PORT = "5091"
npm run serve
```

Working on the page: keep `npm run serve` running and start `npm run dev:web` in a second terminal.
Vite serves the page on <http://127.0.0.1:5173> with hot reload and forwards `/api` to the server.

## Configure it

| Setting | Default | Override |
|---|---|---|
| Address | `127.0.0.1:5080` | `AMWAL_ECR_EXAMPLE_HOST`, `AMWAL_ECR_EXAMPLE_PORT` |
| Allowed hosts | `127.0.0.1;localhost;[::1]` | `AMWAL_ECR_EXAMPLE_ALLOWED_HOSTS` |
| Data folder | `%LOCALAPPDATA%\AmwalECR-JS-Example` (`~/.local/share/...` elsewhere) | `AMWAL_ECR_EXAMPLE_DATA` |
| Time zone | the machine's (as the Windows sample) | `AMWAL_ECR_EXAMPLE_TIMEZONE`, e.g. `Asia/Muscat` |

The data folder holds `terminals.json`, `settings.dat` (environment and both signing keys,
encrypted), `keys/` (the key that decrypts it), `runs/` (transactions the page polls), `log.txt`
(the last 500 SDK lines) and `sdk-state/` (the SDK's terminal lock and merchant-reference journal).

In the UI, keys, environment and terminals are set on the **Terminals** screen: a *Wi-Fi secure hash
key* card, a *Web Service* card (environment `SIT`/`UAT`/`PROD` and the Web Service key), and the
terminal list. Terminal records hold addresses only (Wi-Fi: IP and port; Web Service: merchant and
terminal IDs), never a key. Keys are validated when saved and an invalid one is refused.

### Wi-Fi, without a terminal

The signed fake terminal verifies the till's signature and signs its answers like a real one:

```powershell
node ..\tools\fake-pos-server.mjs --key 0123456789ABCDEF0123456789ABCDEF --port 19100
```

Then: **Terminals** → paste the same key as the Wi-Fi key → **Add terminal** (Wi-Fi, IP `127.0.0.1`,
port `19100`) → **Transaction** → amount → **Start transaction**. Useful flags: `--decline 51`,
`--partial`, `--delay 8` (then **Cancel**, or reload the page), `--drop-sale`,
`--drop-sale --drop-first-inquiry`, `--not-found`, `--busy`, `--no-close-receipt`.

### Web Service

Calls the Amwal Hub over HTTPS (`ecrMode: 4`), not a terminal IP. You need credentials from Amwal.
Set the environment and the **Web Service** key (not the Wi-Fi key) on the Terminals screen, add a
terminal in mode Web Service (serial, numeric merchant and terminal IDs), and select it on the
Transaction screen; the config card must read ready before **Start**. There is no reachability probe
and no e-receipt; keep the merchant reference so **Inquire by reference** can resolve a lost answer.
Behind a TLS-inspecting proxy, give Node the proxy's CA with `NODE_EXTRA_CA_CERTS` (see
[troubleshooting](../docs/troubleshooting.md#web-service)).

## What it demonstrates

Everything the Windows and PHP samples demonstrate (operations, POS-style amount entry, unknown
outcomes, inquiry, Close receipt, QR), plus:

- **Transactions run on the server and the page polls.** `POST /api/transactions` starts a run
  (`202`) as a task of the long-lived Node server; closing the tab or dropping a request never
  cancels a payment, only the explicit Cancel does, and a reloaded page finds its running or unread
  transaction (`useTransaction` adopts it).
- **A countdown driven by the server**: `timeoutSeconds` (120 s Wi-Fi, 130 s Web Service) and
  `remainingSeconds`, counted on the server (`useCountdown`).
- **Cancel only stops waiting.** A cancelled sale, void or refund becomes an unknown outcome with
  **Inquire by reference**, never "cancelled".
- **Close receipt** is its own button on a completed sale, void or refund. Closing the dialog does not
  send it.
- **One running transaction per terminal**, enforced by the server (`409`), and again by the SDK.
- **Write-only keys.** The API never returns a stored key, only `configured: true/false` and its label.
- **The QR is drawn on the server** (`GET /api/qr`, SVG), so the page needs no QR library.
- **A merchant reference is made and stored before anything is sent**, and a run whose server stopped
  mid-payment becomes an unknown outcome carrying that reference when the server starts again, not a
  spinner.
- Light and dark themes and a phone-width layout.

## API

JSON in, JSON out. Mutating calls (`POST`, `PUT`, `DELETE`) **must** send
`Content-Type: application/json` (`{}` if there is nothing to say). Field errors are
`422 { "errors": { "<field>": "<message>" }, "message": null }`; other errors are
`{ "error": "...", "transactionId": null }`. The contract is the web sample's, route for route, and
`createEcrClient()` in `@amwalpay/ecr-react` has one method per route.

| Route | Purpose |
|---|---|
| `GET /api/meta` | Operations (SDK flags, per-combination field layouts), modes, environments, amount limits, today |
| `GET/POST /api/terminals`, `PUT/DELETE /api/terminals/{serial}` | Terminals, keyed by serial |
| `GET /api/terminals/{serial}/config` | The config card: what the SDK plan makes of the terminal, before paying |
| `GET /api/settings`, `PUT /api/settings/environment` | Environment; never a key |
| `PUT/DELETE /api/settings/keys/{wifi\|webService}` | Replace or clear a key (write-only) |
| `GET/POST /api/transactions` | Un-acknowledged runs (newest first); start one (`202`, `422`, `409`) |
| `GET /api/transactions/{id}` | Poll the state |
| `POST /api/transactions/{id}/cancel` | Stop waiting |
| `POST /api/transactions/{id}/inquire` | Look an unknown outcome up by its reference |
| `POST /api/transactions/{id}/receipt` | Fetch the e-receipt of an inquiry result (Wi-Fi) |
| `POST /api/transactions/{id}/close-receipt` | Ask the terminal to put its receipt away |
| `DELETE /api/transactions/{id}` | The operator has read the result (`409` while running) |
| `GET /api/qr?text=` | `image/svg+xml` |
| `GET/DELETE /api/log` | The last 500 SDK log lines; clear |

Finished transactions nobody acknowledged are kept for 12 hours, then dropped.

## Behind IIS, nginx or a service manager

The Node server is enough for one till. In front of it, or as a service:

- Reverse-proxy the site to `http://127.0.0.1:5080` (IIS ARR + URL Rewrite, nginx `proxy_pass`), and
  forward the original `Host` header; set `AMWAL_ECR_EXAMPLE_ALLOWED_HOSTS` to your host names only
  after the steps below.
- Requests are short (the page polls), so the proxy needs no long timeouts; the payment runs in the
  server, outside any request.
- Run it as a service (Windows: NSSM or a scheduled task at start-up; Linux: systemd). On stop
  (`SIGINT`/`SIGTERM`) the server stops taking requests and waits for running payments to be
  recorded; give the service manager a stop timeout above 180 s.
- The service account must be able to write the data folder.

## Security

There is no authentication or authorisation. Anyone who can open the page can start payments, edit
terminals, replace or clear keys and read the debug log (masked card numbers). The defaults keep that
to the machine it runs on:

- Host filtering to loopback names (defeats DNS rebinding; another `Host` gets `400`).
- Stored keys are never sent to the browser or logged; `settings.dat` is AES-256-GCM encrypted.
- No CORS; mutating calls must be `application/json`; a request from another origin
  (`Origin` / `Sec-Fetch-Site`) is refused with `403`.
- Security headers and a strict CSP (no inline script or style); React renders server text as text,
  never as markup; bodies capped at 64 KB; errors carry no detail.
- The key in `keys/` is **not** itself encrypted: the data folder's permissions are what protect it.

### Before you expose this

Add authentication and authorisation on every endpoint (read-only ones included); TLS, with the allowed
hosts set to your host names; per-user terminal ownership; terminals in a database and keys in a
secret store; and audit logging.

## Tests

From `examples/`:

```powershell
npm test               # the server: real HTTP, real tasks, the signed fake terminal
npm run test:web       # the page: rendered with jsdom against a fake server
```

The server tests host this app for real (Node's HTTP server, a temp data folder, server tasks, the
signed fake terminal): terminals and their messages, write-only and encrypted keys, meta, form
validation, approved / declined / partial / unreachable, lost answer recovered, lost answer plus lost
follow-up then **Inquire** on the same run (exactly one SALE), cancel = unknown outcome, `409` and 8
concurrent starts letting exactly one through, terminals side by side, receipt and QR, the log, the
security guard, the page source's rendering rules, and a run whose server stopped turning into an
unknown outcome with its reference.

## Known limits

- Single server: the run registry is in the server's memory and its `runs/` folder, and the SDK's
  terminal lock and journal are files; two servers do not share them (see the integration guide for a
  shared journal and lock).
- The server guards a *running* run; as in the Windows sample, it does not block the next sale while
  an *Outcome unknown* result sits unread. The SDK's opt-in guard (`guardFinancialOperations: true`)
  would refuse it until reconciled.
- Closing the result dialog acknowledges it, including an unknown outcome; the reference stays in the
  debug log and in the SDK journal.
- USB cable and Bluetooth can be registered (to match the Android and Windows terminal lists) but not
  run: the JavaScript SDK opens Wi-Fi and Web Service only.
- Web Service is not exercised against a real Hub by the tests.
