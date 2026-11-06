import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import {
  SENSITIVE_PERMISSIONS,
  classifyAttempt,
  evaluateProbes,
  evaluateToken,
  grantedPermissions,
  requestAttempt,
  tcpAttempt,
} from './cloud-run-lane.mjs';
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
