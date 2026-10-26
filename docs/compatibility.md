# Supported versions

What `@amwalpay/ecr-js` and `@amwalpay/ecr-react` 1.0.0-rc.1 support, and what has actually been
verified. "Supported" means the code targets it and CI runs it; "verified" means it has been run and
recorded. SIT evidence (real terminals and the real Hub) is still to be collected: see
[release.md](release.md).

## Node.js (`@amwalpay/ecr-js`)

| Node.js | Status |
|---|---|
| 18.18+ (LTS) | Supported (minimum, `engines: ">=18.18"`). End of life upstream: plan to move to 20 or 22. |
| 20 (LTS) | Supported (CI). |
| 22 (LTS) | Supported. **Verified**: full suite, Windows 11 Pro 10.0.26200, Node v22.13.0, npm 10.9.2. |
| < 18.18 | Not supported: `Error` `cause`, `socket.resetAndDestroy()` (tests), `Atomics.wait` on the main thread and `Intl` time-zone support are required. |

The package is ESM only (`"type": "module"`): `import { EcrSessions } from '@amwalpay/ecr-js'`. From
CommonJS use `await import('@amwalpay/ecr-js')` (or `require()` on Node 22 with ESM-require). It
has no runtime dependencies and needs no native modules. Types ship with the package (TypeScript
5.x, `moduleResolution: NodeNext` or `Bundler`).

It is a **server** package: it opens TCP sockets and holds signing keys. It does not run in a
browser, a React Native app or an edge runtime without Node's `net`, `https`, `crypto` and `fs`.

## React (`@amwalpay/ecr-react`)

| | Status |
|---|---|
| React 18 | Supported (`peerDependencies: react >=18`). **Verified** with React 18.3. |
| React 19 | Expected to work (same hooks API); not yet verified. |
| Bundlers | Any ESM-aware bundler (Vite verified in `examples/web`). |

## Browsers (the example page)

Current Chrome, Edge, Firefox and Safari: the page uses `<dialog>` with `showModal()`,
`beforeinput`, ES modules and `fetch` with `keepalive`. Internet Explorer and legacy Edge are not
supported.

## Operating systems

| Platform | Status |
|---|---|
| Windows 11 (x64) | Supported. **Verified** (see Node 22 above). |
| Windows 10 1809+ (x64) | Supported. |
| Windows Server 2016, 2019, 2022 (x64) | Supported. Run the till server as a Windows service (NSSM, `node-windows`, or a scheduled task) under an account that owns the state folder. |
| Linux, macOS | Supported (CI runs Ubuntu); not part of the approved Windows scope. |

The guard's locks are files created exclusively and recognise their owner by process id, so the
state folder must be on a **local disk**, not a network share; see [parity.md](parity.md) row 20.

## Terminal and backend

| Component | Supported |
|---|---|
| ECR message format | `version` 1. Answers declaring a higher version are refused (outcome unknown). |
| Terminal firmware | Any POS app version that speaks the Wi-Fi ECR format of `AmwalPay.Ecr` 1.0.0-1.0.2 (signed, unified envelope; legacy flat and `ecrResponse` shapes are read too). `CLOSE_RECEIPT` needs the firmware that `AmwalPay.Ecr` 1.0.2 targets; older firmware answers `CloseReceiptRefused`. Exact firmware numbers to be recorded during SIT. |
| Terminal ECR mode | Wi-Fi (`ecrMode: 2`), Web Service (`ecrMode: 4`). Not USB/cable. |
| Web Service contract | POS-552 (WebIntegration), as implemented by `AmwalPay.Ecr` 1.0.2: `/Ecr/Sale`, `/Ecr/Void`, `/Ecr/Refund`, `/Ecr/Inquiry`, `/Ecr/closeReceipt`. |
| Hub environments | SIT, UAT, PROD (addresses as in `AmwalPay.Ecr` 1.0.2/1.0.1; UAT changed in 1.0.1). |
| Manual settlement (POS-599) | Not supported until the contract is final and versioned. |

## Compatibility matrix for SIT

Fill one row per combination exercised in SIT; attach the evidence (logs with masked PAN, terminal
receipts) to POS-573.

| Windows | Node | Terminal model / firmware | Mode | Environment | Approved | Declined | Timeout → reconciled | Lost answer → reconciled | Result |
|---|---|---|---|---|---|---|---|---|---|
| | | | Wi-Fi | n/a | | | | | |
| | | | Web Service | SIT | | | | | |
