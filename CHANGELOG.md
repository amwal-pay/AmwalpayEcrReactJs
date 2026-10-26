# Changelog

Notable changes to `@amwalpay/ecr-js` and `@amwalpay/ecr-react`. The format follows Keep a
Changelog 1.1.0 and the packages use semantic versioning. Pin an exact version and read the entry
before you upgrade.

## 1.0.0-rc.1 (2026-10-25)

### Fixed (2026-10-26)

- `transactionDateTime` (and Web Service `requestDateTime`) is documented and tested as the
  machine's local time, as the Windows SDK's `DateTime.Now`. `EcrConfig` `timezone` still
  overrides it; `EcrSdk.localTimeZone()` shows the zone read. (Node already uses the operating
  system's zone, so the PHP SDK's php.ini problem does not arise here.)

### Changed (2026-10-26): behaviour matches `AmwalPay.Ecr` 1.0.2 (.NET)

Ported from `amwalpay/ecr-php` (same date).

- **The financial guard is opt-in** (`guardFinancialOperations: false` by default), as the Windows
  SDK has none. Turn it on to keep `Busy`, `Unresolved` and `DuplicateMerchantReferenceException`.
- Amounts accept fractional numbers (read through their shortest exact text); zero, negative and
  over-12-digit amounts are sent as the Windows SDK sends them. Only text that is not a number, and
  `NaN`/`Infinity`, is refused. `Amount.MAX_MINOR_UNITS` is removed; `Amount.toMinorUnits()` now
  returns a `bigint` and throws the new `OverflowException` beyond 64 bits; `minorUnitsText()` added.
- Receipt numbers drop stray characters (any Unicode decimal digit is kept) and are padded, dates
  and the original terminal ID are sent as given, a refund does not require a date; only a blank
  receipt number is refused.
- Answers are read whatever `version` they declare.
- Web Service: a readable HTTP error envelope (5xx included) is returned as read; a refused inquiry
  reads as the Windows SDK reads it; non-numeric IDs and a missing close-receipt reference are
  `Malformed` (not `Invalid`); IDs are read as `long.TryParse`; answer wait 130 s via `plan()`
  (140 s deadline), the config as given via the constructor.
- `EcrConfig` no longer checks `currencyCode`; `WEB_SERVICE_CLIENT_TIMEOUT` is removed and
  `WEB_SERVICE_RESPONSE_TIMEOUT` is 130 s. Plans no longer reject a host with a scheme or path,
  `open()` accepts a blank serial, and `TcpEcrChannel` accepts an empty host.
- .NET string rules: Unicode `Trim()` for references, environment names and error lists; any decimal
  digit kept in a receipt number; invalid UTF-8 in a Wi-Fi answer becomes U+FFFD instead of a
  malformed answer, and an unreadable answer is quoted in full. A Wi-Fi request over 65 535 bytes is
  refused before sending.
- Example: the countdown is the configured response timeout (120 s Wi-Fi, 130 s Web Service).

First release candidate, for SIT only. Not for production until code review, security review,
SIT evidence and release approval are complete (see [docs/release.md](docs/release.md)).

### Added

- `@amwalpay/ecr-js`, a port of `amwalpay/ecr-php` 1.0.0-rc.1 for Node.js 18.18 and later, with the
  same protocol, signing, result semantics and payment-safety rules as `AmwalPay.Ecr` 1.0.2 (.NET).
  The same known-answer vectors pass.
- Wi-Fi/LAN ECR over TCP with the terminal's framing (2-byte big-endian length + UTF-8 JSON),
  HMAC-SHA256 request signing with a 128-bit nonce, and answer verification bound to that nonce.
- ECR Web Service (Amwal Hub, POS-552 contract) for SIT, UAT and PROD: `secureHashValue` signing,
  `/Ecr/Sale`, `/Ecr/Void`, `/Ecr/Refund`, `/Ecr/Inquiry`, `/Ecr/closeReceipt`.
- Operations: sale, void, refund, inquiry by receipt number, inquiry by merchant reference,
  e-receipt (Wi-Fi), close receipt, reachability probe (Wi-Fi).
- Results with the Windows SDK's semantics: `Approved`, `Declined`, `Failed` (with
  `Failure.outcomeUnknown()`), `Found`, `NotFound`, `InquiryFailed`, and the receipt and
  close-receipt families.
- `EcrSessions.plan()` / `open()`, `EcrConfig` validated on construction, `EcrLogger` with
  PAN/PIN/CVV redaction on every line.
- Financial guard (opt-in since the parity change above): one sale, void or refund per terminal at a time across
  processes (`Busy`), each merchant reference used once (`DuplicateMerchantReferenceException`),
  no new money movement while an outcome is unknown (`Unresolved`), `reconcile()` and
  `markResolved()` to settle them.
- `@amwalpay/ecr-react`: an API client for the till's server, `EcrProvider`, hooks for meta,
  terminals, settings, the config card, a server-run transaction (start, poll, cancel, inquire,
  receipt, close receipt, acknowledge), the countdown and the debug log, and the POS-style
  `AmountInput`.
- Example: the Node.js and React port of the Amwal ECR web sample (same page, same 21-route API,
  same Core rules and wording), plus Wi-Fi and Web Service quickstart scripts, installing both
  packages from their built artifacts; signed fake terminal (`tools/fake-pos-server.mjs`).

### Not included

- Manual settlement: blocked until the POS-599 contract is final and versioned.
- USB/cable and Bluetooth transports.
