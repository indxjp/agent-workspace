#!/usr/bin/env node
// Prints `NAME=<port>` for each variable name given, each a distinct loopback port free right now,
// for a job to append to $GITHUB_ENV. The self-hosted MS-A2 pool runs several jobs on one host and
// one Docker daemon, so a harness that publishes a fixed host port (3000, 8333, ...) collides with
// whichever job holds it (docs/operations/ci.md).
//
// Every port stays bound until all are picked, so no two names get the same port. Another process
// can still take one after it is released; the window is the few seconds before the harness binds.
import { createServer } from 'node:net';
import process from 'node:process';

const names = process.argv.slice(2);
if (names.length === 0 || names.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
  process.stderr.write('usage: node scripts/ci/free-ports.mjs NAME [NAME ...]\n');
  process.exit(2);
}

/** @returns {Promise<import('node:net').Server>} */
function listen() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const servers = [];
try {
  for (const name of names) {
    const server = await listen();
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    process.stdout.write(`${name}=${String(address.port)}\n`);
  }
} finally {
  for (const server of servers) server.close();
}
