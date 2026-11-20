import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import {
  classifyProxyAttempt,
  evaluateProxyOpen,
  evaluateProxyRestricted,
  forgeCredentials,
  networkPolicyFromEnv,
  parseProxyUrl,
  proxyConnect,
  proxyForward,
} from './cloud-run-lane.mjs';
import { renderSummary } from './summary.mjs';
import { refused, reset, silent } from './cloud-run-lane.test-support.mjs';

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
const restrictedIds = [
  'proxy-listed-host',
  'proxy-unlisted-host',
  'proxy-direct-bypass',
  'proxy-no-credential',
];
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
  for (const { outcome } of [...Object.values(restricted), ...Object.values(open)])
    assert.equal(outcome, 'pass');
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
  assert.equal(
    evaluateProxyOpen({ ...openBase(), gatewayIlb: {} })['proxy-gateway-ilb'].outcome,
    'inconclusive',
  );
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
  for (const results of all)
    for (const { outcome } of Object.values(results)) assert.notEqual(outcome, 'n/a');
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
    assert.equal(
      classifyProxyAttempt(await proxyConnect({ host: '127.0.0.1', port }, 'open.test:443')),
      'answered',
    );
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
  assert.deepEqual(
    networkPolicyFromEnv({ ISOLATION_NETWORK_POLICY: 'open', ISOLATION_ALLOWED_DOMAINS: 'a.test' }),
    {
      networkPolicy: 'open',
    },
  );
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
  assert.throws(
    () => networkPolicyFromEnv({ ISOLATION_NETWORK_POLICY: 'any' }),
    /must be none, restricted or open/u,
  );
});
