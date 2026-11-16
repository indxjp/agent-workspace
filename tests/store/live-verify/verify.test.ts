/**
 * The real-model harness (R1), driven against the scripted model: the same SDK client and run
 * events as against staging, with the model's decisions scripted. Nothing here touches a real URL.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { fixtures } from '@indx-workspace/sdk/testing';

import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { realModelEvidenceSchema } from '../../../examples/store/catalog/verification.ts';
import { scriptedWorkspace, type Script } from '../../gallery/harness/scripted-workspace.ts';
import {
  productionEvidenceSchema,
  writeEvidence,
  writeProductionEvidence,
} from './evidence-file.ts';
import {
  LiveVerifyRefusal,
  MAX_APPROVALS,
  REASON_MAX,
  SPEND_APPROVED,
  readSettings,
  redact,
  secretsOf,
  verifyLive,
  type LiveClient,
} from './verify.ts';

/** A value that looks like a credential, planted everywhere a secret could leak. */
const CANARY = 'ak_live_CANARYCANARYCANARYCA_CANARYCANARYCANARYCANARYCANARYCANARYCAN';
const AGENT_NAME = 'Support';
const NOW = new Date('2026-12-01T09:30:00.000Z');

const base = CATALOG.find((entry) => entry.status === 'live');
if (base?.status !== 'live') throw new Error('the catalog has no live entry');
/** A live entry whose moment is: look a record up, then a write that waits for approval. */
const entry: LiveEntry = {
  ...base,
  demo: {
    ...base.demo,
    agent: AGENT_NAME,
    check: { tools: ['lookup'], approval: 'update' },
  },
};

const connectors = {
  shop: { id: 'shop-1', session: { call: () => Promise.resolve({ text: 'ok', isError: false }) } },
};
const asksThenWrites: Script = async (context) => {
  await context.tool('shop', 'lookup', {});
  await context.tool('shop', 'update', {});
  return 'Updated.';
};
const onlyLooksUp: Script = async (context) => {
  await context.tool('shop', 'lookup', {});
  return 'Looked it up.';
};

function clientOver(script: Script): LiveClient {
  const workspace = scriptedWorkspace(
    script,
    connectors,
    {},
    { requireApproval: ['mcp__shop__update'] },
  );
  return {
    agents: {
      list: () => Promise.resolve([fixtures.agent({ id: workspace.agentId, name: AGENT_NAME })]),
    },
    runs: workspace.aw.runs,
  };
}

const run = (client: LiveClient) =>
  verifyLive({
    client,
    secrets: [CANARY],
    entries: [entry],
    now: () => NOW,
    environment: 'staging',
  });

describe('the opt-in and the environment', () => {
  const ok = {
    STORE_LIVE_VERIFY: SPEND_APPROVED,
    STORE_LIVE_VERIFY_ENVIRONMENT: 'staging',
    STORE_LIVE_VERIFY_URL: 'https://staging.example.test',
    STORE_LIVE_VERIFY_API_KEY: CANARY,
  };

  it('reads the settings when a person has approved the spend, for staging', () => {
    expect(readSettings(ok)).toEqual({
      environment: 'staging',
      baseUrl: ok.STORE_LIVE_VERIFY_URL,
      apiKey: CANARY,
    });
  });

  it('reads them for production too, which the daily production test runs against', () => {
    const settings = readSettings({ ...ok, STORE_LIVE_VERIFY_ENVIRONMENT: 'production' });
    expect(settings.environment).toBe('production');
  });

  it.each([
    ['no opt-in', { ...ok, STORE_LIVE_VERIFY: undefined }],
    ['a different opt-in value', { ...ok, STORE_LIVE_VERIFY: '1' }],
    ['an environment that is neither', { ...ok, STORE_LIVE_VERIFY_ENVIRONMENT: 'preview' }],
    [
      'production without the opt-in',
      { ...ok, STORE_LIVE_VERIFY_ENVIRONMENT: 'production', STORE_LIVE_VERIFY: undefined },
    ],
    ['no environment', { ...ok, STORE_LIVE_VERIFY_ENVIRONMENT: undefined }],
    ['no deployment URL', { ...ok, STORE_LIVE_VERIFY_URL: undefined }],
    ['no key', { ...ok, STORE_LIVE_VERIFY_API_KEY: ' ' }],
  ])('refuses with %s, and the refusal never carries the key', (_name, env) => {
    let refusal: unknown;
    try {
      readSettings(env);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(LiveVerifyRefusal);
    expect(String((refusal as Error).message)).not.toContain(CANARY);
  });

  it('the command refuses without the opt-in: exit 2, nothing written, no key in any output', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'live-verify-'));
    const file = path.join(dir, 'runs.json');
    writeFileSync(file, '{"runs":[]}\n');
    try {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./run.ts', import.meta.url)), file],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            STORE_LIVE_VERIFY_ENVIRONMENT: 'staging',
            STORE_LIVE_VERIFY_URL: 'https://staging.example.test',
            STORE_LIVE_VERIFY_API_KEY: CANARY,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).not.toContain(CANARY);
      expect(result.stderr).toContain(SPEND_APPROVED);
      expect(readFileSync(file, 'utf8')).toBe('{"runs":[]}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a run against the scripted model', () => {
  it('writes a pass record when the moment happened, the approval given as the asking person', async () => {
    const outcome = await run(clientOver(asksThenWrites));
    expect(outcome.unrun).toEqual([]);
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]).toMatchObject({
      entry: entry.slug,
      date: NOW.toISOString(),
      result: 'pass',
      environment: 'staging',
    });
  });

  it('writes a fail record with the judge reason when the approval never happened', async () => {
    const outcome = await run(clientOver(onlyLooksUp));
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]).toMatchObject({
      result: 'fail',
      reason: 'update did not wait for approval',
    });
  });

  it('records a run id the platform gave, and the evidence parses with the schema', async () => {
    const outcome = await run(clientOver(asksThenWrites));
    const parsed = realModelEvidenceSchema.parse({ runs: outcome.records });
    expect(parsed.runs[0]?.runId.length).toBeGreaterThan(0);
  });

  it('does not run an entry whose agent the deployment lacks: no record, never a fail', async () => {
    const client: LiveClient = {
      ...clientOver(asksThenWrites),
      agents: { list: () => Promise.resolve([]) },
    };
    const outcome = await run(client);
    expect(outcome.records).toEqual([]);
    expect(outcome.unrun.map((missed) => missed.entry)).toEqual([entry.slug]);
  });

  it('prints no secret: errors that echo the credential are redacted in records and unrun reasons', async () => {
    const good = clientOver(asksThenWrites);
    // Explicit delegates: the SDK's runs client keeps its methods on the prototype.
    const runs = (override: Partial<LiveClient['runs']>): LiveClient['runs'] => ({
      start: (...args) => good.runs.start(...args),
      follow: (...args) => good.runs.follow(...args),
      get: (...args) => good.runs.get(...args),
      approve: (...args) => good.runs.approve(...args),
      ...override,
    });
    const leaksOnStart: LiveClient = {
      ...good,
      runs: runs({ start: () => Promise.reject(new Error(`401 Authorization: Bearer ${CANARY}`)) }),
    };
    const leaksAfterStart: LiveClient = {
      ...good,
      runs: runs({
        follow: () => {
          throw new Error(`stream refused for ${CANARY}`);
        },
      }),
    };
    const started = await run(leaksOnStart);
    const followed = await run(leaksAfterStart);
    expect(started.unrun).toHaveLength(1);
    expect(followed.records[0]?.result).toBe('fail');
    expect(JSON.stringify([started, followed])).not.toContain(CANARY);
    expect(JSON.stringify(followed)).toContain('[redacted]');
    expect(redact(`key ${CANARY}`, [CANARY])).toBe('key [redacted]');
  });
});

describe('a production run', () => {
  const productionRun = (client: LiveClient) =>
    verifyLive({
      client,
      secrets: [CANARY],
      entries: [entry],
      now: () => NOW,
      environment: 'production',
    });

  it('records the same moment judgement, marked production', async () => {
    const passed = await productionRun(clientOver(asksThenWrites));
    const failed = await productionRun(clientOver(onlyLooksUp));
    expect(passed.records[0]).toMatchObject({ result: 'pass', environment: 'production' });
    expect(failed.records[0]).toMatchObject({
      result: 'fail',
      reason: 'update did not wait for approval',
      environment: 'production',
    });
  });

  it('has its own evidence: the committed staging schema refuses it, the production one reads it', async () => {
    const outcome = await productionRun(clientOver(asksThenWrites));
    expect(realModelEvidenceSchema.safeParse({ runs: outcome.records }).success).toBe(false);
    expect(productionEvidenceSchema.safeParse({ runs: outcome.records }).success).toBe(true);
  });

  it('writes its evidence whole to the named file and never touches the committed file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'live-verify-'));
    try {
      const file = path.join(dir, 'daily.json');
      const committed = fileURLToPath(
        new URL('../../../examples/store/catalog/real-model-runs.json', import.meta.url),
      );
      const before = readFileSync(committed);
      const outcome = await productionRun(clientOver(asksThenWrites));
      writeProductionEvidence(file, outcome.records);
      const onDisk = productionEvidenceSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      expect(onDisk.runs).toHaveLength(1);
      expect(file).not.toBe(committed);
      expect(readFileSync(committed).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the command refuses a production run with no evidence file, before spending', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.ts', import.meta.url))],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          STORE_LIVE_VERIFY: SPEND_APPROVED,
          STORE_LIVE_VERIFY_ENVIRONMENT: 'production',
          STORE_LIVE_VERIFY_URL: 'http://127.0.0.1:9',
          STORE_LIVE_VERIFY_API_KEY: CANARY,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('evidence file');
    expect(result.stdout + result.stderr).not.toContain(CANARY);
  });
});

describe('the deployment address', () => {
  /** A deployment origin that must never reach a record, a reason or the console. */
  const CANARY_URL = 'https://canary-deployment.example.test';
  const CANARY_HOST = 'canary-deployment.example.test';
  const env = {
    STORE_LIVE_VERIFY_URL: ` ${CANARY_URL} `,
    STORE_LIVE_VERIFY_API_KEY: CANARY,
  };

  it('is a secret, with its host, beside the key', () => {
    expect(secretsOf(env)).toEqual([CANARY, CANARY_URL, CANARY_HOST]);
    expect(secretsOf({ STORE_LIVE_VERIFY_URL: 'not a url' })).toEqual(['not a url']);
    expect(secretsOf({})).toEqual([]);
  });

  it('never reaches a record or an error message when a transport error names it', async () => {
    const good = clientOver(asksThenWrites);
    const failing = (message: string): LiveClient => ({
      agents: good.agents,
      runs: {
        start: (...args) => good.runs.start(...args),
        follow: () => {
          throw new Error(message);
        },
        get: (...args) => good.runs.get(...args),
        approve: (...args) => good.runs.approve(...args),
      },
    });
    const unlisted: LiveClient = {
      ...good,
      agents: { list: () => Promise.reject(new Error(`fetch failed: ${CANARY_URL}/api/agents`)) },
    };
    const secrets = secretsOf(env);
    const verify = (client: LiveClient) =>
      verifyLive({ client, secrets, entries: [entry], now: () => NOW, environment: 'staging' });
    const outcomes = [
      await verify(failing(`getaddrinfo ENOTFOUND ${CANARY_HOST}`)),
      await verify(failing(`request to ${CANARY_URL}/api/runs failed`)),
    ];
    expect(outcomes.map((outcome) => outcome.records[0]?.result)).toEqual(['fail', 'fail']);
    const listing = await verify(unlisted).then(
      () => 'listed',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const text = JSON.stringify([outcomes, listing]);
    expect(text).not.toContain(CANARY_HOST);
    expect(text).toContain('[redacted]');
    expect(listing).toContain('could not be listed');
  });
});

describe('the limits', () => {
  const record = (reason: string) => ({
    runs: [
      {
        entry: 'x',
        runId: 'r',
        date: '2026-12-01T00:00:00.000Z',
        result: 'fail',
        reason,
        environment: 'staging',
      },
    ],
  });

  it('pins the reason limit to the evidence schema', () => {
    expect(realModelEvidenceSchema.safeParse(record('a'.repeat(REASON_MAX))).success).toBe(true);
    expect(realModelEvidenceSchema.safeParse(record('a'.repeat(REASON_MAX + 1))).success).toBe(
      false,
    );
  });

  it('follows at most MAX_APPROVALS approval waits, then judges the turn as it stands', async () => {
    expect(MAX_APPROVALS).toBe(3);
    const good = clientOver(asksThenWrites);
    let approvals = 0;
    const client: LiveClient = {
      ...good,
      runs: {
        start: (...args) => good.runs.start(...args),
        follow: (...args) => good.runs.follow(...args),
        get: (id) => good.runs.get(id).then((found) => ({ ...found, status: 'awaiting_approval' })),
        approve: (id) => {
          approvals += 1;
          return Promise.resolve({
            run: fixtures.run({ id, status: 'queued' }),
            events: `/api/runs/${id}/events`,
          });
        },
      },
    };
    const outcome = await run(client);
    expect(approvals).toBe(MAX_APPROVALS);
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]?.result).toBe('fail');
  });
});

describe('the evidence file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('appends records and never rewrites an earlier one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'live-verify-'));
    dirs.push(dir);
    const file = path.join(dir, 'runs.json');
    const earlier = {
      entry: entry.slug,
      runId: 'run-0',
      date: '2026-11-30T00:00:00.000Z',
      result: 'pass',
      reason: 'the moment happened',
      environment: 'staging',
    };
    writeFileSync(file, `${JSON.stringify({ runs: [earlier] }, null, 2)}\n`);
    const outcome = await run(clientOver(onlyLooksUp));
    const written = writeEvidence(file, outcome.records);
    const onDisk = realModelEvidenceSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(onDisk).toEqual(written);
    expect(onDisk.runs).toHaveLength(2);
    expect(onDisk.runs[0]).toEqual(earlier);
    expect(onDisk.runs[1]?.result).toBe('fail');
  });
});
