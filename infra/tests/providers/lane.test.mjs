/**
 * Live isolation checks for one provider sandbox. `PROVIDERS_LANE=e2b|vercel|cloudflare` picks the
 * provider; the lane creates sandboxes through the real driver of `packages/runtime` (built to
 * `dist/`) and reads what the probe image inside reports. Every outcome is recorded to
 * `$PROVIDERS_RESULTS` in the isolation vocabulary for `infra/tests/isolation/summary.mjs`:
 * pass, fail, inconclusive, n/a, and skipped.
 *
 * A missing credential makes every check `skipped` with the variable names, never pass, and
 * registers one passing "not selected" test so the run does not report a skip. The probe artefact
 * is resolved by `prepare.mjs` (an override variable, else derived in the run); when that fails,
 * every check is `fail` with the reason.
 *
 * A capability the provider does not declare is not tested by weakening the check: it is `n/a`,
 * and the refusal of the policy it lacks is asserted as typed (spec 14.5, ADR-0120 LC4). An
 * undeclared `none` reads `n/a` only once `create` is proven refused before any sandbox or bridge
 * call (ADR-0131); the rows not about `none` then run under `open`. A provider that declares no
 * policy at all reads `n/a` on every create-based row only once `create` is proven refused that way
 * for `none`, `open` and `restricted` (`all-policies-refused`).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { prepare } from './prepare.mjs';
import { GATEWAY_HOST, PROVIDERS, PUBLIC_HOST, runtime } from './providers.mjs';
import {
  blockedVerdict,
  CHECKS,
  cloudMetadataVerdict,
  deadlineVerdict,
  failedRows,
  Inconclusive,
  ipv6Verdict,
  noPolicyRows,
  privateVerdict,
  redact,
  refusalVerdict,
  RUN_POLICIES,
} from './support.mjs';

const laneName = process.env.PROVIDERS_LANE;
const provider = PROVIDERS[laneName ?? ''];
if (provider === undefined) {
  throw new Error(`PROVIDERS_LANE must be one of ${Object.keys(PROVIDERS).join(', ')}; the lane never defaults.`);
}
const resultsFile = process.env.PROVIDERS_RESULTS ?? path.join(tmpdir(), `aw-providers-${laneName}.json`);
const missing = provider.credentials.filter((name) => (process.env[name] ?? '') === '');
const hidden = provider.secrets.map((name) => process.env[name] ?? '');
const prepared = missing.length > 0 ? undefined : await prepare(laneName, process.env, hidden);

const results = {};
function record(id, outcome, detail) {
  results[id] = {
    title: CHECKS[id],
    outcome,
    ...(detail === undefined ? {} : { detail: redact(detail, hidden) }),
  };
  writeFileSync(resultsFile, `${JSON.stringify({ lane: laneName, results }, null, 2)}\n`);
}

if (missing.length > 0) {
  for (const id of Object.keys(CHECKS)) record(id, 'skipped', `not selected: ${missing.join(', ')} not set`);
  process.stderr.write(`${laneName} provider lane NOT exercised: ${missing.join(', ')} not set\n`);
  test('provider live proof is not selected without its credentials', () => {
    assert.ok(missing.length > 0);
  });
} else if ('failure' in prepared) {
  for (const [id, { outcome, detail }] of Object.entries(failedRows(prepared.failure))) record(id, outcome, detail);
  process.stderr.write(`${laneName} provider lane could not prepare its probe artefact: ${prepared.failure}\n`);
  test('probe artefact is available', () => {
    assert.fail(prepared.failure);
  });
} else {
  const laneEnv = { ...process.env, ...prepared.env };
  const ENGINE = 'claude-agent-sdk';
  const DEADLINE_SECONDS = 60;
  const DEADLINE_GRACE_MS = 30_000;
  const REFUSAL_WAIT_MS = 60_000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const notApplicable = (detail) => ({ outcome: 'n/a', detail });

  function check(id, body) {
    test(`${id}: ${CHECKS[id]}`, { timeout: 600_000 }, async () => {
      try {
        const outcome = (await body()) ?? { outcome: 'pass' };
        record(id, outcome.outcome, outcome.detail);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record(id, error instanceof Inconclusive ? 'inconclusive' : 'fail', message);
        throw error;
      }
    });
  }

  let opened;
  const context = () => {
    opened ??= provider.open(laneEnv).then((ctx) => {
      hidden.push(ctx.credential);
      return ctx;
    });
    return opened;
  };

  const sandboxes = [];
  async function createSandbox(networkPolicy, timeoutSeconds = 600) {
    const { driver, credential } = await context();
    const handle = await driver.create(specFor(networkPolicy, timeoutSeconds), credential);
    sandboxes.push(handle);
    return handle;
  }
  const specFor = (networkPolicy, timeoutSeconds = 600) => ({
    sessionId: `providers-live-${randomBytes(4).toString('hex')}`,
    workspacePath: '/workspace',
    engine: ENGINE,
    runSpec: {
      runtimeProfileId: 'providers-live',
      driver: provider.driverId,
      networkPolicy,
      filesystem: 'read-write',
      timeoutSeconds,
    },
  });

  async function authed(handle, urlPath, { timeoutMs = 10_000 } = {}) {
    const { driver } = await context();
    return fetch(driver.requestUrl(handle, urlPath), {
      headers: await driver.authHeaders(handle),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function waitReady(handle, waitMs = 120_000) {
    const until = Date.now() + waitMs;
    for (;;) {
      const ready = await authed(handle, '/ping').then(
        (response) => response.status === 200,
        () => false,
      );
      if (ready) return;
      if (Date.now() >= until) throw new Error('the probe did not answer /ping 200 in time');
      await sleep(3_000);
    }
  }

  const reports = new Map();
  function report(networkPolicy) {
    if (!reports.has(networkPolicy)) {
      reports.set(
        networkPolicy,
        (async () => {
          const handle = await createSandbox(networkPolicy);
          await waitReady(handle);
          const response = await authed(handle, `/probe?gateway=${GATEWAY_HOST}&public=${PUBLIC_HOST}`, {
            timeoutMs: 60_000,
          });
          assert.equal(response.status, 200, `/probe answered ${String(response.status)}`);
          const body = await response.json();
          assert.equal(typeof body?.uid, 'number', 'the probe reported no uid');
          assert.equal(typeof body?.attempts, 'object', 'the probe reported no attempts');
          return { handle, uid: body.uid, attempts: body.attempts };
        })(),
      );
    }
    return reports.get(networkPolicy);
  }

  const declares = async (networkPolicy) => (await context()).driver.capabilities.networkPolicies.includes(networkPolicy);
  const refusedAs = async (networkPolicy) => {
    const { driver } = await context();
    const { RuntimeRefusalError } = await runtime();
    assert.throws(
      () => driver.assertCreatable(specFor(networkPolicy), 'unused-credential'),
      (error) => error instanceof RuntimeRefusalError && error.code === 'network_policy_unsupported',
      `${networkPolicy} was not refused with RuntimeRefusalError network_policy_unsupported`,
    );
  };

  // The real `create` under an undeclared policy, once per policy, with the bridge calls it made.
  const createAttempts = new Map();
  const attemptCreate = (networkPolicy) => {
    if (!createAttempts.has(networkPolicy)) createAttempts.set(networkPolicy, attemptCreateOnce(networkPolicy));
    return createAttempts.get(networkPolicy);
  };
  const attemptCreateOnce = async (networkPolicy) => {
    const { driver, credential, bridgeCalls = () => 0 } = await context();
    const before = bridgeCalls();
    const attempt = await Promise.race([
      driver.create(specFor(networkPolicy), credential).then(
        (handle) => {
          sandboxes.push(handle);
          return { created: true };
        },
        (error) => ({ created: false, error }),
      ),
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ created: false, error: new Error(`create did not settle in ${String(REFUSAL_WAIT_MS)} ms`) }),
          REFUSAL_WAIT_MS,
        ).unref();
      }),
    ]);
    return { ...attempt, bridgeCalls: bridgeCalls() - before };
  };
  /** `create` under `none` refused before a sandbox exists or the bridge is called. */
  const refusedNone = async () => refusalVerdict(await attemptCreate('none'), 'none', (await runtime()).RuntimeRefusalError);
  /** Where no policy is declared: every create-based row's outcome, on proof each policy is refused. */
  let noPolicy;
  const refusedAll = () => {
    noPolicy ??= (async () => {
      const attempts = {};
      for (const policy of RUN_POLICIES) attempts[policy] = await attemptCreate(policy);
      return noPolicyRows(attempts, (await runtime()).RuntimeRefusalError);
    })();
    return noPolicy;
  };
  const NONE_NOT_DECLARED = 'none is not declared by this provider; none-refused proves the refusal';
  const OPEN_NOT_DECLARED = 'open is not declared by this provider; open-refused asserts the refusal';
  /** The policy for the rows not about `none`: the first declared of `none` and `open`, else undefined. */
  const basePolicy = async () => {
    for (const policy of ['none', 'open']) if (await declares(policy)) return policy;
    return undefined;
  };
  /** A create-based row: `body(policy)` under the base policy, else the proven no-policy outcome. */
  const onBase = async (id, body) => {
    const policy = await basePolicy();
    return policy === undefined ? (await refusedAll())[id] : body(policy);
  };
  /** A `none-*` row: run `body` where `none` is declared, else `n/a` on the proven refusal. */
  const underNone = (id, body) =>
    onBase(id, async () => {
      if (await declares('none')) return body();
      await refusedNone();
      return notApplicable(NONE_NOT_DECLARED);
    });
  /** An `open-*` row: run `body` where `open` is declared, else `n/a`. */
  const underOpen = (id, body) =>
    onBase(id, async () => ((await declares('open')) ? body() : notApplicable(OPEN_NOT_DECLARED)));

  check('non-root', () =>
    onBase('non-root', async (policy) => {
      const { uid } = await report(policy);
      assert.ok(uid > 0, `the sandbox runs as uid ${String(uid)}`);
    }),
  );

  check('gateway-reachable', () =>
    onBase('gateway-reachable', async (policy) => {
      const { attempts } = await report(policy);
      assert.equal(attempts.gateway?.answered, true, `gateway ${GATEWAY_HOST}: ${attempts.gateway?.outcome}`);
    }),
  );

  check('none-blocks-public', () =>
    underNone('none-blocks-public', async () => {
      blockedVerdict((await report('none')).attempts, ['public'], 'gateway');
    }),
  );
  check('none-blocks-cloud-metadata', () =>
    underNone('none-blocks-cloud-metadata', async () => {
      cloudMetadataVerdict((await report('none')).attempts, 'gateway');
    }),
  );
  check('none-blocks-private', () =>
    underNone('none-blocks-private', async () => ({
      outcome: 'pass',
      detail: privateVerdict((await report('none')).attempts, 'gateway'),
    })),
  );

  check('open-blocks-cloud-metadata', () =>
    underOpen('open-blocks-cloud-metadata', async () => {
      cloudMetadataVerdict((await report('open')).attempts, 'gateway');
    }),
  );
  check('open-blocks-private', () =>
    underOpen('open-blocks-private', async () => ({
      outcome: 'pass',
      detail: privateVerdict((await report('open')).attempts, 'gateway'),
    })),
  );
  check('metadata-is-per-vm-mmds', () =>
    onBase('metadata-is-per-vm-mmds', async (policy) => {
      const { mmds, keys } = cloudMetadataVerdict((await report(policy)).attempts, 'gateway');
      if (!mmds) return notApplicable('169.254.169.254:80 does not connect');
      return { outcome: 'pass', detail: `per-VM MMDS proven; keys: ${keys.join(', ')}` };
    }),
  );
  check('no-ipv6-egress', () =>
    onBase('no-ipv6-egress', async () => {
      const details = [];
      if (await declares('none')) {
        details.push(`none: ${ipv6Verdict((await report('none')).attempts, 'none', 'gateway')}`);
      } else {
        await refusedNone();
        details.push(`none: n/a, ${NONE_NOT_DECLARED}`);
      }
      if (await declares('open')) {
        details.push(`open: ${ipv6Verdict((await report('open')).attempts, 'open', 'gateway')}`);
      }
      return { outcome: 'pass', detail: details.join('; ') };
    }),
  );
  check('open-reaches-public', () =>
    underOpen('open-reaches-public', async () => {
      const { attempts } = await report('open');
      assert.equal(attempts.public?.answered, true, `public host ${PUBLIC_HOST}: ${attempts.public?.outcome}`);
    }),
  );

  check('loopback', () =>
    notApplicable('the sandbox always reaches its own 127.0.0.1, so a probe from inside cannot show the provider host loopback blocked'),
  );

  check('restricted-refused', async () => {
    if (await declares('allowlist')) {
      throw new Inconclusive('allowlist is declared but this lane has no allowlist check yet');
    }
    await refusedAs('restricted');
  });
  check('open-refused', async () => {
    if (await declares('open')) return notApplicable('open is declared by this provider; the open-* checks run instead');
    await refusedAs('open');
  });
  check('none-refused', async () => {
    if (await declares('none')) return notApplicable('none is declared by this provider; the none-* checks run instead');
    return { outcome: 'pass', detail: await refusedNone() };
  });
  check('all-policies-refused', async () => {
    if ((await basePolicy()) !== undefined) {
      return notApplicable('a network policy is declared by this provider; the create-based checks run instead');
    }
    return (await refusedAll())['all-policies-refused'];
  });

  check('bridge-auth', async () => {
    const { bridgeUrl, driver } = await context();
    if (bridgeUrl === undefined) return notApplicable('this provider has no bridge Worker');
    // The bridge half needs no sandbox: create, destroy and forward each refuse a call with no credential.
    for (const [name, suffix, init] of [
      ['create', '', { method: 'POST', body: '{}' }],
      ['destroy', '/providers-live-unknown', { method: 'DELETE' }],
      ['forward', '/providers-live-unknown/runtime/ping', { method: 'GET' }],
    ]) {
      const response = await fetch(`${bridgeUrl}/v1/sandboxes${suffix}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      await response.body?.cancel();
      assert.equal(response.status, 401, `unauthenticated ${name} answered ${String(response.status)}`);
    }
    const bridgeHalf = 'the bridge refuses an unauthenticated create, destroy and forward';
    const policy = await basePolicy();
    if (policy === undefined) {
      await refusedAll();
      return { outcome: 'pass', detail: `${bridgeHalf}; the sandbox half is n/a, no network policy is declared (all-policies-refused)` };
    }
    const { handle } = await report(policy);
    const url = driver.requestUrl(handle, '/ping');
    const headers = await driver.authHeaders(handle);
    // Neither credential alone reaches the runner server (ADR-0120 LC3).
    const { authorization, ...accessOnly } = headers;
    assert.ok(Object.keys(accessOnly).length > 0, 'the sandbox has no access header to remove');
    const noBearer = await fetch(url, { headers: accessOnly, signal: AbortSignal.timeout(30_000) });
    assert.ok([401, 403].includes(noBearer.status), `no bearer answered ${String(noBearer.status)}`);
    const noAccess = await fetch(url, { headers: { authorization }, signal: AbortSignal.timeout(30_000) });
    assert.equal(noAccess.status, 401, `no access header answered ${String(noAccess.status)}`);
    return { outcome: 'pass', detail: `${bridgeHalf}; neither sandbox credential alone reaches the runner` };
  });

  check('deadline', () =>
    onBase('deadline', async (policy) => {
      const { driver } = await context();
      if (driver.capabilities.maxSessionSeconds === null) {
        return notApplicable('no provider deadline: maxSessionSeconds is null (activity-based sleepAfter, no absolute limit)');
      }
      const handle = await createSandbox(policy, DEADLINE_SECONDS);
      const createdAt = Date.now();
      await waitReady(handle);
      await sleep(Math.max(0, createdAt + DEADLINE_SECONDS * 1_000 + DEADLINE_GRACE_MS - Date.now()));
      const stillAnswers = await authed(handle, '/ping').then(
        (response) => response.status === 200,
        () => false,
      );
      // A failed /ping is not proof: only the provider API saying the sandbox stopped passes.
      const state = await provider.state?.(laneEnv, handle.externalId).catch(
        (error) => `lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      deadlineVerdict(stillAnswers, state);
    }),
  );

  after(async () => {
    if (opened === undefined) return;
    const failures = [];
    try {
      const { driver, credential, close } = await opened;
      for (const handle of sandboxes) {
        await driver.destroy(handle, credential).catch((error) => failures.push(error));
      }
      await close().catch((error) => failures.push(error));
    } catch {
      // opening failed: the checks already recorded it, and nothing was created.
    }
    if (failures.length > 0) {
      throw new Error(`cleanup failed, a sandbox or Worker may be left behind: ${redact(String(failures[0]), hidden)}`);
    }
  });
}
