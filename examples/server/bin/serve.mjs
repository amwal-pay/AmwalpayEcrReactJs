#!/usr/bin/env node
/**
 * The web till's server. From examples/:
 *
 *   npm run build:web      # once: builds the React page into web/dist
 *   npm run serve          # http://127.0.0.1:5080
 *
 * Listen on loopback only: there is no login. Settings come from the
 * environment: AMWAL_ECR_EXAMPLE_HOST (127.0.0.1), AMWAL_ECR_EXAMPLE_PORT
 * (5080), AMWAL_ECR_EXAMPLE_DATA (the data folder), AMWAL_ECR_EXAMPLE_TIMEZONE
 * (the till's time zone, when the machine's is not it), and
 * AMWAL_ECR_EXAMPLE_ALLOWED_HOSTS.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Before anything reads the clock: "today" and transactionDateTime are the till's.
if (process.env.AMWAL_ECR_EXAMPLE_TIMEZONE) process.env.TZ = process.env.AMWAL_ECR_EXAMPLE_TIMEZONE;

const { DataPaths } = await import('../web/DataPaths.js');
const { EcrApp } = await import('../web/EcrApp.js');
const { FrontController } = await import('../web/FrontController.js');

const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, '..', '..', 'web', 'dist');
if (!existsSync(join(publicDirectory, 'index.html'))) {
  console.error('The page is not built yet: run "npm run build:web" in examples/ first.');
  process.exit(1);
}

const host = process.env.AMWAL_ECR_EXAMPLE_HOST || '127.0.0.1';
const port = Number(process.env.AMWAL_ECR_EXAMPLE_PORT || 5080);

const app = new EcrApp(new DataPaths());
const server = createServer(new FrontController(publicDirectory, app).listener());
// A Web Service payment can wait 140 s (connect + answer): never let Node cut the long polls' connections short.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(port, host, () => {
  console.log(`LISTENING http://${host === '::1' ? '[::1]' : host}:${port}`);
  console.log(`Data folder: ${app.paths.root}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // Stop taking requests; let a payment that is waiting finish and be recorded.
    server.close();
    console.log('Stopping: waiting for running transactions to finish...');
    await app.registry.idle();
    process.exit(0);
  });
}
