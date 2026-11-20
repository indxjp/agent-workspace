import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';

import { renderSummary } from '../isolation/summary.mjs';
import { metadataEvidence } from './probe.mjs';
import {
  blockedVerdict,
  CHECKS,
  cloudMetadataVerdict,
  CREATE_ROWS,
  deadlineVerdict,
  Inconclusive,
  ipv6Verdict,
  noPolicyRows,
  PRIVATE_TARGETS,
  privateVerdict,
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
  assert.throws(
    () => blockedVerdict({ ...attempts, gateway: answered(false) }, ['metadata'], 'gateway'),
    Inconclusive,
  );
});

test('a refused or timed-out private range is blocked only next to a gateway that answered', () => {
  const refused = { outcome: 'refused', answered: false };
  const silent = Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, refused]));
  const attempts = { ...silent, metadata: answered(false) };
  assert.doesNotThrow(() =>
    blockedVerdict(
      { ...attempts, gateway: answered(true) },
      ['metadata', ...PRIVATE_TARGETS],
      'gateway',
    ),
  );
  for (const gateway of [answered(false), refused, undefined]) {
    assert.throws(
      () => blockedVerdict({ ...attempts, gateway }, ['metadata', ...PRIVATE_TARGETS], 'gateway'),
      Inconclusive,
    );
  }
});

test('the deadline passes only on a definite provider stop; no answer is inconclusive', () => {
  assert.doesNotThrow(() => deadlineVerdict(false, 'stopped'));
  assert.throws(() => deadlineVerdict(true, 'stopped'), /still answers/u);
  assert.throws(
    () => deadlineVerdict(false, 'running'),
    (error) => !(error instanceof Inconclusive),
  );
  for (const state of [
    undefined,
    'lookup failed: fetch failed',
    'lookup answered 500',
    'unknown state paused',
  ]) {
    assert.throws(() => deadlineVerdict(false, state), Inconclusive);
  }
  const inconclusive = renderSummary({
    e2b: { deadline: { title: CHECKS.deadline, outcome: 'inconclusive' } },
  });
  assert.equal(inconclusive.clean, false);
});

test('a target that answered, or was not reported, is a failure', () => {
  const attempts = { gateway: answered(true), metadata: answered(true), cgnat: answered(false) };
  assert.throws(() => blockedVerdict(attempts, ['metadata'], 'gateway'), /metadata/u);
  assert.throws(
    () => blockedVerdict(attempts, PRIVATE_TARGETS, 'gateway'),
    /rfc1918-10 \(unreported\)/u,
  );
  assert.throws(
    () => blockedVerdict({ ...attempts, cgnat: answered(true) }, ['cgnat'], 'gateway'),
    /cgnat \(connected\)/u,
  );
});

const connected = (bytes, status = null, end = 'close') => ({
  outcome: 'connected',
  answered: true,
  exchange: { bytes, end, status },
});
const withFronted = (entries) =>
  Object.fromEntries(
    Object.entries(entries).flatMap(([name, value]) => [
      [name, value],
      [`${name}-fronted`, value],
    ]),
  );
const proxied = (bytes = 0) =>
  withFronted(Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, connected(bytes)])));
const sentinel = withFronted({ 'test-net': connected(0) });

test('private ranges: refused or timed out passes; a connect passes only as a silent proxy next to a silent unroutable sentinel', () => {
  const gateway = answered(true);
  const refused = withFronted(
    Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, answered(false)])),
  );
  assert.equal(privateVerdict({ gateway, ...refused }, 'gateway'), 'refused or timed out');
  assert.match(
    privateVerdict({ gateway, ...proxied(), ...sentinel }, 'gateway'),
    /egress proxy for .*rfc1918-10.* and unroutable 192\.0\.2\.1, also with the gateway's Host; none returned a byte$/u,
  );
  assert.match(
    privateVerdict(
      { gateway, ...refused, ...withFronted({ 'rfc1918-10': connected(0) }), ...sentinel },
      'gateway',
    ),
    /egress proxy for rfc1918-10 and .*; the rest refused or timed out$/u,
  );
  assert.match(
    privateVerdict(
      { gateway, ...proxied(), ...sentinel, 'test-net': connected(0, null, 'reset') },
      'gateway',
    ),
    /none returned a byte$/u,
  );
});

test('private ranges: a fronted exchange (gateway Host to a private address) that answers or is unreported is a failure', () => {
  const gateway = answered(true);
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...proxied(), ...sentinel, 'rfc1918-10-fronted': connected(120, 200) },
        'gateway',
      ),
    /rfc1918-10-fronted \(connected, 120 bytes, HTTP 200\)/u,
  );
  const { 'cgnat-fronted': _cgnat, ...cgnatUnreported } = proxied();
  assert.throws(
    () => privateVerdict({ gateway, ...cgnatUnreported, ...sentinel }, 'gateway'),
    /cgnat-fronted \(unreported\)/u,
  );
  assert.throws(
    () => privateVerdict({ gateway, ...proxied(), 'test-net': connected(0) }, 'gateway'),
    /test-net-fronted \(unreported\)/u,
  );
  const refused = Object.fromEntries(PRIVATE_TARGETS.map((target) => [target, answered(false)]));
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...refused, ...withFronted({ 'rfc1918-10': connected(0) }), ...sentinel },
        'gateway',
      ),
    /rfc1918-172-fronted \(unreported\)/u,
  );
});

test('private ranges: a connect that stalls until the timeout is a failure', () => {
  const gateway = answered(true);
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...proxied(), ...sentinel, 'rfc1918-192': connected(0, null, 'timeout') },
        'gateway',
      ),
    /rfc1918-192 \(connected, no reply before timeout\)/u,
  );
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...proxied(), ...sentinel, 'test-net-fronted': connected(0, null, 'timeout') },
        'gateway',
      ),
    /test-net-fronted \(connected, no reply before timeout\)/u,
  );
});

test('private ranges: a connect without evidence, a byte, or a sentinel that did not connect is a failure', () => {
  const gateway = answered(true);
  const oldVercelReport = Object.fromEntries(
    PRIVATE_TARGETS.map((target) => [target, answered(true)]),
  );
  assert.throws(
    () => privateVerdict({ gateway, ...oldVercelReport, 'test-net': answered(true) }, 'gateway'),
    /no exchange evidence/u,
  );
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...proxied(), ...sentinel, 'test-net': answered(false) },
        'gateway',
      ),
    /test-net \(timeout\)/u,
  );
  assert.throws(
    () => privateVerdict({ gateway, ...proxied() }, 'gateway'),
    /test-net \(unreported\)/u,
  );
  assert.throws(
    () =>
      privateVerdict(
        { gateway, ...proxied(), ...sentinel, 'test-net': connected(37, 403) },
        'gateway',
      ),
    /test-net \(connected, 37 bytes, HTTP 403\)/u,
  );
  assert.throws(
    () =>
      privateVerdict({ gateway, ...proxied(), cgnat: connected(37, 403), ...sentinel }, 'gateway'),
    /cgnat \(connected, 37 bytes, HTTP 403\)/u,
  );
  assert.throws(
    () => privateVerdict({ gateway, ...sentinel }, 'gateway'),
    /rfc1918-10 \(unreported\)/u,
  );
});

test('private ranges: a gateway that did not answer is inconclusive', () => {
  assert.throws(
    () => privateVerdict({ gateway: answered(false), ...proxied(), ...sentinel }, 'gateway'),
    Inconclusive,
  );
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
  assert.deepEqual(cloudMetadataVerdict(mmdsAttempts(), 'gateway'), {
    mmds: true,
    keys: MMDS_EVIDENCE.keys,
  });
});

test('a blocked 169.254.169.254:80 passes unchanged; unreported or a down gateway does not', () => {
  const blocked = { gateway: answered(true), metadata: answered(false) };
  assert.deepEqual(cloudMetadataVerdict(blocked, 'gateway'), { mmds: false, keys: [] });
  assert.throws(() => cloudMetadataVerdict({ gateway: answered(true) }, 'gateway'), /unreported/u);
  assert.throws(
    () => cloudMetadataVerdict({ ...blocked, gateway: answered(false) }, 'gateway'),
    Inconclusive,
  );
});

test('a key beyond the four MMDS keys fails and the message names the key only', () => {
  const evidence = { ...MMDS_EVIDENCE, keys: ['envID', 'iam'] };
  assert.throws(
    () => cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'),
    /unexpected keys: iam$/u,
  );
  for (const keys of [[], null]) {
    assert.throws(
      () => cloudMetadataVerdict(mmdsAttempts({ ...MMDS_EVIDENCE, keys }), 'gateway'),
      /no key set/u,
    );
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
  assert.throws(
    () =>
      cloudMetadataVerdict(
        mmdsAttempts(MMDS_EVIDENCE, { 'link-local-2': answered(true) }),
        'gateway',
      ),
    /169\.254\.169\.253/u,
  );
  assert.throws(
    () =>
      cloudMetadataVerdict(mmdsAttempts(MMDS_EVIDENCE, { 'link-local-2': undefined }), 'gateway'),
    /169\.254\.169\.253/u,
  );
});

test('a connect without proof fails: no evidence, an unauthenticated 200, or no token', () => {
  assert.throws(() => cloudMetadataVerdict(mmdsAttempts(null), 'gateway'), /without proof/u);
  assert.throws(
    () =>
      cloudMetadataVerdict(
        mmdsAttempts({ ...MMDS_EVIDENCE, unauthenticatedStatus: 200 }),
        'gateway',
      ),
    /not MMDS's 401/u,
  );
  assert.throws(
    () => cloudMetadataVerdict(mmdsAttempts({ ...MMDS_EVIDENCE, tokenStatus: null }), 'gateway'),
    /token PUT/u,
  );
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
  assert.doesNotThrow(() =>
    ipv6Verdict(ipv6Attempts({ 'ipv6-public': answered(true) }), 'open', 'gateway'),
  );
  assert.throws(
    () => ipv6Verdict(ipv6Attempts({ 'ipv6-public': answered(true) }), 'none', 'gateway'),
    /none: reachable: ipv6-public/u,
  );
  for (const target of ['ipv6-link-local', 'ipv6-ula', 'ipv6-loopback']) {
    for (const policy of ['none', 'open']) {
      assert.throws(
        () => ipv6Verdict(ipv6Attempts({ [target]: answered(true) }), policy, 'gateway'),
        new RegExp(`${policy}: reachable: ${target}`, 'u'),
      );
    }
  }
});

test('no-ipv6-egress: an unreported target fails and a down gateway is inconclusive', () => {
  assert.throws(
    () => ipv6Verdict(ipv6Attempts({ 'ipv6-ula': undefined }), 'open', 'gateway'),
    /unreported: ipv6-ula/u,
  );
  assert.throws(
    () => ipv6Verdict(ipv6Attempts({ gateway: answered(false) }), 'none', 'gateway'),
    Inconclusive,
  );
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
  const values = {
    instanceID: 'sbx-secret-value',
    envID: 'env-secret-value',
    address: 'logs-secret-value',
    accessTokenHash: 'hash-secret-value',
  };
  const mmds = (req, res) => {
    const send = (status, text = '') => {
      res.writeHead(status);
      res.end(text);
    };
    if (req.method === 'PUT' && req.url === '/latest/api/token') {
      return req.headers['x-metadata-token-ttl-seconds'] === undefined
        ? send(400)
        : send(200, token);
    }
    if (req.method === 'GET' && req.url === '/') {
      return req.headers['x-metadata-token'] === token
        ? send(200, JSON.stringify(values))
        : send(401);
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
  assert.deepEqual(cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'), {
    mmds: true,
    keys: evidence.keys,
  });
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
      return res.end(
        authorized ? JSON.stringify({ envID: 'env', address: { iam: { role: 'secret' } } }) : '',
      );
    }
    res.writeHead(404);
    return res.end();
  };
  const evidence = await withFakeMetadata(nested, metadataEvidence);
  assert.deepEqual([evidence.keys, evidence.flat], [['address', 'envID'], false]);
  assert.throws(
    () => cloudMetadataVerdict(mmdsAttempts(evidence), 'gateway'),
    /non-string value$/u,
  );
});

test('metadataEvidence on a GCP-like and an AWS-like server fails the verdict', async () => {
  const gcp = (req, res) => {
    res.writeHead(req.url.startsWith('/computeMetadata/v1/') ? 200 : 404, {
      'metadata-flavor': 'Google',
    });
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
    [
      { created: false, error: new Error('bridge create failed with status 502'), bridgeCalls: 1 },
      /not refused .*status 502/u,
    ],
    [
      {
        created: false,
        error: new RuntimeRefusalError('run_spec_unsupported', 'x'),
        bridgeCalls: 0,
      },
      /not refused/u,
    ],
    [
      { created: false, error: new Error('create did not settle in 60000 ms'), bridgeCalls: 0 },
      /not refused .*did not settle/u,
    ],
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
  const refused = {
    created: false,
    error: new RuntimeRefusalError('network_policy_unsupported', 'x'),
    bridgeCalls: 0,
  };
  const all = { none: refused, open: refused, restricted: refused };
  const rows = noPolicyRows(all, RuntimeRefusalError);
  assert.deepEqual(Object.keys(rows).sort(), [...CREATE_ROWS, 'all-policies-refused'].sort());
  for (const id of Object.keys(rows)) assert.ok(id in CHECKS, id);
  for (const id of CREATE_ROWS) assert.equal(rows[id].outcome, 'n/a', id);
  assert.equal(rows['all-policies-refused'].outcome, 'pass');
  assert.match(
    rows['all-policies-refused'].detail,
    /^none refused .*; open refused .*; restricted refused /u,
  );

  const fails = [
    [
      { open: { created: true, bridgeCalls: 1 } },
      /open is declared unsupported, yet a sandbox was created/u,
    ],
    [
      {
        restricted: {
          created: false,
          error: new Error('bridge create failed with status 502'),
          bridgeCalls: 1,
        },
      },
      /restricted was not refused/u,
    ],
    [{ none: { ...refused, bridgeCalls: 1 } }, /none was refused only after 1 bridge call/u],
  ];
  for (const [override, message] of fails) {
    assert.throws(() => noPolicyRows({ ...all, ...override }, RuntimeRefusalError), message);
  }
});
