#!/usr/bin/env node
/**
 * Wi-Fi, start to finish: open a session, sell, read the result, recover a
 * lost answer, close the receipt. Copy from here into your own till.
 *
 *   $env:AMWAL_ECR_WIFI_KEY = '<hex key>'     (PowerShell)
 *   node cli/wifi-quickstart.mjs <terminal-ip> [port] [amount]
 *
 * No terminal? Start the fake one first, with the same key:
 *   node ../tools/fake-pos-server.mjs --key <hex key> --port 19100
 *   node cli/wifi-quickstart.mjs 127.0.0.1 19100 1.234
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Approved, Declined, EcrConfig, EcrLogger, EcrSessions, Failed, Found, InquiryFailed, LanLink, NotFound, ReceiptClosed,
} from '@amwalpay/ecr-js';

const [host = '127.0.0.1', port = '19100', amount = '1.234'] = process.argv.slice(2); // the amount is a string, never a float
const here = dirname(fileURLToPath(import.meta.url));

// 1. Plan: validates the address and the key without connecting.
const plan = EcrSessions.plan(
  new LanLink(host, Number(port)),
  new EcrConfig({
    ecrId: 'TILL-01',
    stateDirectory: join(here, '..', 'var', 'state'), // the SDK's lock and journal
  }),
  process.env.AMWAL_ECR_WIFI_KEY ?? '',
);
if (!plan.isReady()) {
  console.error(plan.issues().join('\n'));
  process.exit(1);
}

// 2. Open one session for the terminal and keep it.
const session = EcrSessions.open('SN-WIFI-0001', plan, { logger: EcrLogger.from(() => {}) });

// 3. Probe before a sale: proves the port answers (not that the terminal is idle).
const probe = await session.probeReachability();
if (probe !== null && !probe.reachable) {
  console.error(`Terminal not reachable: ${probe.endpoint} (${probe.error})`);
  process.exit(1);
}

// 4. Make the reference, save it with the order, THEN send.
const reference = EcrSessions.newMerchantReference();
console.log(`Order reference ${reference} (saved before sending)`);

const result = await session.sale(amount, reference);

// 5. Read the result. Never resend a Failed sale: inquire.
if (result instanceof Approved) {
  console.log(`Approved ${result.amount} · RRN ${result.rrn} · Auth ${result.authCode} · ${result.maskedPan}`);
  if (result.partialApproval) {
    console.log(`Partial approval: asked ${result.requestedAmount}, took ${result.amount}. Collect the difference.`);
  }
  // 6. Close receipt: from the cashier's Close receipt button, not automatically.
  const closed = await session.closeReceipt();
  console.log(closed instanceof ReceiptClosed ? 'Terminal back on its idle screen' : `Close receipt: ${closed.outcome()}`);
} else if (result instanceof Declined) {
  console.log(`Declined: ${result.reason} (code ${result.responseCode})`);
} else if (result instanceof Failed && result.settled()) {
  // The SDK asked the terminal by itself and it knew.
  const t = result.recovered.transaction;
  console.log(`Answer lost, then found: ${t.status} ${t.amount} (receipt ${t.stan})`);
} else if (result instanceof Failed && result.failure.outcomeUnknown()) {
  console.log(`OUTCOME UNKNOWN: ${result.failure.message}`);
  console.log(`Do not charge again. Inquiring by reference ${reference} ...`);
  const inquiry = await session.inquireByReference(reference);
  if (inquiry instanceof Found) console.log(`Found: ${inquiry.transaction.status}`);
  else if (inquiry instanceof NotFound) console.log('Not found yet — confirm on the terminal before taking payment again.');
  else if (inquiry instanceof InquiryFailed) console.log(`Inquiry failed (${inquiry.failure.message}) — inquire again later.`);
} else if (result instanceof Failed) {
  // Nothing was sent: unreachable or, with the opt-in guard, busy or an earlier unknown outcome to reconcile first.
  console.log(`Not sent: ${result.failure.message}`);
}
