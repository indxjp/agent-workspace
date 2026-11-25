/**
 * The daily production test and the nightly sample check, driven against the scripted model and a
 * fake platform: nothing here touches a real URL or spends.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { scriptedWorkspace, type Script } from '../../gallery/harness/scripted-workspace.ts';
import { fixtures } from '@indx-workspace/sdk/testing';
import type { LiveClient } from '../live-verify/verify.ts';
import { exitCodeOf, runDaily, verdictOf } from './daily.ts';
import { OPERATOR_CALL_TIMEOUT_MS, type Platform } from './platform.ts';
import { expectedTemplate, sampleCheck, templateDifferences } from './sample-check.ts';

const TOKEN = 'operator-token-CANARY-0123456789abcdef0123456789';
const PLATFORM_URL = 'https://platform-canary.example.test';
const NOW = new Date('2026-12-01T09:30:00.000Z');
const AGENT_NAME = 'Support';

const base = CATALOG.find((entry) => entry.status === 'live');
if (base?.status !== 'live') throw new Error('the catalog has no live entry');
const entry: LiveEntry = {
  ...base,
  demo: { ...base.demo, agent: AGENT_NAME, check: { tools: ['lookup'], approval: 'update' } },
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

function clientOver(script: Script, listed = true): LiveClient {
  const workspace = scriptedWorkspace(
    script,
    connectors,
    {},
    { requireApproval: ['mcp__shop__update'] },
  );
  return {
    agents: {
      list: () =>
        Promise.resolve(
          listed ? [fixtures.agent({ id: workspace.agentId, name: AGENT_NAME })] : [],
        ),
    },
    runs: workspace.aw.runs,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** A platform that keeps what it is sent and answers `status` to every call. */
function fakePlatform(status = 204): { platform: Platform; calls: Call[] } {
  const calls: Call[] = [];
  const request: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    return Promise.resolve(new Response(null, { status }));
  };
  return { platform: { baseUrl: `${PLATFORM_URL}/`, token: TOKEN, request }, calls };
}

const daily = (client: LiveClient, platform: Platform) =>
  runDaily({ client, platform, secrets: [TOKEN], entries: [entry], now: () => NOW });

describe('the operator call', () => {
  it('waits at most 30 seconds for the platform', () => {
    expect(OPERATOR_CALL_TIMEOUT_MS).toBe(30_000);
  });
});

describe('the daily production test', () => {
  it('takes a passing entry back to available, as the operator', async () => {
    const { platform, calls } = fakePlatform();
    const outcome = await daily(clientOver(asksThenWrites), platform);
    expect(outcome.records[0]).toMatchObject({ result: 'pass', environment: 'production' });
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: `/api/demo/maintenance/${entry.slug}`,
        authorization: `Bearer ${TOKEN}`,
        body: { state: 'available', reason: 'the daily production test passed' },
      },
    ]);
    expect(exitCodeOf(outcome)).toBe(0);
  });

  it('puts a failing entry under maintenance with the reason in words, and the run fails', async () => {
    const { platform, calls } = fakePlatform();
    const outcome = await daily(clientOver(onlyLooksUp), platform);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      state: 'maintenance',
      reason:
        'update did not wait for approval: it was never called (called: lookup; stop: end_turn; ended on a statement)',
    });
    expect(exitCodeOf(outcome)).toBe(1);
  });

  it('sends no verdict for an entry it could not run, and the run fails', async () => {
    const { platform, calls } = fakePlatform();
    const outcome = await daily(clientOver(asksThenWrites, false), platform);
    expect(calls).toEqual([]);
    expect(outcome.unrun).toHaveLength(1);
    expect(exitCodeOf(outcome)).toBe(1);
  });

  it('fails the run when the platform refuses the verdict, naming neither the token nor the address', async () => {
    const { platform } = fakePlatform(401);
    const outcome = await daily(clientOver(asksThenWrites), platform);
    expect(outcome.unsent).toHaveLength(1);
    expect(exitCodeOf(outcome)).toBe(1);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain('platform-canary');
  });

  it('maps a record to a verdict the maintenance route accepts', () => {
    const record = {
      entry: 'crm',
      runId: 'r',
      date: NOW.toISOString(),
      result: 'fail',
      reason: 'a tool did not run',
      environment: 'production',
    } as const;
    expect(verdictOf(record)).toEqual({ state: 'maintenance', reason: 'a tool did not run' });
    expect(verdictOf({ ...record, result: 'pass' }).state).toBe('available');
  });
});

describe('the nightly sample check', () => {
  const live = CATALOG.filter((candidate): candidate is LiveEntry => candidate.status === 'live');
  const expected = live.map((candidate) => expectedTemplate(candidate));
  const matching = expected.map((want) => ({
    entry: want.entry,
    agent: want.agent,
    files: want.files,
    recordSets: want.recordSets,
  }));

  it('reads the sample data the catalog states: seed files, or record sets for the record entries', () => {
    expect(expected.some((want) => want.files > 0)).toBe(true);
    expect(expected.some((want) => want.recordSets > 0)).toBe(true);
    for (const candidate of live) {
      const want = expected.find((item) => item.entry === candidate.slug);
      expect(want?.files === 0 && want.recordSets === 0, candidate.slug).toBe(
        candidate.demo.seed.length === 0 && candidate.demo.records === undefined,
      );
    }
  });

  it('finds no difference when the platform reports what the catalog says', () => {
    expect(templateDifferences(expected, matching)).toEqual([]);
  });

  it('lists each difference: a missing template, a missing agent, a name, the counts, an extra', () => {
    const [first, second, third] = matching;
    if (first === undefined || second === undefined || third === undefined) throw new Error('few');
    const differences = templateDifferences(expected, [
      { ...second, agent: null },
      { ...third, agent: 'Another', files: third.files + 1, recordSets: third.recordSets + 1 },
      ...matching.slice(3),
      { entry: 'stray', agent: 'x', files: 0, recordSets: 0 },
    ]);
    expect(differences).toEqual(
      expect.arrayContaining([
        `${first.entry}: no template was reported`,
        `${second.entry}: the template has no agent`,
        `${third.entry}: the agent has another name`,
        `${third.entry}: ${String(third.files + 1)} sample files, expected ${String(third.files)}`,
        'stray: a template the catalog does not list',
      ]),
    );
  });

  it('asks the platform as the operator and reports the differences', async () => {
    const calls: { path: string; authorization: string | null }[] = [];
    const request: typeof fetch = (input, init) => {
      calls.push({
        path: new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        ).pathname,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(Response.json({ templates: matching.slice(1) }));
    };
    const differences = await sampleCheck(
      { baseUrl: PLATFORM_URL, token: TOKEN, request },
      expected,
    );
    expect(calls).toEqual([{ path: '/api/demo/templates', authorization: `Bearer ${TOKEN}` }]);
    expect(differences).toHaveLength(1);
  });
});

describe('the command line', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  const runCommand = (args: string[], env: Record<string, string>) =>
    new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./run.ts', import.meta.url)), ...args],
        { env: { PATH: process.env['PATH'] ?? '', ...env } },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      child.on('close', (status) => resolve({ status, output }));
    });

  const platformReporting = async (templates: unknown): Promise<string> => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ templates }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  };
  const live = CATALOG.filter((candidate): candidate is LiveEntry => candidate.status === 'live');
  const reports = live.map((candidate) => {
    const want = expectedTemplate(candidate);
    return { entry: want.entry, agent: want.agent, files: want.files, recordSets: want.recordSets };
  });

  it('sample-check exits 0 when every template matches and non-zero on any difference', async () => {
    const same = await runCommand(['sample-check'], {
      STORE_PLATFORM_URL: await platformReporting(reports),
      STORE_OPERATOR_TOKEN: TOKEN,
    });
    expect(same.status).toBe(0);
    const different = await runCommand(['sample-check'], {
      STORE_PLATFORM_URL: await platformReporting(reports.slice(1)),
      STORE_OPERATOR_TOKEN: TOKEN,
    });
    expect(different.status).toBe(1);
    expect(different.output).toContain('no template was reported');
    expect(different.output).not.toContain(TOKEN);
  });

  it('test refuses without the spend opt-in: exit 2, nothing sent, no token in any output', async () => {
    const result = await runCommand(['test'], {
      STORE_PLATFORM_URL: 'http://127.0.0.1:9',
      STORE_OPERATOR_TOKEN: TOKEN,
      STORE_LIVE_VERIFY_ENVIRONMENT: 'production',
      STORE_LIVE_VERIFY_API_KEY: 'k'.repeat(40),
    });
    expect(result.status).toBe(2);
    expect(result.output).toContain('spend-approved');
    expect(result.output).not.toContain(TOKEN);
  });

  it('test refuses a staging environment', async () => {
    const result = await runCommand(['test'], {
      STORE_PLATFORM_URL: 'http://127.0.0.1:9',
      STORE_OPERATOR_TOKEN: TOKEN,
      STORE_LIVE_VERIFY: 'spend-approved',
      STORE_LIVE_VERIFY_ENVIRONMENT: 'staging',
      STORE_LIVE_VERIFY_API_KEY: 'k'.repeat(40),
    });
    expect(result.status).toBe(2);
  });
});
