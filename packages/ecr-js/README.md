# @amwalpay/ecr-js

Drive an Amwal POS terminal from a Node.js till: sale, void, refund, inquiry, e-receipt and close
receipt, over **Wi-Fi/LAN** (TCP to the terminal) or the **ECR Web Service** (HTTPS to the Amwal Hub).
The same protocol, signing, result semantics and payment-safety rules as `AmwalPay.Ecr` 1.0.2 (.NET)
and `amwalpay/ecr-php` 1.0.0-rc.1.

Node.js 18.18 or later, ESM. Runs on the server only: the signing keys never reach a browser. For a
React front end, see `@amwalpay/ecr-react`.

```ts
import { Approved, Declined, EcrConfig, EcrSessions, Failed, LanLink } from '@amwalpay/ecr-js';

const plan = EcrSessions.plan(new LanLink('192.168.1.50'), new EcrConfig({ secureHashKey: process.env.WIFI_KEY }));
if (!plan.isReady()) throw new Error(plan.issues().join('\n'));
const session = EcrSessions.open('SN-WIFI-0001', plan);

const reference = EcrSessions.newMerchantReference(); // save it with the order first
const result = await session.sale('1.234', reference);

if (result instanceof Approved) console.log('Approved', result.amount, result.rrn);
else if (result instanceof Declined) console.log('Declined', result.reason);
else if (result.failure.outcomeUnknown()) console.log('Outcome unknown: inquire by', result.merchantReference);
else console.log('Not sent:', result.failure.message);
```

| | |
|---|---|
| Integration guide | [docs/integration-guide.md](docs/integration-guide.md) |
| API reference | [docs/api-reference.md](docs/api-reference.md) |
| Wire protocol | [docs/protocol.md](docs/protocol.md) |
| Parity with .NET and PHP | [docs/parity.md](docs/parity.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Security | [SECURITY.md](SECURITY.md) |
| Changes | [CHANGELOG.md](CHANGELOG.md) |
