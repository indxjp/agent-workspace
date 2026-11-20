// OIDC exchange: the server — not the workflow — decides read vs write from
// GitHub-signed claims. Tokens here are real RS256 JWTs signed with a local
// key pair; verification runs the production code path.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createAuth } from '../src/auth.mjs';
import { buildFromEnv, DEFAULT_WRITE_EVENTS, DEFAULT_WRITE_REFS } from '../src/main.mjs';
import { compilePolicy, GITHUB_ISSUER, refPattern, roleForClaims } from '../src/oidc.mjs';
import { memoryStorage } from '../src/storage/memory.mjs';
import { get, put, SIGNING_KEY, startCache } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const KID = 'test-kid';
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: KID,
  alg: 'RS256',
  use: 'sig',
};
const { privateKey: otherKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const POLICY = {
  repository: 'example-org/example-repo',
  repositoryId: '1001',
  writeRefs: ['refs/heads/main'],
  writeEvents: ['push', 'schedule'],
  allowRead: true,
};

function jwt(claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      iss: GITHUB_ISSUER,
      aud: 'indx-nx-cache',
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      repository: 'example-org/example-repo',
      repository_id: '1001',
      run_id: '42',
      ...claims,
    }),
  ).toString('base64url');
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

const mainPush = { ref: 'refs/heads/main', event_name: 'push' };
const nightly = { ref: 'refs/heads/main', event_name: 'schedule' };
const prRun = { ref: 'refs/pull/7/merge', event_name: 'pull_request' };
const queueGroup = {
  ref: 'refs/heads/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567',
  event_name: 'merge_group',
};
const samePr = { ...prRun, base_ref: 'main', head_ref: 'feature/x' };

// The deployed policy since ADR-0110's Amendment 2026-11-19 (owner decisions
// D1: the merge queue writes; D1b: same-repository pull requests into main write).
// deploy-gcp.sh opts into it; the server's own defaults stay main-only.
const D1_WRITE_REFS = 'refs/heads/main,refs/heads/gh-readonly-queue/main/*,refs/pull/*/merge';
const D1_WRITE_EVENTS = 'push,schedule,merge_group,pull_request';
const QUEUE_POLICY = compilePolicy({
  repository: 'example-org/example-repo',
  repositoryId: '1001',
  writeRefs: D1_WRITE_REFS.split(','),
  writeEvents: D1_WRITE_EVENTS.split(','),
  pullRequestBaseRefs: ['main'],
  allowRead: true,
});
const ours = { repository: 'example-org/example-repo', repository_id: 1001 };

describe('roleForClaims', () => {
  test('main push / nightly → write; PR → read; foreign repo → none', () => {
    assert.equal(
      roleForClaims(
        { repository: 'example-org/example-repo', repository_id: 1001, ...mainPush },
        POLICY,
      ),
      'write',
    );
    assert.equal(
      roleForClaims(
        { repository: 'example-org/example-repo', repository_id: 1001, ...nightly },
        POLICY,
      ),
      'write',
    );
    assert.equal(
      roleForClaims(
        { repository: 'example-org/example-repo', repository_id: 1001, ...prRun },
        POLICY,
      ),
      'read',
    );
    // pull_request_target / workflow_dispatch on main are not in writeEvents.
    assert.equal(
      roleForClaims(
        {
          repository: 'example-org/example-repo',
          repository_id: 1001,
          ref: 'refs/heads/main',
          event_name: 'pull_request_target',
        },
        POLICY,
      ),
      'read',
    );
    // A PR whose head branch is literally named "main" still has a refs/pull/* ref.
    assert.equal(
      roleForClaims(
        {
          repository: 'example-org/example-repo',
          repository_id: 1001,
          ref: 'refs/heads/main-x',
          event_name: 'push',
        },
        POLICY,
      ),
      'read',
    );
    assert.equal(
      roleForClaims({ repository: 'evil/example-repo', repository_id: 1001, ...mainPush }, POLICY),
      null,
    );
    assert.equal(
      roleForClaims(
        { repository: 'example-org/example-repo', repository_id: 999, ...mainPush },
        POLICY,
      ),
      null,
    );
    assert.equal(
      roleForClaims(
        { repository: 'example-org/example-repo', repository_id: 1001, ...prRun },
        { ...POLICY, allowRead: false },
      ),
      null,
    );
  });
});

describe('roleForClaims — D1/D1b policy (queue and same-repository PRs write)', () => {
  test('main push, nightly, a queue group and a PR into main → write', () => {
    for (const run of [mainPush, nightly, queueGroup, samePr]) {
      assert.equal(roleForClaims({ ...ours, ...run }, QUEUE_POLICY), 'write', run.event_name);
    }
  });

  test('the repository claims still decide first: a foreign repository gets nothing', () => {
    for (const run of [queueGroup, samePr]) {
      assert.equal(
        roleForClaims(
          { ...run, repository: 'evil/example-repo', repository_id: 1001 },
          QUEUE_POLICY,
        ),
        null,
      );
      assert.equal(roleForClaims({ ...ours, ...run, repository_id: 999 }, QUEUE_POLICY), null);
    }
  });

  test('a pull request into another branch, or with no base_ref, only reads', () => {
    assert.equal(roleForClaims({ ...ours, ...prRun, base_ref: 'release/1' }, QUEUE_POLICY), 'read');
    assert.equal(roleForClaims({ ...ours, ...prRun }, QUEUE_POLICY), 'read');
  });

  test('an event outside the policy only reads, even on main or a queue ref', () => {
    for (const event_name of [
      'workflow_dispatch',
      'pull_request_target',
      'workflow_run',
      'release',
      '__proto__',
    ]) {
      for (const ref of ['refs/heads/main', queueGroup.ref, prRun.ref]) {
        assert.equal(
          roleForClaims({ ...ours, ref, event_name, base_ref: 'main' }, QUEUE_POLICY),
          'read',
          `${event_name} ${ref}`,
        );
      }
    }
  });

  test('each event writes only with the ref shape GitHub gives it', () => {
    // A push to a branch named like a queue group is not a queue group.
    assert.equal(
      roleForClaims({ ...ours, ref: queueGroup.ref, event_name: 'push' }, QUEUE_POLICY),
      'read',
    );
    // A merge_group token always carries a gh-readonly-queue ref.
    assert.equal(
      roleForClaims({ ...ours, ref: 'refs/heads/main', event_name: 'merge_group' }, QUEUE_POLICY),
      'read',
    );
    // The queue of another base branch is not main's.
    assert.equal(
      roleForClaims(
        {
          ...ours,
          ref: 'refs/heads/gh-readonly-queue/release/pr-1-abc',
          event_name: 'merge_group',
        },
        QUEUE_POLICY,
      ),
      'read',
    );
    // A pull_request token carries refs/pull/<n>/merge, never a branch or the PR head.
    for (const ref of [
      'refs/heads/main',
      'refs/pull/7/head',
      'refs/pull/x/merge',
      'refs/pull/7/merge/x',
    ]) {
      assert.equal(roleForClaims({ ...ours, ...samePr, ref }, QUEUE_POLICY), 'read', ref);
    }
    // Other branches pushed to never write.
    assert.equal(
      roleForClaims({ ...ours, ref: 'refs/heads/main-x', event_name: 'push' }, QUEUE_POLICY),
      'read',
    );
  });

  test('refPattern: `*` is one path segment and everything else is literal', () => {
    assert.equal(refPattern('refs/pull/*/merge').test('refs/pull/12/merge'), true);
    assert.equal(refPattern('refs/pull/*/merge').test('refs/pull/1/2/merge'), false);
    assert.equal(refPattern('refs/heads/main').test('refs/heads/mainx'), false);
    assert.equal(refPattern('refs/heads/a.b').test('refs/heads/aXb'), false);
  });

  test('compilePolicy refuses events no ref shape is known for, and PR writes without a base', () => {
    const base = {
      repository: 'example-org/example-repo',
      writeRefs: ['refs/heads/main'],
      allowRead: true,
    };
    assert.throws(
      () => compilePolicy({ ...base, writeEvents: ['workflow_dispatch'] }),
      /cannot be granted write/,
    );
    assert.throws(
      () =>
        compilePolicy({
          ...base,
          writeEvents: ['pull_request'],
          pullRequestBaseRefs: [],
        }),
      /WRITE_PR_BASE_REFS/,
    );
  });

  test('buildFromEnv: the defaults are main-only; the D1/D1b env vars widen them', () => {
    const env = {
      NX_CACHE_STORAGE: 'memory',
      NX_CACHE_SIGNING_KEY: SIGNING_KEY,
      NX_CACHE_OIDC_REPOSITORY: 'example-org/example-repo',
      NX_CACHE_OIDC_REPOSITORY_ID: '1001',
    };
    const defaults = buildFromEnv(env).oidc.policy;
    assert.equal(DEFAULT_WRITE_EVENTS, 'push,schedule');
    assert.equal(DEFAULT_WRITE_REFS, 'refs/heads/main');
    assert.deepEqual(defaults.writeEvents, ['push', 'schedule']);
    assert.deepEqual(defaults.writeRefs, ['refs/heads/main']);
    assert.equal(roleForClaims({ ...ours, ...samePr }, defaults), 'read');
    assert.equal(roleForClaims({ ...ours, ...queueGroup }, defaults), 'read');
    assert.equal(roleForClaims({ ...ours, ...mainPush }, defaults), 'write');

    const widened = buildFromEnv({
      ...env,
      NX_CACHE_OIDC_WRITE_REFS: D1_WRITE_REFS,
      NX_CACHE_OIDC_WRITE_EVENTS: D1_WRITE_EVENTS,
    }).oidc.policy;
    assert.deepEqual(widened.pullRequestBaseRefs, ['main']);
    assert.equal(roleForClaims({ ...ours, ...samePr }, widened), 'write');
    assert.equal(roleForClaims({ ...ours, ...queueGroup }, widened), 'write');
    assert.equal(roleForClaims({ ...ours, ...mainPush }, widened), 'write');
    assert.throws(() =>
      buildFromEnv({ ...env, NX_CACHE_OIDC_WRITE_EVENTS: 'push,workflow_dispatch' }),
    );
  });

  // The one deployment the owner decision covers opts in explicitly, and only after reading that
  // forks get no OIDC token: the server cannot tell a fork's run from a branch's by its claims.
  test('deploy-gcp.sh opts into the D1/D1b policy after checking the fork settings', () => {
    const script = readFileSync(new URL('../deploy-gcp.sh', import.meta.url), 'utf8');
    assert.ok(script.includes(`WRITE_REFS="\${WRITE_REFS:-${D1_WRITE_REFS}}"`));
    assert.ok(script.includes(`WRITE_EVENTS="\${WRITE_EVENTS:-${D1_WRITE_EVENTS}}"`));
    const check = script.indexOf('actions/permissions/fork-pr-workflows-private-repos');
    assert.ok(check > 0, 'deploy-gcp.sh must read the fork pull request settings');
    assert.ok(
      check < script.indexOf('echo "==> APIs"'),
      'the fork check must run before deploy-gcp.sh changes anything',
    );
  });
});

describe('POST /v1/token', () => {
  let cache;
  before(async () => {
    cache = await startCache({
      storage: memoryStorage(),
      auth: createAuth({
        readTokens: [],
        writeTokens: [],
        signingKey: SIGNING_KEY,
      }),
      oidc: {
        audience: 'indx-nx-cache',
        getKey: async (kid) => (kid === KID ? jwk : null),
        policy: POLICY,
        ttlSeconds: 600,
      },
    });
  });
  after(() => cache.close());

  const exchange = (token) =>
    fetch(`${cache.url}/v1/token`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test('main push gets a write token that can PUT', async () => {
    const res = await exchange(jwt(mainPush));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, 'write');
    assert.equal((await put(cache.url, 'oidc1', Buffer.from('trusted'), body.token)).status, 200);
    assert.equal((await get(cache.url, 'oidc1', body.token)).status, 200);
  });

  test('a pull_request run gets a READ token — it cannot write even if its YAML asks for write', async () => {
    const res = await exchange(jwt(prRun));
    const body = await res.json();
    assert.equal(body.role, 'read');
    assert.equal((await put(cache.url, 'oidc2', Buffer.from('poison'), body.token)).status, 403);
    assert.equal((await get(cache.url, 'oidc1', body.token)).status, 200);
  });

  test('forged / expired / wrong-audience / wrong-issuer / alg-none JWTs are rejected', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      jwt(mainPush, { key: otherKey }),
      jwt({ ...mainPush, exp: now - 3600 }),
      jwt({ ...mainPush, aud: 'someone-else' }),
      jwt({ ...mainPush, iss: 'https://evil.example' }),
      jwt(mainPush, { kid: 'unknown' }),
      `${Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url')}.${jwt(mainPush).split('.')[1]}.`,
      'not-a-jwt',
    ];
    for (const t of bad) assert.equal((await exchange(t)).status, 401, t.slice(0, 30));
    assert.equal((await exchange(null)).status, 401);
    assert.equal((await exchange(jwt({ ...mainPush, repository: 'evil/x' }))).status, 403);
  });

  test('a minted token cannot be tampered into write', async () => {
    const { token } = await (await exchange(jwt(prRun))).json();
    const [prefix, payload, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.r = 'write';
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    assert.equal((await put(cache.url, 'oidc3', Buffer.from('x'), tampered)).status, 401);
  });

  test('minted tokens expire', async () => {
    const auth = createAuth({ signingKey: SIGNING_KEY, now: () => 0 });
    const { token } = auth.mint({ role: 'write', sub: 't', ttlSeconds: 60 });
    const later = createAuth({ signingKey: SIGNING_KEY, now: () => 61_000 });
    assert.equal(later.authenticate(`Bearer ${token}`), null);
    assert.equal(auth.authenticate(`Bearer ${token}`).role, 'write');
  });

  test('JWTs never reach the log', async () => {
    const t = jwt(prRun);
    await exchange(t);
    assert.equal(cache.logs.join('\n').includes(t.split('.')[2]), false);
  });
});

describe('POST /v1/token — D1/D1b policy', () => {
  let cache;
  before(async () => {
    cache = await startCache({
      storage: memoryStorage(),
      auth: createAuth({
        readTokens: [],
        writeTokens: [],
        signingKey: SIGNING_KEY,
      }),
      oidc: {
        audience: 'indx-nx-cache',
        getKey: async (kid) => (kid === KID ? jwk : null),
        policy: QUEUE_POLICY,
        ttlSeconds: 600,
      },
    });
  });
  after(() => cache.close());

  const exchange = async (claims) =>
    (
      await fetch(`${cache.url}/v1/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt(claims)}` },
      })
    ).json();

  test('a queue group and a same-repository PR get write; the first writer of a key wins (409)', async () => {
    const queue = await exchange(queueGroup);
    const pr = await exchange(samePr);
    assert.equal(queue.role, 'write');
    assert.equal(pr.role, 'write');
    assert.equal((await put(cache.url, 'd1', Buffer.from('queue'), queue.token)).status, 200);
    // A pull request cannot replace what the queue (or main) already wrote.
    assert.equal((await put(cache.url, 'd1', Buffer.from('poison'), pr.token)).status, 409);
    const back = await get(cache.url, 'd1', pr.token);
    assert.equal(back.status, 200);
    assert.equal(Buffer.from(await back.arrayBuffer()).toString(), 'queue');
  });

  test('a dispatch and a PR into another branch still get a read token that cannot PUT', async () => {
    for (const claims of [
      { ref: 'refs/heads/main', event_name: 'workflow_dispatch' },
      { ...prRun, base_ref: 'release/1' },
    ]) {
      const { role, token } = await exchange(claims);
      assert.equal(role, 'read');
      assert.equal((await put(cache.url, 'd2', Buffer.from('x'), token)).status, 403);
    }
  });
});

describe('static token config', () => {
  test('short tokens / signing keys are refused at startup', () => {
    assert.throws(() => createAuth({ readTokens: ['short'] }));
    assert.throws(() => createAuth({ signingKey: 'short' }));
  });
  test('rotation: old and new tokens both work while listed', () => {
    const a = createAuth({
      readTokens: ['a'.repeat(32), 'b'.repeat(32)],
      writeTokens: ['c'.repeat(32)],
    });
    assert.equal(a.authenticate(`Bearer ${'a'.repeat(32)}`).role, 'read');
    assert.equal(a.authenticate(`Bearer ${'b'.repeat(32)}`).role, 'read');
    assert.equal(a.authenticate(`Bearer ${'c'.repeat(32)}`).role, 'write');
    assert.equal(a.authenticate(`Bearer ${'d'.repeat(32)}`), null);
  });
});
