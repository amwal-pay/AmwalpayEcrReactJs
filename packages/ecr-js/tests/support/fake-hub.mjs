#!/usr/bin/env node
/**
 * A stand-in for the Amwal Hub over plain HTTP. Prints "LISTENING host:port".
 *
 *   AMWAL_FAKE_HUB_RECORD=<file> node tests/support/fake-hub.mjs
 *
 * The behaviour comes from the `mode` query parameter, which the tests'
 * rewriting transport adds. Each request is appended to the file named by the
 * AMWAL_FAKE_HUB_RECORD environment variable, as one JSON line.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const record = process.env.AMWAL_FAKE_HUB_RECORD ?? '';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://hub');
    const mode = url.searchParams.get('mode') ?? 'approve';
    const path = url.pathname;
    const body = Buffer.concat(chunks).toString('utf8');
    if (record !== '') {
      appendFileSync(record, JSON.stringify({ path, contentType: req.headers['content-type'] ?? '', body }) + '\n');
    }
    let request = {};
    try {
      request = JSON.parse(body) ?? {};
    } catch {
      // Answered by mode regardless.
    }
    const reference = request.merchantReference ?? '';

    const send = (status, text, reason = '') => {
      res.writeHead(status, reason !== '' ? reason : 'Status', { 'Content-Type': 'application/json' });
      res.end(text);
    };

    switch (mode) {
      case 'approve':
        if (path === '/Ecr/Inquiry') {
          send(200, JSON.stringify({ success: true, responseCode: '00', message: 'Transaction found', data: {
            merchantReference: request.originalMerchantReference ?? '', stan: '000215', status: 'Approved',
            amount: '1.234', rrn: '623807390109', transactionTime: '2026-10-25T10:00:00', canVoid: true,
          }, errorList: [] }));
          break;
        }
        send(200, JSON.stringify({ success: true, responseCode: '00', message: 'Approved', data: {
          merchantReference: reference, amount: '1.234', authorizeAmount: '1.234', rrn: '623807390109',
          authCode: '713984', cardMask: '543173xxxx5785',
        }, errorList: [] }));
        break;
      case 'decline':
        send(200, '{"success":false,"responseCode":"51","message":"Declined","data":null,"errorList":["Insufficient funds"]}');
        break;
      case 'hub-timeout':
        send(200, '{"success":false,"responseCode":"NO_RESPONSE","message":"timeout","nextStep":"INQUIRE_BY_MERCHANT_REFERENCE"}');
        break;
      case 'not-found':
        send(200, '{"success":false,"responseCode":"25","message":"Transaction not found","data":null}');
        break;
      case 'error-500':
        send(500, '', 'Internal Server Error');
        break;
      case 'error-503-explained':
        send(503, '{"success":false,"responseCode":"503","message":"Terminal did not respond"}', 'Service Unavailable');
        break;
      case 'unauthorized':
        send(401, '{"success":false,"responseCode":"401","message":"Invalid signature","errorList":["secureHashValue mismatch"]}', 'Unauthorized');
        break;
      case 'empty':
        send(200, '');
        break;
      case 'html':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>bad gateway</html>');
        break;
      case 'slow':
        setTimeout(() => send(200, '{"success":true,"responseCode":"00"}'), 3000);
        break;
      default:
        send(400, '{"success":false,"message":"unknown mode"}');
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const { address, port } = server.address();
  process.stdout.write(`LISTENING ${address}:${port}\n`);
});
