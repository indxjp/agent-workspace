import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  SENSITIVE_PERMISSIONS,
  classifyAttempt,
  classifyProxyAttempt,
  evaluateAppHealth,
  evaluateGatewayDenied,
  evaluateProbes,
  evaluateToolCall,
  evaluateToolMetadata,
  parseToolAnswer,
  toolOpenRequest,
  toolProbeBundle,
  toolTargetsFromEnv,
  TOOL_NAME,
  evaluateProxyOpen,
  evaluateProxyRestricted,
  forgeCredentials,
  networkPolicyFromEnv,
  parseProxyUrl,
  proxyConnect,
  proxyForward,
  evaluateToken,
  grantedPermissions,
  managerFailure,
  requestAttempt,
  tcpAttempt,
} from './cloud-run-lane.mjs';
import { createHash } from 'node:crypto';
import { renderSummary } from './summary.mjs';

// What a firewall drop looks like: the attempt timed out before any TCP connect.
const silent = { connected: false, timedOut: true, error: 'timed out' };
const refused = { connected: false, timedOut: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED 199.36.153.4:443' };
const reset = { connected: false, timedOut: false, code: 'ECONNRESET', error: 'read ECONNRESET' };
const base = () => ({
  gateway: { status: 200, connected: true },
  gatewayRunApp: silent,
  gatewayRunAppViaVip: silent,
  internet: { 'HTTP example.test at 192.0.2.1:80': silent, 'TCP 443 to 192.0.2.1': silent },
  private: { 'TCP 5432 to 10.0.0.5': silent },
  privateControl: true,
  googleVip: {
    'run.googleapis.com on private.googleapis.com': silent,
    'run.googleapis.com on restricted.googleapis.com': silent,
    'TCP 443 to private.googleapis.com (199.36.153.8)': silent,
    'TCP 80 to restricted.googleapis.com (199.36.153.4)': silent,
    'run.app service outside the project': silent,
    'GCS upload outside the project': silent,
  },
});

test('a sandbox that reaches nothing but the gateway load balancer passes everything', () => {
  const results = evaluateProbes(base());
  for (const { outcome } of Object.values(results)) assert.equal(outcome, 'pass');
  assert.deepEqual(Object.keys(results).sort(), [
    'egress-gateway-run-app',
    'egress-google-vip',
    'egress-internet',
    'egress-private-range',
    'gateway-reachable',
  ]);
  assert.equal(renderSummary({ 'cloud-run': results }).clean, true);
});

test('an internet answer fails with a SECURITY detail', () => {
  const raw = { ...base(), internet: { ...base().internet, 'HTTP example.test at 192.0.2.1:80': { status: 204, connected: true } } };
  const { 'egress-internet': internet } = evaluateProbes(raw);
  assert.equal(internet.outcome, 'fail');
  assert.ok(internet.detail.startsWith('SECURITY:'));
  assert.match(internet.detail, /answered 204/u);
});

// Everything that proves a packet came back from the destination.
const reachedAttempts = {
  refused,
  reset,
  'an HTTP status': { status: 403, connected: true },
  'a raw TCP connect': { connected: true },
  'a hang-up': { connected: false, error: 'socket hang up' },
  'a timeout after the connect': { connected: true, timedOut: true, error: 'timed out' },
  'a TLS error': { connected: true, code: 'ERR_SSL_WRONG_VERSION_NUMBER', error: 'wrong version number' },
};

test('a public host that refuses, resets, connects, answers or fails TLS fails with a SECURITY detail', () => {
  for (const [label, attempt] of Object.entries(reachedAttempts)) {
    for (const name of Object.keys(base().internet)) {
      const raw = base();
      raw.internet[name] = attempt;
      const results = evaluateProbes(raw);
      assert.equal(results['egress-internet'].outcome, 'fail', `${label} on ${name}`);
      assert.ok(results['egress-internet'].detail.startsWith('SECURITY:'), `${label} on ${name}`);
      assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
    }
  }
});

test('a private range that refuses, resets or connects fails with a SECURITY detail', () => {
  for (const [label, attempt] of Object.entries(reachedAttempts)) {
    const raw = { ...base(), private: { 'TCP 5432 to 10.0.0.5': attempt } };
    const privateRange = evaluateProbes(raw)['egress-private-range'];
    assert.equal(privateRange.outcome, 'fail', label);
    assert.ok(privateRange.detail.startsWith('SECURITY:'), label);
  }
});

test('an unclear error on the public host or the private range is inconclusive; no probe at all too', () => {
  const unclear = { code: 'EHOSTUNREACH', error: 'connect EHOSTUNREACH' };
  assert.equal(
    evaluateProbes({ ...base(), internet: { ...base().internet, 'TCP 443 to 192.0.2.1': unclear } })['egress-internet'].outcome,
    'inconclusive',
  );
  assert.equal(evaluateProbes({ ...base(), private: { 'TCP 5432 to 10.0.0.5': unclear } })['egress-private-range'].outcome, 'inconclusive');
  assert.equal(evaluateProbes({ ...base(), internet: {} })['egress-internet'].outcome, 'inconclusive');
  assert.equal(evaluateProbes({ ...base(), private: {} })['egress-private-range'].outcome, 'inconclusive');
});

test('a public host and a private range that time out before the connect pass', () => {
  const results = evaluateProbes(base());
  assert.equal(results['egress-internet'].outcome, 'pass');
  assert.match(results['egress-internet'].detail, /TCP 443 to 192\.0\.2\.1 timed out before connecting/u);
  assert.equal(results['egress-private-range'].outcome, 'pass');
});

test('a failed gateway control makes the other probes inconclusive', () => {
  const results = evaluateProbes({ ...base(), gateway: { error: 'timed out' } });
  assert.equal(results['gateway-reachable'].outcome, 'fail');
  for (const id of ['egress-internet', 'egress-private-range', 'egress-google-vip', 'egress-gateway-run-app']) {
    assert.equal(results[id].outcome, 'inconclusive');
  }
  assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
});

test('a 404 from the gateway is a refusal, not a reach', () => {
  const results = evaluateProbes({ ...base(), gateway: { status: 404 } });
  assert.equal(results['gateway-reachable'].outcome, 'fail');
  assert.match(results['gateway-reachable'].detail, /404/u);
});

test('a reached private range fails, and a failed positive control makes it inconclusive', () => {
  const reached = { ...base(), private: { 'TCP 5432 to 10.0.0.5': { connected: true } } };
  assert.equal(evaluateProbes(reached)['egress-private-range'].outcome, 'fail');
  const blind = { ...reached, privateControl: false };
  assert.equal(evaluateProbes(blind)['egress-private-range'].outcome, 'inconclusive');
});

test('a 200 from the Google VIP fails the lane with a SECURITY detail', () => {
  for (const name of Object.keys(base().googleVip)) {
    const raw = base();
    raw.googleVip[name] = { status: 200 };
    const results = evaluateProbes(raw);
    const vip = results['egress-google-vip'];
    assert.equal(vip.outcome, 'fail', name);
    assert.ok(vip.detail.startsWith('SECURITY:'), name);
    assert.ok(vip.detail.includes(`${name} answered 200`), name);
    assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
  }
});

test('any HTTP answer from the Google VIP fails, a 4xx or 3xx included', () => {
  for (const status of [302, 401, 403, 404, 500]) {
    const raw = base();
    raw.googleVip['GCS upload outside the project'] = { status };
    assert.equal(evaluateProbes(raw)['egress-google-vip'].outcome, 'fail', String(status));
  }
});

test('a Google VIP that times out before the connect passes', () => {
  const vip = evaluateProbes(base())['egress-google-vip'];
  assert.equal(vip.outcome, 'pass');
  assert.match(vip.detail, /TCP 443 to private\.googleapis\.com \(199\.36\.153\.8\) timed out before connecting/u);
  assert.match(vip.detail, /GCS upload outside the project timed out before connecting/u);
});

test('a Google VIP that refuses, resets, hangs up, connects or fails TLS fails with a SECURITY detail', () => {
  const reached = {
    refused,
    reset,
    'socket hang up': { connected: false, code: 'ECONNRESET', error: 'socket hang up' },
    'hang up without a code': { connected: false, error: 'socket hang up' },
    'a raw TCP connect': { connected: true },
    'a timeout after the connect': { connected: true, timedOut: true, error: 'timed out' },
    'a TLS error after the connect': { connected: true, code: 'ERR_SSL_WRONG_VERSION_NUMBER', error: 'wrong version number' },
    'a certificate error': { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', error: 'unable to verify the first certificate' },
  };
  for (const [label, attempt] of Object.entries(reached)) {
    for (const name of Object.keys(base().googleVip)) {
      const raw = base();
      raw.googleVip[name] = attempt;
      const results = evaluateProbes(raw);
      assert.equal(results['egress-google-vip'].outcome, 'fail', `${label} on ${name}`);
      assert.ok(results['egress-google-vip'].detail.startsWith('SECURITY:'), `${label} on ${name}`);
      assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
    }
  }
});

test('an unexplained VIP error is inconclusive, never a pass', () => {
  for (const attempt of [{ code: 'EHOSTUNREACH', error: 'connect EHOSTUNREACH' }, { error: 'something odd' }]) {
    const raw = base();
    raw.googleVip['TCP 443 to private.googleapis.com (199.36.153.8)'] = attempt;
    assert.equal(evaluateProbes(raw)['egress-google-vip'].outcome, 'inconclusive', JSON.stringify(attempt));
  }
});

test('classifyAttempt passes only a timeout before the connect', () => {
  assert.equal(classifyAttempt(silent), 'silent');
  assert.equal(classifyAttempt(refused), 'reached');
  assert.equal(classifyAttempt(reset), 'reached');
  assert.equal(classifyAttempt({ status: 404 }), 'reached');
  assert.equal(classifyAttempt({ connected: true, timedOut: true }), 'reached');
  assert.equal(classifyAttempt({ code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND x.run.app' }), 'dns');
  assert.equal(classifyAttempt({ code: 'EHOSTUNREACH' }), 'unclear');
  assert.equal(classifyAttempt({}), 'unclear');
});

test('no Google VIP probe at all is inconclusive, never a pass', () => {
  const results = evaluateProbes({ ...base(), googleVip: {} });
  assert.equal(results['egress-google-vip'].outcome, 'inconclusive');
  assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
});

test("an answer, a refusal or a reset from the gateway's run.app URL fails with a SECURITY detail; a timeout passes", () => {
  for (const attempt of [{ status: 200 }, { status: 404 }, refused, reset, { connected: true, code: 'ECONNRESET' }]) {
    const results = evaluateProbes({ ...base(), gatewayRunApp: attempt });
    const runApp = results['egress-gateway-run-app'];
    assert.equal(runApp.outcome, 'fail', JSON.stringify(attempt));
    assert.ok(runApp.detail.startsWith('SECURITY:'));
    assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
  }
  assert.equal(evaluateProbes(base())['egress-gateway-run-app'].outcome, 'pass');
});

test("a DNS failure on the run.app name passes only when the IP-literal probe of that host timed out", () => {
  const dns = { connected: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND gw.run.app' };
  const covered = evaluateProbes({ ...base(), gatewayRunApp: dns })['egress-gateway-run-app'];
  assert.equal(covered.outcome, 'pass');
  assert.match(covered.detail, /did not resolve/u);
  const uncovered = { ...base(), gatewayRunApp: dns };
  delete uncovered.gatewayRunAppViaVip;
  assert.equal(evaluateProbes(uncovered)['egress-gateway-run-app'].outcome, 'inconclusive');
  const reachedLiteral = { ...base(), gatewayRunApp: dns, gatewayRunAppViaVip: refused };
  assert.equal(evaluateProbes(reachedLiteral)['egress-gateway-run-app'].outcome, 'inconclusive');
});

test('the raw TCP probe reports a refusal and a connect, which both count as reached', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const opened = await tcpAttempt('127.0.0.1', port, 2_000);
  assert.equal(opened.connected, true);
  assert.equal(classifyAttempt(opened), 'reached');
  await new Promise((resolve) => server.close(resolve));
  const closed = await tcpAttempt('127.0.0.1', port, 2_000);
  assert.equal(closed.code, 'ECONNREFUSED');
  assert.equal(classifyAttempt(closed), 'reached');
});

test('an HTTPS request that connects and then fails or stalls counts as reached', async () => {
  const sockets = new Set();
  const hangUp = createServer((socket) => socket.destroy());
  const stall = createServer((socket) => sockets.add(socket));
  await Promise.all([hangUp, stall].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
  try {
    const request = (server) =>
      requestAttempt(httpsRequest, { host: '127.0.0.1', port: server.address().port, servername: 'run.googleapis.com' }, undefined, {
        timeoutMs: 500,
      });
    const hungUp = await request(hangUp);
    assert.equal(hungUp.connected, true);
    assert.equal(classifyAttempt(hungUp), 'reached');
    const stalled = await request(stall);
    assert.equal(stalled.connected, true);
    assert.equal(stalled.timedOut, true);
    assert.equal(classifyAttempt(stalled), 'reached');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([hangUp, stall].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

const iamClean = { status: 200, granted: [] };

test('the metadata token passes only on a 403 from Cloud Run and an empty testIamPermissions answer', () => {
  const outcome = (metadata) => evaluateToken(metadata).outcome;
  assert.equal(outcome({ tokenStatus: 200, apiStatus: 403, iam: iamClean }), 'pass');
  assert.equal(outcome({ tokenStatus: 200, apiStatus: 200, iam: iamClean }), 'fail');
  assert.equal(outcome({ tokenStatus: 200, apiStatus: 500, iam: iamClean }), 'inconclusive');
  assert.equal(outcome({ tokenStatus: 200, error: 'timed out', iam: iamClean }), 'inconclusive');
  assert.equal(outcome({ tokenStatus: 404 }), 'inconclusive');
});

test('a 403 from Cloud Run alone no longer passes the token check', () => {
  assert.equal(evaluateToken({ tokenStatus: 200, apiStatus: 403 }).outcome, 'inconclusive');
});

test('any permission granted by testIamPermissions fails the token check and is named', () => {
  for (const permission of SENSITIVE_PERMISSIONS) {
    const verdict = evaluateToken({ tokenStatus: 200, apiStatus: 403, iam: { status: 200, granted: [permission] } });
    assert.equal(verdict.outcome, 'fail', permission);
    assert.match(verdict.detail, new RegExp(permission.replaceAll('.', '\\.'), 'u'));
  }
});

test('a testIamPermissions error or a malformed answer is inconclusive, never a pass', () => {
  for (const iam of [{ status: 403 }, { status: 400 }, { status: 500 }, { error: 'timed out' }, { status: 200 }, { status: 200, granted: [1] }]) {
    assert.equal(evaluateToken({ tokenStatus: 200, apiStatus: 403, iam }).outcome, 'inconclusive', JSON.stringify(iam));
  }
});

test('grantedPermissions reads the answer: an absent field is none granted, malformed is undefined', () => {
  assert.deepEqual(grantedPermissions('{}'), []);
  assert.deepEqual(grantedPermissions('{"permissions":["storage.objects.get"]}'), ['storage.objects.get']);
  for (const body of ['', 'not json', 'null', '[]', '{"permissions":"run.services.list"}', '{"permissions":[1]}']) {
    assert.equal(grantedPermissions(body), undefined, body);
  }
});

test('the sensitive permission list covers the reviewed set', () => {
  for (const permission of [
    'run.services.list',
    'run.services.create',
    'storage.objects.get',
    'storage.objects.create',
    'storage.objects.list',
    'storage.buckets.list',
    'secretmanager.versions.access',
    'aiplatform.endpoints.predict',
    'iam.serviceAccounts.getAccessToken',
    'iam.serviceAccounts.actAs',
    'cloudsql.instances.connect',
    'compute.instances.list',
    'logging.logEntries.create',
  ]) {
    assert.ok(SENSITIVE_PERMISSIONS.includes(permission), permission);
  }
});

// ---- The shared egress proxy ----------------------------------------------------------------------

const denied = (status = 403) => ({
  status,
  connected: true,
  body: JSON.stringify({ error: 'egress_denied', reason: 'host_not_allowed' }),
});
const tunnel = { status: 200, connected: true };
const target = { status: 204, connected: true, body: '' };
const handshake = { status: 200, connected: true, tls: true };
const SECRET = 'aw-secret-token-AbCdEf123456';
const proxyUrl = `http://aw:${SECRET}@10.0.0.9:3128`;

const restrictedBase = () => ({
  listedForward: target,
  listedConnect: handshake,
  unlisted: { 'CONNECT example.com:443': denied(), 'GET http://example.com': denied() },
  direct: {
    'TCP 443 to 192.0.2.1 without the proxy': silent,
    'TCP 80 to 192.0.2.1 without the proxy': silent,
  },
  noCredential: { 'CONNECT no credential': denied(407), 'CONNECT forged token': denied(407) },
});
const openBase = () => ({
  publicForward: target,
  publicConnect: handshake,
  privateTarget: { 'CONNECT 10.0.0.5:5432': denied(), 'GET http://10.0.0.5:80': denied() },
  metadata: {
    'GET http://169.254.169.254:80': denied(),
    'CONNECT metadata.google.internal:443': silent,
  },
  googleVip: { 'CONNECT 199.36.153.8:443': denied(), 'CONNECT private.googleapis.com:443': silent },
  gatewayIlb: { 'CONNECT 10.0.0.7:80': denied(), 'GET http://10.0.0.7:80': silent },
});
const restrictedIds = ['proxy-listed-host', 'proxy-unlisted-host', 'proxy-direct-bypass', 'proxy-no-credential'];
const openIds = [
  'proxy-public-host',
  'proxy-private-target',
  'proxy-metadata',
  'proxy-google-vip',
  'proxy-gateway-ilb',
];

test('a proxy that refuses what it must and serves the control passes every proxy result', () => {
  const restricted = evaluateProxyRestricted(restrictedBase());
  const open = evaluateProxyOpen(openBase());
  assert.deepEqual(Object.keys(restricted), restrictedIds);
  assert.deepEqual(Object.keys(open), openIds);
  for (const { outcome } of [...Object.values(restricted), ...Object.values(open)]) assert.equal(outcome, 'pass');
  assert.equal(renderSummary({ 'cloud-run': { ...restricted, ...open } }).clean, true);
});

test('classifyProxyAttempt: only the egress_denied body makes a response a refusal', () => {
  assert.equal(classifyProxyAttempt(denied(403)), 'refused');
  assert.equal(classifyProxyAttempt(denied(407)), 'refused');
  assert.equal(classifyProxyAttempt({ status: 403, body: '{"error":"forbidden"}' }), 'answered');
  assert.equal(classifyProxyAttempt({ status: 403, body: 'egress_denied' }), 'answered');
  assert.equal(classifyProxyAttempt({ status: 502, body: denied().body }), 'refused');
  assert.equal(classifyProxyAttempt({ status: 400, body: denied().body }), 'refused');
  assert.equal(classifyProxyAttempt({ status: 502, body: '{"error":"bad_gateway"}' }), 'answered');
  assert.equal(classifyProxyAttempt({ status: 200 }), 'answered');
  assert.equal(classifyProxyAttempt({ tls: true }), 'answered');
  assert.equal(classifyProxyAttempt(silent), 'silent');
  assert.equal(classifyProxyAttempt({ connected: true, timedOut: true }), 'silent');
});

test('a silent positive control says whether TCP to the proxy connected, and still fails', () => {
  const raw = restrictedBase();
  raw.listedForward = silent;
  raw.listedConnect = { connected: true, timedOut: true, error: 'timed out' };
  const listed = evaluateProxyRestricted(raw)['proxy-listed-host'];
  assert.equal(listed.outcome, 'fail');
  assert.equal(
    listed.detail,
    'forward no response before the timeout (no TCP connection to the proxy), ' +
      'CONNECT no response before the timeout (TCP to the proxy connected)',
  );
});

test('a forwarded 403 without the egress_denied body fails with SECURITY', () => {
  const raw = openBase();
  raw.privateTarget['GET http://10.0.0.5:80'] = {
    status: 403,
    connected: true,
    body: '<html>forbidden</html>',
  };
  const verdict = evaluateProxyOpen(raw)['proxy-private-target'];
  assert.equal(verdict.outcome, 'fail');
  assert.ok(verdict.detail.startsWith('SECURITY:'));
});

test('a 200 tunnel to a private target fails with SECURITY', () => {
  const raw = openBase();
  raw.privateTarget['CONNECT 10.0.0.5:5432'] = tunnel;
  const verdict = evaluateProxyOpen(raw)['proxy-private-target'];
  assert.equal(verdict.outcome, 'fail');
  assert.ok(verdict.detail.startsWith('SECURITY:'));
  assert.match(verdict.detail, /CONNECT 10\.0\.0\.5:5432 answered 200/u);
});

test('any answer from a target fails every denied open probe with SECURITY, a TLS handshake included', () => {
  for (const id of openIds.slice(1)) {
    const key = {
      'proxy-private-target': 'privateTarget',
      'proxy-metadata': 'metadata',
      'proxy-google-vip': 'googleVip',
      'proxy-gateway-ilb': 'gatewayIlb',
    }[id];
    for (const answer of [tunnel, target, handshake, { status: 404, body: '' }]) {
      const raw = openBase();
      raw[key][Object.keys(raw[key])[0]] = answer;
      const verdict = evaluateProxyOpen(raw)[id];
      assert.equal(verdict.outcome, 'fail', `${id} ${JSON.stringify(answer)}`);
      assert.ok(verdict.detail.startsWith('SECURITY:'));
    }
  }
  const raw = restrictedBase();
  raw.unlisted['GET http://example.com'] = target;
  assert.ok(evaluateProxyRestricted(raw)['proxy-unlisted-host'].detail.startsWith('SECURITY:'));
});

test('a silent timeout passes; a proxy that refuses the connection is inconclusive, never a pass or a fail', () => {
  const raw = openBase();
  raw.privateTarget = { 'CONNECT 10.0.0.5:5432': silent };
  assert.equal(evaluateProxyOpen(raw)['proxy-private-target'].outcome, 'pass');
  // ECONNREFUSED or a reset from the proxy: a dead proxy says nothing about the policy.
  for (const attempt of [refused, reset, { code: 'ENOTFOUND' }, {}]) {
    const unclear = openBase();
    unclear.metadata['GET http://169.254.169.254:80'] = attempt;
    assert.equal(classifyProxyAttempt(attempt), 'unclear');
    assert.equal(evaluateProxyOpen(unclear)['proxy-metadata'].outcome, 'inconclusive');
  }
  assert.equal(evaluateProxyOpen({ ...openBase(), gatewayIlb: {} })['proxy-gateway-ilb'].outcome, 'inconclusive');
});

test('a failed positive control fails and makes the security results inconclusive', () => {
  for (const control of [
    { listedForward: denied() },
    { listedConnect: tunnel },
    { listedConnect: silent },
    { listedForward: { status: 500 } },
  ]) {
    const results = evaluateProxyRestricted({ ...restrictedBase(), ...control });
    assert.equal(results['proxy-listed-host'].outcome, 'fail');
    for (const id of restrictedIds.slice(1)) assert.equal(results[id].outcome, 'inconclusive', id);
    assert.equal(renderSummary({ 'cloud-run': results }).clean, false);
  }
  const open = evaluateProxyOpen({ ...openBase(), publicConnect: silent });
  assert.equal(open['proxy-public-host'].outcome, 'fail');
  for (const id of openIds.slice(1)) assert.equal(open[id].outcome, 'inconclusive', id);
});

test('the direct bypass passes only on a timeout before the connect', () => {
  for (const attempt of [{ connected: true }, refused, { status: 200 }]) {
    const raw = restrictedBase();
    raw.direct['TCP 443 to 192.0.2.1 without the proxy'] = attempt;
    const verdict = evaluateProxyRestricted(raw)['proxy-direct-bypass'];
    assert.equal(verdict.outcome, 'fail');
    assert.ok(verdict.detail.startsWith('SECURITY:'));
  }
});

test('no credential or a forged token must be a 407 egress_denied refusal', () => {
  const verdict = (attempt) => {
    const raw = restrictedBase();
    raw.noCredential['CONNECT forged token'] = attempt;
    return evaluateProxyRestricted(raw)['proxy-no-credential'];
  };
  assert.equal(verdict(tunnel).outcome, 'fail');
  assert.ok(verdict(tunnel).detail.startsWith('SECURITY:'));
  assert.equal(verdict(denied(403)).outcome, 'fail');
  assert.equal(verdict(silent).outcome, 'inconclusive');
  assert.equal(verdict(refused).outcome, 'inconclusive');
  assert.equal(verdict(denied(407)).outcome, 'pass');
});

test('no proxy result is ever n/a, and none holds a token or a credential', () => {
  const all = [];
  const attemptsOf = [
    target,
    tunnel,
    handshake,
    denied(),
    denied(407),
    silent,
    refused,
    reset,
    {},
    { status: 403, body: 'x' },
  ];
  for (const attempt of attemptsOf) {
    const restricted = restrictedBase();
    restricted.unlisted['CONNECT example.com:443'] = attempt;
    restricted.noCredential['CONNECT no credential'] = attempt;
    restricted.direct['TCP 443 to 192.0.2.1 without the proxy'] = attempt;
    const open = openBase();
    for (const key of ['privateTarget', 'metadata', 'googleVip', 'gatewayIlb'])
      open[key][Object.keys(open[key])[0]] = attempt;
    all.push(
      evaluateProxyRestricted(restricted),
      evaluateProxyOpen(open),
      evaluateProxyRestricted({ ...restricted, listedConnect: attempt }),
    );
  }
  for (const results of all) for (const { outcome } of Object.values(results)) assert.notEqual(outcome, 'n/a');
  // The attempts above carry what a real run holds: the proxy URL's token sits in the request, not in the answer.
  const { credentials } = parseProxyUrl(proxyUrl);
  assert.equal(credentials, `aw:${SECRET}`);
  const text = JSON.stringify(all);
  for (const needle of [
    SECRET,
    'Proxy-Authorization',
    'Basic ',
    Buffer.from(credentials).toString('base64'),
    proxyUrl,
  ]) {
    assert.ok(!text.includes(needle), needle);
  }
});

test('forgeCredentials flips the first signature character; parseProxyUrl never echoes a bad URL', () => {
  assert.equal(forgeCredentials('aw:payload.Abc'), 'aw:payload.Bbc');
  assert.equal(forgeCredentials('aw:payload.xbc'), 'aw:payload.Abc');
  assert.notEqual(forgeCredentials(`aw:${SECRET}`), `aw:${SECRET}`);
  assert.deepEqual(parseProxyUrl('http://10.0.0.9'), { host: '10.0.0.9', port: 3128 });
  assert.throws(
    () => parseProxyUrl(`not a url ${SECRET}`),
    (error) => !error.message.includes(SECRET),
  );
});

test('the proxy client speaks CONNECT and absolute-URI forward requests, with Basic credentials', async () => {
  const seen = [];
  const refusal = JSON.stringify({ error: 'egress_denied', reason: 'credential_invalid' });
  const proxy = createHttpServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    res
      .writeHead(403, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(refusal),
      })
      .end(refusal);
  });
  proxy.on('connect', (req, socket) => {
    seen.push({ connect: req.url, auth: req.headers['proxy-authorization'] });
    const status = req.headers['proxy-authorization'] === undefined ? 407 : 403;
    socket.end(
      `HTTP/1.1 ${String(status)} X\r\ncontent-length: ${String(Buffer.byteLength(refusal))}\r\n\r\n${refusal}`,
    );
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address();
  try {
    const withToken = { host: '127.0.0.1', port, credentials: 'aw:tok' };
    const forward = await proxyForward(withToken, 'http://target.test:80/x');
    assert.equal(classifyProxyAttempt(forward), 'refused');
    assert.deepEqual(seen[0], {
      url: 'http://target.test:80/x',
      auth: `Basic ${Buffer.from('aw:tok').toString('base64')}`,
    });
    const connected = await proxyConnect(withToken, 'target.test:443');
    assert.equal(classifyProxyAttempt(connected), 'refused');
    assert.equal(connected.status, 403);
    const bare = await proxyConnect({ host: '127.0.0.1', port }, 'target.test:443');
    assert.equal(bare.status, 407);
    assert.equal(classifyProxyAttempt(bare), 'refused');
    assert.equal(seen[2].auth, undefined);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
  const down = await proxyConnect({ host: '127.0.0.1', port }, 'target.test:443', {
    timeoutMs: 500,
  });
  assert.equal(classifyProxyAttempt(down), 'unclear');
});

test('a 200 tunnel is an answer, and a proxy that never replies is silent', async () => {
  const sockets = new Set();
  const proxy = createHttpServer();
  proxy.on('connect', (req, socket) => {
    sockets.add(socket);
    if (req.url.startsWith('open')) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address();
  try {
    assert.equal(classifyProxyAttempt(await proxyConnect({ host: '127.0.0.1', port }, 'open.test:443')), 'answered');
    const quiet = await proxyConnect({ host: '127.0.0.1', port }, 'quiet.test:443', {
      timeoutMs: 300,
    });
    assert.equal(classifyProxyAttempt(quiet), 'silent');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('create takes its network policy from the environment, none by default', () => {
  assert.deepEqual(networkPolicyFromEnv({}), { networkPolicy: 'none' });
  assert.deepEqual(networkPolicyFromEnv({ ISOLATION_NETWORK_POLICY: 'open', ISOLATION_ALLOWED_DOMAINS: 'a.test' }), {
    networkPolicy: 'open',
  });
  assert.deepEqual(
    networkPolicyFromEnv({
      ISOLATION_NETWORK_POLICY: 'restricted',
      ISOLATION_ALLOWED_DOMAINS: 'a.test, b.test,',
    }),
    {
      networkPolicy: 'restricted',
      allowedDomains: ['a.test', 'b.test'],
    },
  );
  assert.throws(() => networkPolicyFromEnv({ ISOLATION_NETWORK_POLICY: 'any' }), /must be none, restricted or open/u);
});

// ---- App reachability and the tool sandbox lane ----------------------------------------------

test('an app run.app URL is judged like the gateway one: any HTTP answer fails with SECURITY, silence passes', () => {
  const withApp = (appRunApp, appRunAppViaVip = silent) => ({ ...base(), appRunApp, appRunAppViaVip });
  const passing = evaluateProbes(withApp(silent));
  assert.equal(passing['egress-app-run-app'].title, 'A none sandbox cannot reach an app service');
  assert.equal(passing['egress-app-run-app'].outcome, 'pass');
  for (const attempt of [{ status: 200 }, { status: 404 }, { status: 403 }, refused, reset]) {
    const app = evaluateProbes(withApp(attempt))['egress-app-run-app'];
    assert.equal(app.outcome, 'fail', JSON.stringify(attempt));
    assert.ok(app.detail.startsWith('SECURITY:'));
  }
  const dns = { connected: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND app.run.app' };
  assert.equal(evaluateProbes(withApp(dns))['egress-app-run-app'].outcome, 'pass');
  assert.equal(evaluateProbes(withApp(dns, { status: 200 }))['egress-app-run-app'].outcome, 'inconclusive');
  // Without an app configured there is no such result, and a failed control blinds it.
  assert.equal('egress-app-run-app' in evaluateProbes(base()), false);
  assert.equal(evaluateProbes({ ...withApp(silent), gateway: { status: 404 } })['egress-app-run-app'].outcome, 'inconclusive');
});

test('the app health control passes only on a 200', () => {
  assert.equal(evaluateAppHealth({ status: 200 }).outcome, 'pass');
  for (const attempt of [{ status: 503 }, { status: 404 }, silent]) {
    assert.equal(evaluateAppHealth(attempt).outcome, 'fail');
  }
});

const probeOutput = (over = {}) => {
  const { privateControl: _control, ...attempts } = { ...base(), appRunApp: silent, appRunAppViaVip: silent, ...over };
  return attempts;
};
const silentApi = { api: silent, iam: silent };
const toolAnswer = (output, status = 200) => ({
  status,
  text: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(output) }] },
  }),
});
const silentOutput = () => toolAnswer({ attempts: probeOutput(), metadata: { tokenStatus: 200, attempts: silentApi } });

test('a tool sandbox that reaches nothing passes every tool result, from JSON or from SSE', () => {
  for (const response of [
    silentOutput(),
    { status: 200, text: `event: message\ndata: ${silentOutput().text}\n\n` },
  ]) {
    const results = evaluateToolCall(response, true);
    assert.deepEqual(Object.keys(results).sort(), [
      'tool-call',
      'tool-egress-app-run-app',
      'tool-egress-gateway-run-app',
      'tool-egress-google-vip',
      'tool-egress-internet',
      'tool-egress-private',
      'tool-gateway-reachable',
      'tool-metadata-token',
    ]);
    for (const { outcome } of Object.values(results)) assert.equal(outcome, 'pass');
  }
});

test('any HTTP answer from a target fails the tool results with SECURITY', () => {
  const cases = {
    'tool-egress-internet': { internet: { 'TCP 443 to 192.0.2.1': { connected: true } } },
    'tool-egress-private': { private: { 'TCP 5432 to 10.0.0.5': { connected: true } } },
    'tool-egress-google-vip': { googleVip: { 'TCP 80 to private.googleapis.com (199.36.153.8)': { status: 200 } } },
    'tool-egress-gateway-run-app': { gatewayRunApp: { status: 200 } },
    'tool-egress-app-run-app': { appRunApp: { status: 200 } },
  };
  for (const [key, over] of Object.entries(cases)) {
    const results = evaluateToolCall(toolAnswer({ attempts: probeOutput(over), metadata: { attempts: silentApi } }), true);
    assert.equal(results[key].outcome, 'fail', key);
    assert.ok(results[key].detail.startsWith('SECURITY:'), key);
  }
});

test('the tool token passes on silence or on a 403, and fails when the API answers or grants anything', () => {
  assert.equal(evaluateToolMetadata({ attempts: silentApi }).outcome, 'pass');
  const refusedOk = { apiStatus: 403, iam: { status: 200, granted: [] }, attempts: { api: { status: 403 }, iam: { status: 200 } } };
  assert.equal(evaluateToolMetadata(refusedOk).outcome, 'pass');
  const accepted = { apiStatus: 200, iam: { status: 200, granted: [] }, attempts: { api: { status: 200 }, iam: { status: 200 } } };
  assert.equal(evaluateToolMetadata(accepted).outcome, 'fail');
  const granted = { iam: { status: 200, granted: ['run.services.list'] }, attempts: { api: silent, iam: { status: 200 } } };
  assert.equal(evaluateToolMetadata(granted).outcome, 'fail');
  assert.equal(evaluateToolMetadata({ tokenStatus: 404 }).outcome, 'inconclusive');
  assert.equal(evaluateToolMetadata(undefined).outcome, 'inconclusive');
});

// Run 42577620759: tool-call sent no project, so the tool never tried its token ("no metadata token
// probe ran"). The targets now always carry it, and the tool's token is judged from its answer.
test('tool-call always hands the tool the project and region, and refuses to run without them', () => {
  const env = {
    ISOLATION_INTERNET_URL: 'http://example.test/',
    ISOLATION_INTERNET_ADDRESS: '192.0.2.1',
    ISOLATION_PRIVATE_ADDRESS: '10.0.0.5',
    ISOLATION_GATEWAY_URL: 'http://10.0.0.9',
    ISOLATION_GATEWAY_RUN_APP_URL: 'https://gateway.example.test',
  };
  const targets = toolTargetsFromEnv({ ...env, GCP_PROJECT: 'example-project', GCP_REGION: 'example-region1' });
  assert.equal(targets.project, 'example-project');
  assert.equal(targets.region, 'example-region1');
  assert.throws(() => toolTargetsFromEnv(env), /GCP_PROJECT is required/u);
  assert.throws(() => toolTargetsFromEnv({ ...env, GCP_PROJECT: 'example-project' }), /GCP_REGION is required/u);
});

test("the tool sandbox's token passes only on proof, fails when usable, and is inconclusive when not tried", () => {
  const judge = (metadata) => evaluateToolCall(toolAnswer({ attempts: probeOutput(), metadata }), true)['tool-metadata-token'];
  const unreachable = judge({ tokenStatus: 200, apiStatus: undefined, attempts: silentApi });
  assert.equal(unreachable.outcome, 'pass');
  assert.match(unreachable.detail, /no route to a Google API/u);
  const refusedEverywhere = judge({
    tokenStatus: 200,
    apiStatus: 403,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 403 }, iam: { status: 200 } },
  });
  assert.equal(refusedEverywhere.outcome, 'pass');
  const usable = judge({
    tokenStatus: 200,
    apiStatus: 200,
    iam: { status: 200, granted: [] },
    attempts: { api: { status: 200 }, iam: { status: 200 } },
  });
  assert.equal(usable.outcome, 'fail');
  const granting = judge({
    tokenStatus: 200,
    apiStatus: 403,
    iam: { status: 200, granted: ['run.services.create'] },
    attempts: { api: { status: 403 }, iam: { status: 200 } },
  });
  assert.equal(granting.outcome, 'fail');
  assert.match(granting.detail, /run\.services\.create/u);
  // The token server refused, or the probe never ran: nothing is proven.
  assert.equal(judge({ tokenStatus: 403 }).outcome, 'inconclusive');
  assert.equal(judge({ error: 'fetch failed' }).outcome, 'inconclusive');
  assert.equal(judge(undefined).outcome, 'inconclusive');
  // A silent Cloud Run API with an answering testIamPermissions is judged on the answer, not passed.
  assert.notEqual(
    judge({ tokenStatus: 200, iam: { status: 200, granted: undefined }, attempts: { api: silent, iam: { status: 200 } } }).outcome,
    'pass',
  );
});

test('the tool probe tries its metadata token whenever it is given a project', () => {
  const bundle = toolProbeBundle();
  assert.match(bundle, /targets\.project === undefined \? undefined : collectMetadata\(targets\.project, targets\.region\)/u);
});

test('a failed gateway control in the tool sandbox is a fail, and every security result is inconclusive', () => {
  const results = evaluateToolCall(
    toolAnswer({ attempts: probeOutput({ gateway: { status: 404 } }), metadata: { attempts: silentApi } }),
    true,
  );
  assert.equal(results['tool-gateway-reachable'].outcome, 'fail');
  for (const [key, value] of Object.entries(results)) {
    if (key !== 'tool-gateway-reachable' && key !== 'tool-call') assert.equal(value.outcome, 'inconclusive', key);
  }
  assert.equal(renderSummary({ tool: results }).clean, false);
});

test('a tool call that returns no probe output fails tool-call and proves nothing else', () => {
  const bad = [
    { status: 503, text: '{"error":"tool_host_not_ready"}' },
    { status: 401, text: '' },
    { error: 'timed out' },
    { status: 200, text: 'not json' },
    { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }) },
    { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }) },
    toolAnswer({ unexpected: true }),
  ];
  for (const response of bad) {
    const results = evaluateToolCall(response, true);
    assert.equal(results['tool-call'].outcome, 'fail', JSON.stringify(response));
    for (const [key, value] of Object.entries(results)) {
      if (key !== 'tool-call') assert.equal(value.outcome, 'inconclusive', key);
    }
  }
  assert.match(evaluateToolCall(bad[0], true)['tool-call'].detail, /503.*tool_host_not_ready/u);
});

test('the tool private range is inconclusive when the positive control failed', () => {
  assert.equal(evaluateToolCall(silentOutput(), false)['tool-egress-private'].outcome, 'inconclusive');
});

test('parseToolAnswer reads JSON and the data line of an SSE stream', () => {
  assert.deepEqual(parseToolAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolAnswer('event: message\ndata: {"a":2}\n\n'), { a: 2 });
  assert.equal(parseToolAnswer('nothing'), undefined);
  assert.equal(parseToolAnswer(undefined), undefined);
});

test('the gateway identity must get 403 from an agent sandbox; any other answer fails with SECURITY', () => {
  const through = { status: 200 };
  assert.equal(evaluateGatewayDenied({ status: 403 }, through).outcome, 'pass');
  assert.equal(evaluateGatewayDenied({ status: 403 }, { status: 401 }).outcome, 'pass');
  for (const status of [200, 204, 302, 401, 404, 500]) {
    for (const control of [through, { status: 403 }, { error: 'timed out' }]) {
      const verdict = evaluateGatewayDenied({ status }, control);
      assert.equal(verdict.outcome, 'fail', String(status));
      assert.ok(verdict.detail.startsWith('SECURITY:'));
    }
  }
  assert.equal(evaluateGatewayDenied({ error: 'timed out' }, through).outcome, 'inconclusive');
});

test('a 403 from the agent sandbox proves nothing when the tool sandbox refused the same identity', () => {
  // Live run 42525921402: both answered 403, so the gateway reached no sandbox at all.
  const refused = evaluateGatewayDenied({ status: 403 }, { status: 403 });
  assert.equal(refused.outcome, 'inconclusive');
  assert.match(refused.detail, /tool sandbox answered 403 too/u);
  assert.equal(evaluateGatewayDenied({ status: 403 }, { error: 'timed out' }).outcome, 'inconclusive');
});

test("a bare 403 from the tool sandbox is named as Cloud Run's refusal, a JSON one by its reason", () => {
  const bare = evaluateToolCall({ status: 403, text: '<html>Error: Forbidden</html>' }, true)['tool-call'];
  assert.equal(bare.outcome, 'fail');
  assert.match(bare.detail, /^POST \/mcp answered 403 \(by Cloud Run, before the container/u);
  const json = evaluateToolCall({ status: 403, text: '{"error":"origin_not_allowed"}' }, true)['tool-call'];
  assert.equal(json.detail, 'POST /mcp answered 403 (origin_not_allowed)');
});

test('tool-probe.mjs exports the run function the tool host expects and the bundle is one self-contained module', async () => {
  const { default: run } = await import('./tool-probe.mjs');
  assert.equal(typeof run, 'function');
  const bundle = toolProbeBundle();
  assert.doesNotMatch(bundle, /from '\.\//u);
  assert.doesNotMatch(bundle, /^export (?!default)/mu);
  // Loaded in a child process through a static import: the bundle is one ES module, and a
  // computed import() here is what the module-boundary gates cannot decide.
  const directory = mkdtempSync(path.join(tmpdir(), 'tool-probe-'));
  try {
    writeFileSync(path.join(directory, 'bundle.mjs'), bundle);
    writeFileSync(
      path.join(directory, 'check.mjs'),
      "import run from './bundle.mjs';\nprocess.stdout.write(JSON.stringify([typeof run, run.length]));\n",
    );
    const printed = execFileSync(process.execPath, [path.join(directory, 'check.mjs')], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(printed), ['function', 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the tool-open request is a valid manifest whose digest is the bundle sha256 and holds the one probe tool', () => {
  const request = toolOpenRequest({ id: 'abc123', runId: 'run-abc123', token: 'tok-0123456789abcdef' });
  assert.equal(request.workspaceId, 'aw-iso-abc123');
  assert.equal(request.clientId, 'aw-iso-abc123-tool');
  assert.deepEqual(request.toolSandbox.run, { runId: 'run-abc123', token: 'tok-0123456789abcdef' });
  // The field names of ToolSandboxManifestSchema (packages/contracts), checked by hand: this suite
  // runs without the workspace installed.
  const { manifest } = request.toolSandbox;
  assert.deepEqual(Object.keys(manifest).sort(), ['env', 'stdioServers', 'tools']);
  assert.deepEqual(request.toolSandbox.allowedDomains, []);
  assert.equal(manifest.tools.length, 1);
  const [tool] = manifest.tools;
  assert.deepEqual(Object.keys(tool).sort(), ['bundleBase64', 'description', 'digest', 'inputSchema', 'name', 'timeoutMs']);
  assert.match(tool.name, /^[A-Za-z0-9_-]{1,41}$/u);
  assert.match(tool.digest, /^[0-9a-f]{64}$/u);
  assert.equal(tool.name, TOOL_NAME);
  assert.deepEqual(manifest.env, {});
  assert.deepEqual(manifest.stdioServers, []);
  assert.equal(tool.digest, createHash('sha256').update(Buffer.from(tool.bundleBase64, 'base64')).digest('hex'));
});

test('managerFailure names the manager error code and reason, and only the status without a JSON answer', () => {
  assert.equal(
    managerFailure(
      'POST',
      '/tool-sandboxes',
      503,
      JSON.stringify({ error: 'tool_sandbox_unavailable', message: 'the tool sandbox could not be prepared' }),
    ),
    'runner manager POST /tool-sandboxes answered 503 (tool_sandbox_unavailable: the tool sandbox could not be prepared)',
  );
  assert.equal(managerFailure('POST', '/tool-sandboxes', 503, 'upstream connect error'), 'runner manager POST /tool-sandboxes answered 503');
  assert.equal(
    managerFailure('POST', '/runtimes', 500, JSON.stringify({ error: 'internal_error' })),
    'runner manager POST /runtimes answered 500 (internal_error)',
  );
  assert.equal(managerFailure('POST', '/x', 503, JSON.stringify({ message: 'm'.repeat(400) })).length, 'runner manager POST /x answered 503 ()'.length + 300);
});
