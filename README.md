# Amwal ECR SDK for JavaScript and React

Two packages that drive an Amwal POS terminal from a JavaScript till: sale, void, refund, inquiry,
e-receipt and close receipt. **Wi-Fi/LAN** talks to the terminal's ECR port on the shop network.
**ECR Web Service** talks HTTPS to the Amwal Hub. Card data stays on the terminal.

| Package | Runs in | What it does |
|---|---|---|
| [`@amwalpay/ecr-js`](packages/ecr-js) | Node.js (the till's server) | The SDK: protocol, signing, results, payment-safety rules. |
| [`@amwalpay/ecr-react`](packages/ecr-react) | The browser (React 18+) | Hooks and components for the till's screens, talking to your server. |

The SDK runs on the server because a browser cannot open a TCP socket to a terminal, and because the
signing keys must never reach a browser. The React package holds no key: it talks only to your own
server's JSON API (the example implements that API with `@amwalpay/ecr-js`).

`@amwalpay/ecr-js` is a port of `amwalpay/ecr-php` 1.0.0-rc.1 and has the same protocol, signing,
result semantics and payment-safety rules as the Windows SDK `AmwalPay.Ecr` 1.0.2 (.NET). It passes
the same known-answer vectors. JavaScript-specific differences (async calls, options objects, the
lock file) are listed in [docs/parity.md](docs/parity.md).

Version **1.0.0-rc.1**: SIT release candidate. See [docs/release.md](docs/release.md) before using it in production.

| | |
|---|---|
| Integration guide | [docs/integration-guide.md](docs/integration-guide.md) |
| API reference | [docs/api-reference.md](docs/api-reference.md) |
| React package | [packages/ecr-react/README.md](packages/ecr-react/README.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Supported versions | [docs/compatibility.md](docs/compatibility.md) |
| Wire protocol | [docs/protocol.md](docs/protocol.md) |
| Runnable example | [examples/README.md](examples/README.md) |
| Release and rollback | [docs/release.md](docs/release.md) |

## Install

Node.js 18.18 or later. ESM only.

```powershell
npm install --save-exact @amwalpay/ecr-js@1.0.0-rc.1
npm install --save-exact @amwalpay/ecr-react@1.0.0-rc.1   # for a React front end
```

Pin the exact version. Until the packages are published, install the built artifacts; see
[docs/release.md](docs/release.md#roll-out).

## Open a session

Open one session per terminal and keep it. Every operation goes through it.

### Wi-Fi

The terminal shows its IP address and port on its idle screen. The till and the terminal must be
on the same network.

```ts
import { EcrConfig, EcrSessions, LanLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(
  new LanLink('192.168.1.50', 9100),
  new EcrConfig({ secureHashKey: wifiKey, stateDirectory: 'C:\\ProgramData\\MyTill\\ecr' }),
);
if (!plan.isReady()) throw new Error(plan.issues().join('\n'));
const session = EcrSessions.open('SN-WIFI-0001', plan);
```

### Web Service

```ts
import { EcrEnvironment, WebServiceLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(
  new WebServiceLink('10001', '20002'),
  new EcrConfig({ secureHashKey: webServiceKey, environment: EcrEnvironment.UAT }),
);
const session = EcrSessions.open('SN-WS-0001', plan);
```

The Hub address stays inside the SDK: choose `SIT` (default), `UAT` or `PROD`. The Wi-Fi key and the
Web Service key are two different secrets; never hard-code either.

## Take a payment

Amounts are major units: a string (`'1.234'`), a number or a `bigint`, rounded like the Windows
SDK's `decimal`. Make the merchant reference yourself and save it with the order **before** the call: it is how you find the payment if
the answer is lost.

```ts
import { Approved, Declined, Failed } from '@amwalpay/ecr-js';

const reference = EcrSessions.newMerchantReference();   // or your own: 32 printable ASCII, no space, & or =
await saveOrder(orderId, reference);

const result = await session.sale('1.234', reference);

if (result instanceof Approved) {
  await record(result.merchantReference, result.amount, result.rrn, result.authCode);
  if (result.partialApproval) await collectBalance(result.requestedAmount, result.amount);
} else if (result instanceof Declined) {
  show(result.reason);
} else if (result instanceof Failed && result.settled()) {
  await apply(result.recovered.transaction);             // Wi-Fi asked the terminal by itself
} else if (result instanceof Failed && result.failure.outcomeUnknown()) {
  await markUnresolved(result.merchantReference);       // inquire by reference; never resend
} else {
  show(result.failure.message);                         // nothing was sent
}
```

| Result | Meaning |
|---|---|
| `Approved` | Money moved. `amount` is what was taken or returned. With `partialApproval`, collect the difference. |
| `Declined` | The terminal answered and refused. No money moved. |
| `Failed`, `failure.outcomeUnknown()` false | Nothing was sent: unreachable, busy, an earlier unknown outcome to reconcile, or a bad configuration. |
| `Failed`, `failure.outcomeUnknown()` true | The request went out and the answer did not settle it: timeout, lost connection, unreadable or unauthenticated answer. **The payment may have completed.** |
| `Failed.settled()` | Wi-Fi only: the SDK inquired once and found the transaction (`recovered`). |
| `InvalidRequestException` | Refused before anything was sent: bad amount, reference, receipt number or date. |

## Other operations

```ts
await session.void('24', { merchantReference: 'ORDER-1001-V1' });
await session.refund('1.000', '24', '20261019', { merchantReference: 'ORDER-1001-R1' });
await session.inquire('24', '20261019');                                 // Found / NotFound / InquiryFailed
await session.inquireByReference('ORDER-1001-1');                         // after a lost answer
await session.receipt('24', '20261019');                                  // Wi-Fi: e-receipt URL for a QR code
await session.closeReceipt({ originalMerchantReference: 'ORDER-1001-1' }); // the cashier's Close receipt button
```

## The till's screens in React

The page never talks to a terminal: it asks your server, which runs the payment with
`@amwalpay/ecr-js` and lets the page watch it. Closing the tab never cancels a payment.

```tsx
import { AmountInput, EcrProvider, createEcrClient, useMeta, useTransaction } from '@amwalpay/ecr-react';

const client = createEcrClient({ baseUrl: '' });   // your server's /api, same origin

export function App() {
  return <EcrProvider client={client}><Till /></EcrProvider>;
}
```

See [packages/ecr-react/README.md](packages/ecr-react/README.md) for every hook and component, and
[examples/](examples/README.md) for the complete till: the server, and the page built on the hooks.

## Payment safety, enforced

- **Unknown outcome is never a decline.** Inquire by merchant reference; charge again only after the
  inquiry says `Declined`, or the terminal confirms the attempt did not complete.
- **Opt-in financial guard** (`guardFinancialOperations: true`; off by default, as the Windows SDK
  has none). With it on:
- **One sale, void or refund per terminal at a time**, across all processes on the machine. A second
  one gets `Failed` with `Busy`; nothing is sent.
- **A merchant reference is used once.** Reusing one throws `DuplicateMerchantReferenceException`.
- **No new money movement while an outcome is unknown.** The terminal answers `Unresolved` until
  `session.reconcile()` (or an inquiry by that reference) settles it, or an operator records how it
  was confirmed with `session.markResolved(reference, note)`.
- **Every Wi-Fi answer is verified** against the till's key and the request's nonce; an answer that
  fails is `Unauthenticated` (outcome unknown), never believed.
- **Web Service waits up to 140 s** (10 s connect + 130 s answer), as the Windows SDK.
- **Logs never carry the key**; card numbers, PIN, CVV and tokens are masked on every line.

Run `await session.reconcile()` at start-up. Point `stateDirectory` at a durable, private folder.

## Develop

```powershell
npm install
npm run build                 # both packages
npm test                      # unit + integration (real TCP, real HTTP, child processes) + React
npm run check:secrets         # no keys or card numbers in the repository
npm run pack:artifacts        # dist/amwalpay-ecr-js-<version>.tgz, dist/amwalpay-ecr-react-<version>.tgz + .sha256
```

Manual settlement is not included: it waits on the POS-599 contract. USB/cable is not offered.
