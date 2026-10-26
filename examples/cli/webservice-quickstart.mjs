#!/usr/bin/env node
/**
 * ECR Web Service, start to finish: HTTPS to the Amwal Hub, which relays to the
 * terminal in Web Service mode (ecrMode 4). Copy from here into your own till.
 *
 *   $env:AMWAL_ECR_WEBSERVICE_KEY = '<hex key>'   (the Web Service key, not the Wi-Fi key)
 *   node cli/webservice-quickstart.mjs <merchantId> <terminalId> <serial> [SIT|UAT|PROD] [amount]
 *
 * Needs Hub credentials from Amwal; there is no fake Hub for this script.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Approved, Declined, EcrConfig, EcrEnvironment, EcrSessions, Failed, Found, InquiryFailed, NotFound, WebServiceLink,
} from '@amwalpay/ecr-js';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('usage: node cli/webservice-quickstart.mjs <merchantId> <terminalId> <serial> [SIT|UAT|PROD] [amount]');
  process.exit(2);
}
const [merchantId, terminalId, serial, environmentName = 'SIT', amount = '1.000'] = args;
const environment = EcrEnvironment.fromName(environmentName);
const here = dirname(fileURLToPath(import.meta.url));

// 1. Plan: numeric IDs, the Web Service key, the environment. The Hub address stays inside the SDK.
const plan = EcrSessions.plan(
  new WebServiceLink(merchantId, terminalId),
  new EcrConfig({
    environment,
    ecrId: 'TILL-01',
    stateDirectory: join(here, '..', 'var', 'state'),
    // caBundlePath: 'C:\\certs\\corporate-root.pem',   // behind a TLS-inspecting proxy
  }),
  process.env.AMWAL_ECR_WEBSERVICE_KEY ?? '',
);
if (!plan.isReady()) {
  console.error(plan.issues().join('\n'));
  process.exit(1);
}
console.log('Connection:', plan.connectionSummary()); // e.g. "UAT · merchant 10001 · terminal 20002"

const session = EcrSessions.open(serial, plan);

// 2. Reference first, saved with the order.
const reference = EcrSessions.newMerchantReference();
console.log(`Order reference ${reference} (saved before sending). Waiting up to 140 s for card and PIN...`);

const result = await session.sale(amount, reference);

if (result instanceof Approved) {
  console.log(`Approved ${result.amount} · RRN ${result.rrn} · Auth ${result.authCode}`);
  // Close receipt on Web Service needs the sale's reference.
  const closed = await session.closeReceipt({ originalMerchantReference: reference });
  console.log(`Close receipt: ${closed.outcome()}`);
} else if (result instanceof Declined) {
  console.log(`Declined: ${result.reason} (code ${result.responseCode})`);
} else if (result instanceof Failed && result.failure.outcomeUnknown()) {
  // Web Service never inquires by itself: the inquiry is yours. Never resend.
  console.log(`OUTCOME UNKNOWN: ${result.failure.message}\nInquiring by reference ${reference} ...`);
  const inquiry = await session.inquireByReference(reference); // no date: do not invent "today"
  if (inquiry instanceof Found) console.log(`Found: ${inquiry.transaction.status} ${inquiry.transaction.amount}`);
  else if (inquiry instanceof NotFound) console.log('The Hub has no record yet — check the merchant portal before taking payment again.');
  else if (inquiry instanceof InquiryFailed) console.log(`Inquiry failed (${inquiry.failure.message}) — inquire again later; it moves no money.`);
} else if (result instanceof Failed) {
  console.log(`Not sent: ${result.failure.message}`);
}
