import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { attempt } from './probe.mjs';
import { PROVIDERS } from './providers.mjs';
import { CHECKS, redact } from './support.mjs';

test('every lane without its credentials records every check as skipped and still exits 0', () => {
  const lanePath = fileURLToPath(new URL('./lane.test.mjs', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'providers-unit-'));
  try {
    for (const [name, provider] of Object.entries(PROVIDERS)) {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !provider.credentials.includes(key) && key !== 'NODE_TEST_CONTEXT',
        ),
      );
      const resultsFile = path.join(dir, `${name}.json`);
      const run = spawnSync(process.execPath, ['--test', lanePath], {
        encoding: 'utf8',
        env: { ...env, PROVIDERS_LANE: name, PROVIDERS_RESULTS: resultsFile },
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const { results } = JSON.parse(readFileSync(resultsFile, 'utf8'));
      assert.deepEqual(Object.keys(results).sort(), Object.keys(CHECKS).sort());
      for (const { outcome, detail } of Object.values(results)) {
        assert.equal(outcome, 'skipped');
        assert.match(detail, new RegExp(provider.credentials[0], 'u'));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe refuses a call without the bearer and reports uid and attempts with it', async () => {
  const bearer = 'unit-test-bearer-0123456789';
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const probe = spawn(process.execPath, [fileURLToPath(new URL('./probe.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, RUNTIME_SANDBOX_BEARER: bearer, PORT: port, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let tries = 0; ; tries += 1) {
      const up = await fetch(`${base}/ping`).then(
        () => true,
        () => false,
      );
      if (up) break;
      assert.ok(tries < 50, 'the probe did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(`${base}/ping`)).status, 401);
    assert.equal(
      (await fetch(`${base}/probe`, { headers: { authorization: 'Bearer wrong' } })).status,
      401,
    );
    const response = await fetch(`${base}/probe?gateway=bad_host!`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    assert.equal(response.status, 200);
    const { uid, attempts } = await response.json();
    assert.equal(uid, process.getuid());
    assert.deepEqual(Object.keys(attempts).sort(), [
      'cgnat',
      'ipv6-link-local',
      'ipv6-loopback',
      'ipv6-public',
      'ipv6-ula',
      'link-local-2',
      'metadata',
      'rfc1918-10',
      'rfc1918-172',
      'rfc1918-192',
      'test-net',
    ]);
  } finally {
    probe.kill();
  }
});

test('the probe refuses to start without the bearer', () => {
  const probePath = fileURLToPath(new URL('./probe.mjs', import.meta.url));
  const refused = spawnSync(process.execPath, [probePath], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /RUNTIME_SANDBOX_BEARER is required/u);
});

test('a refused connection is not reached, and a hostname is reached only on a TLS handshake', async () => {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.end('not tls\n', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.deepEqual(await attempt(['127.0.0.1', port]), { outcome: 'connected', answered: true });
    const plainTcp = await attempt(['localhost', port], { tls: true });
    assert.equal(plainTcp.answered, false, plainTcp.outcome);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(await attempt(['127.0.0.1', port]), { outcome: 'refused', answered: false });
});

test('attempt with exchange reports bytes, end and status and keeps no response text', async () => {
  const sockets = [];
  const serve = async (onConnection) => {
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      onConnection(socket);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const closer = await serve((socket) => socket.end());
  const replier = await serve((socket) =>
    socket.once('data', () => socket.end('HTTP/1.0 200 OK\r\n\r\nx')),
  );
  const resetter = await serve((socket) => socket.resetAndDestroy());
  const lateResetter = await serve((socket) => socket.once('data', () => socket.resetAndDestroy()));
  const fronted = await serve((socket) =>
    socket.once('data', (chunk) =>
      chunk.toString().includes('\r\nHost: gateway.example\r\n')
        ? socket.end('HTTP/1.0 200 OK\r\n\r\n')
        : socket.end(),
    ),
  );
  try {
    const run = (server) => attempt(['127.0.0.1', server.address().port], { exchange: true });
    assert.deepEqual(await run(closer), {
      outcome: 'connected',
      answered: true,
      exchange: { bytes: 0, end: 'close', status: null },
    });
    assert.deepEqual(await run(replier), {
      outcome: 'connected',
      answered: true,
      exchange: { bytes: 20, end: 'close', status: 200 },
    });
    assert.equal((await run(resetter)).answered, false);
    assert.deepEqual(await run(lateResetter), {
      outcome: 'connected',
      answered: true,
      exchange: { bytes: 0, end: 'reset', status: null },
    });
    assert.equal((await run(fronted)).exchange.bytes, 0);
    const port = fronted.address().port;
    assert.equal(
      (await attempt(['127.0.0.1', port], { exchange: true, hostHeader: 'gateway.example' }))
        .exchange.status,
      200,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const server of [closer, replier, resetter, lateResetter, fronted])
      await new Promise((resolve) => server.close(resolve));
  }
  const gone = await attempt(['127.0.0.1', 1], { exchange: true });
  assert.deepEqual(gone, { outcome: 'refused', answered: false });
});

test('redact removes every secret and ignores empty ones', () => {
  const token = 'sentinel-token-0123456789';
  assert.equal(redact(`boom ${token} and ${token}`, [token, '']), 'boom [redacted] and [redacted]');
  assert.equal(redact('nothing here', ['']), 'nothing here');
});
