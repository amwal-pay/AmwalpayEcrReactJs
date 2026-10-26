# Wire protocol

What `@amwalpay/ecr-js` puts on the wire and how it reads the answers. It is the same contract as
`AmwalPay.Ecr` 1.0.2 (.NET) and `amwalpay/ecr-php` 1.0.0-rc.1; the known-answer vectors below are
pinned by `packages/ecr-js/tests/unit` byte for byte with those SDKs. You need this page only to
debug a terminal or the Hub, or to build a request yourself.

## Wi-Fi/LAN

### Framing

One TCP connection carries one request and one answer: connect, send, wait, read, close.

```
+--------+--------+------------------------------+
| len hi | len lo | len bytes of UTF-8 JSON      |
+--------+--------+------------------------------+
```

- A 2-byte **big-endian unsigned** length, then that many bytes. Maximum 65 535 bytes; a longer
  request is refused before connecting (`EcrFrames.wrap()`).
- JSON is compact, UTF-8 without BOM; non-ASCII, `<`, `>`, `&` and `/` are written as themselves
  (the same escapes as PHP's `json_encode(JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)`,
  including ` ` and ` `).
- A zero length is an empty message (malformed). A stream that ends early is a closed connection.

### Request

Fields that do not apply are **left out**, never sent empty: the terminal reads a field's presence as
meaning the operation uses it.

| Field | Sale | Void | Refund | Inquiry | Receipt | Close receipt |
|---|---|---|---|---|---|---|
| `version` (number `1`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `messageType` | `SALE` | `VOID` | `REFUND` | `INQUIRY` | `RECEIPT` | `CLOSE_RECEIPT` |
| `merchantReference` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `terminalSerial`, `currencyCode`, `transactionDateTime` (`yyyyMMddHHmmss`), `ecrId` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `amount` (12 digits, minor units) | ✓ | | ✓ | | | |
| `stan` (6 digits) | | ✓ | ✓ | by receipt | ✓ | |
| `originalTerminalId` | | when given | when given | when given | when given | |
| `originalTransactionDate` (`yyyyMMdd`) | | | ✓ | when given | when given | |
| `originalMerchantReference` | | | | by reference | | |
| `nonce`, `secureHash` | when signed | when signed | when signed | when signed | when signed | when signed |

Example, unsigned, field order as sent:

```json
{"version":1,"messageType":"SALE","merchantReference":"ORD-1","terminalSerial":"SN-WIFI-0001","currencyCode":"512","transactionDateTime":"20261025101500","ecrId":"ECR01","amount":"000000001234"}
```

`transactionDateTime` is formatted in `EcrConfig.timezone`, or the Node process's local time zone
when that is null.

### Signing (`secureHash`)

1. Take every **top-level** entry whose value is a string, number or boolean. Drop nulls, objects,
   arrays, and `secureHash` itself.
2. Sort by key, byte for byte on the UTF-8 text (`B` before `a`).
3. Join as `key=value&key=value`; numbers and booleans as written (`version=1`, `success=true`).
4. HMAC-SHA256 of that text under the **hex-decoded** key (32 hex characters = 16 bytes), as
   uppercase hex.

A request first gets `nonce` (32 uppercase hex, 128 random bits from `crypto.randomBytes`), then
`secureHash` over everything including the nonce. The terminal refuses a nonce it has seen.

Known answer: `amount=000000001234&messageType=SALE&version=1` under the key `aa…aa` (32 × `a`) is
`9425F9125C871197E5D0A6B88E4F9E6E29D1E0E49C96AA3D88A5E34D6FB9D45A`.

### Answer

```json
{"success":true,"responseCode":"00","message":"Approved","data":{...},"errorList":[],"nonce":"<echoed>","secureHash":"<signature>"}
```

When the till has a key, an answer is believed only if `secureHash` verifies under the same key
(compared in constant time with `crypto.timingSafeEqual`, hex case ignored) **and** `nonce` equals
the request's. Otherwise it is `Unauthenticated`. Note that `data` is not covered by the signature
(documented limitation of the agreed format).

The reader also accepts the legacy shapes: the envelope nested under `ecrResponse`, and flat
`approved` / `responseMessage` / `amount` (minor units) fields.

The reader is strict (`Json`, not `JSON.parse`): a byte-order mark, a repeated key anywhere,
trailing commas, comments, single quotes, a bare value or array, nesting deeper than 64: all are
malformed, and the error quotes the whole answer. Invalid UTF-8 in a Wi-Fi answer is not a refusal:
as .NET's `Encoding.UTF8.GetString`, each invalid sequence becomes U+FFFD. Numbers keep their
written text (`961.10` stays `961.10`, as `JsonNumber`) so signatures verify. A request body over
65 535 bytes is refused before it is sent.

Answers are read whatever `version` they declare, as the Windows SDK reads them.

## Web Service (Amwal Hub)

### Endpoints

`POST` with `Content-Type: application/json; charset=utf-8` and `Accept: application/json` to the
Hub of the configured environment (SIT, UAT, PROD; addresses resolved inside the SDK):

| Operation | Path |
|---|---|
| Sale | `/Ecr/Sale` |
| Void | `/Ecr/Void` |
| Refund | `/Ecr/Refund` |
| Inquiry (by receipt or by reference) | `/Ecr/Inquiry` |
| Close receipt | `/Ecr/closeReceipt` |

No e-receipt endpoint exists. TLS certificates and host names are always verified
(`rejectUnauthorized: true`); redirects are not followed.

### Bodies

Common fields, in this order: `version` (number), `messageType`, `merchantId` (number), `terminalId`
(number), `terminalSerial`, `ecrId`, `merchantReference`, `currencyCode`, `transactionDateTime`,
`requestDateTime` (same value; the Hub requires both). Then:

| Operation | Extra fields |
|---|---|
| Sale | `amount` |
| Void | `stan`, `originalMerchantReference` (= this void's own reference), `originalTerminalId` (number) |
| Refund | `amount`, `stan`, `originalTransactionDate`, `originalMerchantReference` (= this refund's reference), `originalTerminalId` |
| Inquiry by receipt | `stan`, `originalTransactionDate`, `originalMerchantReference: ""`, `originalTerminalId` |
| Inquiry by reference | `stan: ""`, `originalTransactionDate`, `originalMerchantReference`, `originalTerminalId` |
| Close receipt | no `messageType`, no `currencyCode`; `originalMerchantReference` = the sale, void or refund being dismissed |

`merchantId`, `terminalId` and `originalTerminalId` are JSON numbers written from `bigint`, so a
64-bit ID is never rounded.

Signed with `secureHashValue`: the same composition as Wi-Fi, excluding `secureHashValue`, under the
**Web Service** key. Known answer: the sale for merchant `8899`, terminal `999`, serial `QQW`,
reference `EA5C14BDB0A2`, amount `111`, time `20260826115847` under the key `bb…bb` (64 × `b`) is
`FEF8D18506A6AC035DC825A1DBA4413EE885898BBCE27EE4A681683FFAADC61E`. The body, as sent:

```json
{"version":1,"messageType":"SALE","merchantId":8899,"terminalId":999,"terminalSerial":"QQW","ecrId":"ECR01","merchantReference":"EA5C14BDB0A2","currencyCode":"512","transactionDateTime":"20260826115847","requestDateTime":"20260826115847","amount":"000000000111","secureHashValue":"FEF8D18506A6AC035DC825A1DBA4413EE885898BBCE27EE4A681683FFAADC61E"}
```

The Hub's answers are not signed in the POS-552 contract; TLS authenticates the Hub.

### Answers that are not answers

The SDK turns every failure into an envelope so it is read one way:

| What happened | Envelope | Result |
|---|---|---|
| Network error, TLS failure, DNS | `NO_RESPONSE` + `nextStep: INQUIRE_BY_MERCHANT_REFERENCE` | `Failed` (`Timeout`: every `NO_RESPONSE` reads as one, as in the Windows SDK) |
| Client deadline passed | `NO_RESPONSE`, "Timed out after 2m 20s", `nextStep` | `Failed` (`Timeout`) |
| Empty body | HTTP status as `responseCode`, `nextStep` | `Failed` (`ConnectionLost`) |
| Not a single strict JSON object | HTTP status, "not valid JSON", `nextStep` | `Failed` (`ConnectionLost`) |
| HTTP 5xx with nothing readable | status, reason phrase, `nextStep` | `Failed` (`ConnectionLost`) |
| HTTP 5xx with a readable envelope | that envelope, as read | as the envelope says (usually `Declined`) |
| HTTP 4xx with a readable envelope | that envelope | `Declined` (the Hub refused it) |
| HTTP 4xx with nothing readable | status, reason phrase, no `nextStep` | `Declined` |
| Hub answers `nextStep: INQUIRE_BY_MERCHANT_REFERENCE` | as sent | `Failed` (`Timeout` when `NO_RESPONSE` or "timeout") |

For an inquiry, an envelope with `nextStep` and no `data` is `InquiryFailed`, never `NotFound`.

## Timeouts

| | Connect | Answer | Total |
|---|---|---|---|
| Wi-Fi | 10 s | 120 s (+ one more for the automatic inquiry after a lost answer) | |
| Web Service | 10 s | 130 s | 140 s (one HTTP deadline) |
