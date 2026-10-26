# Parity with the Windows and PHP SDKs

`@amwalpay/ecr-js` 1.0.0-rc.1 is a port of `amwalpay/ecr-php` 1.0.0-rc.1, which is itself a port of
`AmwalPay.Ecr` 1.0.2 (.NET, <https://github.com/amwal-pay/AmwalpayEcrWindows>). This page lists what
is the same, how names map, and every deliberate difference, so POS-573 (cross-channel parity) can
be checked line by line.

## The same

As in the PHP SDK, and therefore as in the Windows SDK:

- Wi-Fi framing, request fields and field order, nonce, `secureHash` composition and HMAC, answer
  verification and nonce binding, the strict JSON reading rules.
- Web Service paths, body fields and order, `secureHashValue`, the environment-to-Hub mapping.
- Result mapping: unified and legacy envelopes, `errorList` before `message`, `nextStep`
  `INQUIRE_BY_MERCHANT_REFERENCE` → `Failed` (never `Declined`), partial approvals,
  `authorizeAmount` vs `amount`, inquiry "found" meaning a transaction record is present (a declined
  sale is `Found`), Hub flat fields, correlation-only `data` → `NotFound`, receipt and close-receipt
  readers, Web Service inquiry outage → `InquiryFailed`.
- Failure classification: connect failure → `Unreachable` (nothing sent, no inquiry); reset after the
  request → `ConnectionLost` (outcome unknown, inquiry); timeout, malformed, unauthenticated → outcome
  unknown.
- Automatic inquiry by reference after a lost Wi-Fi answer, once, never a resend; never on Web Service.
- Merchant reference rules (32 printable ASCII counted in UTF-16 units, no space, `&`, `=`; trimmed
  with .NET's Unicode `Trim()`; generated as 12 uppercase hex), receipt numbers stripped of
  non-digits and padded to 6, amounts rounded half away from zero to minor units padded to 12 and not
  judged (zero and negative are sent), dates and original terminal IDs sent as given.
- Answers read whatever `version` they declare; a readable Web Service HTTP error envelope (5xx
  included) returned as read; Web Service IDs read as `long.TryParse`; `Malformed` for non-numeric
  IDs and a missing close-receipt reference; Web Service answer wait 130 s through `plan()`
  (140 s deadline), the config as given through the constructor.
- `transactionDateTime` in the machine's local time (`DateTime.Now`); invalid UTF-8 in a Wi-Fi
  answer read as U+FFFD (`Encoding.UTF8.GetString`).
- Key rules (even-length hex, at least 16), plan issues and their wording, `connectionSummary()`.
- Log wording, and the secret logged only as `configured`.
- The opt-in financial guard (off by default in both) and its rules (one money-moving call per
  terminal, a reference used once, no new money movement while an outcome is unknown, the reference
  journalled before sending), with the
  same failures (`Busy`, `Unresolved`), the same `DuplicateMerchantReferenceException` message and
  the same journal file format (`journal-<sha256>.json`, `{ terminal, entries }`).

Verified by porting the PHP tests (which port the .NET tests): the known-answer vectors (Wi-Fi, Web
Service, RFC 4231), the wire-shape strings, and the reading, terminal, recovery, session, config,
guard and channel cases.

## Names

| .NET | PHP | JavaScript |
|---|---|---|
| `SaleAsync(decimal, ...)` | `sale(string\|int\|Amount, ...)` (synchronous) | `sale(string \| number \| bigint \| Amount, merchantReference?)` → `Promise<EcrResult>` |
| `VoidAsync(...)`, `RefundAsync(...)` with named arguments | `void(receiptNumber: ..., merchantReference: ...)` | `void(receiptNumber, { originalTerminalId?, merchantReference? })` |
| `EcrResult.Approved` / `.Declined` / `.Failed` | `Result\Approved` / `Declined` / `Failed` | `Approved` / `Declined` / `Failed` |
| `EcrInquiry.Found` / `.NotFound` / `.Failed` | `Result\Found` / `NotFound` / `InquiryFailed` | `Found` / `NotFound` / `InquiryFailed` |
| `EcrReceipt.Ready` / `.Unavailable` / `.Failed` | `ReceiptReady` / `ReceiptUnavailable` / `ReceiptFailed` | same as PHP |
| `EcrReceiptClosed.Idle` / `.Refused` / `.Failed` | `ReceiptClosed` / `CloseReceiptRefused` / `CloseReceiptFailed` | same as PHP |
| `Failure.OutcomeUnknown` | `Failure::outcomeUnknown()` | `failure.outcomeUnknown()` |
| `Failed.Settled`, `Failed.Recovered` | `settled()`, `$recovered` | `settled()`, `recovered` |
| `EcrLink.Lan`, `EcrLink.WebService` | `Link\LanLink`, `Link\WebServiceLink` | `LanLink`, `WebServiceLink` |
| `IEcrChannel`, `EcrChannelTimeout` | `Channel\EcrChannel`, `Channel\EcrChannelTimeout` | `EcrChannel` (interface), `EcrChannelTimeout` |
| `EcrWebServiceRequestJson.*` | `WebService\WebServiceRequests::*` | `WebServiceRequests.*({ ... })` |
| `IEcrLogger`, `EcrLogger.From` | `Log\EcrLogger`, `EcrLogger::from()` / `::psr()` | `EcrLogger`, `EcrLogger.from()` / `.adapt()` |
| `EcrConfig` record with `with` | `new EcrConfig(name: value)`, `->with(...)` | `new EcrConfig({ ... })`, `.with({ ... })` |
| `TimeSpan` | seconds (`float`) | seconds (`number`) |
| `ArgumentException` | `InvalidArgumentException` (`Exception\InvalidRequestException`) | `InvalidArgumentException` (`InvalidRequestException`) |
| `CancellationToken` | none | none |
| — | `toArray()` | `toJSON()` (so `JSON.stringify(result)` works) |
| — | `reconcile(): array<string, EcrInquiry>` | `reconcile(): Promise<Map<string, EcrInquiry>>` |
| — | `EcrWebServiceTerminal::id(): ?int` | `EcrWebServiceTerminal.id(): bigint \| null` |
| — | `CurlHttpTransport` | `NodeHttpTransport` |
| — | `TransactionJournal`, `TerminalLock` (synchronous) | the same interfaces; each method may return a value or a promise |

## Deliberate differences

Behaviour, results and wording follow the Windows SDK, including its leniency (see "The same").
What remains different comes from the runtime, or is an opt-in that is off by default.

### Inherited from the PHP SDK (differences from .NET)

| # | Difference | Why |
|---|---|---|
| 1 | **Financial guard, opt-in** (`guardFinancialOperations: true`): cross-process terminal lock, reference journal, block while unknown, with failures `Busy`, `Unresolved` and `DuplicateMerchantReferenceException`. Off by default, so results match .NET. | A server runs many requests at once, and several processes may drive one terminal; a till that wants these rules needs them on disk. |
| 2 | **Timeouts must be positive; `timezone` is an optional override** (null, the default, is the machine's zone as .NET). | A socket cannot wait a negative time. |
| 3 | **Log lines are redacted** (Luhn-valid PANs, PIN/CVV/track/token/password fields). | Second line of defence; never changes a result. |
| 4 | **`EcrConfig` cannot be serialized** and does not show its key. | Secrets must never leak through caches, sessions or error pages. |
| 5 | **No USB/cable link, no cancellation token.** | Out of scope. |
| 6 | **`Failure.Invalid` still exists** but is no longer produced. | Results stored by earlier builds still read. |

### Specific to JavaScript (differences from PHP)

| # | Difference | Why |
|---|---|---|
| 7 | **Every operation is async** and returns a `Promise`. | Node's sockets and HTTP are asynchronous; the .NET SDK is async too. |
| 8 | **Optional arguments are options objects** (`void(receipt, { originalTerminalId, merchantReference })`, `session.closeReceipt({ merchantReference, originalMerchantReference })`, `EcrSessions.open(serial, plan, { logger, httpTransport, guard })`). | JavaScript has no named arguments; two adjacent string parameters are easy to swap. |
| 9 | **Amounts are `string`, `number`, `bigint` or `Amount`**, read as exact decimal text (a fractional number through `String(n)`, its shortest round-trip form); text that is not a number, `NaN` and `Infinity` throw `InvalidRequestException`. | No `decimal` type; .NET cannot be handed a value that is not a number. |
| 10 | **`Amount.toMinorUnits()` returns a `bigint`** and throws `OverflowException` beyond 64 bits (.NET's `checked` cast). | A JavaScript number loses precision above 2⁵³. |
| 11 | **Text must be well-formed UTF-16** (no lone surrogates), or `InvalidArgumentException` before sending. | `Json.write` cannot encode a lone surrogate as UTF-8; .NET would replace it. |
| 12 | **No `extendTimeLimit`, `ignore_user_abort` or `max_execution_time`.** `FinancialGuard.run()` takes no time budget. | A Node server process is long-lived, and a payment wait is a promise, not tied to an HTTP request. Keep it off the request (see the integration guide, section 11). |
| 13 | **The terminal lock and the journal's write lock are files created exclusively (`wx`) holding the owner's pid, host and a token.** A lock whose owner process on this host is gone is taken over as stale; an unreadable lock file older than 10 s is stale; a lock from another host name is never taken over. | Node has no `flock`, so the OS cannot release a lock when a process dies (PHP's `flock` is released by the OS). The state folder must be on a local disk. |
| 14 | **`caBundlePath` is a PEM file added to Node's own trust store** (`tls.rootCertificates` plus the file). `NODE_EXTRA_CA_CERTS` works too. | Node ships Mozilla's roots, so a bundle is needed only for a private CA or a TLS-inspecting proxy (PHP on Windows often has no bundle at all). |
| 15 | **The machine's time zone is Node's own** (`Intl`, `EcrSdk.localTimeZone()` returns its IANA name); nothing has to be detected, unlike PHP, which must look past php.ini's `date.timezone`. The `TZ` environment variable overrides it for the process. `timezone` takes zone names only, not offsets such as `+04:00`. | Node already stamps in the operating system's zone. |
| 16 | **`EcrConfig` keeps its key in a private field** (`#secureHashKey`: not enumerable, not copied by spread or `structuredClone`), shows `<redacted>` in `toString()` and `util.inspect`/`console.log`, and `toJSON()` throws `LogicException`. | The counterparts of PHP's `__debugInfo`, `#[SensitiveParameter]` and `__serialize` throwing. |
| 17 | **Web Service IDs are `bigint`** (`EcrWebServiceTerminal.id()`), within the signed 64-bit range. | A JavaScript number loses precision above 2⁵³. |
| 18 | **HTTPS with Node's `https` module** (`NodeHttpTransport`) instead of cURL; one fresh connection per call (`agent: false`), no redirects, no proxy unless your own `HttpTransport` adds one. | No native dependency. |
| 19 | **The JSON reader validates bytes as strict UTF-8** with `TextDecoder({ fatal: true })` and refuses a BOM (a Wi-Fi answer is first decoded leniently, invalid bytes becoming U+FFFD, as .NET); JSON strings are written with PHP's escapes byte for byte. | Same reading as PHP's, same bytes on the wire. |
| 20 | **`Failed.settled()` and `EcrResult.isApproved()` are TypeScript type guards.** | Narrowing in `if` chains; no behaviour change. |
