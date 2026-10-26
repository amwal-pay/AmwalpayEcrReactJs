# @amwalpay/ecr-js API reference

This page lists the public API of the npm package `@amwalpay/ecr-js` (ESM, Node.js >= 18.18,
TypeScript types included). The package connects a merchant's till server to an Amwal POS terminal,
either over Wi-Fi/LAN or through the Amwal Hub (ECR Web Service). For every export of the package
root it gives the TypeScript signature, what it returns and what it throws. Modules under
`internal/` that the root does not export, and anything marked `@internal`, are not API and can
change without notice.

```ts
import { EcrSessions, EcrConfig, LanLink, Approved, Declined, Failed } from '@amwalpay/ecr-js';
```

> **Amounts are major units**: a decimal string (`'1.234'`), a number (`5`, `1.234`), a `bigint`
> (`5n`) or an `Amount`, rounded like the Windows SDK's `decimal`. A fractional number is read
> through its shortest exact text, so `1.005` stays `1.005`. Only text that is not a number (and
> `NaN` or `Infinity`) is refused with `InvalidRequestException`.

> **Every operation is asynchronous.** Methods that talk to a terminal or the Hub return a
> `Promise`. Results describe what happened; an exception means the call was refused before
> anything was sent.

## Contents

- [Sessions](#sessions): `EcrSessions`, `EcrSessionPlan`, `EcrOpenedSession`
- [Configuration](#configuration): `EcrConfig`, `EcrEnvironment`, `EcrSdk`, `Amount`
- [Links](#links): `EcrLink`, `LanLink`, `WebServiceLink`
- [Terminals](#terminals): `EcrTerminal`, `EcrWebServiceTerminal`, `EcrReachability`
- [Results](#results): `EcrResult`, `EcrInquiry`, `EcrReceipt`, `EcrReceiptClosed` families, `EcrTransaction`, `NextStep`
- [Failures](#failures): `Failure` and its subclasses
- [Exceptions](#exceptions)
- [Safety](#safety): `FinancialGuard`, `JournalEntry`, `TransactionJournal`, `FileTransactionJournal`, `TerminalLock`, `FileTerminalLock`
- [Logging](#logging): `EcrLogger`, `Redactor`
- [Channel](#channel): `EcrChannel`, `TcpEcrChannel`, `EcrFrames`, `EcrIOException`, `EcrChannelTimeout`
- [Web Service](#web-service): `WebServiceRequests`, `WebServiceSecureHash`, `WebServiceRoutes`, `WebServiceOperation`, `WebServiceApi`, HTTP transport
- [EcrWireResponse](#ecrwireresponse)
- [EcrTransactionType](#ecrtransactiontype)
- [Json (supporting types)](#json-supporting-types)

---

## Sessions

The way in. Validate a link and its credentials into a plan, then open one session for that plan. The session handles every operation the same way over Wi-Fi and Web Service.

### `EcrSessions`

```ts
class EcrSessions {
  static plan(link: EcrLink, config: EcrConfig, rawSecureHashKey?: string | null): EcrSessionPlan;
  static open(terminalSerial: string, plan: EcrSessionPlan, options?: OpenOptions): EcrOpenedSession;
  static lanTerminal(terminalSerial: string, plan: EcrSessionPlan, options?: Omit<OpenOptions, 'httpTransport'>): EcrTerminal;
  static webServiceTerminal(terminalSerial: string, plan: EcrSessionPlan, options?: OpenOptions): EcrWebServiceTerminal;
  static newMerchantReference(): string;
}

interface OpenOptions {
  logger?: EcrLogger | null;              // default EcrLogger.none()
  httpTransport?: HttpTransport | null;   // Web Service only; default NodeHttpTransport
  guard?: FinancialGuard | null;          // default FinancialGuard.fromConfig(plan.config, logger)
}
```

| Method | Returns | Notes |
|---|---|---|
| `plan()` | `EcrSessionPlan` | Validates `link` and `config` without opening a connection. Problems come back as the plan's `issues()` instead of exceptions, so a settings screen can show what is missing. `rawSecureHashKey` is the key as the operator typed it: it is trimmed and checked here, and defaults to the config's key. For a `LanLink`, the link's port replaces the config's port. For a `WebServiceLink`, the merchant and terminal IDs are copied into the config. If the response timeout is still the Wi-Fi default, it becomes `EcrConfig.WEB_SERVICE_RESPONSE_TIMEOUT` (130 s). Hosts and IDs are kept as given; an ID is numeric when `long.TryParse` would read it (surrounding white space and a sign are allowed). A missing signing key is reported as an issue. Throws `InvalidArgumentException` only for a link type it does not support. |
| `open()` | `EcrOpenedSession` | Opens the transport the plan describes. There is one dispatch for Wi-Fi and Web Service, so sale, inquiry and recovery always build the same client. `terminalSerial` is the terminal's serial number as registered. **Throws** `InvalidArgumentException` if the plan has issues. The serial is sent as given. Opening connects to nothing. |
| `lanTerminal()` | `EcrTerminal` | Builds the Wi-Fi terminal directly. Throws `InvalidArgumentException` if the plan is not for Wi-Fi. |
| `webServiceTerminal()` | `EcrWebServiceTerminal` | Builds the Web Service terminal directly. Throws `InvalidArgumentException` if the plan is not for Web Service. |
| `newMerchantReference()` | `string` | A fresh merchant reference in the SDK's own format: 12 uppercase hex characters. Generate it, save it with the order, then send it. |

```ts
import { EcrConfig, EcrSessions, LanLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(
  new LanLink('192.168.1.50'),
  new EcrConfig({ ecrId: 'TILL-01', secureHashKey: wifiKey }),
);
if (!plan.isReady()) throw new Error(plan.issues().join('\n'));
const session = EcrSessions.open('SN-WIFI-0001', plan);
```

### `EcrSessionPlan`

A validated configuration for one terminal link, built by `EcrSessions.plan()` so the app does not have to repeat transport rules. `issues()` lists what is wrong. An empty list means the plan can be opened.

```ts
class EcrSessionPlan {
  constructor(link: EcrLink, config: EcrConfig, issues?: readonly string[]);
  readonly link: EcrLink;
  readonly config: EcrConfig;
  issues(): string[];
  isReady(): boolean;
  usesLan(): boolean;
  usesWebService(): boolean;
  signingKeyLabel(): string;
  signingKeyConfigured(): boolean;
  connectionSummary(): string;
}
```

- `issues()`: what is wrong with this plan (a copy); empty when it can be opened. Duplicates are removed.
- `isReady()`: `true` when `issues()` is empty.
- `usesLan()` / `usesWebService()`: which kind of link the plan uses.
- `signingKeyLabel()`: which of the two secrets this plan expects: `Wi-Fi/CABLE secure hash key` or `Web Service secure hash key`.
- `signingKeyConfigured()`: whether the resolved config has a key.
- `connectionSummary()`: a summary for the operator that never contains a secret, e.g. `192.168.1.50:9100` or `UAT · merchant 10001 · terminal 20002`. Throws `LogicException` for a link type it does not support.

The plan issues, word for word:

| Issue | When |
|---|---|
| `Secure hash key must be an even-length hex string of at least 16 characters` | The typed key is not empty and not valid. |
| `IP address is required for Wi-Fi ECR` | Blank host. |
| `Port must be between 1 and 65535 (default 9100)` | The link's port is not an integer in range. |
| `Merchant ID is required for Web Service` / `Merchant ID must be numeric` | Blank merchant ID, or one `long.TryParse` would not read. |
| `Terminal ID is required for Web Service` / `Terminal ID must be numeric` | Blank terminal ID, or one `long.TryParse` would not read. |
| `<key label> is not configured` | No valid key for this link. |

### `EcrOpenedSession`

One opened transport for a validated plan. Every sale, void, refund, inquiry, e-receipt and close receipt for that terminal goes through it, the same way over Wi-Fi and Web Service. Get one from `EcrSessions.open()`. The constructor is `@internal`.

```ts
type Money = string | number | bigint | Amount;

interface OriginalOptions {
  originalTerminalId?: string;   // the terminal the original was taken on (Wi-Fi only)
  merchantReference?: string;    // this request's own reference; blank: generated
}

class EcrOpenedSession {
  readonly plan: EcrSessionPlan;

  usesWebService(): boolean;
  usesLocalTerminal(): boolean;
  supportsReceipt(): boolean;
  lanTerminal(): EcrTerminal | null;
  webServiceTerminal(): EcrWebServiceTerminal | null;
  probeReachability(): Promise<EcrReachability | null>;

  sale(amount: Money, merchantReference?: string): Promise<EcrResult>;
  void(receiptNumber: string, options?: OriginalOptions): Promise<EcrResult>;
  refund(amount: Money, receiptNumber: string, transactionDate: string, options?: OriginalOptions): Promise<EcrResult>;
  inquire(receiptNumber: string, transactionDate: string, options?: { originalTerminalId?: string }): Promise<EcrInquiry>;
  inquireByReference(originalReference: string, options?: OriginalOptions & { transactionDate?: string }): Promise<EcrInquiry>;
  receipt(receiptNumber: string, transactionDate: string, options?: { originalTerminalId?: string }): Promise<EcrReceipt>;
  closeReceipt(options?: { merchantReference?: string; originalMerchantReference?: string }): Promise<EcrReceiptClosed>;

  terminalKey(): string;
  guard(): FinancialGuard;
  pendingOutcomes(): Promise<JournalEntry[]>;
  reconcile(): Promise<Map<string, EcrInquiry>>;
  markResolved(merchantReference: string, note: string): Promise<JournalEntry>;
}
```

| Method | Resolves to | Notes |
|---|---|---|
| `usesWebService()` / `usesLocalTerminal()` | `boolean` | Which transport the session uses. |
| `supportsReceipt()` | `boolean` | Receipt URLs exist only on Wi-Fi. |
| `lanTerminal()` | `EcrTerminal \| null` | The Wi-Fi terminal behind the session, or `null` on Web Service. |
| `webServiceTerminal()` | `EcrWebServiceTerminal \| null` | The Web Service terminal behind the session, or `null` on Wi-Fi. |
| `probeReachability()` | `EcrReachability \| null` | Checks before a sale whether the Wi-Fi port answers. Always `null` on Web Service, because the Hub has no probe. |
| `sale()` | `EcrResult` | `amount` is in major units: a string such as `'1.234'`, a number or a `bigint`. `merchantReference` is this attempt's own reference: save it before calling. |
| `void()` | `EcrResult` | `originalTerminalId` is used on Wi-Fi only; Web Service uses the terminal in the plan. |
| `refund()` | `EcrResult` | `transactionDate` is the original transaction's day as `yyyyMMdd`. `originalTerminalId` is used on Wi-Fi only. |
| `inquire()` | `EcrInquiry` | Looks up a transaction by receipt number and date. `originalTerminalId` is used on Wi-Fi only. |
| `inquireByReference()` | `EcrInquiry` | Reads the attempt you sent as `originalReference`. Use it to get the result of a sale, void or refund that never answered. `originalTerminalId` is used on Wi-Fi only; `merchantReference` is the inquiry's own. |
| `receipt()` | `EcrReceipt` | Wi-Fi only. On Web Service it resolves to `ReceiptUnavailable` ("Receipt fetch is only supported over Wi‑Fi and USB cable ECR", the Windows SDK's wording). |
| `closeReceipt()` | `EcrReceiptClosed` | Asks the terminal to put its receipt away and return to idle. Call it from the till's Close receipt action, never automatically. `merchantReference` is this close request's own ID; when blank, one is generated. `originalMerchantReference` is the sale, void or refund being dismissed; Web Service requires it and Wi-Fi ignores it. On Web Service, if only `merchantReference` is given, it is used as the original and the SDK generates the close request's own ID. If neither is given, the result is `CloseReceiptFailed` with a `Malformed` failure. |
| `terminalKey()` | `string` | Identifies this terminal to the guard's lock and journal. |
| `guard()` | `FinancialGuard` | The guard the terminal uses. |
| `pendingOutcomes()` | `JournalEntry[]` | Sales, voids and refunds on this terminal whose outcome is still unknown, oldest first. While any are listed, a new money-moving call resolves to `Failed` with `Unresolved`. |
| `reconcile()` | `Map<string, EcrInquiry>` | Inquires by reference, one after another, for every unknown outcome on this terminal and lets the answers settle what they can. The map is keyed by the original merchant reference. Run it at start-up and after a failure. It is safe to repeat, because an inquiry moves no money. |
| `markResolved()` | `JournalEntry` | Settles an unknown outcome by hand once it has been confirmed on the terminal or with Amwal, for example an inquiry that keeps answering "not found". `note` records how it was confirmed. Rejects with `InvalidArgumentException` if no transaction with that reference was sent to this terminal, or if the note is blank; with `LogicException` if the guard is off. |

Money-moving calls (`sale`, `void`, `refund`) reject with `InvalidRequestException` when a request cannot be built, and nothing is sent in that case. With the guard enabled they also reject with `DuplicateMerchantReferenceException` (see [Safety](#safety)). `inquireByReference()` rejects with `InvalidRequestException` if `originalReference` is blank or malformed.

```ts
import { Found, InquiryFailed, NotFound } from '@amwalpay/ecr-js';

for (const [reference, inquiry] of await session.reconcile()) {
  if (inquiry instanceof Found) {
    // inquiry.transaction.status says what became of it (Approved, Declined, ...).
    await updateOrder(reference, inquiry.transaction);
  } else if (inquiry instanceof NotFound) {
    // Not proof that nothing was charged. Confirm on the terminal or with Amwal, then:
    // await session.markResolved(reference, 'Confirmed on the terminal transaction list');
  } else if (inquiry instanceof InquiryFailed) {
    // Nothing was learned. Run reconcile() again later.
  }
}
```

---

## Configuration

### `EcrConfig`

Defines how this ECR identifies itself and how it talks to a terminal. The object is frozen. Invalid values are refused when the config is built, so a key with a stray space fails at start-up instead of showing up later as a decline the cashier cannot explain. Timeouts are in seconds. The defaults describe an Omani deployment (OMR, three decimals) on the standard port.

```ts
interface EcrConfigOptions {
  ecrId?: string;
  currencyCode?: string;
  minorUnitDigits?: number;
  port?: number;
  connectTimeout?: number;
  responseTimeout?: number;
  probeTimeout?: number;
  secureHashKey?: string | null;
  merchantId?: string;
  terminalId?: string;
  environment?: EcrEnvironment;
  autoInquireOnFailure?: boolean;
  guardFinancialOperations?: boolean;
  stateDirectory?: string | null;
  caBundlePath?: string | null;
  timezone?: string | null;
}

class EcrConfig {
  static readonly DEFAULT_PORT = 9100;
  static readonly DEFAULT_RESPONSE_TIMEOUT = 120;
  static readonly DEFAULT_CONNECT_TIMEOUT = 10;
  static readonly WEB_SERVICE_RESPONSE_TIMEOUT = 130;

  constructor(options?: EcrConfigOptions);

  readonly ecrId: string;
  readonly currencyCode: string;
  readonly minorUnitDigits: number;
  readonly port: number;
  readonly connectTimeout: number;
  readonly responseTimeout: number;
  readonly probeTimeout: number;
  readonly merchantId: string;
  readonly terminalId: string;
  readonly environment: EcrEnvironment;
  readonly autoInquireOnFailure: boolean;
  readonly guardFinancialOperations: boolean;
  readonly stateDirectory: string | null;
  readonly caBundlePath: string | null;
  readonly timezone: string | null;
  get secureHashKey(): string;

  with(changes: EcrConfigOptions): EcrConfig;
  signsMessages(): boolean;
  static isValidSecureHashKey(key: string | null | undefined): boolean;
  toString(): string;
  toJSON(): never;
}
```

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_PORT` | `9100` | The port Amwal POS terminals listen on for ECR requests. |
| `DEFAULT_RESPONSE_TIMEOUT` | `120` | Wi-Fi wait for the terminal's answer: card present plus PIN. |
| `DEFAULT_CONNECT_TIMEOUT` | `10` | Connect wait. |
| `WEB_SERVICE_RESPONSE_TIMEOUT` | `130` | The answer wait `EcrSessions.plan()` gives a Web Service link when the caller left the Wi-Fi default (`EcrConfig.WebServiceResponseTimeout` in the Windows SDK). With the default connect timeout, the HTTP deadline is 140 s. |

| Option | Type | Default | Meaning |
|---|---|---|---|
| `ecrId` | `string` | `'ECR01'` | Identifies this cash register to the terminal and on its records. |
| `currencyCode` | `string` | `'512'` | ISO 4217 numeric code: `512` for OMR. Sent as given. |
| `minorUnitDigits` | `number` | `3` | Decimal places the currency has (integer 0 to 4): 3 for OMR, 2 for USD. |
| `port` | `number` | `9100` | The terminal's ECR listener port (integer 1 to 65535). |
| `connectTimeout` | `number` | `10` | Seconds to wait for the terminal (or the Hub) to accept a connection. |
| `responseTimeout` | `number` | `120` | Seconds to wait for the result once the request is sent. |
| `probeTimeout` | `number` | `3` | Seconds a reachability probe waits. |
| `secureHashKey` | `string \| null` | `''` | The signing secret, as hex. Wi-Fi and Web Service use different secrets. It must be empty or an even-length hex string of at least 16 characters. Empty sends unsigned messages. |
| `merchantId` | `string` | `''` | Backend merchant ID, for Web Service. |
| `terminalId` | `string` | `''` | Backend terminal ID, for Web Service. |
| `environment` | `EcrEnvironment` | `EcrEnvironment.SIT` | Hub deployment for Web Service. |
| `autoInquireOnFailure` | `boolean` | `true` | After a lost Wi-Fi answer, sends one inquiry by merchant reference. |
| `guardFinancialOperations` | `boolean` | `false` | Opt-in (the Windows SDK has no guard). Allows one money-moving call per terminal at a time, requires unique references, and blocks new money movement while an earlier outcome is unknown. See `FinancialGuard`. |
| `stateDirectory` | `string \| null` | `null` | Where the guard keeps its locks and journal. `null` uses `amwalpay-ecr` under `os.tmpdir()`. Use a durable, private folder on a local disk in production. |
| `caBundlePath` | `string \| null` | `null` | A PEM file of CA certificates for the Web Service TLS check, added to Node's own trust store (for a private CA or a TLS-inspecting proxy). |
| `timezone` | `string \| null` | `null` | IANA time zone for `transactionDateTime`, e.g. `Asia/Muscat`. `null` uses the machine's local time (the operating system's time zone, as the Windows SDK's `DateTime.Now`; `EcrSdk.localTimeZone()` names it). Set it only to override the machine. Offsets such as `+04:00` are refused. |

**Throws** `InvalidArgumentException` for any value outside the rules above, including timeouts that are not positive and finite and an `environment` that is not an `EcrEnvironment`.

- `with(changes)`: returns a copy with some values changed, validated like the constructor, e.g. `config.with({ responseTimeout: 60, ecrId: 'TILL-02' })`. Throws `InvalidArgumentException` (`EcrConfig has no setting named …`) for an unknown option name.
- `secureHashKey`: the key, as hex, or `''`. Kept in a private field: not enumerable, not copied by spread or `structuredClone`.
- `signsMessages()`: whether this till signs what it sends (the key is not empty).
- `isValidSecureHashKey(key)`: whether `key` is acceptable: `null`, `undefined`, empty, or even-length hex of at least 16 characters.
- `toString()` and `util.inspect` / `console.log`: never show the secret. They print `<redacted>` or `empty` in its place.
- `toJSON()`: always throws `LogicException` (`EcrConfig holds a signing secret and cannot be serialized`). A config is never written to sessions, caches or queues.

### `EcrEnvironment`

The deployment environment for Web Service ECR. The SDK resolves the Amwal Hub address itself; you pass only this value in `EcrConfig.environment`.

```ts
class EcrEnvironment {
  static readonly SIT: EcrEnvironment;
  static readonly UAT: EcrEnvironment;
  static readonly PROD: EcrEnvironment;
  static readonly DEFAULT: EcrEnvironment;   // SIT
  readonly value: 'SIT' | 'UAT' | 'PROD';

  static cases(): EcrEnvironment[];
  static tryFrom(value: string): EcrEnvironment | null;
  static fromName(name: string | null | undefined): EcrEnvironment;
  toString(): string;
  toJSON(): string;
}
```

- `tryFrom()`: the environment with exactly this value, or `null`.
- `fromName()`: reads an environment by name, ignoring case and surrounding spaces. Unknown names read as `SIT`.
- Instances are singletons: compare with `===`.

### `EcrSdk`

Facts about this build of the SDK, for logs and support tickets.

```ts
class EcrSdk {
  static readonly VERSION = '1.0.0-rc.1';
  static readonly PROTOCOL_VERSION = 1;
  static readonly PARITY_WITH = 'AmwalPay.Ecr 1.0.2 (.NET)';
  static readonly PORT_OF = 'amwalpay/ecr-php 1.0.0-rc.1';
  static readonly MINIMUM_NODE = '18.18.0';

  static localTimeZone(): string;
}
```

- `VERSION`: the package version, kept in step with the Git tag, both `package.json` files and `CHANGELOG.md`.
- `PROTOCOL_VERSION`: the ECR message format this SDK writes and reads (`version` on the wire).
- `PARITY_WITH`: the Windows SDK release whose behaviour this one matches.
- `PORT_OF`: the PHP SDK this package is a line-for-line port of.
- `MINIMUM_NODE`: the lowest supported Node.js version.
- `localTimeZone()`: the machine's IANA time zone (e.g. `Asia/Muscat`), which `transactionDateTime` uses when `EcrConfig.timezone` is `null`. Node reads it from the operating system unless the `TZ` environment variable overrides it.

### `Amount`

Money as exact decimal text: the JavaScript stand-in for the Windows SDK's `decimal`. Amounts enter as strings (`'1.234'`), numbers (`5`, `1.234`, a fractional one read through its shortest exact text) or `bigint`s (`5n`). The SDK rounds half away from zero to the currency's decimal places, then sends minor units: `'1.234'` OMR travels as `000000001234`. As in the Windows SDK, the amount itself is not judged: zero and negative amounts are sent as they are, and the terminal or the Hub answers them.

```ts
class Amount {
  readonly decimal: string;

  static of(amount: string | number | bigint | Amount): Amount;
  static fromMinorUnits(minorUnits: number | bigint, digits: number): Amount;
  toMinorUnits(digits: number): bigint;
  toWire(digits: number): string;
  minorUnitsText(digits: number): string;
  format(digits: number): string;
  toString(): string;
  toJSON(): string;
  static majorUnits(minorUnits: string, digits: number): string;
}
```

| Member | Returns | Notes |
|---|---|---|
| `of(amount)` | `Amount` | An amount in major units, e.g. `Amount.of('1.234')`. Text may carry a sign and an exponent (`'-1'`, `'1e3'`); `'.5'` reads as `0.5`. A fractional number is read through `String(n)`, its shortest exact text. Throws `InvalidRequestException` for text that is not a number (separators, currency signs, empty) and for `NaN` or `Infinity`. |
| `fromMinorUnits(minorUnits, digits)` | `Amount` | An amount already in minor units: `Amount.fromMinorUnits(1234, 3)` is `1.234`. Throws `InvalidRequestException` for a number that is not a safe integer. |
| `toMinorUnits(digits)` | `bigint` | Minor units for a currency with `digits` decimal places, rounded half away from zero, as the Web Service carries them (a 64-bit integer; may be zero or negative). **Throws** `OverflowException` ("Arithmetic operation resulted in an overflow.") when it does not fit 64 bits, as .NET's `checked` cast. |
| `toWire(digits)` | `string` | Minor units padded to 12 characters, as the Wi-Fi message carries them (ISO 8583 field 4). Like the Windows SDK, longer or negative values are padded as text and not refused: `-1` at 3 digits is `0000000-1000`. |
| `minorUnitsText(digits)` | `string` | The rounded minor units written as an integer: `-1234`, `0`, `1234567890123`. |
| `format(digits)` | `string` | The amount rounded to `digits` places, e.g. `1.234`. |
| `toString()` / `toJSON()` | `string` | The decimal text as given. |
| `majorUnits(minorUnits, digits)` | `string` | Reads minor units from the wire as major units: `000000000365` is `0.365` with three decimals. Text that is not an integer is returned unchanged, because a terminal that sends `1.234` is already reporting major units. |

---

## Links

A link says how this till reaches a POS terminal. The app supplies addresses and backend IDs; the SDK handles the protocol, signing and transport. The JavaScript SDK does not support a USB cable connection.

```ts
abstract class EcrLink {}

class LanLink extends EcrLink {
  constructor(host: string, port?: number);   // default EcrConfig.DEFAULT_PORT
  readonly host: string;
  readonly port: number;
}

class WebServiceLink extends EcrLink {
  constructor(merchantId: string, terminalId: string);
  readonly merchantId: string;
  readonly terminalId: string;
}
```

- `EcrLink`: the base type, either `LanLink` (Wi-Fi/LAN) or `WebServiceLink` (the Amwal Hub over HTTPS).
- `LanLink`: TCP to the IP address and port the terminal shows on its idle screen. The till and the terminal must be on the same network. `host` is a host name or IP address, kept as given; only a blank one is a plan issue. An IPv6 address may be written with or without brackets.
- `WebServiceLink`: HTTPS to the Amwal Hub, which relays to the terminal configured for Web Service mode (`ecrMode: 4`). The Hub address comes from `EcrConfig.environment` and is resolved by the SDK. `merchantId` and `terminalId` are the numeric backend IDs as text, e.g. `'10001'` and `'20002'`.

---

## Terminals

The two transport clients behind a session. You usually reach them through `EcrOpenedSession`, but you can also use them directly.

### `EcrTerminal`

A POS terminal reachable over Wi-Fi/LAN. One instance addresses one terminal and holds no connection between calls, so it is cheap to keep and safe to reuse.

When the config has a key, every request is signed, and every answer must be signed with the same key and echo the request's nonce. Otherwise the answer is discarded as `Unauthenticated`. Without this check, anything on the network that answers on the terminal's port could claim "approved" for a payment that never happened.

```ts
interface EcrTerminalOptions {
  logger?: EcrLogger | null;
  guard?: FinancialGuard | null;
}

interface RunOptions {
  amount?: string | number | bigint | Amount | null;
  originalStan?: string;
  originalTerminalId?: string;
  originalDate?: string;
  merchantReference?: string;
}

class EcrTerminal {
  constructor(channel: EcrChannel | string, serialNumber?: string, config?: EcrConfig, options?: EcrTerminalOptions);

  terminalKey(): string;
  guard(): FinancialGuard;
  config(): EcrConfig;
  isReachable(): Promise<boolean>;
  probeReachability(): Promise<EcrReachability>;

  sale(amount: Money, merchantReference?: string): Promise<EcrResult>;
  void(receiptNumber: string, options?: OriginalOptions): Promise<EcrResult>;
  refund(amount: Money, receiptNumber: string, transactionDate: string, options?: OriginalOptions): Promise<EcrResult>;
  inquire(receiptNumber: string, transactionDate: string, options?: OriginalOptions): Promise<EcrInquiry>;
  inquireByReference(originalReference: string, options?: OriginalOptions & { transactionDate?: string }): Promise<EcrInquiry>;
  receipt(receiptNumber: string, transactionDate: string, options?: OriginalOptions): Promise<EcrReceipt>;
  closeReceipt(merchantReference?: string): Promise<EcrReceiptClosed>;
  run(type: EcrTransactionType, options?: RunOptions): Promise<EcrResult>;

  static formatDuration(seconds: number): string;
}
```

Constructor:

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `channel` | `EcrChannel \| string` | | The terminal's host or IP address, or a channel that carries the bytes. A string becomes a `TcpEcrChannel` on `config.port` with `config.connectTimeout`. An empty host is not refused there, as in the Windows SDK; connecting fails instead. |
| `serialNumber` | `string` | `''` | Identifies the terminal in the message: the serial the operator registered. |
| `config` | `EcrConfig` | `new EcrConfig()` | Settings. |
| `options.logger` | `EcrLogger \| null` | `null` | `null` uses `EcrLogger.none()`. |
| `options.guard` | `FinancialGuard \| null` | `null` | `null` uses `FinancialGuard.fromConfig(config, logger)`. |

| Method | Resolves to | Notes |
|---|---|---|
| `terminalKey()` | `string` | Identifies this physical terminal to the guard's lock and journal (`wifi\|<host, lower case>\|<port>`). |
| `isReachable()` | `boolean` | Whether the terminal is listening. It proves the port is open, not that the terminal is idle. |
| `probeReachability()` | `EcrReachability` | Asks the channel whether the terminal is there, before sending anything. Worth calling before a sale: a wrong address then gets an immediate answer instead of a failure the cardholder has to wait through. |
| `sale()` | `EcrResult` | Takes a payment; the cardholder presents the card at the terminal. `amount` is in major units: a string, a number or a `bigint`. `merchantReference` is this attempt's own reference: save it before calling. When blank, one is generated. **Rejects** with `InvalidRequestException`, in which case nothing was sent. |
| `void()` | `EcrResult` | Cancels an earlier transaction for its full amount, by its receipt number. `originalTerminalId` is the terminal the original was taken on, when that is not this one. `merchantReference` is the void's own reference, not the original's. |
| `refund()` | `EcrResult` | Returns money against an earlier transaction, in full or in part. `transactionDate` is the original's day as `yyyyMMdd`, because a receipt number is unique only within a day. |
| `inquire()` | `EcrInquiry` | Asks what became of an earlier transaction by its receipt number, without touching it. Safe to repeat, and answered even while the terminal is busy. `merchantReference` is the inquiry's own reference, not a way to look a transaction up. |
| `inquireByReference()` | `EcrInquiry` | Asks what became of the transaction this till sent as `originalReference`. Use it for an outcome you never received: after a timeout or a lost connection there is no receipt number to quote, but you still have the reference you sent the request with. **Never retry instead.** `transactionDate` is optional, because a reference is not scoped to a day; do not fill in "today". **Rejects** with `InvalidRequestException` if `originalReference` is blank or malformed. The answer is passed to the guard, which settles the journal entry where it can. |
| `receipt()` | `EcrReceipt` | Fetches an earlier transaction's e-receipt URL, for a QR code. Non-financial and repeatable. |
| `closeReceipt()` | `EcrReceiptClosed` | Asks the terminal to put its receipt away and return to its idle screen. Call it from the till's Close receipt action when the cashier is finished, not as a side effect of dismissing a dialog. Firmware too old to know this command answers `CloseReceiptRefused`. |
| `run()` | `EcrResult` | Runs any money-moving operation. The typed methods above are the usual way in; this one is for a till that sets the type from its own form. **Rejects** with `InvalidRequestException` (nothing was sent) if the type does not move money ("<Type> is run with inquire()"), an amount is missing, a void or refund has a blank receipt number, or a reference or amount is malformed. The request is built and signed before the guard records anything. |
| `formatDuration()` | `string` | Formats seconds as `45s`, `2m` or `1m 30s`. |

Arguments follow the Windows SDK. A blank receipt number rejects with `InvalidRequestException` for a void, refund, inquiry or receipt; otherwise every character that is not a decimal digit (any Unicode `\p{Nd}`, as `char.IsDigit`) is dropped and the rest is padded to six (`24` → `000024`). Dates and the original terminal ID are sent as given when not blank; a refund without a date is sent without one. Amounts are rounded half away from zero and not judged: zero and negative amounts are sent. A merchant reference is at most 32 printable ASCII characters (counted in UTF-16 units), with no spaces, `&` or `=`, after .NET's Unicode `Trim()`; text that is not a number is the only amount refused.

When a Wi-Fi sale, void or refund loses its answer with an unknown outcome and `autoInquireOnFailure` is on, the SDK asks the terminal once, on a fresh connection, what became of the transaction. An inquiry only reads, so this follow-up cannot itself move money. The finding is attached to `Failed.recovered`; it does not replace the failure, because the exchange still failed. If the follow-up throws, `recovered` is `null`.

How a channel error becomes a failure: an `EcrChannelTimeout` is `Timeout` ("The terminal did not answer within 2m. The transaction may still have completed — inquire before retrying."); an `EcrIOException` whose message contains "not valid JSON" (the unreadable answer is quoted in full) or "empty message" is `Malformed`, "closed the connection" is `ConnectionLost`, anything else is `Unreachable` with the endpoint appended.

### `EcrWebServiceTerminal`

The ECR Web Service client: REST over HTTPS to the Amwal Hub, with signed JSON bodies. Use it when the terminal is configured for Web Service mode (`ecrMode: 4`).

A lost or unreadable answer arrives as `Failed` with an outcome-unknown failure, and is **never** followed by an automatic inquiry (`Failed.recovered` is always `null`). Inquire by reference yourself.

```ts
interface EcrWebServiceTerminalOptions {
  logger?: EcrLogger | null;
  http?: HttpTransport | null;
  guard?: FinancialGuard | null;
}

class EcrWebServiceTerminal {
  constructor(terminalSerial: string, config?: EcrConfig, options?: EcrWebServiceTerminalOptions);

  terminalKey(): string;
  guard(): FinancialGuard;
  config(): EcrConfig;

  sale(amount: Money, merchantReference?: string): Promise<EcrResult>;
  void(receiptNumber: string, merchantReference?: string): Promise<EcrResult>;
  refund(amount: Money, receiptNumber: string, transactionDate: string, merchantReference?: string): Promise<EcrResult>;
  inquire(receiptNumber: string, transactionDate: string, merchantReference?: string): Promise<EcrInquiry>;
  inquireByReference(originalReference: string, transactionDate?: string, merchantReference?: string): Promise<EcrInquiry>;
  closeReceipt(originalMerchantReference: string, merchantReference?: string): Promise<EcrReceiptClosed>;

  static id(text: string): bigint | null;
}
```

Constructor: the config is used as given, so the HTTP deadline is `connectTimeout + responseTimeout` (130 s with the defaults). `EcrSessions.plan()` raises an untouched 120 s answer wait to 130 s (140 s deadline), as the Windows SDK. `options.http` sets how the HTTPS post is made; `null` uses `NodeHttpTransport` with `config.caBundlePath`. The URL is always the SDK's. `options.logger` defaults to `EcrLogger.none()`, and `options.guard` to `FinancialGuard.fromConfig()`.

| Method | Resolves to | Notes |
|---|---|---|
| `terminalKey()` | `string` | Identifies this terminal to the guard (`ws\|<environment>\|<merchantId>\|<terminalId>`). |
| `sale()` | `EcrResult` | `amount` is in major units: a string, a number or a `bigint`. |
| `void()` | `EcrResult` | By receipt number. |
| `refund()` | `EcrResult` | `transactionDate` is the original's day as `yyyyMMdd`. |
| `inquire()` | `EcrInquiry` | By receipt number and date. |
| `inquireByReference()` | `EcrInquiry` | Looks up the transaction sent as `originalReference`; use it for an outcome you never received. `transactionDate` is optional; do not fill in "today", because the Hub filters by that day. Rejects with `InvalidRequestException` if `originalReference` is blank or malformed. |
| `closeReceipt()` | `EcrReceiptClosed` | Posts `/Ecr/closeReceipt` for the sale, void or refund sent as `originalMerchantReference`. Call it from the Close receipt action; it is never sent automatically. `merchantReference` is this close request's own ID; when blank, one is generated. A blank original resolves to `CloseReceiptFailed` with `Malformed`. |
| `id()` | `bigint \| null` | The ID as `long.TryParse` reads it (surrounding white space and a leading sign allowed, within the signed 64-bit range), or `null`. |

If `merchantId` or `terminalId` on the config is not numeric, money-moving calls resolve to `Failed` (with an empty merchant reference) and `Malformed`, inquiries to `InquiryFailed` with `Malformed`, and close receipt to `CloseReceiptFailed` with `Malformed`, as the Windows SDK. Nothing is sent in any of these cases. Receipt numbers and dates are sent as given (receipt numbers padded); a malformed reference or an amount that is not a number rejects with `InvalidRequestException`. If a Hub transport failure comes back to an inquiry as an answer with no data, it is reported as `InquiryFailed` (`ConnectionLost`), never as `NotFound`. An inquiry the Hub refuses with a readable answer reads as the Windows SDK reads it (usually `NotFound`). Answers are read whatever `version` they declare.

### `EcrReachability`

Whether the terminal's ECR port answers a connection. It proves the port is open, not that the terminal is idle: a terminal already taking a payment answers too.

```ts
class EcrReachability {
  constructor(reachable: boolean, host: string, port: number, error?: string | null, endpoint?: string | null);
  readonly reachable: boolean;
  readonly host: string;
  readonly port: number;
  readonly error: string | null;
  readonly endpoint: string;
  toJSON(): { reachable: boolean; host: string; port: number; error: string | null; endpoint: string };
}
```

- `error`: the reason when the terminal is not reachable, e.g. `Connection refused: nothing is listening on that port (ECONNREFUSED)` or `Connection timed out after 3000 ms`.
- `endpoint`: defaults to `host:port`, or `host` when the port is 0.

---

## Results

Every operation resolves to a result object instead of throwing. Each family has an abstract base with a public `merchantReference: string`, `outcome()` and `toJSON()`. Tell the subclasses apart with `instanceof`.

### EcrResult family

How a sale, void or refund ended. The three outcomes need different handling from a till. `Approved` means money moved. `Declined` means the terminal answered and refused. `Failed` means the exchange itself failed: it may still have taken the customer's money, so **never treat it as a refusal**.

```ts
abstract class EcrResult {
  constructor(merchantReference: string);
  readonly merchantReference: string;
  isApproved(): this is Approved;
  isDeclined(): this is Declined;
  isFailed(): this is Failed;
  abstract outcome(): 'approved' | 'declined' | 'failed';
  abstract toJSON(): Record<string, unknown>;
}

class Approved extends EcrResult {
  constructor(
    merchantReference: string,
    amount: string,
    responseCode: string,
    rrn: string,
    authCode: string,
    maskedPan: string,
    partialApproval: boolean,
    requestedAmount: string,
    raw: string,
  );
}

class Declined extends EcrResult {
  constructor(merchantReference: string, responseCode: string, reason: string, nextStep: NextStep, raw: string);
}

class Failed extends EcrResult {
  constructor(merchantReference: string, failure: Failure, recovered?: EcrInquiry | null);
  readonly failure: Failure;
  readonly recovered: EcrInquiry | null;
  nextStep(): NextStep;
  settled(): this is Failed & { recovered: Found };
  withRecovered(recovered: EcrInquiry | null): Failed;
}
```

All constructor parameters are also `readonly` properties of the same name.

- `merchantReference`: the reference the transaction was sent with, either the caller's own or one the SDK generated (or the answer's own, `data.merchantReference`, when it carries one). It identifies this transaction to the terminal afterwards.
- **`Approved`**: money moved.
  - `amount`: what was actually taken or returned, in major units, e.g. `1.234`.
  - `responseCode`: the backend's code, `00` on a plain approval.
  - `maskedPan`: masked, never the full number, e.g. `543173xxxx5785`. May be empty.
  - `partialApproval`: the issuer authorised less than was asked for. Collect the difference by other means before handing over the goods. This is not a refusal.
  - `requestedAmount`: what was asked for, when partially approved.
  - `raw`: the terminal's full answer as JSON text, for anything not exposed as a property.
- **`Declined`**: the terminal answered and refused. **No money moved.** `reason` is the text to show: the backend's error list in preference to its message. An answer that says the outcome is unknown (`nextStep` `INQUIRE_BY_MERCHANT_REFERENCE`) never arrives as a decline; it arrives as `Failed`. So `nextStep` is always `NextStep.None` and is kept only for parity with the Windows SDK.
- **`Failed`**: the exchange itself failed. When `failure.outcomeUnknown()` is `true`, the payment may have completed. Read `recovered` first (on Wi-Fi the SDK asks the terminal once by itself), then inquire by `merchantReference`. **Never resend.**
  - `recovered`: what the terminal said when asked afterwards, or `null` if it was not asked. `Found` settles the outcome; anything else leaves it unknown. Always `null` on Web Service.
  - `nextStep()`: always `NextStep.InquireByMerchantReference`, because nothing here says the transaction did not happen.
  - `settled()`: whether the follow-up inquiry found the transaction (`recovered instanceof Found`), so the outcome is no longer unknown.
  - `withRecovered()`: a copy with `recovered` set.
- `toJSON()`: `{ outcome, merchantReference, ... }` without `raw`. `Failed` adds `failure`, `nextStep`, `settled` and `recovered`.

```ts
import { Approved, Declined, EcrSessions, Failed } from '@amwalpay/ecr-js';

const reference = EcrSessions.newMerchantReference();
await saveOrderReference(orderId, reference);       // save before sending

const result = await session.sale('1.234', reference);

if (result instanceof Approved) {
  await recordPayment(orderId, result.amount, result.rrn);
  if (result.partialApproval) await collectDifference(orderId, result.requestedAmount, result.amount);
} else if (result instanceof Declined) {
  show(result.reason);                               // no money moved
} else if (result instanceof Failed) {
  if (result.settled()) {
    await applyTransaction(orderId, result.recovered.transaction);
  } else if (result.failure.outcomeUnknown()) {
    await markUnresolved(orderId, result.merchantReference);   // inquire later, never resend
  } else {
    show(result.failure.message);                    // nothing was sent
  }
}
```

### EcrInquiry family

The answer to "what became of this transaction": `Found`, `NotFound` or `InquiryFailed`. It is kept separate from `EcrResult` because it reports on a transaction instead of performing one. A successful inquiry says nothing by itself about whether money moved; `EcrTransaction.status` says that.

```ts
abstract class EcrInquiry {
  constructor(merchantReference: string);
  readonly merchantReference: string;
  abstract outcome(): 'found' | 'not_found' | 'failed';
  abstract toJSON(): Record<string, unknown>;
}

class Found extends EcrInquiry {
  constructor(merchantReference: string, transaction: EcrTransaction, raw: string);
}

class NotFound extends EcrInquiry {
  constructor(merchantReference: string, reason: string, raw: string);
}

class InquiryFailed extends EcrInquiry {
  constructor(merchantReference: string, failure: Failure);
}
```

- `merchantReference`: the reference the inquiry was sent with, or the answer's own.
- **`Found`**: the transaction was found. `transaction.status` says what became of it.
- **`NotFound`**: this lookup returned no record. After a lost answer, that is **not proof nothing was charged**: the same answer follows a terminal reset or a record that has aged out. Confirm on the terminal, or with Amwal, before taking payment again.
- **`InquiryFailed`**: the lookup itself failed, so nothing was learned. Harmless to repeat, because an inquiry moves no money.

### EcrReceipt family

A transaction's e-receipt: `ReceiptReady`, `ReceiptUnavailable` or `ReceiptFailed`. The URL is shown as a QR code, so a till with no printer can still hand over a receipt. Wi-Fi only.

```ts
abstract class EcrReceipt {
  constructor(merchantReference: string);
  readonly merchantReference: string;
  abstract outcome(): 'ready' | 'unavailable' | 'failed';
  abstract toJSON(): Record<string, unknown>;
}

class ReceiptReady extends EcrReceipt { constructor(merchantReference: string, url: string, raw: string); }
class ReceiptUnavailable extends EcrReceipt { constructor(merchantReference: string, reason: string, raw: string); }
class ReceiptFailed extends EcrReceipt { constructor(merchantReference: string, failure: Failure); }
```

- **`ReceiptReady`**: the receipt is published. Put `url` in a QR code exactly as it is.
- **`ReceiptUnavailable`**: no receipt to show: not found, not published, or not offered on this transport. Asking again is safe.
- **`ReceiptFailed`**: the exchange failed. Nothing changed, and the call can be repeated.

### EcrReceiptClosed family

The answer to a request to put the terminal's receipt away: `ReceiptClosed`, `CloseReceiptRefused` or `CloseReceiptFailed`. Success means the terminal is idle again, whether or not it had a receipt up. Safe to repeat.

```ts
abstract class EcrReceiptClosed {
  constructor(merchantReference: string);
  readonly merchantReference: string;
  abstract outcome(): 'idle' | 'refused' | 'failed';
  abstract toJSON(): Record<string, unknown>;
}

class ReceiptClosed extends EcrReceiptClosed { constructor(merchantReference: string, raw: string); }
class CloseReceiptRefused extends EcrReceiptClosed { constructor(merchantReference: string, responseCode: string, reason: string, raw: string); }
class CloseReceiptFailed extends EcrReceiptClosed { constructor(merchantReference: string, failure: Failure); }
```

- **`ReceiptClosed`**: the terminal is on its idle screen (.NET `EcrReceiptClosed.Idle`).
- **`CloseReceiptRefused`**: the terminal answered and refused, e.g. its firmware is too old for `CLOSE_RECEIPT`. Treat it as "cannot be asked" and carry on; the receipt stays up.
- **`CloseReceiptFailed`**: the exchange failed. Nothing changed, and the call can be repeated.

### `EcrTransaction`

A transaction as the terminal's backend records it. Found in `Found.transaction`.

```ts
interface EcrTransactionFields {
  transactionId: string;
  stan: string;
  type: string;
  status: string;
  amount: string;
  totalAmount: string;
  currency: string;
  transactionTime: string;
  maskedPan: string;
  cardHolderName: string;
  rrn: string;
  authCode: string;
  batchId: string;
  terminalId: string;
  isRefunded: boolean;
  canVoid: boolean;
  canRefund: boolean;
  partialApproval?: boolean;     // default false
  authorizedAmount?: string;     // default ''
}

class EcrTransaction implements Required<EcrTransactionFields> {
  constructor(fields: EcrTransactionFields);
  isApproved(): boolean;
  isDeclined(): boolean;
  day(): string;
  toJSON(): Required<EcrTransactionFields>;
}
```

| Property | Meaning |
|---|---|
| `transactionId` | The backend's identifier, unique across terminals and days. |
| `stan` | The receipt number, unique only within one terminal's day. |
| `type` | `Purchase`, `Void`, `Refund`, as the backend names it. |
| `status` | What became of it: `Approved`, `Declined`, `Voided`... Compare ignoring case. |
| `amount` | In major units: the amount that was requested. |
| `totalAmount` | Including tips and fees, where there were any. |
| `transactionTime` | As recorded, e.g. `2026-08-09T12:41:07`. |
| `maskedPan` | Masked, never the full number. May be empty. |
| `canVoid` | Whether the terminal would accept a void for it now. |
| `canRefund` | Whether the terminal would accept a refund against it. |
| `partialApproval` | The issuer approved less than was asked for; `authorizedAmount` is what was charged. |
| `authorizedAmount` | What was actually authorised. Equal to the amount unless partially approved. |

- `isApproved()` / `isDeclined()`: whether `status` reads `Approved` / `Declined`, ignoring case and surrounding space.
- `day()`: the day of `transactionTime` as `yyyyMMdd`, or `''` if it has none.
- `toJSON()`: all properties.

### `NextStep`

What the till should do about an outcome it cannot act on directly. The SDK states this explicitly instead of leaving the till to infer it from a response code, because the wrong inference is expensive: reading an unknown outcome as a refusal and sending the sale again charges the cardholder twice.

```ts
class NextStep {
  static readonly None: NextStep;                          // value 'NONE'
  static readonly InquireByMerchantReference: NextStep;    // value 'INQUIRE_BY_MERCHANT_REFERENCE'
  readonly value: 'NONE' | 'INQUIRE_BY_MERCHANT_REFERENCE';
  static fromWire(value: string): NextStep;
}
```

- `None`: the answer settles the matter.
- `InquireByMerchantReference`: ask what became of the transaction, quoting the reference it was sent with. **Never retry instead.**
- `fromWire()`: reads the wire value. Unknown values read as `None`, because a till must not act on a step it does not understand.

---

## Failures

Why an exchange could not be completed. Found on `Failed.failure`, `InquiryFailed.failure`, `ReceiptFailed.failure` and `CloseReceiptFailed.failure`.

The one distinction that matters after a failure is `outcomeUnknown()`. When it is `false`, nothing reached the terminal, so there is nothing to reconcile. When it is `true`, the request went out and the terminal may have acted on it, whatever came back or did not: **inquire by merchant reference, never resend.**

```ts
abstract class Failure {
  constructor(message: string);
  readonly message: string;
  outcomeUnknown(): boolean;     // true unless a subclass says otherwise
  abstract kind(): string;
  toJSON(): { kind: string; message: string; outcomeUnknown: boolean };
}
```

| Class | `kind()` | `outcomeUnknown()` | Meaning |
|---|---|---|---|
| `Timeout` | `timeout` | `true` | The request went out and no answer came in time. The transaction may still have completed: inquire before retrying. |
| `ConnectionLost` | `connection_lost` | `true` | The connection broke after the request went out. The transaction may still have completed: inquire before retrying. |
| `Malformed` | `malformed` | `true` | The answer could not be read. The transaction may still have completed: inquire before retrying. Also used, as in the Windows SDK, when Web Service IDs on the config are not numeric or close receipt has no original reference (nothing was sent then). |
| `Unauthenticated` | `unauthenticated` | `true` | The answer could not be shown to come from the terminal: it was not signed with this till's key, or it answers a different request. It is discarded, not believed. The terminal may have taken the payment: inquire before retrying. If this happens repeatedly, the key on the till and the key on the terminal differ. |
| `Unreachable` | `unreachable` | `false` | Nothing is listening: wrong address, terminal off, or a different network. Nothing was sent. |
| `Busy` | `busy` | `false` | Another sale, void or refund is already running on this terminal, from this process or another. Nothing was sent. |
| `Invalid` | `invalid` | `false` | No longer produced: the SDK reports these cases as `Malformed`, as the Windows SDK. Kept so stored results still read. |
| `Unresolved` | `unresolved` | `false` | An earlier sale, void or refund on this terminal has an unknown outcome and must be reconciled by inquiry before a new one is sent. Nothing was sent. |

`Busy`, `Invalid` and `Unresolved` do not exist in the Windows SDK; they come from the PHP SDK. `Busy` and `Unresolved` come only from the opt-in financial guard.

---

## Exceptions

Exceptions are thrown (or a promise rejects) only for calls that are refused before anything is sent, and for misuse of the SDK. All extend `Error` and set `name` to the class name.

```ts
class InvalidArgumentException extends Error {}
class LogicException extends Error {}
class RuntimeException extends Error {}
class OverflowException extends Error {}

class InvalidRequestException extends InvalidArgumentException {}

class DuplicateMerchantReferenceException extends InvalidRequestException {
  constructor(previous: JournalEntry);
  readonly previous: JournalEntry;
}
```

- **`InvalidArgumentException`**: a value is outside the rules for it (a config setting, a key that cannot sign, a plan with issues passed to `open()`). The .NET SDK throws `ArgumentException`.
- **`LogicException`**: the SDK was used in a way its own code never should, e.g. serializing an `EcrConfig`, or `markResolved()` with the guard off.
- **`RuntimeException`**: something outside the SDK failed: the state folder, the journal file, a lock, an unreadable CA bundle.
- **`OverflowException`**: an amount does not fit the 64-bit integer the Web Service carries (`Amount.toMinorUnits()`). The .NET SDK throws `OverflowException` from its `checked` cast.
- **`InvalidRequestException`**: the call was refused before anything was built or sent. Causes include a merchant reference the wire cannot carry, an amount that is not a number, and a blank receipt number. Nothing reached the terminal, so there is no outcome to reconcile.
- **`DuplicateMerchantReferenceException`**: a sale, void or refund was requested with a merchant reference this terminal has already been sent. Reusing a reference is how a till resends a payment it is unsure about, and resending is how a cardholder is charged twice. If the earlier attempt's outcome is unknown, inquire by this reference. If it was declined, start the new attempt with a new reference. `previous` is the journal entry for the earlier attempt. The message names its type and state, and adds either "Its outcome is still unknown: inquire by this reference, never resend." or "A new attempt needs a new reference."

---

## Safety

Payment-safety rules for a till server that serves many requests at once. They are off by default, as the Windows SDK has no such guard. Turn them on with `new EcrConfig({ guardFinancialOperations: true })` when your own system does not already enforce them.

### `FinancialGuard`

1. **One financial transaction per terminal at a time.** A second sale, void or refund while one is running, from any process on the machine, gets `Busy` and nothing is sent.
2. **A merchant reference is used once.** Sending a reference this terminal has already been sent throws `DuplicateMerchantReferenceException`, because that is how a till resends a payment it is unsure about.
3. **No new money movement while an outcome is unknown.** After a timeout, a lost connection, or an unreadable or unauthenticated answer, the reference is kept as unresolved. The next sale, void or refund on that terminal gets `Unresolved` until an inquiry by reference settles it, or an operator settles it with `markResolved()`.
4. **The reference is saved before the request leaves**, so a process killed mid-wait leaves an unresolved entry, not a forgotten payment.

Inquiries, receipts and close receipt move no money and are never blocked.

```ts
class FinancialGuard {
  constructor(journal: TransactionJournal, lock: TerminalLock, enabled?: boolean, logger?: EcrLogger | null);

  static fromConfig(config: EcrConfig, logger?: EcrLogger | null): FinancialGuard;
  enabled(): boolean;
  run(
    terminalKey: string,
    type: EcrTransactionType,
    reference: string,
    amountMinorUnits: string,
    currencyCode: string,
    send: () => Promise<EcrResult>,
  ): Promise<EcrResult>;
  observeInquiry(terminalKey: string, originalReference: string, inquiry: EcrInquiry): Promise<void>;
  unresolved(terminalKey: string): Promise<JournalEntry[]>;
  entry(terminalKey: string, reference: string): Promise<JournalEntry | null>;
  markResolved(terminalKey: string, reference: string, note: string): Promise<JournalEntry>;
}
```

| Method | Resolves to | Notes |
|---|---|---|
| `fromConfig()` | `FinancialGuard` | Uses `FileTransactionJournal` and `FileTerminalLock` in `config.stateDirectory`, or in `amwalpay-ecr` under `os.tmpdir()` if that is `null`. Takes `enabled` from `config.guardFinancialOperations`. |
| `enabled()` | `boolean` | Whether the rules are enforced. |
| `run()` | `EcrResult` | Runs one sale, void or refund under the rules above. `terminalKey` identifies the physical terminal (see the terminals' `terminalKey()`). `reference` is the resolved merchant reference the request will carry. `send` builds and sends the request. Resolves to `Failed` with `Busy` or `Unresolved` without calling `send`. **Rejects** with `DuplicateMerchantReferenceException`. Approved and declined results are recorded. A failure where nothing was sent removes the entry, so the reference may be used again. A failure with an unknown outcome leaves the entry unresolved. If `send` rejects, the entry stays `pending` (unresolved) and the lock is released. With the guard disabled, it only calls `send`. |
| `observeInquiry()` | `void` | Lets an inquiry by reference settle an unresolved entry. A record whose status is Approved or Declined settles it. A record with any other status stays unknown, with a note to confirm by hand. Not found settles nothing, because after a lost answer it does not prove nothing was charged. Does nothing when the guard is disabled. |
| `unresolved()` | `JournalEntry[]` | Entries whose outcome is unknown, oldest first. Always empty when the guard is disabled. |
| `entry()` | `JournalEntry \| null` | One entry by reference. Always `null` when the guard is disabled. |
| `markResolved()` | `JournalEntry` | Settles an unresolved entry by hand, after the outcome was confirmed on the terminal or with Amwal. `note` should say how it was confirmed. An entry that is already settled is returned unchanged. **Rejects** with `InvalidArgumentException` if no entry exists for the reference, or if `note` is blank; with `LogicException` when the guard is disabled. |

Journal and lock failures (state folder cannot be created, journal unreadable or corrupt, lock cannot be opened) surface as `RuntimeException` from the file implementations below.

### `JournalEntry`

One sale, void or refund the guard sent, as the journal remembers it. It holds the reference, type, amount and outcome, and never card data or keys.

```ts
interface JournalEntryData {
  reference: string;
  type: string;
  state: string;
  amountMinorUnits: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  failure: string;
  note: string;
}

class JournalEntry implements JournalEntryData {
  static readonly PENDING = 'pending';
  static readonly UNKNOWN = 'unknown';
  static readonly APPROVED = 'approved';
  static readonly DECLINED = 'declined';
  static readonly RESOLVED = 'resolved';

  constructor(
    reference: string,
    type: string,
    state: string,
    amountMinorUnits: string,
    currencyCode: string,
    createdAt: string,
    updatedAt: string,
    status?: string,
    failure?: string,
    note?: string,
  );

  isUnresolved(): boolean;
  with(changes: { state?: string; status?: string; failure?: string; note?: string }): JournalEntry;
  toJSON(): JournalEntryData;
  static fromJSON(data: Record<string, unknown>): JournalEntry;
}
```

| State constant | Value | Meaning |
|---|---|---|
| `PENDING` | `pending` | Recorded before the request left; the answer has not been read yet. |
| `UNKNOWN` | `unknown` | The request went out and the answer did not settle it. Inquire by reference. |
| `APPROVED` | `approved` | Approved. |
| `DECLINED` | `declined` | Declined. |
| `RESOLVED` | `resolved` | Settled by hand with `FinancialGuard.markResolved()` after confirming on the terminal or with Amwal. |

- `type`: the `EcrTransactionType` value (`Sale`, `Void`, `Refund`). Timestamps are UTC to the second, `2026-10-25T10:15:00Z`.
- `isUnresolved()`: `true` for `PENDING` or `UNKNOWN`, meaning the outcome is still unknown and the terminal must be asked before any new money moves.
- `with()`: a copy with the given fields changed and `updatedAt` set to the current UTC time.
- `toJSON()` / `fromJSON()`: plain-object form for storage. `fromJSON()` reads missing or non-scalar fields as `''`.

### `TransactionJournal`

Remembers every merchant reference sent to a terminal and what became of it, across requests and processes. Implement it over your database to share the guard between servers. `FileTransactionJournal` is the default. Each method may answer directly or with a promise.

```ts
type MaybePromise<T> = T | Promise<T>;

interface TransactionJournal {
  find(terminalKey: string, reference: string): MaybePromise<JournalEntry | null>;
  unresolved(terminalKey: string): MaybePromise<JournalEntry[]>;   // oldest first
  put(terminalKey: string, entry: JournalEntry): MaybePromise<void>;
  remove(terminalKey: string, reference: string): MaybePromise<void>;
}
```

- `unresolved()`: entries whose outcome is still unknown, oldest first.
- `put()`: inserts or replaces the entry for `entry.reference`.

### `FileTransactionJournal`

The journal as one JSON file per terminal (`journal-<first 32 hex of sha256(terminalKey)>.json`, `{ "terminal": …, "entries": { reference: entry } }`), in a private folder. Every change is a read-modify-write under a lock file (`<journal>.json.lock`, waited for up to 10 s), written to a temporary file and renamed into place, so two processes never interleave their writes and a crash never leaves half a file. Settled entries older than the retention period are dropped. Unresolved entries are kept until they are settled. The methods are synchronous.

```ts
class FileTransactionJournal implements TransactionJournal {
  constructor(directory: string, retentionDays?: number);   // default 90
}
```

- **Throws** `RuntimeException` when the folder cannot be created, or the journal cannot be read, locked or saved. A journal file that cannot be parsed also throws ("corrupt and must be checked by hand"). This fails closed, because a journal that cannot be read cannot prove a reference is unused.

### `TerminalLock`

One financial transaction per terminal at a time, across every process on the machine. Implement it over a shared lock service (Redis, a database row) when several servers drive the same terminal.

```ts
interface TerminalLock {
  tryAcquire(terminalKey: string): MaybePromise<(() => MaybePromise<void>) | null>;
}
```

- `tryAcquire()`: takes the terminal without waiting. Returns the release function, or `null` if another caller holds the terminal.

### `FileTerminalLock`

A terminal lock implemented as a file created exclusively (`fs.openSync(path, 'wx')`) in the state folder, `terminal-<first 32 hex of sha256(terminalKey)>.lock`, holding the owner's process id, host name and a random token. Node cannot ask the operating system to release a lock when a process dies, so a lock whose owner process on this host is gone is **stale and taken over**: a crashed till never leaves a terminal locked for good. A lock file that cannot be read (being written) is stale after 10 s. A lock written by another host name is never taken over. Release deletes the file only if it still carries this holder's token, and is safe to call more than once. Works on Windows, Linux and macOS; the folder must be on a local disk.

```ts
class FileTerminalLock implements TerminalLock {
  constructor(directory: string);
  tryAcquire(terminalKey: string): (() => void) | null;
}
```

- **Throws** `RuntimeException` if the folder cannot be created or the lock file cannot be opened for a reason other than "already exists".
- A second call in the same process while the lock is held returns `null`: the holder's pid is this process, which is alive.

---

## Logging

Where the SDK writes its diagnostics. Logging is off until you pass a logger. Lines carry request and response payloads: masked card number, amount and reference. The signing secret is never written, and card numbers and sensitive fields are masked by `Redactor` before a line reaches the logger. Treat the lines as transaction records.

```ts
interface DebugLogger {
  debug(message: string, context?: Record<string, unknown>): unknown;
}

abstract class EcrLogger {
  protected abstract write(line: string): void;
  debug(message: string): void;
  static none(): EcrLogger;
  static from(sink: (line: string) => unknown): EcrLogger;
  static adapt(logger: DebugLogger): EcrLogger;
}

class NullEcrLogger extends EcrLogger {}
class CallableEcrLogger extends EcrLogger { constructor(sink: (line: string) => unknown); }
class LoggerAdapter extends EcrLogger { constructor(logger: DebugLogger); }

class Redactor {
  static line(line: string): string;
  static mask(pan: string): string;
  static luhn(digits: string): boolean;
}
```

| Member | Notes |
|---|---|
| `EcrLogger.debug()` | Writes one diagnostic line, redacted. To write your own logger, extend `EcrLogger` and implement `write()`. |
| `EcrLogger.none()` | Discards everything. This is the default. |
| `EcrLogger.from(sink)` | Wraps a function that takes one line, e.g. `EcrLogger.from((line) => console.log(line))`. An error thrown by the function escapes the SDK call. |
| `EcrLogger.adapt(logger)` | Wraps a logger object with a `debug` method: pino, winston, bunyan, `console`. The counterpart of PHP's PSR-3 adapter. |
| `NullEcrLogger` | Discards every line. |
| `CallableEcrLogger` | Hands each redacted line to a function. |
| `LoggerAdapter` | Sends each redacted line to `logger.debug(line, { channel: 'amwalpay-ecr' })`, without making any logging library a dependency. Throws `InvalidArgumentException` if the object has no `debug` method. |
| `Redactor.line()` | Masks what must never reach a log; applied to every line the SDK writes. A run of 13 to 19 digits that passes the Luhn check is masked to its first six and last four digits. The values of JSON fields named like a PIN, CVV, track data, token, password, secret or key are replaced with `"***"`. This is the second line of defence, for the day a terminal, a Hub or a caller's own text carries something it should not. |
| `Redactor.mask()` | Keeps the first six and last four digits and replaces the rest with `*`. |
| `Redactor.luhn()` | Whether a digit string passes the Luhn check. |

```ts
import pino from 'pino';
const session = EcrSessions.open(serial, plan, { logger: EcrLogger.adapt(pino({ level: 'debug' })) });
```

---

## Channel

How bytes reach a Wi-Fi terminal, and nothing else. Signing a request, checking the answer and deciding what a response code means all belong to `EcrTerminal`, and work the same however the bytes travel. You need this layer only to supply your own transport, e.g. for tests.

### `EcrChannel`

A channel carries one framed request and brings back one framed answer.

```ts
interface EcrChannel {
  endpoint(): string;
  host(): string;
  port(): number;
  probe(timeout: number): Promise<string | null>;
  exchange(body: string, timeout: number): Promise<Uint8Array | string>;
}
```

- `endpoint()`: what to show an operator when this link fails, e.g. `192.168.1.50:9100`.
- `port()`: zero when the link is not a socket.
- `probe()`: whether the terminal can be reached, without sending anything. Resolves to `null` if reachable, otherwise the reason. `timeout` is in seconds.
- `exchange()`: sends one request body and returns the answer body, both UTF-8 JSON without the length header (bytes are read as strict UTF-8; a string is taken as it is). Applying the framing is the channel's job. `timeout` is in seconds. **Rejects** with `EcrChannelTimeout` if the terminal accepted the request and did not answer within `timeout`, and with `EcrIOException` for anything else that broke the link.

```ts
// A channel that answers from memory, for a test.
const channel: EcrChannel = {
  endpoint: () => 'fake:0', host: () => 'fake', port: () => 0,
  probe: async () => null,
  exchange: async () => '{"success":true,"responseCode":"00","message":"Approved","data":{"amount":"1.234"}}',
};
const terminal = new EcrTerminal(channel, 'SN-TEST', new EcrConfig({ guardFinancialOperations: false }));
```

### `TcpEcrChannel`

The terminal over TCP (`node:net`), on the shop's Wi-Fi or LAN. One connection carries one request and one answer, which is how POS ECR ports behave: connect, send, wait for the cardholder, read the result, disconnect. The connect budget and the answer budget are separate. Connecting is a handshake on the local network: it either happens quickly or the address is wrong. Because nothing has been sent at that point, a connect failure counts as "unreachable". The long wait belongs to the answer, which includes the cardholder presenting a card. `TCP_NODELAY` is set.

```ts
class TcpEcrChannel implements EcrChannel {
  static readonly DEFAULT_CONNECT_TIMEOUT = 3;
  constructor(host: string, port?: number, connectTimeout?: number | null);
}
```

- `DEFAULT_CONNECT_TIMEOUT`: used when `connectTimeout` is `null`. Prefer passing `EcrConfig.connectTimeout`, as `EcrTerminal` does.
- **Throws** `InvalidArgumentException` if `host` is empty. `[::1]` is accepted and connected to as `::1`.
- A request too large for a frame fails locally before connecting, so it is never reported as a dropped connection.
- Connect failures read `Connection timed out after N ms`, or a reason with the socket code, e.g. `Connection refused: nothing is listening on that port (ECONNREFUSED)`, `No route to host (EHOSTUNREACH)`, `Host name not found (ENOTFOUND)`.
- After the request is written, a socket error reads `Terminal closed the connection: <reason>`, and a stream that ends early `Terminal closed the connection while sending the response header` (or `body`); both become `ConnectionLost`.

### `EcrFrames`

The wire framing: a 2-byte big-endian length followed by that many bytes of UTF-8 JSON. A TCP stream carries no message boundaries, so the header is what says where one message ends.

```ts
class EcrFrames {
  static readonly HEADER_BYTES = 2;
  static readonly MAX_BODY_BYTES = 0xffff;

  static wrap(body: Uint8Array | string): Buffer;
  static bodyLength(header: Uint8Array): number;
  static readBody(readExactly: (count: number, what: string) => Promise<Uint8Array> | Uint8Array): Promise<Buffer>;
  static closed(what: string): EcrIOException;
  static readBodyFrom(bytes: Uint8Array, cursor?: { offset: number }): Buffer;
}
```

| Method | Notes |
|---|---|
| `wrap()` | Puts a length header in front of `body` (text is written as UTF-8). Throws `EcrIOException` if the body does not fit a frame (more than `MAX_BODY_BYTES`). |
| `bodyLength()` | The body length a 2-byte header announces. Throws `InvalidArgumentException` if the header is shorter than two bytes. |
| `readBody()` | Reads exactly one message body from a byte source. `readExactly` must return exactly `count` bytes or throw. Rejects with `EcrIOException`, including "Terminal returned an empty message" for a zero length. |
| `closed()` | The error for a stream that ended partway through `what`. |
| `readBodyFrom()` | Reads one framed body from bytes already in memory, starting at `cursor.offset`, and moves `cursor.offset` past it. For channels that already hold the bytes. Throws `EcrIOException`. |

### `EcrIOException` and `EcrChannelTimeout`

```ts
class EcrIOException extends Error {}
class EcrChannelTimeout extends EcrIOException {}
```

- **`EcrIOException`**: the link to the terminal failed. The SDK decides what the failure means for the payment from the message text, the same way the Windows SDK reads `IOException`:
  - "closed the connection": the request may have arrived (connection lost).
  - "not valid JSON" or "empty message": the answer was unreadable (malformed).
  - Anything else: nothing was sent (unreachable).
- **`EcrChannelTimeout`**: the terminal accepted the request and did not answer in time. This is not a refusal: the transaction may still have run.

---

## Web Service

Building blocks for the ECR Web Service (HTTPS to the Amwal Hub). Sessions use these on their own. Use them directly only when you make the HTTP call yourself or replace the transport.

### `WebServiceRequests`

Builds and signs Hub request bodies, for a caller that posts the JSON itself. Each method returns the body as a `JsonObject`; send `body.toJson()`.

```ts
interface Common {
  merchantId: bigint | number;
  terminalId: bigint | number;
  terminalSerial: string;
  merchantReference?: string;      // blank: generated
  ecrId?: string;                  // default 'ECR01'
  transactionDateTime?: string;    // yyyyMMddHHmmss; blank: now, machine's local time (EcrSdk.localTimeZone())
  secureHashKey?: string;          // empty: unsigned
}
interface WithCurrency extends Common { currencyCode?: string }   // default '512'

class WebServiceRequests {
  static sale(o: WithCurrency & { amountMinorUnits: number }): JsonObject;
  static void(o: WithCurrency & { stan: string }): JsonObject;
  static refund(o: WithCurrency & { amountMinorUnits: number; stan: string; originalTransactionDate: string }): JsonObject;
  static transactionStatus(o: WithCurrency & { stan?: string; originalTransactionDate?: string; originalMerchantReference?: string }): JsonObject;
  static closeReceipt(o: Common & { originalMerchantReference: string }): JsonObject;
}
```

- `amountMinorUnits`: minor units, so OMR 1.234 is `1234`.
- `originalTransactionDate`: `yyyyMMdd`.
- `transactionStatus()`: the inquiry. It looks up by receipt number when `stan` is set, and otherwise by `originalMerchantReference`.
- `closeReceipt()`: the body for `/Ecr/closeReceipt`. A blank `originalMerchantReference` throws `InvalidArgumentException`.
- `stan` is padded leniently, as in the Windows SDK (stray characters stripped).
- **Throws** `InvalidRequestException` for a malformed merchant reference, and `InvalidArgumentException` if the key cannot sign.

```ts
const body = WebServiceRequests.sale({
  merchantId: 10001n, terminalId: 20002n, terminalSerial: 'SN-WS-0001',
  amountMinorUnits: 1234, merchantReference: 'ORDER-1', secureHashKey: webServiceKey,
});
await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: body.toJson() });
```

### `WebServiceSecureHash`

Web Service request signing: the platform's `calcHash(obj, secret)`. `obj` is not the raw JSON body. It is the sorted `key=value&key=value` text of every top-level scalar except `secureHashValue`, following the same rules as Wi-Fi. That text is signed with HMAC-SHA256 under the hex-decoded secret and written as uppercase hex.

```ts
class WebServiceSecureHash {
  static readonly FIELD = 'secureHashValue';
  static readonly KEY_LABEL = 'Web Service secure hash key';

  static calcHash(message: string, secret: string): string;
  static compose(json: JsonObject): string;
  static sign(body: JsonObject, secret: string): string;
  static withHash(body: JsonObject, secret: string): JsonObject;
}
```

- `calcHash()`: HMAC-SHA256 under the hex-decoded secret, as uppercase hex. Returns `''` if the secret is empty or is not even-length hex.
- `compose()`: the sorted `key=value&...` signing text, excluding `secureHashValue`.
- `sign()`: `calcHash(compose(body), secret)`.
- `withHash()`: a copy of `body` with `secureHashValue` set (last). The input is left alone, and an earlier hash is replaced. An empty secret returns the body unchanged. **Throws** `InvalidArgumentException` if the secret cannot sign, so an unsigned body is never sent by mistake.

### `WebServiceRoutes`

Resolves the Hub URL and the fixed ECR operation paths for an environment. The Hub address itself is resolved by the SDK.

```ts
class WebServiceRoutes {
  constructor(environment: EcrEnvironment);
  hub(): string;
  path(operation: WebServiceOperation): string;
  url(operation: WebServiceOperation): string;
  pathFor(type: EcrTransactionType): string | null;
}
```

- `hub()`: the Hub base URL for the environment.
- `path()`: the operation's path.
- `url()`: the hub plus the path.
- `pathFor()`: the path for a transaction type, or `null` for a receipt, which has no Web Service operation.

### `WebServiceOperation`

Web Service ECR operations, with one REST endpoint each on the Hub.

```ts
class WebServiceOperation {
  static readonly Sale: WebServiceOperation;               // '/Ecr/Sale'
  static readonly Void: WebServiceOperation;               // '/Ecr/Void'
  static readonly Refund: WebServiceOperation;             // '/Ecr/Refund'
  static readonly TransactionStatus: WebServiceOperation;  // '/Ecr/Inquiry'
  static readonly CloseReceipt: WebServiceOperation;       // '/Ecr/closeReceipt'
  readonly value: string;

  static cases(): WebServiceOperation[];
  path(): string;
  label(): string;
  static forType(type: EcrTransactionType): WebServiceOperation | null;
}
```

- `label()`: `Sale`, `Void`, `Refund`, `Transaction status`, `Close receipt`.
- `forType()`: the REST operation for a transaction type, or `null` if it has none (receipts).

### `WebServiceApi`

Posts signed JSON bodies to the Web Service ECR endpoints. Every failure (no response, an empty body, invalid JSON, an HTTP error with nothing readable) comes back as a `success: false` envelope instead of an exception, so callers read every outcome the same way. When the request may have reached the Hub, the envelope carries `nextStep` `INQUIRE_BY_MERCHANT_REFERENCE`: a till must inquire, not treat it as a refusal and send the sale again.

```ts
class WebServiceApi {
  static readonly UNKNOWN_OUTCOME_STEP = 'INQUIRE_BY_MERCHANT_REFERENCE';
  constructor(config: EcrConfig, logger: EcrLogger, http?: HttpTransport | null);
  routes(): WebServiceRoutes;
  postJson(operation: WebServiceOperation, body: JsonObject): Promise<JsonObject>;
}
```

- `UNKNOWN_OUTCOME_STEP`: the wire value that `NextStep.InquireByMerchantReference` is read from.
- Constructor: `http` set to `null` uses `NodeHttpTransport` with `config.caBundlePath`.
- `postJson()`: posts `body` and resolves to the answer as JSON, never rejecting for a transport failure (an `HttpTransportException`). The deadline is `connectTimeout + responseTimeout`. A transport failure (`NO_RESPONSE`, or "Timed out after 2m 20s" when it timed out), an empty body or invalid JSON resolves to an envelope with `nextStep` set. An HTTP error that explains itself (a `message` or `errorList`), 5xx included, is returned as read, as the Windows SDK. An HTTP error with nothing readable gets `nextStep` only when its status is 5xx.

### `HttpTransport`, `HttpResponse`, `HttpTransportException`

Posts one JSON body and returns the answer. `NodeHttpTransport` is the default. Supply your own to route through a corporate proxy or for tests. The URL is always the one the SDK resolved for the environment.

```ts
interface HttpTransport {
  post(url: string, body: string, headers: Record<string, string>, connectTimeout: number, totalTimeout: number): Promise<HttpResponse>;
}

class HttpResponse {
  constructor(status: number, body: string | Uint8Array, reasonPhrase?: string);
  readonly status: number;
  readonly body: string | Uint8Array;
  readonly reasonPhrase: string;
  text(): string;
}

class HttpTransportException extends Error {
  constructor(message: string, timedOut?: boolean, options?: { cause?: unknown });
  readonly timedOut: boolean;
}
```

- `connectTimeout`: seconds to establish the connection. `totalTimeout`: seconds for the whole exchange, connection included.
- `post()` **rejects** with `HttpTransportException` if no answer was read: DNS, TLS, connection refused or reset, or the deadline passed (`timedOut: true`). The request may have reached the Hub, so the SDK treats this as an unknown outcome.
- `HttpResponse.body`: the answer as text, or as raw bytes so the SDK can refuse invalid UTF-8. `reasonPhrase` may be empty (HTTP/2). `text()` decodes for logs and emptiness checks only.

### `NodeHttpTransport`

HTTPS with Node's own `https` module. The TLS certificate and host name are always verified. Plain HTTP is accepted only because the URL is never the caller's: the SDK resolves it (always `https`), or a custom transport rewrites it, e.g. in tests. One fresh connection per call; redirects are not followed; no proxy is used.

```ts
class NodeHttpTransport implements HttpTransport {
  constructor(caBundlePath?: string | null);
}
```

- `caBundlePath`: a PEM file of extra CA certificates, added to Node's own (`tls.rootCertificates`). Throws `RuntimeException` if it cannot be read. `NODE_EXTRA_CA_CERTS` works too. **Never turn verification off:** the Hub's answer decides whether goods are handed over, and only TLS proves the answer came from the Hub.
- Errors read e.g. `Could not resolve host (ENOTFOUND)`, `Failed to connect: connection refused (ECONNREFUSED)`, `SSL certificate problem: … (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`, `Operation timed out after 140000 milliseconds`.

---

## EcrWireResponse

The unified ECR response envelope: `{ success, responseCode, message, data, errorList, nonce?, secureHash? }`. Legacy answers that nest the envelope under `ecrResponse`, or carry flat `approved` / `responseMessage` fields, are normalised.

```ts
class EcrWireResponse {
  constructor(
    success: boolean,
    responseCode: string,
    message: string,
    data: JsonObject | null,
    errorList: string[],
    nonce?: string,
    secureHash?: string,
  );

  static parse(json: JsonObject): EcrWireResponse;
  merchantReference(): string;
  terminalSerial(): string;
  displayMessage(): string;
  static displayMessageFromRaw(raw: string, fallback?: string): string;
}
```

- `parse()`: reads an envelope, including the legacy shapes.
- `merchantReference()`: `data.merchantReference`, then legacy `merchantReferenceId`, then `requestId`. Returns `''` if there is no `data`.
- `terminalSerial()`: `data.terminalSerial`, or `''`.
- `displayMessage()`: user-facing text: the `errorList` entries first (joined by newlines), then the message.
- `displayMessageFromRaw()`: user-facing text from raw JSON: `errorList` first, then `message`. Returns `fallback` if the text is empty, is not a JSON object, or says nothing. Never throws.

---

## EcrTransactionType

The operations a terminal can be asked to run. Each type declares what the caller has to supply, so a till's own form can be driven from these flags instead of repeating the rules. What the terminal will accept (whether the original exists, whether it can still be voided) is decided by the terminal. Manual settlement is not offered: it is waiting on the POS-599 contract.

```ts
class EcrTransactionType {
  static readonly Sale: EcrTransactionType;
  static readonly Void: EcrTransactionType;
  static readonly Refund: EcrTransactionType;
  static readonly Inquiry: EcrTransactionType;
  static readonly Receipt: EcrTransactionType;
  static readonly CloseReceipt: EcrTransactionType;
  readonly value: 'Sale' | 'Void' | 'Refund' | 'Inquiry' | 'Receipt' | 'CloseReceipt';

  static cases(): EcrTransactionType[];
  static tryFrom(value: string): EcrTransactionType | null;
  static menuOptions(): EcrTransactionType[];
  messageType(): string;
  displayName(): string;
  requiresAmount(): boolean;
  requiresOriginalStan(): boolean;
  requiresOriginalDate(): boolean;
  movesMoney(): boolean;
  allowsOtherTerminal(): boolean;
}
```

| Case | Meaning | `messageType()` |
|---|---|---|
| `Sale` | An ordinary purchase. | `SALE` |
| `Void` | Cancels an earlier transaction for its full amount. No card is presented. | `VOID` |
| `Refund` | Returns money against an earlier transaction, in full or in part. The cardholder presents the card. | `REFUND` |
| `Inquiry` | Asks what became of an earlier transaction. Read-only and safe to repeat. | `INQUIRY` |
| `Receipt` | Asks for an earlier transaction's e-receipt URL. Wi-Fi only. | `RECEIPT` |
| `CloseReceipt` | Asks the terminal to put its receipt away and return to idle. | `CLOSE_RECEIPT` |

- Instances are singletons: compare with `===` (or use them in a `switch`).
- `tryFrom()`: the type with exactly this value, or `null`.
- `menuOptions()`: the operations an operator picks from, in the order a till usually offers them: Sale, Void, Refund, Inquiry. Receipt and CloseReceipt are left out by design.
- `messageType()`: the value carried in the message's `messageType` field.
- `displayName()`: the value, except `Close receipt` for `CloseReceipt`.
- `requiresAmount()`: whether the caller supplies an amount (Sale, Refund). A void takes the original's amount, which only the terminal knows.
- `requiresOriginalStan()`: whether the caller identifies an earlier transaction by its receipt number (STAN): Void, Refund, Inquiry, Receipt.
- `requiresOriginalDate()`: whether the caller supplies the original's date, because a receipt number is unique only within a terminal's day: Refund, Inquiry, Receipt.
- `movesMoney()`: whether the operation moves money: Sale, Void, Refund.
- `allowsOtherTerminal()`: whether the caller may name a different terminal the original was taken on (Wi-Fi only). The same set as `requiresOriginalStan()`.

---

## Json (supporting types)

The strict JSON types used in a few public signatures: `EcrWireResponse.data`, `WebServiceRequests` return values, `WebServiceApi.postJson()`, and `WebServiceSecureHash`.

```ts
type JsonValue = string | boolean | null | number | bigint | JsonNumber | JsonObject | JsonArray;

class Json {
  static readonly MAX_DEPTH = 64;
  static parseObject(text: string | Uint8Array): JsonObject;   // throws JsonException
  static parse(input: string | Uint8Array): JsonValue;         // throws JsonException
  static write(value: JsonValue): string;
  static pretty(value: JsonValue): string;
  static content(value: JsonValue): string;
  static isScalar(value: JsonValue): boolean;
  static compose(json: JsonObject, excluded: string): string;
}

class JsonObject implements Iterable<[string, JsonValue]> {
  constructor(values?: Record<string, unknown> | Iterable<[string, unknown]>);
  has(key: string): boolean;
  get(key: string): JsonValue;            // null when absent
  set(key: string, value: unknown): this;
  remove(key: string): this;
  keys(): string[];
  count(): number;
  str(key: string): string;
  obj(key: string): JsonObject | null;
  arr(key: string): JsonArray | null;
  flag(key: string): boolean;
  strictBool(key: string): boolean | null;
  toJson(): string;
  clone(): JsonObject;
}

class JsonArray implements Iterable<JsonValue> {
  constructor(items?: readonly unknown[]);
  items(): JsonValue[];
  count(): number;
  readonly length: number;
  clone(): JsonArray;
}

class JsonNumber {
  constructor(raw: string);
  readonly raw: string;
  toString(): string;
}

class JsonException extends Error {}
```

- `Json`: the one JSON reader and writer the SDK uses on the wire. It is strict on purpose. It keeps numbers exactly as written, and refuses repeated keys, trailing commas, comments, single quotes, invalid UTF-8 (bytes are decoded with a fatal decoder), lone surrogates and a byte order mark. `MAX_DEPTH` matches System.Text.Json, which the Windows SDK parses with. `parseObject()` requires exactly one object. `write()` writes compact JSON with PHP's escapes (non-ASCII, `/`, `<`, `>`, `&` as themselves; ` `/` ` escaped) and throws `InvalidArgumentException` for a string with a lone surrogate. `pretty()` indents by two spaces, for logs. `compose()` builds the sorted `key=value&...` signing text of the scalar entries, leaving out `excluded`.
- `JsonObject`: keeps keys in order and values exactly as they arrived. `set()` accepts `string`, `boolean`, `null`, a safe-integer `number`, `bigint`, `JsonNumber`, `JsonObject` or `JsonArray`, and throws `InvalidArgumentException` for a fractional number (`JSON values must not be floats; use JsonNumber or a string`) or any other type, because money must never pass through a float. `str()` reads any scalar as text, and reads JSON `null` or a missing field as `''`; a nested object or array reads as compact JSON. `flag()` counts only `true`/`false` (or their text); anything else is `false`. `clone()` is a deep copy.
- `JsonNumber`: a JSON number kept exactly as written, because a signature is computed over the number's text.
- `JsonException`: the text is not the single, strict JSON value it was expected to be.
