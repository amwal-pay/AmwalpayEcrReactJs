#!/usr/bin/env node
/**
 * A TCP server that misbehaves on purpose, one behaviour per connection, for
 * the channel tests. Prints "LISTENING host:port", then serves.
 *
 *   --modes=answer,reset   behaviour for connection 0, 1, ...; the last repeats
 *   --answer=<base64>      the JSON body for "answer" / "pieces" / "slow"
 *   --record=<file>        appends each raw request (base64) as a line
 *
 * Modes: answer, pieces (header and body in separate writes), slow (answers
 * after 600 ms), stall (never answers), drop (closes without answering),
 * truncated (half a body), zero (a zero-length frame), reset (TCP RST).
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';

const option = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const modes = option('modes', 'answer').split(',');
const answer = Buffer.from(option('answer', Buffer.from('{"responseCode":"00"}').toString('base64')), 'base64');
const record = option('record', null);

const frame = (body) => {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let connection = 0;
const held = [];
const server = createServer((socket) => {
  const mode = modes[Math.min(connection++, modes.length - 1)];
  socket.on('error', () => {});
  let received = Buffer.alloc(0);
  let handled = false;
  socket.on('data', async (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (handled || received.length < 2 || received.length < 2 + received.readUInt16BE(0)) return;
    handled = true;
    if (record !== null) appendFileSync(record, received.toString('base64') + '\n');
    switch (mode) {
      case 'answer':
        socket.end(frame(answer));
        break;
      case 'pieces': {
        const framed = frame(answer);
        for (const piece of [framed.subarray(0, 1), framed.subarray(1, 2), framed.subarray(2, 12), framed.subarray(12)]) {
          socket.write(piece);
          await sleep(50);
        }
        socket.end();
        break;
      }
      case 'slow':
        await sleep(600);
        socket.end(frame(answer));
        break;
      case 'stall':
        held.push(socket); // keep it open, never answer
        break;
      case 'drop':
        socket.end();
        break;
      case 'truncated': {
        const header = Buffer.alloc(2);
        header.writeUInt16BE(64, 0);
        socket.end(Buffer.concat([header, Buffer.from('{"responseCode":')]));
        break;
      }
      case 'zero':
        socket.end(Buffer.from([0, 0]));
        break;
      case 'reset':
        socket.resetAndDestroy();
        break;
      default:
        socket.end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  const { address, port } = server.address();
  process.stdout.write(`LISTENING ${address}:${port}\n`);
});
