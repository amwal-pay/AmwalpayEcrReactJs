# Integration guide

How to put an Amwal POS terminal behind a Node.js till with `@amwalpay/ecr-js`: install, configure,
run every operation over Wi-Fi or Web Service, read the results, and resolve the payments whose
answer was lost. Every snippet uses placeholders (`wifiKey`, `SN-WIFI-0001`, `10001`); real values
come from Amwal and your own configuration. Snippets are TypeScript; the same code runs as plain
JavaScript (ESM) without the type annotations.

**Where the SDK runs.** `@amwalpay/ecr-js` runs on the till's **server** (Node.js), never in the
browser. A browser cannot open a TCP socket to a terminal, and a signing key in front-end code is a
key anyone can read. The page talks to your server's JSON API; `@amwalpay/ecr-react` gives the page
hooks and components for that API (section 13).

1. [What you need from Amwal](#1-what-you-need-from-amwal)
2. [Install](#2-install)
3. [Configure](#3-configure)
4. [Wi-Fi: open a session](#4-wi-fi-open-a-session)
5. [Web Service: open a session](#5-web-service-open-a-session)
6. [Operations](#6-operations)
7. [Read the result](#7-read-the-result)
8. [Resolve an unknown outcome](#8-resolve-an-unknown-outcome)
9. [The financial guard](#9-the-financial-guard)
10. [References, receipt numbers, amounts and dates](#10-references-receipt-numbers-amounts-and-dates)
11. [Timeouts and long waits in a Node.js server](#11-timeouts-and-long-waits-in-a-nodejs-server)
12. [Keys and logging](#12-keys-and-logging)
13. [Building the till's screens](#13-building-the-tills-screens)

---

## 1. What you need from Amwal

| | Wi-Fi (`ecrMode: 2`) | Web Service (`ecrMode: 4`) |
|---|---|---|
| Terminal set up in TMS for | ECR over Wi-Fi | ECR Web Service |
| Address | The IP and port on the terminal's idle screen (port 9100 by default) | None: the SDK calls the Amwal Hub |
| Identity | The terminal's serial number | Serial number, numeric merchant ID, numeric terminal ID |
| Secret | The **Wi-Fi secure hash key** (hex) | The **Web Service secure hash key** (hex), a different secret |
| Environment | n/a | SIT, UAT or PROD |
| Network | Till server and terminal on the same LAN/Wi-Fi; outbound TCP to the terminal's port | Outbound HTTPS to the Hub |

Endpoint, authentication, header and environment details for Web Service are owned by the Amwal
POS team (POS-552); confirm them before SIT.

## 2. Install

```powershell
npm install --save-exact @amwalpay/ecr-js@1.0.0-rc.1
```

Requirements: Node.js 18.18 or later; no native modules, no runtime dependencies. The package is ESM
only. See [compatibility.md](compatibility.md).

### Install from the artifact

Until the packages are on a registry, every environment installs the same built tarball, so SIT
tests exactly what will ship. Put `amwalpay-ecr-js-1.0.0-rc.1.tgz` in a folder (here
`../artifacts`) and:

```json
{
  "dependencies": {
    "@amwalpay/ecr-js": "file:../artifacts/amwalpay-ecr-js-1.0.0-rc.1.tgz"
  }
}
```

Check the tarball against its `.sha256` file before installing. `examples/bin/verify-artifact.mjs`
shows how a till can confirm at run time which version it loaded.

## 3. Configure

`EcrConfig` is immutable and checked when it is built: an invalid value throws
`InvalidArgumentException` at start-up, not on the shop floor.

```ts
import { EcrConfig } from '@amwalpay/ecr-js';

const config = new EcrConfig({
  ecrId: 'TILL-01',                                   // this till's name on the terminal's records
  secureHashKey: wifiKey,                             // Wi-Fi key or Web Service key, by link
  stateDirectory: 'C:\\ProgramData\\MyTill\\ecr',     // durable, private: the guard's locks and journal
});
const later = config.with({ responseTimeout: 90 });   // a validated copy
```

| Setting | Default | Notes |
|---|---|---|
| `ecrId` | `ECR01` | Shown on the terminal's records. |
| `currencyCode` | `512` (OMR) | ISO 4217 **numeric**, three digits, as a string. |
| `minorUnitDigits` | `3` | 0 to 4. Another currency needs both settings. |
| `port` | `9100` | Wi-Fi. The link's port wins. |
| `connectTimeout` | `10` s | Wi-Fi connect; Web Service connect. |
| `responseTimeout` | `120` s | Wi-Fi answer wait. `plan()` raises an untouched 120 s to 130 s for Web Service: 140 s with connect. |
| `probeTimeout` | `3` s | Reachability probe. |
| `secureHashKey` | empty | Even-length hex, at least 16 characters. `open()` requires one. |
| `merchantId`, `terminalId` | empty | Set from `WebServiceLink` by `plan()`. |
| `environment` | `EcrEnvironment.SIT` | `EcrEnvironment.fromName('uat')` reads names, ignoring case; unknown names read as SIT. |
| `autoInquireOnFailure` | `true` | Wi-Fi: follow a lost answer with one inquiry by reference. |
| `guardFinancialOperations` | `false` | Opt-in. See [section 9](#9-the-financial-guard). |
| `stateDirectory` | `os.tmpdir()` + `amwalpay-ecr` | **Set it in production.** The temp folder can be cleaned. |
| `caBundlePath` | none | Web Service TLS: a PEM file of extra CA certificates (a private CA or TLS-inspecting proxy). |
| `timezone` | machine's local time | Leave it unset: `transactionDateTime` uses the operating system's clock and time zone, as the Windows SDK's `DateTime.Now` (`EcrSdk.localTimeZone()` names it). Set an IANA name only to override the machine. |

`EcrSessions.plan()` turns a link plus a config into a plan and **lists** problems rather than
throwing, so a settings screen can show them. Pass the key as the operator typed it as the third
argument: it is trimmed and checked, and a bad one becomes an issue.

```ts
const plan = EcrSessions.plan(link, config, typedKey);
for (const issue of plan.issues()) console.log(issue);
console.log(plan.connectionSummary());   // "192.168.1.50:9100" or "UAT · merchant 10001 · terminal 20002"
console.log(plan.signingKeyLabel());     // which of the two keys this plan expects
```

## 4. Wi-Fi: open a session

```ts
import { EcrLogger, EcrSessions, LanLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(new LanLink('192.168.1.50', 9100), config);
const session = EcrSessions.open('SN-WIFI-0001', plan, { logger: EcrLogger.from((line) => console.log(line)) });

const probe = await session.probeReachability();   // before a sale
if (probe !== null && !probe.reachable) {
  show(`Terminal not reachable: ${probe.endpoint} (${probe.error})`);
}
```

A probe proves the port answers, not that the terminal is idle. It sends nothing.

Every request is signed with the Wi-Fi key and carries a fresh nonce; every answer must be signed
with the same key and echo that nonce, or it is discarded as `Unauthenticated`. A key mismatch
therefore shows up as repeated `Unauthenticated` failures, never as approvals.

No terminal yet? `node tools/fake-pos-server.mjs --key <hex> --port 19100` runs a signed fake
terminal; register `127.0.0.1:19100`. Its flags simulate declines, partial approvals, busy
terminals, lost and garbled answers, resets and old firmware.

## 5. Web Service: open a session

```ts
import { EcrConfig, EcrEnvironment, EcrSessions, WebServiceLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(
  new WebServiceLink('10001', '20002'),   // merchant ID, terminal ID
  new EcrConfig({ secureHashKey: webServiceKey, environment: EcrEnvironment.UAT }),
);
const session = EcrSessions.open('SN-WS-0001', plan);
```

- The Hub address is chosen by the SDK from the environment and cannot be typed in.
- There is no probe (`probeReachability()` resolves to `null`) and no e-receipt (`receipt()`
  answers `ReceiptUnavailable`).
- A lost answer is never inquired about automatically: `Failed.recovered` is always `null`. The
  inquiry is yours.
- `originalTerminalId` is ignored: the plan's terminal is used.
- A corporate proxy or custom HTTP stack: pass `{ httpTransport }` to `EcrSessions.open()`. The URL
  it is given is always the SDK's.

## 6. Operations

Every operation returns a promise.

| Call | Moves money | Wi-Fi | Web Service |
|---|---|---|---|
| `sale(amount, merchantReference)` | yes | ✓ | ✓ |
| `void(receiptNumber, { originalTerminalId, merchantReference })` | yes | ✓ | ✓ (`originalTerminalId` ignored) |
| `refund(amount, receiptNumber, transactionDate, { originalTerminalId, merchantReference })` | yes | ✓ | ✓ |
| `inquire(receiptNumber, transactionDate, { originalTerminalId })` | no | ✓ | ✓ |
| `inquireByReference(originalReference, { transactionDate })` | no | ✓ | ✓ |
| `receipt(receiptNumber, transactionDate)` | no | ✓ | `ReceiptUnavailable` |
| `closeReceipt({ merchantReference, originalMerchantReference })` | no | ✓ | ✓ (needs the original) |
| `probeReachability()` | no | ✓ | `null` |

**Sale.** The cardholder presents the card. `merchantReference` names this attempt.

**Void.** Cancels an earlier transaction for its full amount, by receipt number (STAN). No card.
The void has its own reference. `originalTerminalId` names another terminal (Wi-Fi only).

**Refund.** Returns some or all of an earlier transaction. The cardholder presents the card.
`transactionDate` is the original's day, `yyyyMMdd`, and is required.

**Inquiry by receipt number.** Reads a transaction. No card, no money; safe to repeat, answered even
while the terminal is busy. The date is optional but narrows the lookup.

**Inquiry by merchant reference.** Reads the attempt you sent as `originalReference`: the way to find a
sale, void or refund that never answered. Leave the date out rather than inventing "today".

**E-receipt (Wi-Fi).** `ReceiptReady.url` goes in a QR code for the customer's phone.

**Close receipt.** Asks the terminal to leave the receipt screen. Call it from the cashier's Close
receipt button when they are done, never automatically. Web Service requires
`originalMerchantReference`, the sale, void or refund being dismissed. Firmware without
`CLOSE_RECEIPT` answers `CloseReceiptRefused`: carry on.

## 7. Read the result

`sale()`, `void()` and `refund()` resolve to an `EcrResult`:

```ts
import { Approved, Declined, Failed } from '@amwalpay/ecr-js';

const result = await session.sale('1.234', reference);
if (result instanceof Approved) {
  record(result);                                   // amount, rrn, authCode, maskedPan
} else if (result instanceof Declined) {
  show(result.reason);
} else if (result instanceof Failed && result.settled()) {
  apply(result.recovered.transaction);              // Wi-Fi found it by itself
} else if (result instanceof Failed && result.failure.outcomeUnknown()) {
  markUnresolved(result.merchantReference);         // section 8
} else if (result instanceof Failed) {
  show(result.failure.message);                     // nothing was sent
}
```

| Failure | `outcomeUnknown()` | What happened |
|---|---|---|
| `Unreachable` | false | No connection was made. Nothing sent. |
| `Busy` | false | Another sale, void or refund is running on this terminal. Nothing sent. |
| `Unresolved` | false | An earlier outcome on this terminal is unknown. Nothing sent. |
| `Timeout` | true | The request went out; no answer in time. |
| `ConnectionLost` | true | The connection broke after the request went out. |
| `Malformed` | true | The answer was unreadable, or (Web Service) the IDs on the config are not numeric and nothing was sent. |
| `Unauthenticated` | true | The answer was not signed with this key or answered another request. |

An answer whose `nextStep` is `INQUIRE_BY_MERCHANT_REFERENCE` (a Hub timeout, `NO_RESPONSE`) arrives
as `Failed` (`Timeout` or `ConnectionLost`), never as `Declined`. An empty or unreadable Hub answer,
an HTTP 5xx with nothing readable, and every network failure is an unknown outcome. An HTTP error
that explains itself is read as the Hub wrote it, as in the Windows SDK.

Inquiries resolve to `Found` (with `transaction`), `NotFound` (with `reason`) or `InquiryFailed`.
`Found` means a record came back, not that money moved: read `transaction.status`
(`isApproved()`, `isDeclined()`). A declined sale the terminal knows is `Found` with status
`Declined`. On `Found`, `transaction.stan` is the receipt number; `canVoid`/`canRefund` say what the
terminal would accept now; with `partialApproval`, `amount` was asked and `authorizedAmount` charged.

## 8. Resolve an unknown outcome

`failure.outcomeUnknown()` means **the payment may have completed.**

1. Save the merchant reference before calling `sale()`, `void()` or `refund()`.
2. Wi-Fi: read `Failed.recovered` first. With `autoInquireOnFailure` on, the SDK already asked once.
   `Found` settles it. `NotFound`, `InquiryFailed` or `null` leaves it unknown.
3. Call `await session.inquireByReference(reference)`.
4. Read `Found.transaction.status`, ignoring case:
   - `Approved`: the attempt completed (for a void or refund: the void or refund completed).
   - `Declined`: it did not. A new attempt needs a **new** reference.
   - Anything else (`Voided`, `Reversed`, ...): leave it unresolved and check with Amwal.
5. `NotFound` after a lost answer means only that this lookup found nothing; the same answer follows a
   terminal reset or an aged-out record. Confirm on the terminal or with Amwal before taking payment
   again.
6. `InquiryFailed`: the lookup itself failed. Inquire again; it moves no money.
7. On start-up, `await session.reconcile()` inquires every attempt still unresolved on that terminal.

The SDK records the outcome of each step (section 9): an `Approved` or `Declined` inquiry settles the
entry; when an operator settles it another way, record how:

```ts
await session.markResolved('ORDER-1001-1', 'Terminal batch report 2026-10-25: not charged (ticket 4711)');
```

## 9. The financial guard

A server handles many requests at once, and may run as several processes, so the rules a desktop
till keeps in memory have to live on disk. The Windows SDK has no guard, so it is off by default;
turn it on with `new EcrConfig({ guardFinancialOperations: true })` and it covers every sale, void
and refund:

| Rule | What the caller sees |
|---|---|
| One financial transaction per terminal at a time (all processes on the machine) | `Failed` + `Busy`, nothing sent |
| A merchant reference is sent to a terminal once | `DuplicateMerchantReferenceException`, nothing sent |
| No new money movement while an earlier outcome is unknown | `Failed` + `Unresolved` listing the references, nothing sent |
| The reference is written down before the request leaves | A process killed mid-wait leaves a `pending` entry that blocks until reconciled |

Inquiries, receipts and close receipt are never blocked. The journal holds references, types, amounts
in minor units and outcomes, never card data or keys. Settled entries are kept 90 days.

```ts
await session.pendingOutcomes();   // JournalEntry[]: reference, type, state, amountMinorUnits, failure, note
await session.reconcile();         // inquire each; resolves to Map<reference, EcrInquiry>
```

- Point `stateDirectory` at a durable folder on a local disk that only the till's service account
  can write (`icacls C:\ProgramData\MyTill\ecr /inheritance:r /grant:r "NT SERVICE\MyTill:(OI)(CI)M"`).
- The terminal lock is a file created exclusively, holding the owner's process id. If that process
  dies, the next caller takes the lock over; a lock held by a live process (or by another host
  name) answers `Busy`.
- Several servers driving the same terminal: implement `TransactionJournal` and `TerminalLock` over
  your database or Redis (methods may return promises), and pass the guard when opening:
  `EcrSessions.open(serial, plan, { guard: new FinancialGuard(journal, lock) })`.
- Leave it off only when your own system enforces the same rules.

## 10. References, receipt numbers, amounts and dates

**Merchant reference.** At most 32 characters of printable ASCII, with space, `&` and `=` excluded;
trimmed. One per attempt; an order number plus an attempt suffix fits (`ORDER-1001-1`). A void and a
refund each get their own. Blank: the SDK generates 12 hex characters and returns it on the result,
but then you cannot save it before sending; prefer `EcrSessions.newMerchantReference()`.

**Receipt number (STAN).** As the Windows SDK: anything that is not a digit is dropped and the rest is
sent padded (`24` → `000024`); only a blank one is refused.
`Approved` does not carry it: read `Found.transaction.stan` from an inquiry by reference, or the
printed receipt. Unique on one terminal for one day.

**Amount.** Major units as a string (`'1.234'`), a number (`5`, or `1.234`, read through its shortest
exact text so `1.005` stays `1.005`), a `bigint` (`5n`), or `Amount.of()` for a value object. Rounded
half away from zero to `minorUnitDigits`, sent as minor units padded to 12 digits, as the Windows
SDK's `decimal`. The amount is not judged: zero and negative amounts are sent and the terminal or Hub
answers them. Only text that is not a number (and `NaN`/`Infinity`) is refused. OMR keeps three
decimals.

**Currency.** `currencyCode` is the ISO 4217 numeric code (`'512'` OMR, `'840'` USD) with
`minorUnitDigits` to match.

**Dates.** `yyyyMMdd`, sent as given. Pass one for a refund; optional for inquiries and receipts.
`EcrTransaction.day()` turns `transactionTime` into one.

## 11. Timeouts and long waits in a Node.js server

| Transport | Wait |
|---|---|
| Wi-Fi | connect 10 s, then answer 120 s. A lost answer can add one more wait for the automatic inquiry. |
| Web Service | one HTTP deadline of connect + answer: **140 s** through `plan()` with the defaults. |

The wait covers card presentation and PIN. Node holds the wait as a promise inside the server
process; nothing ties it to an HTTP request, and nothing should.

- **Keep the payment off the request.** Start it, answer `202` with an id, and let the page poll
  (every 500 ms in the example). A browser, proxy or load balancer that gives up on a long request
  then cannot touch the payment, and a reloaded page finds it again. `examples/server` does exactly
  this.
- **If you do hold a request open**, raise `server.requestTimeout` (default 300 s in Node 18+) and
  every reverse proxy and load balancer idle timeout above 180 s.
- **Never let a process manager kill a waiting payment.** On `SIGTERM`, stop accepting requests
  (`server.close()`), await the payments that are running, then exit; give pm2, the service wrapper
  or the orchestrator a stop timeout above 180 s. A process killed mid-wait leaves an unknown
  outcome: reconcile on start-up.
- **One process per state folder is not required**, but every process that drives the same terminal
  must share the same `stateDirectory` on the same machine, or a shared guard (section 9).
- **Windows Firewall.** Allow outbound TCP to the terminal's port for `node.exe`; set the Wi-Fi
  network profile to Private.

## 12. Keys and logging

**Keys.** Two secrets: the Wi-Fi key signs `secureHash`, the Web Service key signs `secureHashValue`.
`plan.signingKeyLabel()` names the one a plan expects. Keep them out of source control and out of
the browser: environment variables, the Windows Credential Manager/DPAPI, or a secrets vault.
`EcrConfig` keeps its key in a private field, never prints it (`toString()`, `console.log`,
`util.inspect`), and refuses to be serialized (`JSON.stringify(config)` throws `LogicException`).

**Logging.** Off until you pass a logger:

```ts
EcrSessions.open(serial, plan, { logger: EcrLogger.from((line) => console.log(line)) });
EcrSessions.open(serial, plan, { logger: EcrLogger.adapt(pinoLogger) });   // anything with debug(message, context)
```

Lines carry the request and answer payloads (masked PAN, amount, reference) and the signing steps;
the key appears only as `configured`. Every line also passes through a redactor that masks any
Luhn-valid card number and the values of PIN, CVV, track, token and password fields. Treat the log as
a transaction record. An error thrown by your logger escapes the SDK call.

## 13. Building the till's screens

- Offer **Inquire by reference**, never **Retry**, on an unknown outcome. Keep the reference on screen.
- Show a countdown sized to the wait (120 s Wi-Fi, 130 s Web Service); do not impose a shorter one.
- **Close receipt** is its own button on a completed sale, void or refund. Dismissing a dialog does
  not send it.
- On `Approved` with `partialApproval`, show both amounts and collect the difference.
- On start-up, run `reconcile()` and show what is still unresolved.
- In React, `@amwalpay/ecr-react` provides the API client, the POS-style amount field and the hooks
  for terminals, settings and a transaction that runs on the server while the page watches it; see
  its README.
- The example till in `examples/` (Node server + React page) does all of the above; see
  [examples/README.md](../examples/README.md).
