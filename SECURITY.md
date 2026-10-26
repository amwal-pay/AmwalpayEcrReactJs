# Security

## Reporting

Report a vulnerability privately to the Amwal Pay security contact, not in a public issue. Include the
SDK version (`EcrSdk.VERSION` from `@amwalpay/ecr-js`) and steps to reproduce. Never include a real
key, card number or customer data.

## What the SDK protects

- **Requests** to the terminal are signed (HMAC-SHA256, hex-decoded shared key) and carry a 128-bit
  nonce, so a captured request cannot be replayed and a device on the network cannot issue one.
- **Answers** from the terminal are believed only when signed with the same key and bound to the
  request's nonce; anything else is an unknown outcome, never an approval.
- **Web Service** uses HTTPS with certificate and host-name verification always on, and signed bodies.
  Redirects are not followed.
- **Unknown outcomes are never declines**, and the financial guard blocks new money movement until
  they are reconciled, so a lost answer cannot become a double charge.
- **Secrets**: `EcrConfig` keeps its key in a private field: it does not appear in `console.log`,
  `util.inspect`, object spread or `structuredClone`, and `JSON.stringify(config)` throws. Logs show
  the key only as `configured`.
- **Card data**: the terminal sends only masked PANs; every log line is additionally passed through a
  redactor that masks Luhn-valid card numbers and PIN, CVV, track, token and password fields.

## Where the SDK runs

`@amwalpay/ecr-js` runs on the server (Node.js), never in a browser: a browser cannot open a TCP
socket to the terminal, and anything shipped to a browser is readable by whoever uses it. The signing
keys stay on the server. `@amwalpay/ecr-react` holds no key and never talks to a terminal or the Hub:
it talks only to your own server's JSON API, which the example implements.

## What the integrator must do

- Keep keys out of source control, logs, URLs and front-end bundles; load them from the environment or
  a secrets store.
- Make `stateDirectory` private to the server process, on a local disk.
- Protect any page or API route that can start a payment with authentication; the example web till is
  loopback-only and has none.
- Treat SDK logs as transaction records.

## Known limitation of the agreed format

The Wi-Fi signature covers top-level fields only; nested `data` (amounts, RRN, masked PAN in the answer)
is not signed. The till acts on `success`, `message` and `nonce`, which are. This matches the terminal,
the Windows SDK and the PHP SDK.

The repository is checked for keys and card numbers by `tools/check-secrets.mjs` in CI.
