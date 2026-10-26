# Troubleshooting

Find the symptom, then the cause. Turn on logging first
(`EcrSessions.open(serial, plan, { logger: EcrLogger.from((line) => console.log(line)) })`): the
lines show what was sent and received, with the key shown only as `configured`.

## Before anything is sent

| Symptom | Cause and fix |
|---|---|
| `plan.issues()`: *Wi-Fi/CABLE secure hash key is not configured* / *Web Service secure hash key is not configured* | The key for **this link** is empty. Wi-Fi and Web Service use different keys; check which one `signingKeyLabel()` names. |
| *Secure hash key must be an even-length hex string of at least 16 characters* | A space, a newline, a missing character, or a key that is not hex. Paste it again from Amwal. |
| *Merchant ID must be numeric* / *Terminal ID must be numeric* | Web Service IDs are whole numbers (as `long.TryParse`: 64-bit, white space and a sign allowed). |
| `InvalidArgumentException` from `new EcrConfig({...})` | The message names the setting: timeouts positive, `minorUnitDigits` 0-4, port 1-65535, key hex, timezone a zone name like `Asia/Muscat` (not `+04:00`). |
| `InvalidArgumentException`: *EcrConfig has no setting named …* | A misspelt key in `config.with({ ... })`. |
| `LogicException`: *EcrConfig holds a signing secret and cannot be serialized* | `JSON.stringify` reached an `EcrConfig` (a cache, a session, a queue message, a log). Store the settings you need, never the config. |
| `InvalidRequestException`: amount | The amount is not a number: pass `'1.234'`, `5`, `5n` or `1.234`, with no thousands separator or currency sign. |
| `OverflowException` | The amount does not fit the 64-bit integer the Web Service carries. |
| `InvalidRequestException`: merchant reference | At most 32 characters, printable ASCII, no space, `&` or `=`. |
| `InvalidRequestException`: receipt number | A void, refund, inquiry or receipt was given a blank receipt number. |
| `DuplicateMerchantReferenceException` | This reference was already sent to this terminal. If its outcome is unknown, inquire by it; never resend. Otherwise use a new reference. |
| `Failed` + `Busy` | Another sale, void or refund is running on this terminal (another request, browser tab or server process). Wait. Nothing was sent. |
| `Failed` + `Busy` that never clears | A lock file `terminal-<hash>.lock` in `stateDirectory` belongs to a process that is still running (another till server, or a hung one), or to another host name. Stop that process; a lock whose owner process is gone is taken over automatically. |
| `Failed` + `Unresolved` | An earlier payment on this terminal has an unknown outcome. Run `await session.reconcile()`, or inquire by the reference named in the message. If the terminal keeps answering "not found", confirm with the terminal's report or Amwal, then `markResolved()`. |
| `RuntimeException`: *ECR state folder cannot be created* / *journal could not be saved* | `stateDirectory` must exist or be creatable, on a local disk, writable by the account the Node process runs as (a Windows service account, a container user). |
| `RuntimeException`: *The ECR transaction journal could not be locked* | Another process held the journal's write lock for 10 s. Check for a hung process on the same `stateDirectory`; a `.json.lock` file left by a dead process is taken over. |
| *journal is corrupt and must be checked by hand* | Do not delete it blindly: it lists payments whose outcome is unknown. Read the file, reconcile each reference, then restore a valid file. |

## Wi-Fi

| Symptom | Cause and fix |
|---|---|
| `Unreachable`: *Connection timed out after 10000 ms* | Wrong IP, terminal off, or on another network. Check the IP under the card logos on the terminal; till and terminal on the same Wi-Fi; the Windows network profile is **Private**. |
| `Unreachable`: *Connection refused: nothing is listening on that port (ECONNREFUSED)* | The terminal is not in ECR (Wi-Fi) mode, or the port is wrong (default 9100). |
| `Unreachable`: *No route to host (EHOSTUNREACH)* / *Network is unreachable (ENETUNREACH)* | The till has no route to the terminal's subnet: another Wi-Fi, a VPN, or a guest network that isolates clients. |
| Probe fails from the service but works from a terminal window | Windows Firewall rule for `node.exe` (outbound TCP to the terminal's port), or the service runs under an account or container with no access to the shop LAN. |
| Every answer is `Unauthenticated`: *not signed with this terminal's key* | The till's Wi-Fi key and the terminal's key differ. Re-enter the key on the till; confirm with Amwal which key the terminal has. Each one is an unknown outcome: reconcile before taking another payment. |
| `Unauthenticated`: *belongs to a different request* | An answer to an earlier request, or a device replaying traffic. Reconcile; if it repeats, investigate the network. |
| `Timeout` after 2 minutes | The cardholder did not finish, or the terminal lost its backend connection. Outcome unknown: the SDK inquires once; reconcile if it is still unknown. |
| `ConnectionLost`: *Terminal closed the connection…* / *Connection reset by the terminal (ECONNRESET)* | Wi-Fi dropped or the terminal restarted mid-transaction. Same as a timeout. |
| `CloseReceiptRefused` | Firmware without `CLOSE_RECEIPT`. The receipt stays up; press back on the terminal. |
| `ReceiptUnavailable` *The receipt could not be generated* | The backend has not published one. Try again later; the transaction is unaffected. |

## Web Service

| Symptom | Cause and fix |
|---|---|
| `Failed` *SSL certificate problem: … (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)* or *SELF_SIGNED_CERT_IN_CHAIN* | A TLS-inspecting proxy or private CA sits between the till and the Hub. Pass its root certificate (PEM) as `caBundlePath`, or set `NODE_EXTRA_CA_CERTS` for the process. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `Failed` *Could not resolve host (ENOTFOUND)* / *Failed to connect* | Outbound HTTPS blocked: proxy, firewall or DNS. The built-in transport does not use `HTTPS_PROXY`; behind a proxy, pass an `HttpTransport` that goes through it. This is an unknown outcome: the request may have reached the Hub before the failure. |
| `Failed` *Timed out after 2m 20s* | The Hub did not answer within 140 s. Reconcile by reference. If the page gives up before 140 s, something in front of the server (reverse proxy, load balancer) has a shorter timeout — but the payment itself carries on in the server. |
| `Declined` *secureHashValue mismatch* / HTTP 401 | Wrong key: the Web Service key, not the Wi-Fi key. The Hub refused the request; nothing moved. |
| `Declined` *RequestDateTimeIsRequired*, or "The request timestamp is outside the accepted window" | The till's clock or time zone disagrees with the terminal's. Check the machine's clock and time zone (Windows: Settings > Time & language), and that `TZ` is not set to another zone for the Node process. Leave `EcrConfig` `timezone` unset so the SDK uses the machine's local time, as the Windows SDK does. |
| `NotFound` right after a lost sale | The Hub has no record yet, or the date filter excluded it: inquire by reference without a date. Not proof that nothing was charged. |
| `InquiryFailed` | The lookup itself failed (network). Inquire again: it moves no money. |

## Node.js and the server

| Symptom | Cause and fix |
|---|---|
| The browser's request fails after ~60 s, 100 s or 120 s during a sale | A proxy, load balancer or `server.requestTimeout` ended the HTTP request. Keep the payment off the request (start it, return 202, poll); raise proxy idle timeouts above 180 s. The payment may have completed: reconcile. |
| A payment was cut off when the server restarted | A process manager (pm2, a service wrapper, a container orchestrator) killed the process mid-wait. On `SIGTERM`, stop accepting requests and await running payments before exiting; give the manager a stop timeout above 180 s. Reconcile on start-up. |
| `transactionDateTime` is hours off | `EcrConfig` `timezone` or the `TZ` environment variable names another zone, or the machine's time zone is wrong. `EcrSdk.localTimeZone()` shows the zone the SDK reads. |
| `ERR_REQUIRE_ESM` | The package is ESM only: use `import`, or `await import('@amwalpay/ecr-js')` from CommonJS. |
| The bundler cannot resolve `node:net`, `node:crypto` or `node:fs` | `@amwalpay/ecr-js` is a server package. Use `@amwalpay/ecr-react` in the page and call your server. |
| Two servers both sold on one terminal at once | The lock files only cover one machine. Implement `TerminalLock` and `TransactionJournal` over shared storage. |

## Getting help

Send Amwal: the SDK version (`EcrSdk.VERSION`), the Node version (`node --version`), the Windows
version, terminal serial and firmware, the merchant reference, the time, and the SDK log lines for
that reference. Never send the key; the log never contains it.
