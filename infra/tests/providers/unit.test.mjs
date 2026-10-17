import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderSummary } from '../isolation/summary.mjs';
import {
  BRIDGE_PREFIX,
  bridgeWorkerName,
  deleteBridgeResources,
  isLaneName,
  isLeftover,
  isWorkerPropagating,
  ownedBy,
  renderConfig,
  retryWorkerPropagation,
  waitForBridge,
  WORKER_PROPAGATION_DELAYS_MS,
  workersDevUrl,
} from './cloudflare-bridge.mjs';
import { e2bBuild, inlineBaseImage, prepare, probeKey, readProbeFiles } from './prepare.mjs';
import { attempt, metadataEvidence } from './probe.mjs';
import { PROVIDERS } from './providers.mjs';
import {
  blockedVerdict,
  CHECKS,
  cloudMetadataVerdict,
  CREATE_ROWS,
  deadlineVerdict,
  failedRows,
  Inconclusive,
  ipv6Verdict,
  noPolicyRows,
  PRIVATE_TARGETS,
  privateVerdict,
  redact,
  refusalVerdict,
} from './support.mjs';

const answered = (value) => ({ answered: value, outcome: value ? 'connected' : 'timeout' });
const lane = (outcome) => ({ 'non-root': { title: CHECKS['non-root'], outcome } });

test('a skipped provider is never clean, so a missing secret cannot read as a green row', () => {
  const skipped = renderSummary({ e2b: lane('skipped'), vercel: lane('pass') });
  assert.equal(skipped.clean, false);
  assert.match(skipped.markdown, /\| skipped \| pass \|/u);
  assert.equal(renderSummary({ e2b: lane('pass'), vercel: lane('n/a') }).clean, true);
  assert.equal(renderSummary({ e2b: lane('pass'), vercel: undefined }).clean, false);
});

test('a blocked target passes only next to a positive control that answered', () => {
  const attempts = { gateway: answered(true), metadata: answered(false) };
  assert.doesNotThrow(() => blockedVerdict(attempts, ['metadata'], 'gateway'));
  assert.throws(() => blockedVerdict({ ...attempts, gateway: answered(false) }, ['metadata'], 'gateway'), Inconclusive);
});

test('a refused or timed-out private range is blocked only next to a gateway that answered', () => {
  const refused = { outcome: 'refused', answered: false };
  const silent = Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, refused]));
  const attempts = { ...silent, metadata: answered(false) };
  assert.doesNotThrow(() => blockedVerdict({ ...attempts, gateway: answered(true) }, ['metadata', ...PRIVATE_TARGETS], 'gateway'));
  for (const gateway of [answered(false), refused, undefined]) {
    assert.throws(() => blockedVerdict({ ...attempts, gateway }, ['metadata', ...PRIVATE_TARGETS], 'gateway'), Inconclusive);
  }
});

test('the deadline passes only on a definite provider stop; no answer is inconclusive', () => {
  assert.doesNotThrow(() => deadlineVerdict(false, 'stopped'));
  assert.throws(() => deadlineVerdict(true, 'stopped'), /still answers/u);
  assert.throws(() => deadlineVerdict(false, 'running'), (error) => !(error instanceof Inconclusive));
  for (const state of [undefined, 'lookup failed: fetch failed', 'lookup answered 500', 'unknown state paused']) {
    assert.throws(() => deadlineVerdict(false, state), Inconclusive);
  }
  const inconclusive = renderSummary({ e2b: { deadline: { title: CHECKS.deadline, outcome: 'inconclusive' } } });
  assert.equal(inconclusive.clean, false);
});

test('a target that answered, or was not reported, is a failure', () => {
  const attempts = { gateway: answered(true), metadata: answered(true), cgnat: answered(false) };
  assert.throws(() => blockedVerdict(attempts, ['metadata'], 'gateway'), /metadata/u);
  assert.throws(() => blockedVerdict(attempts, PRIVATE_TARGETS, 'gateway'), /rfc1918-10 \(unreported\)/u);
  assert.throws(() => blockedVerdict({ ...attempts, cgnat: answered(true) }, ['cgnat'], 'gateway'), /cgnat \(connected\)/u);
});

const connected = (bytes, status = null, end = 'close') => ({ outcome: 'connected', answered: true, exchange: { bytes, end, status } });
const withFronted = (entries) => Object.fromEntries(Object.entries(entries).flatMap(([name, value]) => [[name, value], [`${name}-fronted`, value]]));
const proxied = (bytes = 0) => withFronted(Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, connected(bytes)])));
const sentinel = withFronted({ 'test-net': connected(0) });

test('private ranges: refused or timed out passes; a connect passes only as a silent proxy next to a silent unroutable sentinel', () => {
  const gateway = answered(true);
  const refused = withFronted(Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, answered(false)])));
  assert.equal(privateVerdict({ gateway, ...refused }, 'gateway'), 'refused or timed out');
  assert.match(
    privateVerdict({ gateway, ...proxied(), ...sentinel }, 'gateway'),
    /egress proxy for .*rfc1918-10.* and unroutable 192\.0\.2\.1, also with the gateway's Host; none returned a byte$/u,
  );
  assert.match(
    privateVerdict({ gateway, ...refused, ...withFronted({ 'rfc1918-10': connected(0) }), ...sentinel }, 'gateway'),
    /egress proxy for rfc1918-10 and .*; the rest refused or timed out$/u,
  );
  assert.match(privateVerdict({ gateway, ...proxied(), ...sentinel, 'test-net': connected(0, null, 'reset') }, 'gateway'), /none returned a byte$/u);
});

test('private ranges: a fronted exchange (gateway Host to a private address) that answers or is unreported is a failure', () => {
  const gateway = answered(true);
  assert.throws(
    () => privateVerdict({ gateway, ...proxied(), ...sentinel, 'rfc1918-10-fronted': connected(120, 200) }, 'gateway'),
    /rfc1918-10-fronted \(connected, 120 bytes, HTTP 200\)/u,
  );
  const { 'cgnat-fronted': _cgnat, ...cgnatUnreported } = proxied();
  assert.throws(() => privateVerdict({ gateway, ...cgnatUnreported, ...sentinel }, 'gateway'), /cgnat-fronted \(unreported\)/u);
  assert.throws(() => privateVerdict({ gateway, ...proxied(), 'test-net': connected(0) }, 'gateway'), /test-net-fronted \(unreported\)/u);
  const refused = Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, answered(false)]));
  assert.throws(
    () => privateVerdict({ gateway, ...refused, ...withFronted({ 'rfc1918-10': connected(0) }), ...sentinel }, 'gateway'),
    /rfc1918-172-fronted \(unreported\)/u,
  );
});

test('private ranges: a connect that stalls until the timeout is a failure', () => {
  const gateway = answered(true);
  assert.throws(
    () => privateVerdict({ gateway, ...proxied(), ...sentinel, 'rfc1918-192': connected(0, null, 'timeout') }, 'gateway'),
    /rfc1918-192 \(connected, no reply before timeout\)/u,
  );
  assert.throws(
    () => privateVerdict({ gateway, ...proxied(), ...sentinel, 'test-net-fronted': connected(0, null, 'timeout') }, 'gateway'),
    /test-net-fronted \(connected, no reply before timeout\)/u,
  );
});

test('private ranges: a connect without evidence, a byte, or a sentinel that did not connect is a failure', () => {
  const gateway = answered(true);
  const oldVercelReport = Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, answered(true)]));
  assert.throws(() => privateVerdict({ gateway, ...oldVercelReport, 'test-net': answered(true) }, 'gateway'), /no exchange evidence/u);
  assert.throws(() => privateVerdict({ gateway, ...proxied(), ...sentinel, 'test-net': answered(false) }, 'gateway'), /test-net \(timeout\)/u);
  assert.throws(() => privateVerdict({ gateway, ...proxied() }, 'gateway'), /test-net \(unreported\)/u);
  assert.throws(() => privateVerdict({ gateway, ...proxied(), ...sentinel, 'test-net': connected(37, 403) }, 'gateway'), /test-net \(connected, 37 bytes, HTTP 403\)/u);
  assert.throws(
    () => privateVerdict({ gateway, ...proxied(), cgnat: connected(37, 403), ...sentinel }, 'gateway'),
    /cgnat \(connected, 37 bytes, HTTP 403\)/u,
  );
  assert.throws(() => privateVerdict({ gateway, ...sentinel }, 'gateway'), /rfc1918-10 \(unreported\)/u);
});

test('private ranges: a gateway that did not answer is inconclusive', () => {
  assert.throws(() => privateVerdict({ gateway: answered(false), ...proxied(), ...sentinel }, 'gateway'), Inconclusive);
});

const MMDS_EVIDENCE = {
  unauthenticatedStatus: 401,
  tokenStatus: 200,
  keys: ['accessTokenHash', 'address', 'envID', 'instanceID'],
  flat: true,
  gcp: { status: 404, flavor: false },
  imdsv2: { tokenStatus: 200, iamStatus: 404 },
  imdsv1: { iamStatus: 401 },
};
const mmdsAttempts = (evidence = MMDS_EVIDENCE, overrides = {}) => ({
  gateway: answered(true),
  metadata: { ...answered(true), ...(evidence === null ? {} : { evidence }) },
  'link-local-2': answered(false),
  ...overrides,
});

test('MMDS proven passes, and the info row maps to pass with the key names', () => {
  assert.deepEqual(cloudMetadataVerdict(mmdsAttempts(), 'gateway'), { mmds: true, keys: MMDS_EVIDENCE.keys });
});

test('a blocked 169.254.169.254:80 passes unchanged; unreported or a down gateway does not', () => {
  const blocked = { gateway: answered(true), metadata: answered(false) };
  assert.deepEqual(cloudMetadataVerdict(blocked, 'gateway'), { mmds: false, keys: [] });
  assert.throws(() => cloudMetadataVerdict({ gateway: answered(true) }, 'gateway'), /unreported/u);
  assert.throws(() => cloudMetadataVerdict({ ...blocked, gateway: answered(false) }, 'gateway'), Inconclusive);
});

test('a key beyond the four MMDS keys fails and the message names the key only', () => {
  const evidence = { ...MMDS_EVIDENCE, keys: ['envID', 'iam'] };
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'), /unexpected keys: iam$/u);
  for (const keys of [[], null]) {
    assert.throws(() => cloudMetadataVerdict(mmdsAttempts({ ...MMDS_EVIDENCE, keys }), 'gateway'), /no key set/u);
  }
});

test('a cloud-metadata answer fails: GCP, IMDSv2 iam/, IMDSv1 iam/', () => {
  for (const [evidence, message] of [
    [{ ...MMDS_EVIDENCE, gcp: { status: 200, flavor: false } }, /GCP/u],
    [{ ...MMDS_EVIDENCE, gcp: { status: 404, flavor: true } }, /GCP/u],
    [{ ...MMDS_EVIDENCE, imdsv2: { tokenStatus: 200, iamStatus: 200 } }, /IMDSv2/u],
    [{ ...MMDS_EVIDENCE, imdsv1: { iamStatus: 200 } }, /IMDSv1/u],
  ]) {
    assert.throws(() => cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'), message);
  }
});

test('a reachable or unreported second link-local target fails', () => {
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(MMDS_EVIDENCE, { 'link-local-2': answered(true) }), 'gateway'), /169\.254\.169\.253/u);
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(MMDS_EVIDENCE, { 'link-local-2': undefined }), 'gateway'), /169\.254\.169\.253/u);
});

test('a connect without proof fails: no evidence, an unauthenticated 200, or no token', () => {
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(null), 'gateway'), /without proof/u);
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts({ ...MMDS_EVIDENCE, unauthenticatedStatus: 200 }), 'gateway'), /not MMDS's 401/u);
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts({ ...MMDS_EVIDENCE, tokenStatus: null }), 'gateway'), /token PUT/u);
});

const noRoute = (code = 'ENETUNREACH') => ({ outcome: code, answered: false });
const ipv6Attempts = (overrides = {}) => ({
  gateway: answered(true),
  'ipv6-link-local': noRoute(),
  'ipv6-ula': noRoute(),
  'ipv6-loopback': { outcome: 'refused', answered: false },
  'ipv6-public': noRoute(),
  ...overrides,
});

test('no-ipv6-egress: no route passes and says so; a route with everything blocked passes', () => {
  assert.equal(ipv6Verdict(ipv6Attempts(), 'none', 'gateway'), 'no IPv6 route');
  const routed = ipv6Attempts({ 'ipv6-public': answered(false), 'ipv6-ula': answered(false) });
  assert.equal(ipv6Verdict(routed, 'none', 'gateway'), 'IPv6 targets unreachable');
});

test('no-ipv6-egress: under open the public host may answer, the denied ranges may not', () => {
  assert.doesNotThrow(() => ipv6Verdict(ipv6Attempts({ 'ipv6-public': answered(true) }), 'open', 'gateway'));
  assert.throws(() => ipv6Verdict(ipv6Attempts({ 'ipv6-public': answered(true) }), 'none', 'gateway'), /none: reachable: ipv6-public/u);
  for (const target of ['ipv6-link-local', 'ipv6-ula', 'ipv6-loopback']) {
    for (const policy of ['none', 'open']) {
      assert.throws(() => ipv6Verdict(ipv6Attempts({ [target]: answered(true) }), policy, 'gateway'), new RegExp(`${policy}: reachable: ${target}`, 'u'));
    }
  }
});

test('no-ipv6-egress: an unreported target fails and a down gateway is inconclusive', () => {
  assert.throws(() => ipv6Verdict(ipv6Attempts({ 'ipv6-ula': undefined }), 'open', 'gateway'), /unreported: ipv6-ula/u);
  assert.throws(() => ipv6Verdict(ipv6Attempts({ gateway: answered(false) }), 'none', 'gateway'), Inconclusive);
});

/** A local fake of what answers at 169.254.169.254: `flavor` makes it a GCP-like server instead of MMDS. */
async function withFakeMetadata(handler, body) {
  const server = createHttpServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('metadataEvidence reports statuses and key names only, never a token or a value', async () => {
  const token = 'tok-secret-0123456789';
  const values = { instanceID: 'sbx-secret-value', envID: 'env-secret-value', address: 'logs-secret-value', accessTokenHash: 'hash-secret-value' };
  const mmds = (req, res) => {
    const send = (status, text = '') => {
      res.writeHead(status);
      res.end(text);
    };
    if (req.method === 'PUT' && req.url === '/latest/api/token') {
      return req.headers['x-metadata-token-ttl-seconds'] === undefined ? send(400) : send(200, token);
    }
    if (req.method === 'GET' && req.url === '/') {
      return req.headers['x-metadata-token'] === token ? send(200, JSON.stringify(values)) : send(401);
    }
    return send(404);
  };
  const evidence = await withFakeMetadata(mmds, metadataEvidence);
  assert.deepEqual(evidence, {
    unauthenticatedStatus: 401,
    tokenStatus: 200,
    keys: ['accessTokenHash', 'address', 'envID', 'instanceID'],
    flat: true,
    gcp: { status: 404, flavor: false },
    imdsv2: { tokenStatus: 400, iamStatus: 404 },
    imdsv1: { iamStatus: 404 },
  });
  const serialized = JSON.stringify(evidence);
  for (const secret of [token, ...Object.values(values)]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'), { mmds: true, keys: evidence.keys });
});

test('a nested value under an allowed MMDS key fails', async () => {
  const token = 'tok-nested';
  const nested = (req, res) => {
    if (req.method === 'PUT' && req.url === '/latest/api/token') {
      res.writeHead(200);
      return res.end(token);
    }
    if (req.method === 'GET' && req.url === '/') {
      const authorized = req.headers['x-metadata-token'] === token;
      res.writeHead(authorized ? 200 : 401);
      return res.end(authorized ? JSON.stringify({ envID: 'env', address: { iam: { role: 'secret' } } }) : '');
    }
    res.writeHead(404);
    return res.end();
  };
  const evidence = await withFakeMetadata(nested, metadataEvidence);
  assert.deepEqual([evidence.keys, evidence.flat], [['address', 'envID'], false]);
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'), /non-string value$/u);
});

test('metadataEvidence on a GCP-like and an AWS-like server fails the verdict', async () => {
  const gcp = (req, res) => {
    res.writeHead(req.url.startsWith('/computeMetadata/v1/') ? 200 : 404, { 'metadata-flavor': 'Google' });
    res.end('instance/');
  };
  const gcpEvidence = await withFakeMetadata(gcp, metadataEvidence);
  assert.deepEqual(gcpEvidence.gcp, { status: 200, flavor: true });
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(gcpEvidence), 'gateway'), /GCP|401/u);

  const aws = (req, res) => {
    res.writeHead(200);
    res.end(req.method === 'PUT' ? 'aws-token' : 'role/');
  };
  const awsEvidence = await withFakeMetadata(aws, metadataEvidence);
  assert.equal(awsEvidence.imdsv1.iamStatus, 200);
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(awsEvidence), 'gateway'), /IMDSv1/u);
});

test('an undeclared policy is n/a only on a typed refusal with no sandbox and no bridge call', () => {
  class RuntimeRefusalError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const refusal = new RuntimeRefusalError('network_policy_unsupported', 'refuses none');
  assert.equal(
    refusalVerdict({ created: false, error: refusal, bridgeCalls: 0 }, 'none', RuntimeRefusalError),
    'none refused with network_policy_unsupported; no sandbox created, no bridge call',
  );
  const fails = [
    [{ created: true, bridgeCalls: 1 }, /none is declared unsupported, yet a sandbox was created/u],
    [{ created: false, error: new Error('bridge create failed with status 502'), bridgeCalls: 1 }, /not refused .*status 502/u],
    [{ created: false, error: new RuntimeRefusalError('run_spec_unsupported', 'x'), bridgeCalls: 0 }, /not refused/u],
    [{ created: false, error: new Error('create did not settle in 60000 ms'), bridgeCalls: 0 }, /not refused .*did not settle/u],
    [{ created: false, error: refusal, bridgeCalls: 1 }, /refused only after 1 bridge call/u],
  ];
  for (const [attempt, message] of fails) {
    assert.throws(() => refusalVerdict(attempt, 'none', RuntimeRefusalError), message);
  }
});

test('no declared policy: create-based rows are n/a and all-policies-refused passes only when every policy is refused', () => {
  class RuntimeRefusalError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const refused = { created: false, error: new RuntimeRefusalError('network_policy_unsupported', 'x'), bridgeCalls: 0 };
  const all = { none: refused, open: refused, restricted: refused };
  const rows = noPolicyRows(all, RuntimeRefusalError);
  assert.deepEqual(Object.keys(rows).sort(), [...CREATE_ROWS, 'all-policies-refused'].sort());
  for (const id of Object.keys(rows)) assert.ok(id in CHECKS, id);
  for (const id of CREATE_ROWS) assert.equal(rows[id].outcome, 'n/a', id);
  assert.equal(rows['all-policies-refused'].outcome, 'pass');
  assert.match(rows['all-policies-refused'].detail, /^none refused .*; open refused .*; restricted refused /u);

  const fails = [
    [{ open: { created: true, bridgeCalls: 1 } }, /open is declared unsupported, yet a sandbox was created/u],
    [{ restricted: { created: false, error: new Error('bridge create failed with status 502'), bridgeCalls: 1 } }, /restricted was not refused/u],
    [{ none: { ...refused, bridgeCalls: 1 } }, /none was refused only after 1 bridge call/u],
  ];
  for (const [override, message] of fails) {
    assert.throws(() => noPolicyRows({ ...all, ...override }, RuntimeRefusalError), message);
  }
});

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
      const up = await fetch(`${base}/ping`).then(() => true, () => false);
      if (up) break;
      assert.ok(tries < 50, 'the probe did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(`${base}/ping`)).status, 401);
    assert.equal((await fetch(`${base}/probe`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
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
  const refused = spawnSync(process.execPath, [probePath], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
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
  const replier = await serve((socket) => socket.once('data', () => socket.end('HTTP/1.0 200 OK\r\n\r\nx')));
  const resetter = await serve((socket) => socket.resetAndDestroy());
  const lateResetter = await serve((socket) => socket.once('data', () => socket.resetAndDestroy()));
  const fronted = await serve((socket) =>
    socket.once('data', (chunk) => (chunk.toString().includes('\r\nHost: gateway.example\r\n') ? socket.end('HTTP/1.0 200 OK\r\n\r\n') : socket.end())),
  );
  try {
    const run = (server) => attempt(['127.0.0.1', server.address().port], { exchange: true });
    assert.deepEqual(await run(closer), { outcome: 'connected', answered: true, exchange: { bytes: 0, end: 'close', status: null } });
    assert.deepEqual(await run(replier), { outcome: 'connected', answered: true, exchange: { bytes: 20, end: 'close', status: 200 } });
    assert.equal((await run(resetter)).answered, false);
    assert.deepEqual(await run(lateResetter), { outcome: 'connected', answered: true, exchange: { bytes: 0, end: 'reset', status: null } });
    assert.equal((await run(fronted)).exchange.bytes, 0);
    const port = fronted.address().port;
    assert.equal((await attempt(['127.0.0.1', port], { exchange: true, hostHeader: 'gateway.example' })).exchange.status, 200);
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const server of [closer, replier, resetter, lateResetter, fronted]) await new Promise((resolve) => server.close(resolve));
  }
  const gone = await attempt(['127.0.0.1', 1], { exchange: true });
  assert.deepEqual(gone, { outcome: 'refused', answered: false });
});

test('redact removes every secret and ignores empty ones', () => {
  const token = 'sentinel-token-0123456789';
  assert.equal(redact(`boom ${token} and ${token}`, [token, '']), 'boom [redacted] and [redacted]');
  assert.equal(redact('nothing here', ['']), 'nothing here');
});

const BUILD_ID = '11111111-2222-4333-8444-555555555555';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const KEY = 'unit-test-key-0123456789';
const probeFiles = { dockerfile: 'ARG NODE_IMAGE=node:1@sha256:00\nFROM ${NODE_IMAGE}\nUSER node\n', probe: 'probe' };
const TAG = `p-${probeKey(probeFiles)}`;
const e2bEnv = { E2B_API_KEY: KEY };
const vercelEnv = { VERCEL_TOKEN: KEY, VERCEL_TEAM_ID: 'team_unit' };
const cloudflareEnv = { CLOUDFLARE_API_TOKEN: KEY, CLOUDFLARE_ACCOUNT_ID: 'acct0123' };

/** Fakes for `prepare`: `respond("GET /path")` answers `[status, body]`, `run` stands in for the CLIs. */
function fakeDeps({ respond = () => [500, undefined], run = () => '', now = () => 0 } = {}) {
  const calls = { fetch: [], run: [] };
  return {
    calls,
    readFiles: async () => probeFiles,
    sleep: async () => {},
    now,
    fetch: async (url, init = {}) => {
      const call = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
      calls.fetch.push(call);
      const [status, body] = respond(call, init);
      return { status, json: async () => body };
    },
    run: (command, args, options) => {
      calls.run.push({ command, args, options });
      return run(command, args, options);
    },
  };
}

test('the probe key follows the content of the two probe files and nothing else', async () => {
  assert.match(TAG, /^p-[0-9a-f]{16}$/u);
  assert.equal(probeKey(probeFiles), probeKey({ ...probeFiles }));
  assert.notEqual(probeKey(probeFiles), probeKey({ ...probeFiles, probe: 'probe2' }));
  assert.notEqual(probeKey(probeFiles), probeKey({ ...probeFiles, dockerfile: `${probeFiles.dockerfile}\n` }));
  const real = await readProbeFiles();
  assert.match(probeKey(real), /^[0-9a-f]{16}$/u);
  const inlined = inlineBaseImage(real.dockerfile);
  assert.doesNotMatch(inlined, /ARG NODE_IMAGE|\$\{NODE_IMAGE\}/u);
  assert.match(inlined, /^FROM node:\S+@sha256:[0-9a-f]{64}$/mu);
});

test('an override variable is used as is and nothing is called', async () => {
  const overrides = {
    e2b: { ...e2bEnv, E2B_PROBE_TEMPLATE: 'custom:tpl' },
    vercel: { ...vercelEnv, VERCEL_PROJECT_ID: 'prj_custom', VERCEL_PROBE_IMAGE: 'custom/image@sha256:aa' },
    cloudflare: { ...cloudflareEnv, CLOUDFLARE_PROBE_IMAGE: 'registry.example/x@sha256:bb' },
  };
  for (const [lane, env] of Object.entries(overrides)) {
    const deps = fakeDeps();
    const result = await prepare(lane, env, [KEY], deps);
    const expected = Object.fromEntries(Object.entries(env).filter(([name]) => /PROBE|PROJECT_ID/u.test(name)));
    assert.deepEqual(result, { env: expected }, lane);
    assert.deepEqual(deps.calls, { fetch: [], run: [] }, lane);
  }
});

test('an empty override variable counts as unset', async () => {
  const deps = fakeDeps({ respond: () => [200, [{ tag: TAG, buildID: BUILD_ID }]] });
  const result = await prepare('e2b', { ...e2bEnv, E2B_PROBE_TEMPLATE: '' }, [KEY], deps);
  assert.deepEqual(result, { env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` } });
});

const TEMPLATE_ID = 'tpl0123';
const BUILD_STATUS = `GET /templates/${TEMPLATE_ID}/builds/${BUILD_ID}/status`;

/** E2B REST fakes: `lookups` answers the tag lookups in turn, the rest of the build by default succeeds. */
function e2bRespond({ lookups = [[200, []]], create = [202, { templateID: TEMPLATE_ID, buildID: BUILD_ID }], ...overrides } = {}) {
  const pending = [...lookups];
  let polls = 0;
  const answers = {
    'POST /v3/templates': create,
    [`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`]: [202, {}],
    'POST /templates/tags': [201, { buildID: BUILD_ID, tags: [TAG] }],
    ...overrides,
  };
  return (call) => {
    if (call === 'GET /templates/aw-providers-probe/tags') return pending.length > 1 ? pending.shift() : pending[0];
    if (call === BUILD_STATUS && answers[BUILD_STATUS] === undefined) {
      polls += 1;
      return [200, { status: polls === 1 ? 'building' : 'ready' }];
    }
    return answers[call] ?? [500, undefined];
  };
}

test('e2b reuses the template tagged with the probe hash and builds nothing', async () => {
  const cached = fakeDeps({ respond: () => [200, [{ tag: 'default', buildID: 'x' }, { tag: TAG, buildID: BUILD_ID }]] });
  assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], cached), {
    env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
  });
  assert.deepEqual(cached.calls.fetch, ['GET /templates/aw-providers-probe/tags']);
  assert.deepEqual(cached.calls.run, []);
});

test('e2b builds the template over REST when the tag is missing, then tags the build', async () => {
  for (const lookup of [[200, []], [404, undefined]]) {
    const bodies = {};
    const respond = e2bRespond({ lookups: [lookup] });
    const built = fakeDeps({
      respond: (call, init) => {
        if (init.body !== undefined) bodies[call] = JSON.parse(init.body);
        return respond(call);
      },
    });
    assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], built), {
      env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
    });
    assert.deepEqual(built.calls.fetch, [
      'GET /templates/aw-providers-probe/tags',
      'POST /v3/templates',
      `POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`,
      BUILD_STATUS,
      BUILD_STATUS,
      'POST /templates/tags',
    ]);
    assert.deepEqual(built.calls.run, [], 'no CLI and no SDK');
    assert.deepEqual(bodies['POST /v3/templates'], { name: 'aw-providers-probe' });
    const build = bodies[`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`];
    assert.equal(build.fromImage, 'node:1@sha256:00');
    assert.deepEqual(build.steps, [
      { type: 'USER', args: ['root'] },
      { type: 'USER', args: ['node'] },
    ]);
    assert.equal('startCmd' in build, false, 'the provider starts the probe after create, with the bearer');
    assert.equal('readyCmd' in build, false);
    assert.deepEqual(bodies['POST /templates/tags'], { target: 'aw-providers-probe:default', tags: [TAG] });
  }
});

test('the e2b build mirrors probe.Dockerfile and writes probe.mjs from base64', async () => {
  const real = await readProbeFiles();
  const { steps } = e2bBuild(real);
  assert.deepEqual(
    steps.map(({ type }) => type),
    ['USER', 'RUN', 'RUN', 'USER', 'WORKDIR'],
  );
  const encoded = /^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/srv\/apps\/runner\/dist\/index\.js$/u.exec(steps[2].args[0]);
  assert.equal(Buffer.from(encoded[1], 'base64').toString('utf8'), real.probe);
  assert.doesNotMatch(real.probe, /49983|\/envs/u, 'the probe no longer reads the bearer from envd');
});

test('e2b reuses the template when it already exists and another run tagged it', async () => {
  const deps = fakeDeps({
    respond: e2bRespond({ lookups: [[200, []], [200, [{ tag: TAG, buildID: BUILD_ID }]]], create: [409, undefined] }),
  });
  assert.deepEqual(await prepare('e2b', e2bEnv, [KEY], deps), {
    env: { E2B_PROBE_TEMPLATE: `aw-providers-probe:${BUILD_ID}` },
  });
  assert.deepEqual(deps.calls.fetch, [
    'GET /templates/aw-providers-probe/tags',
    'POST /v3/templates',
    'GET /templates/aw-providers-probe/tags',
  ]);
});

test('an e2b REST error is returned without provider text, and every row of the lane then reads fail', async () => {
  const cases = [
    [{ lookups: [[500, undefined]] }, 'e2b tag lookup failed with status 500'],
    [{ create: [409, undefined] }, 'e2b template create failed with status 409'],
    [{ create: [403, { message: `banned ${KEY}` }] }, 'e2b template create failed with status 403'],
    [{ create: [202, { templateID: TEMPLATE_ID }] }, 'e2b reported no build id'],
    [{ [`POST /v2/templates/${TEMPLATE_ID}/builds/${BUILD_ID}`]: [400, { message: KEY }] }, 'e2b template build failed with status 400'],
    [{ [BUILD_STATUS]: [200, { status: 'error', reason: { message: KEY } }] }, 'e2b template build failed'],
    [{ 'POST /templates/tags': [404, undefined] }, 'e2b tag assign failed with status 404'],
    [{ 'POST /templates/tags': [201, { buildID: 'other' }] }, 'e2b tag assign did not tag this build'],
  ];
  for (const [answers, expected] of cases) {
    const result = await prepare('e2b', e2bEnv, [KEY], fakeDeps({ respond: e2bRespond(answers) }));
    assert.equal(result.failure, expected);
  }
  let clock = 0;
  const stuck = fakeDeps({ respond: e2bRespond({ [BUILD_STATUS]: [200, { status: 'building' }] }), now: () => (clock += 400_000) });
  assert.equal((await prepare('e2b', e2bEnv, [KEY], stuck)).failure, 'e2b template build timed out');

  const transport = fakeDeps();
  transport.fetch = async () => {
    throw new Error(`connect failed ${KEY}`);
  };
  const failure = (await prepare('e2b', e2bEnv, [KEY], transport)).failure;
  assert.equal(failure, 'e2b tag lookup failed');

  const rows = failedRows('e2b template build failed with status 400');
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(CHECKS).sort());
  for (const { outcome, detail } of Object.values(rows)) {
    assert.equal(outcome, 'fail');
    assert.match(detail, /^probe artefact: e2b template build failed/u);
  }
  const summary = renderSummary({ e2b: rows });
  assert.equal(summary.clean, false);
  assert.match(summary.markdown, /\| fail \|/u);
});

function vercelRun({ cached }) {
  return (command, args) => {
    if (args[0] === 'buildx' && args[1] === 'imagetools') {
      if (!cached) throw new Error('docker buildx imagetools inspect failed with exit 1: not found');
      return JSON.stringify({ digest: DIGEST });
    }
    if (args[0] === 'buildx' && args[1] === 'build') {
      writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify({ 'containerimage.digest': DIGEST }));
    }
    return '';
  };
}

function vercelRespond({ projectStatus = 200, project = { id: 'prj_derived', name: 'aw-providers-live' }, notReady = 1 } = {}) {
  let pending = notReady;
  return (call) => {
    if (call.startsWith('GET /v9/projects/')) return [projectStatus, projectStatus === 200 ? project : undefined];
    if (call === 'POST /v11/projects') return [200, { id: 'prj_created', name: 'aw-providers-live' }];
    if (call.startsWith('GET /v2/teams/')) return [200, { slug: 'team-slug' }];
    if (call === 'POST /v4/sandboxes') {
      if (pending > 0) {
        pending -= 1;
        return [400, { error: { code: 'image_not_ready' } }];
      }
      return [201, {}];
    }
    if (call.startsWith('DELETE /v2/sandboxes/')) return [200, {}];
    return [500, undefined];
  };
}

test('vercel resolves the project by its fixed name, pins the pushed image and waits until VCR is ready', async () => {
  const deps = fakeDeps({ respond: vercelRespond(), run: vercelRun({ cached: true }) });
  const result = await prepare('vercel', vercelEnv, [KEY], deps);
  assert.deepEqual(result, {
    env: {
      VERCEL_PROJECT_ID: 'prj_derived',
      VERCEL_PROBE_IMAGE: `team-slug/aw-providers-live/aw-providers-probe@${DIGEST}`,
    },
  });
  const sandboxCalls = deps.calls.fetch.filter((call) => call.includes('sandboxes'));
  assert.deepEqual(sandboxCalls.slice(0, 2), ['POST /v4/sandboxes', 'POST /v4/sandboxes']);
  assert.equal(sandboxCalls.length, 3);
  assert.match(sandboxCalls[2], /^DELETE \/v2\/sandboxes\/aw-ready-/u);
  assert.ok(!deps.calls.run.some((call) => call.args[1] === 'build'), 'a cached tag is not rebuilt');
  const login = deps.calls.run.find((call) => call.args[0] === 'login');
  assert.equal(login.options.input, KEY);
  assert.ok(!JSON.stringify(deps.calls.run.map(({ args }) => args)).includes(KEY), 'the token never reaches argv');
});

test('vercel creates the missing project and builds the image when its tag is not in VCR', async () => {
  const deps = fakeDeps({ respond: vercelRespond({ projectStatus: 404, notReady: 0 }), run: vercelRun({ cached: false }) });
  const result = await prepare('vercel', vercelEnv, [KEY], deps);
  assert.equal(result.env.VERCEL_PROJECT_ID, 'prj_created');
  assert.ok(deps.calls.fetch.includes('POST /v11/projects'));
  const build = deps.calls.run.find((call) => call.args[1] === 'build');
  assert.ok(build.args.includes('linux/amd64'));
  assert.ok(build.args.includes('--provenance=false') && build.args.includes('--sbom=false'), 'a single-platform manifest is pushed');
  const { DOCKER_CONFIG: credentials, BUILDX_CONFIG: builders } = build.options.env;
  assert.ok(
    typeof builders === 'string' && !path.resolve(builders).startsWith(path.resolve(credentials)),
    'buildx keeps the builder setup-buildx-action registered',
  );
  assert.match(
    build.args[build.args.indexOf('--output') + 1],
    /^type=image,name=vcr\.vercel\.com\/team-slug\/aw-providers-live\/aw-providers-probe:p-[0-9a-f]{16},push=true/u,
  );
});

test('a VERCEL_PROJECT_ID override is looked up, never created, and names the image repository', async () => {
  const found = fakeDeps({
    respond: vercelRespond({ project: { id: 'prj_custom', name: 'custom-name' }, notReady: 0 }),
    run: vercelRun({ cached: true }),
  });
  const result = await prepare('vercel', { ...vercelEnv, VERCEL_PROJECT_ID: 'prj_custom' }, [KEY], found);
  assert.equal(result.env.VERCEL_PROJECT_ID, 'prj_custom');
  assert.match(result.env.VERCEL_PROBE_IMAGE, /^team-slug\/custom-name\//u);

  const missing = fakeDeps({ respond: vercelRespond({ projectStatus: 404 }) });
  const failure = await prepare('vercel', { ...vercelEnv, VERCEL_PROJECT_ID: 'prj_gone' }, [KEY], missing);
  assert.equal(failure.failure, 'vercel project resolve failed with status 404');
  assert.ok(!missing.calls.fetch.includes('POST /v11/projects'));
});

test('vercel fails with the reason when the image never becomes ready or the push fails', async () => {
  let clock = 0;
  const never = fakeDeps({
    respond: vercelRespond({ notReady: Infinity }),
    run: vercelRun({ cached: true }),
    now: () => (clock += 200_000),
  });
  assert.equal((await prepare('vercel', vercelEnv, [KEY], never)).failure, 'vercel image readiness failed with status 400');

  const push = fakeDeps({
    respond: vercelRespond(),
    run: (command, args) => {
      if (args[0] === 'login') return '';
      if (args[1] === 'imagetools') throw new Error('not found');
      throw new Error(`docker buildx build failed with exit 1: denied ${KEY}`);
    },
  });
  const failure = await prepare('vercel', vercelEnv, [KEY], push);
  assert.match(failure.failure, /^docker buildx build failed with exit 1: denied \[redacted\]$/u);
});

test('cloudflare pushes with wrangler and pins the digest docker reports for the registry name', async () => {
  const reference = `registry.cloudflare.com/acct0123/aw-providers-probe:${TAG}@${DIGEST}`;
  const deps = fakeDeps({ run: (command) => (command === 'docker' ? `other.example/x@${DIGEST}\n${reference}\n` : '') });
  assert.deepEqual(await prepare('cloudflare', cloudflareEnv, [KEY], deps), {
    env: { CLOUDFLARE_PROBE_IMAGE: reference },
  });
  const [build] = deps.calls.run;
  assert.deepEqual(build.args.slice(0, 5), ['--yes', 'wrangler@4.147.0', 'containers', 'build', '-p']);
  assert.equal(build.args[build.args.indexOf('-t') + 1], `aw-providers-probe:${TAG}`);
  assert.ok(!JSON.stringify(deps.calls.run.map(({ args }) => args)).includes(KEY));
});

test('cloudflare fails when wrangler fails or no registry digest can be read back', async () => {
  const broken = fakeDeps({
    run: () => {
      throw new Error(`wrangler containers build failed with exit 1: ${KEY}`);
    },
  });
  assert.equal(
    (await prepare('cloudflare', cloudflareEnv, [KEY], broken)).failure,
    'wrangler containers build failed with exit 1: [redacted]',
  );
  const unreadable = fakeDeps({ run: () => '' });
  assert.match((await prepare('cloudflare', cloudflareEnv, [KEY], unreadable)).failure, /no registry digest/u);
});

const BRIDGE = 'https://bridge-ci-1.acct.workers.dev';
const edge404 = () => new Response('<html>There is nothing here yet SENTINEL_BODY</html>', { status: 404 });
const bridgeAnswer = (status, error) => () => Response.json({ error }, { status });
const noSleep = () => Promise.resolve();

test('the bridge wait resolves only on the bridge-owned 401, after the edge 404 and the 503', async () => {
  const answers = [edge404, bridgeAnswer(503, 'not_configured'), () => new Response('x', { status: 401 }), bridgeAnswer(401, 'unauthorized')];
  const seen = [];
  await waitForBridge(BRIDGE, {
    sleep: noSleep,
    fetch: (url, init) => {
      seen.push(`${init.method} ${url}`);
      return Promise.resolve(answers[seen.length - 1]());
    },
  });
  assert.deepEqual(seen, Array(4).fill(`POST ${BRIDGE}/v1/sandboxes`));
});

test('the bridge wait fails with the last answer and none of the body, never skips', async () => {
  const error = await waitForBridge(BRIDGE, {
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    timeoutMs: 20,
    intervalMs: 2,
    fetch: () => Promise.resolve(edge404()),
  }).then(
    () => assert.fail('expected a timeout'),
    (thrown) => thrown,
  );
  assert.match(error.message, /last answer 404 not the bridge/u);
  assert.doesNotMatch(error.message, /SENTINEL_BODY/u);
});

test('the workers.dev URL is the deployed Worker, not another URL in the output', () => {
  const output = 'See https://other.acct.workers.dev\nDeployed https://bridge-ci-1.acct.workers.dev (1.2 sec)';
  assert.equal(workersDevUrl(output, 'bridge-ci-1'), BRIDGE);
  assert.throws(() => workersDevUrl('https://other.acct.workers.dev', 'bridge-ci-1'), /no workers\.dev URL for bridge-ci-1/u);
});

// The message `deployBridge`'s `run` throws: the command and the redacted tail of its output.
const wranglerFailure = (code) =>
  new Error(`wrangler deploy failed: ✘ [ERROR] A request to the Cloudflare API failed.\n  This Worker does not exist on your account. [code: ${code}]`);

test('only wrangler error 10007 is a Worker that Cloudflare does not know yet', () => {
  assert.equal(isWorkerPropagating(wranglerFailure(10007)), true);
  assert.equal(isWorkerPropagating(wranglerFailure(10000)), false);
  assert.equal(isWorkerPropagating(wranglerFailure(10006)), false);
  assert.equal(isWorkerPropagating(new Error('Worker 10007 not found')), false);
});

test('a wrangler step failing with 10007 is run again after each delay, and then succeeds', async () => {
  const slept = [];
  let runs = 0;
  const result = await retryWorkerPropagation(
    () => {
      runs += 1;
      if (runs <= 2) throw wranglerFailure(10007);
      return 'deployed';
    },
    { sleep: (ms) => Promise.resolve(slept.push(ms)) },
  );
  assert.equal(result, 'deployed');
  assert.equal(runs, 3);
  assert.deepEqual(slept, [2_000, 5_000]);
  assert.equal(WORKER_PROPAGATION_DELAYS_MS.reduce((total, ms) => total + ms, 0) <= 60_000, true);
});

test('an async step rejecting with 10007 is run again', async () => {
  let runs = 0;
  const result = await retryWorkerPropagation(
    async () => {
      runs += 1;
      if (runs === 1) throw wranglerFailure(10007);
      return 'deployed';
    },
    { sleep: noSleep },
  );
  assert.equal(result, 'deployed');
  assert.equal(runs, 2);
});

test('the retry stops at the attempt cap and rethrows the step’s own error', async () => {
  let runs = 0;
  const failure = wranglerFailure(10007);
  const thrown = await retryWorkerPropagation(
    () => {
      runs += 1;
      throw failure;
    },
    { sleep: noSleep },
  ).catch((error) => error);
  assert.equal(thrown, failure);
  assert.equal(runs, 1 + WORKER_PROPAGATION_DELAYS_MS.length);
});

test('any other wrangler error is thrown at once, without a retry', async () => {
  let runs = 0;
  const thrown = await retryWorkerPropagation(
    () => {
      runs += 1;
      throw wranglerFailure(10000);
    },
    { sleep: () => assert.fail('must not wait') },
  ).catch((error) => error);
  assert.match(thrown.message, /\[code: 10000\]/u);
  assert.equal(runs, 1);
});

test('the bridge name is unique per run and attempt and always inside the lane prefix', () => {
  const first = bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
  assert.equal(first, 'agent-workspace-sandbox-bridge-ci-42-1');
  assert.notEqual(first, bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' }));
  assert.notEqual(first, bridgeWorkerName({ GITHUB_RUN_ID: '421', GITHUB_RUN_ATTEMPT: '1' }));
  const local = [bridgeWorkerName({}), bridgeWorkerName({})];
  assert.notEqual(local[0], local[1]);
  for (const name of [first, ...local]) assert.ok(isLaneName(name) && name.length + "-sandboxnone".length <= 63);
  assert.throws(() => bridgeWorkerName({ GITHUB_RUN_ID: '1;rm' }), /must be digits/u);
  assert.throws(() => bridgeWorkerName({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1;rm' }), /must be digits/u);
});

test('the leftover filter matches the lane prefix only, and a deployment owns only its own names', () => {
  assert.ok(isLaneName(`${BRIDGE_PREFIX}ci-7-1-sandboxnone`));
  assert.ok(isLaneName('agent-workspace-sandbox-bridge-sandboxnone'));
  for (const other of ['agent-workspace-sandbox-bridge', 'agent-workspace-lp', 'my-agent-workspace-sandbox-bridge-x', 'awlj-1-web', '', undefined]) {
    assert.equal(isLaneName(other), false, String(other));
  }
  const owns = ownedBy('agent-workspace-sandbox-bridge-ci-42-1');
  assert.ok(owns('agent-workspace-sandbox-bridge-ci-42-1'));
  assert.ok(owns('agent-workspace-sandbox-bridge-ci-42-1-sandboxopen'));
  assert.equal(owns('agent-workspace-sandbox-bridge-ci-42-10-sandboxopen'), false);
  assert.equal(owns('agent-workspace-sandbox-bridge-ci-42-2'), false);
});

test('the rendered config carries the per-run name, so the container applications do too', () => {
  const shipped = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../cloudflare/sandbox-bridge/wrangler.jsonc'), 'utf8');
  const rendered = renderConfig(shipped, { image: 'r/i@sha256:' + 'a'.repeat(64), gatewayHost: 'gw.example', workerName: 'agent-workspace-sandbox-bridge-ci-42-1' });
  assert.match(rendered, /"name": "agent-workspace-sandbox-bridge-ci-42-1",/u);
  assert.doesNotMatch(rendered, /REPLACE_[A-Z]|"name": "agent-workspace-sandbox-bridge",/u);
  assert.throws(() => renderConfig('{}', { image: 'i', gatewayHost: 'g', workerName: 'w' }), /expected name field/u);
});

function fakeCloudflare({ refuse = [], listStatus = 200 } = {}) {
  const calls = [];
  const body = (url) =>
    url.endsWith('/containers/applications')
      ? { result: [
          { id: 'a1', name: 'agent-workspace-sandbox-bridge-sandboxnone' },
          { id: 'a2', name: 'agent-workspace-sandbox-bridge-ci-42-1-sandboxopen' },
          { id: 'a3', name: 'unrelated-sandboxnone' },
        ] }
      : { result: [{ id: 'agent-workspace-sandbox-bridge-ci-42-1' }, { id: 'agent-workspace-lp' }, { id: 'agent-workspace-sandbox-bridge' }] };
  const fetch = (url, init) => {
    calls.push(`${init.method} ${url.replace(/^.*\/accounts\/[^/]+\//u, '')}`);
    assert.equal(init.headers.authorization, 'Bearer TOKEN');
    if (init.method === 'GET') return Promise.resolve(new Response(JSON.stringify(body(url)), { status: listStatus }));
    if (refuse.some((id) => url.includes(`/${id}`))) return Promise.resolve(new Response('SENTINEL_BODY', { status: 403 }));
    return Promise.resolve(new Response('{}', { status: url.includes('/a2') ? 404 : 200 }));
  };
  return { fetch, calls };
}

test('the sweep deletes only this lane’s applications and Workers; a 404 counts as gone', async () => {
  const { fetch, calls } = fakeCloudflare();
  const removed = await deleteBridgeResources({ accountId: 'acct', token: 'TOKEN', owns: isLaneName, fetch });
  assert.deepEqual(removed, [
    ['container application', 'agent-workspace-sandbox-bridge-sandboxnone'],
    ['container application', 'agent-workspace-sandbox-bridge-ci-42-1-sandboxopen'],
    ['worker', 'agent-workspace-sandbox-bridge-ci-42-1'],
  ]);
  assert.deepEqual(calls.filter((call) => call.startsWith('DELETE')), [
    'DELETE containers/applications/a1',
    'DELETE containers/applications/a2',
    'DELETE workers/scripts/agent-workspace-sandbox-bridge-ci-42-1?force=true',
  ]);
});

test('a refused deletion or unreadable list is a failure naming resources and status, never the body', async () => {
  const refused = await deleteBridgeResources({
    accountId: 'acct', token: 'TOKEN', owns: ownedBy('agent-workspace-sandbox-bridge-ci-42-1'), fetch: fakeCloudflare({ refuse: ['a2', 'agent-workspace-sandbox-bridge-ci-42-1'] }).fetch,
  }).then(() => assert.fail('expected a failure'), (thrown) => thrown);
  assert.match(refused.message, /delete container application agent-workspace-sandbox-bridge-ci-42-1-sandboxopen: HTTP 403/u);
  assert.match(refused.message, /delete worker agent-workspace-sandbox-bridge-ci-42-1: HTTP 403/u);
  assert.doesNotMatch(refused.message, /SENTINEL_BODY|TOKEN/u);
  const unreadable = await deleteBridgeResources({ accountId: 'acct', token: 'TOKEN', owns: isLaneName, fetch: fakeCloudflare({ listStatus: 500 }).fetch })
    .then(() => assert.fail('expected a failure'), (thrown) => thrown);
  assert.match(unreadable.message, /list container applications: HTTP 500/u);
});

test('the sweep keeps a young lane name, its own names, an undated entry and other names; it deletes an old lane name', async () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const old = '2026-10-09T07:00:00Z';
  const young = '2026-10-09T11:00:00Z';
  const calls = [];
  const lists = {
    'containers/applications': { result: [
      { id: 'a-old', name: `${BRIDGE_PREFIX}ci-1-1-sandboxnone`, created_at: old },
      { id: 'a-young', name: `${BRIDGE_PREFIX}ci-2-1-sandboxnone`, created_at: young },
      { id: 'a-undated', name: `${BRIDGE_PREFIX}ci-3-1-sandboxnone` },
      { id: 'a-bad-date', name: `${BRIDGE_PREFIX}ci-4-1-sandboxnone`, created_at: 'yesterday' },
      { id: 'a-own', name: `${BRIDGE_PREFIX}ci-9-1-sandboxopen`, created_at: old },
      { id: 'a-other', name: 'unrelated-sandboxnone', created_at: old },
    ] },
    'workers/scripts': { result: [
      { id: `${BRIDGE_PREFIX}ci-1-1`, created_on: old, modified_on: old },
      { id: `${BRIDGE_PREFIX}ci-5-1`, created_on: old, modified_on: young },
      { id: 'agent-workspace-lp', created_on: old, modified_on: old },
    ] },
  };
  const fetch = (url, init) => {
    const pathAndQuery = url.replace(/^.*\/accounts\/[^/]+\//u, '');
    calls.push(`${init.method} ${pathAndQuery}`);
    return Promise.resolve(new Response(JSON.stringify(init.method === 'GET' ? lists[pathAndQuery] : {}), { status: 200 }));
  };
  const removed = await deleteBridgeResources({ accountId: 'acct', token: 'TOKEN', owns: isLeftover(`${BRIDGE_PREFIX}ci-9-1`, now), fetch });
  assert.deepEqual(removed, [
    ['container application', `${BRIDGE_PREFIX}ci-1-1-sandboxnone`],
    ['worker', `${BRIDGE_PREFIX}ci-1-1`],
  ]);
  assert.equal(calls.filter((call) => call.startsWith('DELETE')).length, 2);
});

test('the sweep reads every list page by cursor or page number before deleting', async () => {
  const pages = {
    'containers/applications': { result: [{ id: 'a1', name: `${BRIDGE_PREFIX}p1` }], result_info: { page: 1, total_pages: 2 } },
    'containers/applications?page=2': { result: [{ id: 'a2', name: `${BRIDGE_PREFIX}p2` }], result_info: { page: 2, total_pages: 2 } },
    'workers/scripts': { result: [{ id: `${BRIDGE_PREFIX}w1` }], result_info: { cursor: 'next one' } },
    'workers/scripts?cursor=next%20one': { result: [{ id: `${BRIDGE_PREFIX}w2` }], result_info: { cursor: '' } },
  };
  const calls = [];
  const fetch = (url, init) => {
    const pathAndQuery = url.replace(/^.*\/accounts\/[^/]+\//u, '');
    calls.push(`${init.method} ${pathAndQuery}`);
    return Promise.resolve(new Response(JSON.stringify(init.method === 'GET' ? pages[pathAndQuery] : {}), { status: 200 }));
  };
  const removed = await deleteBridgeResources({ accountId: 'acct', token: 'TOKEN', owns: isLaneName, fetch });
  assert.deepEqual(removed.map(([, name]) => name), [`${BRIDGE_PREFIX}p1`, `${BRIDGE_PREFIX}p2`, `${BRIDGE_PREFIX}w1`, `${BRIDGE_PREFIX}w2`]);
  assert.deepEqual(calls.slice(0, 2), ['GET containers/applications', 'GET containers/applications?page=2']);
  const endless = await deleteBridgeResources({
    accountId: 'acct', token: 'TOKEN', owns: isLaneName,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ result: [], result_info: { cursor: 'again' } }), { status: 200 })),
  }).then(() => assert.fail('expected a failure'), (thrown) => thrown);
  assert.match(endless.message, /list container applications: more than 100 pages/u);
});
