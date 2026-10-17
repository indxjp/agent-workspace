import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  DECLARATION,
  DECLARED_SECRET,
  OFFLINE_DECLARATION,
  OFFLINE_RUN_FILE,
  TOOL_NAME,
} from '../tool-sandbox.e2e.mjs';
import { promotePastGate } from '../build-deploy-journey/journey.e2e.mjs';
import { createAnthropicToolsHandler } from '../../journey/fake-anthropic-tools.mjs';
import { killLaneSandboxes } from './e2b-sandboxes.mjs';
import fakeProvider from './fake-provider-worker.mjs';
import { deployFakeProvider, wranglerConfig } from './fake-provider.mjs';
import {
  awaitSetup,
  failedRunDetail,
  frontendFiles,
  frontendTurn,
  JOURNEY_DEPLOYMENT_POLICY,
  pushVercelSandboxImage,
  refusedPush,
  redactingCheck,
  refusedRun,
  responseSecrets,
  setDotEnv,
  setupAnswered,
  vercelLogExcerpt,
  withVercelLogs,
} from './journey.e2e.mjs';
import {
  isLeftover,
  LANES,
  LEFTOVER_AGE_MS,
  resourceNames,
  resultsWriter,
  runChapters,
} from './lanes.mjs';
import { teardown } from './teardown.mjs';

const SUMMARY = path.resolve(import.meta.dirname, '../../../infra/tests/isolation/summary.mjs');
const ALL_CHAPTERS = [
  'create',
  'eval',
  'deploy',
  'configure',
  'gate',
  'chat-api',
  'hosted-chat',
  'widget',
  'frontend',
  'rollback',
];
const [vercelLane, , cloudflareLane] = LANES;
if (vercelLane === undefined || cloudflareLane === undefined) throw new Error('lanes are missing');

const directories: string[] = [];
let stderr: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function outcomes(lane: (typeof LANES)[number], env: Record<string, string>, steps = {}) {
  const rows: Record<string, { outcome: string; detail: string | undefined }> = {};
  const record = (id: string, outcome: string, detail?: string) => {
    rows[id] = { outcome, detail };
  };
  const ran: string[] = [];
  const stepFor = Object.fromEntries(
    ALL_CHAPTERS.map((id) => [id, () => Promise.resolve().then(() => void ran.push(id))]),
  );
  return runChapters(lane, env, { ...stepFor, ...steps }, record, () => [
    'minted-secret-value',
  ]).then(() => ({ rows, ran }));
}

const credentials = (lane: (typeof LANES)[number]) =>
  Object.fromEntries(lane.credentials.map((name) => [name, `${name.toLowerCase()}-value`]));

describe('the lightweight journey lanes (issue #832)', () => {
  it('skips every row of a lane without its credentials, naming them, and runs nothing', async () => {
    const { rows, ran } = await outcomes(vercelLane, {});
    expect(ran).toEqual([]);
    expect(Object.keys(rows)).toEqual(ALL_CHAPTERS);
    for (const row of Object.values(rows)) {
      expect(row.outcome).toBe('skipped');
      expect(row.detail).toContain('VERCEL_TOKEN');
    }
  });

  it('lists exactly the credentials each lane needs, and no model key', () => {
    const neon = ['NEON_API_KEY', 'NEON_PROJECT_ID'];
    const r2 = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    const vercel = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', ...r2, ...neon];
    const cloudflare = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', ...r2, ...neon];
    const e2b = ['E2B_API_KEY'];
    expect(
      Object.fromEntries(LANES.map((lane) => [lane.id, [...lane.credentials].sort()])),
    ).toEqual({
      'vercel-vercel-sandbox': [...vercel].sort(),
      'vercel-e2b': [...vercel, ...e2b].sort(),
      'cloudflare-cloudflare-sandbox': [...cloudflare].sort(),
      'cloudflare-e2b': [...cloudflare, ...e2b].sort(),
    });
  });

  it('passes every row with the lane credentials alone, no model key', async () => {
    const { rows, ran } = await outcomes(vercelLane, credentials(vercelLane));
    expect(ran).toEqual(ALL_CHAPTERS);
    expect(Object.values(rows).map((row) => row.outcome)).toEqual(ALL_CHAPTERS.map(() => 'pass'));
  });

  it('skips only the lane whose credential is missing', async () => {
    const cloudflareE2bLane = LANES.find((lane) => lane.id === 'cloudflare-e2b');
    if (cloudflareE2bLane === undefined) throw new Error('the cloudflare-e2b lane is missing');
    const env = credentials(cloudflareLane);
    const sandbox = await outcomes(cloudflareLane, env);
    const e2b = await outcomes(cloudflareE2bLane, env);
    expect(Object.values(sandbox.rows).every((row) => row.outcome === 'pass')).toBe(true);
    expect(Object.values(e2b.rows).every((row) => row.outcome === 'skipped')).toBe(true);
    expect(e2b.rows['create']?.detail).toContain('E2B_API_KEY');
  });

  it('expects only the Cloudflare Sandbox lane to refuse its runs, with the typed code (ADR-0131)', () => {
    expect(Object.fromEntries(LANES.map((lane) => [lane.id, lane.refusal]))).toEqual({
      'vercel-vercel-sandbox': undefined,
      'vercel-e2b': undefined,
      'cloudflare-cloudflare-sandbox': 'network_policy_unsupported',
      'cloudflare-e2b': undefined,
    });
  });

  it('expects aw push to be refused with code_tool_needs_host on the two sandbox lanes with no tool host', () => {
    expect(Object.fromEntries(LANES.map((lane) => [lane.id, lane.pushRefusal]))).toEqual({
      'vercel-vercel-sandbox': 'code_tool_needs_host',
      'vercel-e2b': undefined,
      'cloudflare-cloudflare-sandbox': 'code_tool_needs_host',
      'cloudflare-e2b': undefined,
    });
  });

  it('accepts a refused push only when every problem line is the typed 422 refusal', () => {
    const code = 'code_tool_needs_host';
    const line = `agents/assistant.ts: 422 ${code} [connector:aw-dev-tools, tool:getOrderByOrderNumber]`;
    expect(refusedPush(code, `${line}\nerror: 1 problem\n`)).toMatch(
      /^n\/a: .*code_tool_needs_host/u,
    );
    expect(refusedPush(code, `${line}\n${line}\n`)).toContain(code);
    expect(() => refusedPush(code, 'error: 1 problem\n')).toThrow(
      /refused with code_tool_needs_host/u,
    );
    expect(() => refusedPush(code, `${line}\nskills: 503 skills_runtime_not_configured\n`)).toThrow(
      /refused with/u,
    );
    expect(() => refusedPush(code, `${line}\nagents/assistant.ts: 422 other_code\n`)).toThrow(
      /refused with/u,
    );
    expect(() => refusedPush(code, line.replace('422', '500'))).toThrow(/refused with/u);
    expect(() =>
      refusedPush(code, `${line}\n✗ agents/assistant.ts:3:5  bad import\nerror: 2 problems\n`),
    ).toThrow(/printed 2 problem\(s\) but 1 refusal line/u);
  });

  it('records a chapter that proves a typed refusal as n/a with that proof, never pass', async () => {
    const proof = 'n/a: the first run was refused with network_policy_unsupported';
    const { rows } = await outcomes(cloudflareLane, credentials(cloudflareLane), {
      'chat-api': () => Promise.resolve(proof),
      'hosted-chat': () => Promise.resolve(proof),
    });
    expect(rows['chat-api']).toEqual({ outcome: 'n/a', detail: proof });
    expect(rows['hosted-chat']?.outcome).toBe('n/a');
    expect(rows['deploy']?.outcome).toBe('pass');
    expect(rows['widget']?.outcome).toBe('pass');
  });

  it('expects the recorded refusal at setup exactly on the lane that refuses its runs (ADR-0131)', () => {
    const code = 'network_policy_unsupported';
    const answer = (runtimeRefusal: unknown) => ({
      status: 201,
      text: '{}',
      json: { runtimeRefusal },
    });
    const recorded = {
      code,
      message: 'cloudflare-sandbox refuses every network policy (ADR-0131)',
    };
    expect(() => setupAnswered(code, answer(recorded))).not.toThrow();
    expect(() => setupAnswered(undefined, answer(null))).not.toThrow();
    expect(() => setupAnswered(code, answer(null))).toThrow(/recorded the runtime refusal/u);
    expect(() => setupAnswered(undefined, answer(recorded))).toThrow(
      /recorded the runtime refusal/u,
    );
    expect(() => setupAnswered(code, { status: 500, text: 'setup_failed', json: null })).toThrow(
      /setup answered 500/u,
    );
  });

  it('accepts a refused run only when the typed code is there and the run did not complete', async () => {
    const code = 'network_policy_unsupported';
    const frames = (status: string, reason: string) => [
      { event: 'run.status', data: { status, reason } },
    ];
    const refusedAtStart = { status: 422, text: `{"error":{"code":"${code}"}}` };
    await expect(refusedRun(code, refusedAtStart, () => Promise.resolve([]))).resolves.toContain(
      `refused with ${code}`,
    );
    const accepted = { status: 202, text: '{}' };
    await expect(
      refusedRun(code, accepted, () => Promise.resolve(frames('failed', code))),
    ).resolves.toContain(code);
    await expect(
      refusedRun(code, accepted, () => Promise.resolve(frames('completed', code))),
    ).rejects.toThrow(/was refused/u);
    await expect(
      refusedRun(code, accepted, () => Promise.resolve(frames('failed', 'runtime_unavailable'))),
    ).rejects.toThrow(/was refused/u);
    await expect(
      refusedRun(code, { status: 500, text: 'boom' }, () => Promise.resolve([])),
    ).rejects.toThrow(/was refused/u);
    await expect(
      refusedRun(code, { status: 500, text: `{"error":"${code}"}` }, () => Promise.resolve([])),
    ).rejects.toThrow(/was refused/u);
  });

  it('runs the code tool on the E2B lanes with no declared network, which E2B refuses to restrict (ADR-0132)', () => {
    // A declared domain makes the runner ask E2B for `restricted`, and every run is then refused.
    expect(DECLARATION).toContain('allowedDomains');
    expect(OFFLINE_DECLARATION).not.toContain('allowedDomains');
    expect(OFFLINE_DECLARATION).toContain(`secret('${DECLARED_SECRET}')`);
    expect(OFFLINE_RUN_FILE).toContain('order-data-');
    expect(OFFLINE_RUN_FILE).toContain('declared=');
    expect(OFFLINE_RUN_FILE).not.toMatch(/request|fetch/u);
    expect(OFFLINE_DECLARATION).toContain(`name: '${TOOL_NAME}'`);
    expect(readFileSync(path.join(import.meta.dirname, 'journey.e2e.mjs'), 'utf8')).toContain(
      'declaration: OFFLINE_DECLARATION',
    );
  });

  describe('the gate and the frontend turn (issue #832)', () => {
    const source = () => readFileSync(path.join(import.meta.dirname, 'journey.e2e.mjs'), 'utf8');

    it('gives the profile-path deployment the promotion bar aw deploy would write, single-quoted', () => {
      expect(ProjectPolicySchema.parse(JSON.parse(JOURNEY_DEPLOYMENT_POLICY))).toEqual({
        promotion: { minEvalScore: 1 },
      });
      const env = setDotEnv('A=1\n', { AW_DEPLOYMENT_POLICY: `'${JOURNEY_DEPLOYMENT_POLICY}'` });
      expect(env).toBe(`A=1\nAW_DEPLOYMENT_POLICY='${JOURNEY_DEPLOYMENT_POLICY}'\n`);
      expect(source()).toMatch(
        /lane\.deploy === 'profile'\) \{\s*entries\['AW_DEPLOYMENT_POLICY'\] = `'\$\{JOURNEY_DEPLOYMENT_POLICY\}'`;/u,
      );
    });

    it('runs the below-bar half of the gate on every lane that reaches it', () => {
      expect(source()).toMatch(/promotePastGate\(\{[^}]*refusal: true,\s*\}\);/u);
    });

    describe('promotePastGate', () => {
      const gate = (refusal: string) => {
        const project = mkdtempSync(path.join(tmpdir(), 'lj-gate-'));
        directories.push(project);
        mkdirSync(path.join(project, 'evals'));
        writeFileSync(path.join(project, 'evals/support.yaml'), 'cases: []\n');
        const calls: string[][] = [];
        const aw = (args: string[]) => {
          calls.push(args);
          const [command, subcommand] = args;
          if (command === 'versions') {
            return JSON.stringify({
              pointers: [
                { environment: 'local', number: 3 },
                { environment: 'production', number: 3 },
              ],
            });
          }
          const passed = calls.some((call) => call.includes('--junit'));
          if (command === 'eval' && subcommand === 'run')
            return passed ? '' : 'v3 is below --min-score 1';
          return command === 'promote' && !passed ? refusal : '';
        };
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const created = { project, aw, agentName: 'support' } as never;
        return () => promotePastGate({ created, remote: {}, evidence: project, refusal: true });
      };

      it('passes when the refusal names the version it refused', () => {
        expect(gate('production refused: v3 scored 0 (bar 1). Failing cases: x')).not.toThrow();
      });

      it('fails on a refusal that names another version or only says refused', () => {
        expect(gate('production refused: v2 scored 0 (bar 1).')).toThrow(
          /refused below the bar \(v3\)/u,
        );
        expect(gate('production refused')).toThrow(/refused below the bar \(v3\)/u);
      });
    });

    describe('frontendTurn', () => {
      const origin = 'https://web.example';
      const nonce = 'e2e-nonce-journeyabcd';
      const session = { token: 'visitor-token-1234', sessionId: 'sess-1', agentId: 'agent-1' };
      const frames = (status: string, text: string) => [
        { event: 'agent.message', data: { role: 'assistant', blocks: [{ type: 'text', text }] } },
        { event: 'run.status', data: { status } },
      ];
      type Ask = Parameters<typeof frontendTurn>[0]['ask'];
      const turn = (over: { status?: number; allow?: string | null; frames?: unknown[] } = {}) => {
        const ask = vi.fn<Ask>(() =>
          Promise.resolve({
            status: over.status ?? 202,
            text: '{}',
            headers: new Headers(
              over.allow === null ? {} : { 'access-control-allow-origin': over.allow ?? origin },
            ),
            json: { run: { id: 'run-1' } },
          }),
        );
        const lines: string[] = [];
        const report = (ok: boolean, message: string) => {
          if (!ok) throw new Error(`journey assertion failed: ${message}`);
          lines.push(message);
        };
        const framesOf = vi.fn<(runId: string) => Promise<unknown[]>>(() =>
          Promise.resolve(over.frames ?? frames('completed', `order-data-${nonce}`)),
        );
        return {
          ask,
          lines,
          framesOf,
          run: () =>
            frontendTurn({
              control: 'https://cp.example',
              origin,
              nonce,
              session,
              ask,
              framesOf,
              report,
            }),
        };
      };

      it('sends the run the way the frontend client does and accepts a completed, answered turn', async () => {
        const t = turn();
        await t.run();
        const [url, init] = t.ask.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://cp.example/api/agents/agent-1/runs');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ authorization: `Bearer ${session.token}`, origin });
        expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({
          prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
          sessionId: 'sess-1',
        });
        expect(t.framesOf).toHaveBeenCalledWith('run-1');
        expect(t.lines).toHaveLength(4);
        expect(t.lines.join('\n')).not.toContain(session.token);
      });

      it.each([
        ['a run that is not accepted', { status: 403 }, /was accepted \(403/u],
        ['a missing CORS header', { allow: null }, /allows the frontend origin \(null\)/u],
        ['another allowed origin', { allow: 'https://other.example' }, /allows the frontend/u],
        ['a run that did not complete', { frames: frames('failed', 'x') }, /run completed/u],
        [
          'a reply without the tool data',
          { frames: frames('completed', 'hello') },
          /carries the code tool's data/u,
        ],
      ])('fails on %s', async (_name, over, message) => {
        await expect(turn(over).run()).rejects.toThrow(message);
      });
    });
  });

  describe('awaitSetup', () => {
    const fast = { windowMs: 250, delayMs: 5 };
    const url = 'https://cp.example.workers.dev';

    it('names the last status and the start of the body when /setup never answers 200', async () => {
      const get = vi.fn(() =>
        Promise.resolve(new Response('The control plane is starting', { status: 503 })),
      );
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow(
        /\/setup with 200 in 0\.25 s \(\d+ requests\); last: HTTP 503 "The control plane is starting"/u,
      );
      expect(get.mock.calls.length).toBeGreaterThan(1);
    });

    it("summarizes Cloudflare's HTML error page to its title, code and cf-ray", async () => {
      const page =
        '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->' +
        '<head><title>Worker threw exception | cp.example.workers.dev | Cloudflare</title></head>' +
        '<body><span class="cf-error-code">Error 1101</span></body></html>';
      const get = () =>
        Promise.resolve(new Response(page, { status: 500, headers: { 'cf-ray': '9a1b-NRT' } }));
      const message = await awaitSetup(url, { windowMs: 0, delayMs: 0, fetch: get }).then(
        () => '',
        (error: unknown) => String(error),
      );
      expect(message).toContain('code: Error 1101');
      expect(message).toContain('cf-ray: 9a1b-NRT');
      expect(message).not.toContain('<!DOCTYPE');
    });

    it('does not count a redirect as an answer', async () => {
      const get = () =>
        Promise.resolve(new Response(null, { status: 307, headers: { location: '/signin' } }));
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow('last: HTTP 307');
    });

    it('names the network error cause code', async () => {
      const get = () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
          }),
        );
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow(
        'last: network error ECONNREFUSED',
      );
    });

    it('gives each attempt a timeout so a hung server is reported, not waited on', async () => {
      const get = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        });
      await expect(
        awaitSetup(url, { windowMs: 0, delayMs: 0, requestTimeoutMs: 5, fetch: get }),
      ).rejects.toThrow('last: network error');
    });

    it('resolves as soon as /setup answers 200', async () => {
      const answers = [503, 503, 200];
      const get = vi.fn(() =>
        Promise.resolve(new Response('', { status: answers.shift() ?? 500 })),
      );
      await expect(
        awaitSetup(url, { ...fast, windowMs: 5_000, fetch: get }),
      ).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledTimes(3);
    });
  });

  it('builds the E2B runtime template from the checkout and never reads the released-image variable', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'journey.e2e.mjs'), 'utf8');
    expect(source).toContain('const [runtimeTemplate, toolHostTemplate] = await Promise.all([');
    expect(source).toContain('E2B_RUNTIME_TEMPLATE: runtimeTemplate,');
    expect(source).toContain('E2B_TOOL_HOST_TEMPLATE: toolHostTemplate,');
    expect(source).toContain('...runtimeBuild(ROOT)');
    expect(source).toContain('...toolHostBuild(ROOT)');
    expect(source).not.toContain("process.env['E2B_RUNTIME_TEMPLATE']");
    const workflow = readFileSync(
      path.join(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    expect(workflow).not.toMatch(/^\s+E2B_RUNTIME_TEMPLATE:/mu);
  });

  describe('killLaneSandboxes (issue #832)', () => {
    const SECRET = 'e2b_SENTINEL_lane_key_0123456789';
    function e2b(alive: string[], toolIds: readonly string[] = []) {
      const calls: { method: string; url: string; key: string | null }[] = [];
      const request = ((input: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const headers = new Headers(init.headers);
        calls.push({ method, url: input, key: headers.get('x-api-key') });
        if (method === 'DELETE') {
          const id = decodeURIComponent(input.split('/sandboxes/')[1] ?? '');
          const at = alive.indexOf(id);
          if (at < 0) return Promise.resolve(new Response('{}', { status: 404 }));
          alive.splice(at, 1);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          Response.json(
            alive.map((sandboxID) => ({
              sandboxID,
              metadata: toolIds.includes(sandboxID) ? { awTools: 'tools-1' } : { awSession: 's' },
            })),
          ),
        );
      }) as typeof fetch;
      return { calls, request };
    }

    it("lists by the lane's workspace tag, kills each, and prints the count before and after", async () => {
      const f = e2b(['sbx-1', 'sbx-2', 'sbx-3'], ['sbx-3']);
      const log: string[] = [];
      const result = await killLaneSandboxes({
        apiKey: SECRET,
        workspaceId: 'ws-lane',
        request: f.request,
        log: (line) => log.push(line),
        pollMs: 0,
      });
      expect(result).toEqual({ before: 3, after: 0 });
      const listing = new URL(f.calls[0]?.url ?? '');
      expect(listing.searchParams.get('metadata')).toBe('awWorkspace=ws-lane');
      expect(listing.searchParams.get('state')).toBe('running');
      expect(f.calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([
        'https://api.e2b.dev/sandboxes/sbx-1',
        'https://api.e2b.dev/sandboxes/sbx-2',
        'https://api.e2b.dev/sandboxes/sbx-3',
      ]);
      expect(f.calls.every((call) => call.key === SECRET)).toBe(true);
      expect(log).toEqual([
        expect.stringContaining('before the sweep: 3 (runtime=2 tool=1)'),
        expect.stringContaining('after the sweep: 0'),
      ]);
      expect(log.join('\n')).not.toContain(SECRET);
    });

    it('kills nothing and reports 0 when the lane has no sandbox alive', async () => {
      const f = e2b([]);
      expect(
        await killLaneSandboxes({ apiKey: SECRET, workspaceId: 'ws-lane', request: f.request }),
      ).toEqual({ before: 0, after: 0 });
      expect(f.calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('reports what is still alive, not 0, when the provider keeps listing a sandbox', async () => {
      const request = ((_input: string, init: RequestInit = {}) =>
        Promise.resolve(
          init.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : Response.json([{ sandboxID: 'stuck' }]),
        )) as typeof fetch;
      expect(
        await killLaneSandboxes({
          apiKey: SECRET,
          workspaceId: 'ws-lane',
          request,
          polls: 2,
          pollMs: 0,
        }),
      ).toEqual({ before: 1, after: 1 });
    });

    it('fails when a kill is refused, without printing the key', async () => {
      const request = ((_input: string, init: RequestInit = {}) =>
        Promise.resolve(
          init.method === 'DELETE'
            ? new Response(SECRET, { status: 403 })
            : Response.json([{ sandboxID: 'sbx-1' }]),
        )) as typeof fetch;
      const error: unknown = await killLaneSandboxes({
        apiKey: SECRET,
        workspaceId: 'ws-lane',
        request,
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('E2B refused to kill sbx-1 (403)');
    });
  });

  it('runs the two E2B lanes one after the other and every other lane in a group of its own', () => {
    const workflow = readFileSync(
      path.join(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    expect(workflow).toContain(
      "group: lightweight-journey-${{ endsWith(matrix.lane, '-e2b') && 'e2b' || matrix.lane }}",
    );
    expect(LANES.filter((lane) => lane.sandbox === 'e2b').map((lane) => lane.id)).toEqual([
      'vercel-e2b',
      'cloudflare-e2b',
    ]);
  });

  it('sweeps the E2B lane sandboxes by workspace after the chapters, on success and failure alike', () => {
    const source = readFileSync(path.join(import.meta.dirname, 'journey.e2e.mjs'), 'utf8');
    const after = source.slice(source.indexOf('await runChapters(lane, process.env, steps'));
    expect(after).toMatch(
      /finally \{[\s\S]*if \(lane\.sandbox === 'e2b'\) await sweepE2bSandboxes\(\);/u,
    );
    expect(source).toContain("s['workspaceId'] = me.json.workspaceId");
    // A lane that never learned its workspace fails the sweep instead of skipping it.
    const sweep = source.slice(source.indexOf('async function sweepE2bSandboxes'));
    expect(sweep).toMatch(/try \{[\s\S]*?check\(\s*typeof workspaceId === 'string',/u);
    expect(sweep.slice(0, sweep.indexOf('killLaneSandboxes'))).not.toContain('return;');
  });

  describe('failedRunDetail', () => {
    const answer = (status: number, json: unknown) => ({
      request: vi.fn(() => Promise.resolve({ status, json })),
    });

    it('prints the stored status and error with every secret masked and control characters removed', async () => {
      const client = answer(200, {
        run: {
          status: 'failed',
          error: 'The runtime could not be reached.\u001b[31m e2b_test_redact_me',
        },
      });
      const detail = await failedRunDetail(client, 'run-1', ['e2b_test_redact_me']);
      expect(detail).toBe('status=failed error=The runtime could not be reached. [31m [redacted]');
      expect(client.request).toHaveBeenCalledWith('/api/runs/run-1', {});
    });

    it('authenticates as the visitor when given their token', async () => {
      const client = answer(200, { run: { status: 'failed', error: null } });
      await failedRunDetail(client, 'run-1', [], 'visitor-token');
      expect(client.request).toHaveBeenCalledWith('/api/runs/run-1', { apiKey: 'visitor-token' });
    });

    it('reports the HTTP status when the run cannot be read, and caps the length', async () => {
      expect(await failedRunDetail(answer(403, null), 'run-1', [])).toBe('status=403');
      const long = await failedRunDetail(
        answer(200, { run: { status: 'failed', error: 'x'.repeat(1_000) } }),
        'run-1',
        [],
      );
      expect(long).toHaveLength(300);
    });

    it('degrades to a fixed note when the run cannot be fetched', async () => {
      const client = { request: vi.fn(() => Promise.reject(new Error('fetch failed'))) };
      expect(await failedRunDetail(client, 'run-1', [])).toBe('run detail unavailable');
    });
  });

  describe('vercelLogExcerpt', () => {
    const base = { url: 'https://cp.vercel.app', team: 'team_x', token: 'vcp_token' };

    it('keeps the last error lines of the log, runs vercel logs with the token in the child env only', () => {
      const run = vi.fn(() => ({
        stdout: [
          'GET / 200',
          'Error: AW_DEPLOYMENT_POLICY is invalid: the value is not JSON',
          'GET /setup 500',
          'Error: instrumentation failed',
        ].join('\n'),
      }));
      const excerpt = vercelLogExcerpt({ ...base, lines: 1, run });
      expect(excerpt).toBe('Error: instrumentation failed');
      const [command, args, options] = run.mock.calls[0] as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv; timeout: number },
      ];
      expect([command, ...args]).toEqual(['vercel', 'logs', base.url, '--scope', 'team_x']);
      expect(options.env['VERCEL_TOKEN']).toBe('vcp_token');
      expect(options.timeout).toBeGreaterThan(0);
    });

    it('keeps what arrived when the stream is killed at the timeout', () => {
      const run = () => ({
        stdout: 'Error: invalid policy',
        error: new Error('spawnSync vercel ETIMEDOUT'),
      });
      expect(vercelLogExcerpt({ ...base, run })).toBe('Error: invalid policy');
    });

    it('says why there is no excerpt instead of failing', () => {
      const run = () => ({ stdout: null, error: new Error('spawnSync vercel ENOENT') });
      expect(vercelLogExcerpt({ ...base, run })).toBe(
        '(no runtime log excerpt: spawnSync vercel ENOENT)',
      );
      expect(vercelLogExcerpt({ ...base, run: () => ({ stdout: 'GET / 200\n' }) })).toBe(
        '(no runtime log excerpt: no error lines)',
      );
    });

    it('keeps the manager’s own failure line and a provider failure', () => {
      const run = () => ({
        stdout: [
          'GET /verify 500',
          'runner manager request failed: vercel-sandbox runtime: provider vercel create failed with status 400.',
        ].join('\n'),
      });
      expect(vercelLogExcerpt({ ...base, run })).toContain(
        'runner manager request failed: vercel-sandbox runtime: provider vercel create failed with status 400.',
      );
    });
  });

  describe('withVercelLogs', () => {
    it('appends each deployment’s log excerpt to the failure and keeps the cause', () => {
      const run = vi.fn((_command: string, args: string[]) => ({
        stdout: `[runs] run preparation failed at the tools step (Error): ${args[1]}`,
      }));
      const cause = new Error(
        'run 99b7f1e5: run_preparation_failed: ... at the tools step (Error).',
      );
      const wrapped = withVercelLogs(cause, {
        targets: [
          ['control plane', 'https://cp.vercel.app'],
          ['manager', 'https://cp-manager.vercel.app'],
        ],
        team: 'team_x',
        token: 'vcp_token',
        run,
      });
      expect(wrapped.cause).toBe(cause);
      expect(wrapped.message).toBe(
        `${cause.message} — control plane log: [runs] run preparation failed at the tools step (Error): https://cp.vercel.app — manager log: [runs] run preparation failed at the tools step (Error): https://cp-manager.vercel.app`,
      );
    });
  });

  describe('pushVercelSandboxImage', () => {
    const TOKEN = 'vcp_SENTINEL_token_0123456789';
    const DIGEST = 'a'.repeat(64);
    const PUSHED = 'b'.repeat(64);
    const reference = `localhost:5000/agent-runtime@sha256:${DIGEST}`;
    const tagged = `vcr.vercel.com/acme/aw-lj-manager/agent-workspace-runtime:sha256-${DIGEST}`;
    const options = { reference, team: 'team_x', token: TOKEN, project: 'aw-lj', pollMs: 0 };

    function fixture(
      sandboxAnswers: { status: number; text: string }[],
      projectStatus = 200,
      inspected = `${tagged.split(':')[0] ?? ''}@sha256:${PUSHED}\n`,
    ) {
      const commands: { line: string; input?: string; env?: NodeJS.ProcessEnv }[] = [];
      const requests: string[] = [];
      const run = vi.fn(
        (
          command: string,
          args: readonly string[],
          opts: { env?: NodeJS.ProcessEnv; input?: string },
        ) => {
          commands.push({
            line: [command, ...args].join(' '),
            ...(opts.input === undefined ? {} : { input: opts.input }),
            ...(opts.env === undefined ? {} : { env: opts.env }),
          });
          return args[0] === 'image' ? inspected : '';
        },
      );
      const answers = [...sandboxAnswers];
      const call = vi.fn((url: string, init?: RequestInit & { token?: string }) => {
        requests.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*$/u, '')}`);
        const reply = (status: number, json: unknown = null, text = '') =>
          Promise.resolve({ status, json, text });
        if (url.includes('/v2/teams/')) return reply(200, { slug: 'acme' });
        if (url.includes('/v9/projects/')) return reply(projectStatus, { id: 'prj_1' });
        if (url.includes('/v11/projects')) return reply(200, { id: 'prj_new' });
        if (url.includes('/v4/sandboxes')) {
          const next = answers.shift() ?? { status: 201, text: '{}' };
          return reply(next.status, null, next.text);
        }
        return reply(200);
      });
      return { run, call, commands, requests };
    }

    it('pushes through an isolated docker config with the token on stdin only, then returns the registry digest reference', async () => {
      const f = fixture([
        { status: 400, text: '{"error":{"code":"image_not_ready"}}' },
        { status: 400, text: '{"error":{"code":"image_not_ready"}}' },
        { status: 201, text: '{}' },
      ]);
      const sleep = vi.fn(() => Promise.resolve());

      const image = await pushVercelSandboxImage({ ...options, run: f.run, call: f.call, sleep });

      expect(image).toBe(`acme/aw-lj-manager/agent-workspace-runtime@sha256:${PUSHED}`);
      expect(f.commands.map((command) => command.line)).toEqual([
        'docker login vcr.vercel.com --username team_x --password-stdin',
        `docker pull --platform linux/amd64 ${reference}`,
        `docker tag ${reference} ${tagged}`,
        `docker push ${tagged}`,
        `docker image inspect --format {{join .RepoDigests "\\n"}} ${tagged}`,
      ]);
      expect(f.commands.filter((command) => command.input !== undefined)).toEqual([
        expect.objectContaining({ input: TOKEN }),
      ]);
      expect(f.commands.map((command) => command.line).join('\n')).not.toContain(TOKEN);
      expect(f.commands.every((command) => command.env?.['DOCKER_CONFIG'] !== undefined)).toBe(
        true,
      );
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(f.requests.filter((request) => request.includes('/v4/sandboxes'))).toHaveLength(3);
      expect(f.requests.at(-1)).toMatch(/^DELETE .*\/v2\/sandboxes\/aw-ready-/u);
      expect(f.requests).not.toContainEqual(expect.stringContaining('/v11/projects'));
    });

    it('returns the VCR digest even when the source registry digest is listed first', async () => {
      const f = fixture([], 200, `${reference}\n${tagged.split(':')[0] ?? ''}@sha256:${PUSHED}\n`);
      const image = await pushVercelSandboxImage({ ...options, run: f.run, call: f.call });
      expect(image).toBe(`acme/aw-lj-manager/agent-workspace-runtime@sha256:${PUSHED}`);

      const sourceOnly = fixture([], 200, `${reference}\n`);
      await expect(
        pushVercelSandboxImage({ ...options, run: sourceOnly.run, call: sourceOnly.call }),
      ).rejects.toThrow(/has a registry digest/u);
    });

    it('creates the manager project when it does not exist', async () => {
      const f = fixture([], 404);
      await pushVercelSandboxImage({ ...options, run: f.run, call: f.call });
      expect(f.requests).toContain('POST https://api.vercel.com/v11/projects');
    });

    it('fails with the provider answer when the image never becomes ready, or is refused for another reason', async () => {
      const notReady = { status: 400, text: 'image_not_ready' };
      const waiting = fixture([notReady, notReady, notReady]);
      await expect(
        pushVercelSandboxImage({
          ...options,
          polls: 3,
          run: waiting.run,
          call: waiting.call,
          sleep: () => Promise.resolve(),
        }),
      ).rejects.toThrow(/does not start \(HTTP 400 image_not_ready\)/u);

      const refused = fixture([{ status: 403, text: '{"error":{"code":"forbidden"}}' }]);
      const sleep = vi.fn(() => Promise.resolve());
      await expect(
        pushVercelSandboxImage({ ...options, run: refused.run, call: refused.call, sleep }),
      ).rejects.toThrow(/HTTP 403/u);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('refuses an image that is not pinned by digest before any call', async () => {
      const f = fixture([]);
      await expect(
        pushVercelSandboxImage({ ...options, reference: 'agent-runtime:latest', ...f }),
      ).rejects.toThrow(/pinned by digest/u);
      expect(f.call).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    });
  });

  it('records a throwing deploy as fail with the reason, redacted, and the rest as not reached', async () => {
    const env = credentials(cloudflareLane);
    const token = env['CLOUDFLARE_API_TOKEN'] ?? '';
    const { rows, ran } = await outcomes(cloudflareLane, env, {
      deploy: () =>
        Promise.reject(
          new Error(`Unauthorized: needs Containers: Edit (token ${token}, minted-secret-value)`),
        ),
    });
    expect(ran).toEqual(['create', 'eval']);
    expect(rows['deploy']?.outcome).toBe('fail');
    expect(rows['deploy']?.detail).toContain('Containers: Edit');
    expect(rows['deploy']?.detail).not.toContain(token);
    expect(rows['deploy']?.detail).not.toContain('minted-secret-value');
    for (const id of ALL_CHAPTERS.slice(3)) {
      expect(rows[id]?.outcome).toBe('fail');
      expect(rows[id]?.detail).toContain('not reached');
    }
  });

  it('prints a failing chapter’s redacted message to stderr, not only to the results file', async () => {
    const env = credentials(cloudflareLane);
    const token = env['CLOUDFLARE_API_TOKEN'] ?? '';
    await outcomes(cloudflareLane, env, {
      deploy: () =>
        Promise.reject(new Error(`wrangler: Unauthorized (token ${token}, minted-secret-value)`)),
    });
    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(printed).toContain('chapter "deploy" failed');
    expect(printed).toContain('wrangler: Unauthorized');
    expect(printed).toContain('[redacted]');
    expect(printed).not.toContain(token);
    expect(printed).not.toContain('minted-secret-value');
  });

  it('is never clean in the isolation summary unless every row passed', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lj-summary-'));
    directories.push(directory);
    const file = path.join(directory, 'results.json');
    const write = (rows: Record<string, string>) => {
      const record = resultsWriter('lane', (target, text) => writeFileSync(target, text), file);
      for (const [id, outcome] of Object.entries(rows)) record(id, outcome);
      return spawnSync('node', [SUMMARY, `lane=${file}`], { encoding: 'utf8' });
    };
    const allPass = Object.fromEntries(ALL_CHAPTERS.map((id) => [id, 'pass']));
    expect(write(allPass).status).toBe(0);
    expect(write({ ...allPass, rollback: 'skipped' }).status).toBe(1);
    const failed = write({ ...allPass, deploy: 'fail' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('fail');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { lane: string }).lane).toBe('lane');
  });

  it('the journey script writes an all-skipped file and exits 0 for a lane with no credentials', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lj-dry-'));
    directories.push(directory);
    const file = path.join(directory, 'results.json');
    const run = spawnSync('node', [path.join(import.meta.dirname, 'journey.e2e.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        LJ_LANE: vercelLane.id,
        LJ_RUN_ID: '1',
        LJ_RESULTS: file,
      },
    });
    expect(run.status, run.stderr).toBe(0);
    const { results } = JSON.parse(readFileSync(file, 'utf8')) as {
      results: Record<string, { outcome: string }>;
    };
    expect(Object.keys(results)).toEqual(ALL_CHAPTERS);
    expect(Object.values(results).every((row) => row.outcome === 'skipped')).toBe(true);
  });

  it('builds its images on the docker driver, which can push to the runner-host registry', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // A docker-container builder pushes from its own network namespace, where localhost:5000 is
    // not the registry (run 37864353535).
    expect(workflow).not.toMatch(/docker\/setup-buildx-action|buildx\s+(?:create|use)\b/u);
  });

  it('installs the host CLIs at exact pins, wrangler at the bridge deploy’s pin, within a bound', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    const start = workflow.indexOf('- name: Install the host CLI\n');
    expect(start).toBeGreaterThan(-1);
    const step = workflow.slice(start, workflow.indexOf('\n      - name:', start + 1));
    expect(step).toMatch(/timeout-minutes: 5\b/u);
    // The bridge deploy's pin; read as text so tsc does not check the untyped bridge module.
    const bridge = readFileSync(
      path.resolve(import.meta.dirname, '../../../infra/tests/providers/cloudflare-bridge.mjs'),
      'utf8',
    );
    const wrangler = /^export const WRANGLER = '([^']+)';$/mu.exec(bridge)?.[1];
    expect(wrangler).toMatch(/^wrangler@\d+\.\d+\.\d+$/u);
    expect(step).toContain(`npm install --global ${String(wrangler)} `);
    expect(step).toMatch(/npm install --global vercel@\d+\.\d+\.\d+ /u);
  });

  it('frees the runner’s unused toolchains before the build and prints the disk either side', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // Run 37871130400: the lanes filled the runner disk before the first journey row.
    const stepOf = (name: string) => {
      const start = workflow.indexOf(`- name: ${name}\n`);
      expect(start).toBeGreaterThan(-1);
      const next = workflow.indexOf('\n      - name:', start + 1);
      return workflow.slice(start, next === -1 ? undefined : next);
    };
    const free = stepOf('Free disk');
    expect(workflow.indexOf('- name: Free disk')).toBeLessThan(workflow.indexOf('- name: Install'));
    expect(free).toContain('sudo rm -rf');
    for (const toolchain of [
      '/usr/share/dotnet',
      '/usr/local/lib/android',
      '/opt/ghc',
      '/opt/hostedtoolcache/CodeQL',
    ]) {
      expect(free).toContain(toolchain);
    }
    expect(stepOf('Disk after the journey')).toMatch(/if: always\(\)/u);
  });

  it('tears down and uploads before the disk report, which is bounded and cannot fail the job', () => {
    const workflow = readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/lightweight-journey.yml'),
      'utf8',
    );
    // Run 37876751956: `docker system df` hung, the job died (exit 143) and Teardown never ran.
    const at = (name: string) => workflow.indexOf(`- name: ${name}\n`);
    const names = ['Run the journey', 'Teardown', 'Upload results', 'Disk after the journey'];
    for (const name of names) expect(at(name)).toBeGreaterThan(-1);
    expect(at('Run the journey')).toBeLessThan(at('Teardown'));
    expect(at('Teardown')).toBeLessThan(at('Upload results'));
    expect(at('Upload results')).toBeLessThan(at('Disk after the journey'));
    const stepOf = (name: string) => {
      const next = workflow.indexOf('\n      - name:', at(name) + 1);
      const end = next === -1 ? workflow.indexOf('\n  summary:') : next;
      return workflow.slice(at(name), end);
    };
    const minutes = names.map((name) => Number(/timeout-minutes: (\d+)/u.exec(stepOf(name))?.[1]));
    for (const step of minutes) expect(step).toBeGreaterThan(0);
    const job = Number(/^ {4}timeout-minutes: (\d+)/mu.exec(workflow)?.[1]);
    expect(minutes.reduce((total, step) => total + step, 0)).toBeLessThan(job);
    expect(job * 60_000).toBeLessThan(LEFTOVER_AGE_MS);
    expect(stepOf('Teardown')).toContain('if: always()');
    expect(stepOf('Upload results')).toContain('if: always()');
    expect(stepOf('Disk after the journey')).toContain('timeout 30 docker system df || true');
    expect(stepOf('Disk after the journey')).toContain('df -h /');
  });

  it('derives deterministic, distinct, short, lowercase names per run and lane', () => {
    const names = LANES.map((lane) => resourceNames(lane, '123456'));
    expect(resourceNames(vercelLane, '123456')).toEqual(names[0]);
    expect(new Set(names.map((entry) => entry.project)).size).toBe(LANES.length);
    expect(resourceNames(vercelLane, '123457').project).not.toBe(names[0]?.project);
    for (const entry of names) {
      for (const name of [...entry.vercelProjects, ...entry.workers]) {
        expect(name).toMatch(/^[a-z0-9-]{1,52}$/u);
      }
    }
  });
});

describe('the lightweight journey teardown (issue #832)', () => {
  const env = Object.fromEntries(
    LANES.flatMap((lane) => lane.credentials).map((name) => [name, `${name}-value`]),
  );

  it('counts a 404 as already gone and an refused deletion as a leftover', async () => {
    const seen: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const status = url.includes('-gateway') ? 403 : 404;
      return Promise.resolve(new Response('{}', { status }));
    }) as unknown as typeof fetch;
    const { removed, leftovers } = await teardown(vercelLane, '42', env, request);
    expect(removed.some((label) => label.includes('vercel project'))).toBe(true);
    expect(leftovers.some((label) => label.includes('-gateway') && label.includes('403'))).toBe(
      true,
    );
    expect(seen.every((line) => !line.includes(env['VERCEL_TOKEN'] ?? 'x'))).toBe(true);
  });

  it('deletes only this run’s Neon branch and Cloudflare container applications', async () => {
    const names = resourceNames(cloudflareLane, '42');
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      const body = url.includes('/containers/applications')
        ? {
            result: [
              { id: 'mine', name: `${names.project}-manager` },
              { id: 'other', name: 'unrelated' },
            ],
          }
        : {
            branches: [
              { id: 'br-mine', name: names.neonBranch },
              { id: 'br-main', name: 'main' },
            ],
          };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const { leftovers } = await teardown(cloudflareLane, '42', env, request);
    expect(leftovers).toEqual([]);
    expect(deleted.some((url) => url.endsWith('/containers/applications/mine'))).toBe(true);
    expect(deleted.some((url) => url.endsWith('/containers/applications/other'))).toBe(false);
    expect(deleted.some((url) => url.endsWith('/branches/br-mine'))).toBe(true);
    expect(deleted.some((url) => url.endsWith('/branches/br-main'))).toBe(false);
  });

  it('deletes the run’s bridge container applications from its lane only, scoped to the run', async () => {
    const cloudflareE2bLane = LANES.find((lane) => lane.id === 'cloudflare-e2b');
    if (cloudflareE2bLane === undefined) throw new Error('the cloudflare-e2b lane is missing');
    const bridge = resourceNames(cloudflareLane, '42').bridgeWorker;
    const deletesFrom = async (lane: (typeof LANES)[number]) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') deleted.push(url);
        const body = url.endsWith('/containers/applications')
          ? {
              result: [
                { id: 'none', name: `${bridge}-sandboxnone` },
                { id: 'open', name: `${bridge}-sandboxopen` },
                { id: 'later-run', name: `${bridge}1-sandboxnone` },
                { id: 'other', name: 'agent-workspace-sandbox-bridge-ci-7-sandboxnone' },
              ],
            }
          : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as unknown as typeof fetch;
      const { leftovers } = await teardown(lane, '42', env, request);
      expect(leftovers).toEqual([]);
      return deleted.filter((url) => url.includes('/containers/applications/'));
    };
    expect(await deletesFrom(cloudflareE2bLane)).toEqual([]);
    const deleted = await deletesFrom(cloudflareLane);
    expect(deleted.map((url) => url.split('/').pop()).sort()).toEqual(['none', 'open']);
  });

  it('deletes the run’s bridge Worker only from the lane that deploys it', async () => {
    const cloudflareE2bLane = LANES.find((lane) => lane.id === 'cloudflare-e2b');
    if (cloudflareE2bLane === undefined) throw new Error('the cloudflare-e2b lane is missing');
    const bridge = resourceNames(cloudflareLane, '42').bridgeWorker;
    const deletesFrom = async (lane: (typeof LANES)[number]) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') deleted.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof fetch;
      await teardown(lane, '42', env, request);
      return deleted;
    };
    expect((await deletesFrom(cloudflareE2bLane)).some((url) => url.includes(bridge))).toBe(false);
    expect((await deletesFrom(cloudflareLane)).some((url) => url.includes(bridge))).toBe(true);
  });

  it('deletes the run’s fake provider Worker and sweeps a leftover one', async () => {
    const { fakeProvider } = resourceNames(cloudflareLane, '42');
    expect(fakeProvider).toBe(`${resourceNames(cloudflareLane, '42').project}-provider`);
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deleted.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    await teardown(cloudflareLane, '42', env, request);
    expect(deleted.some((url) => url.includes(`/scripts/${fakeProvider}`))).toBe(true);
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000).toISOString();
    expect(
      isLeftover(cloudflareLane, '42')(`awlj-0123abcd-${cloudflareLane.key}-provider`, {
        created_on: old,
      }),
    ).toBe(true);
    expect(isLeftover(cloudflareLane, '42')(fakeProvider, { created_on: old })).toBe(false);
  });

  it('deletes a Vercel lane’s fake provider Worker, and no other Cloudflare resource', async () => {
    const { fakeProvider } = resourceNames(vercelLane, '42');
    const requested: string[] = [];
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      requested.push(url);
      if (init?.method === 'DELETE') deleted.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const { leftovers } = await teardown(vercelLane, '42', env, request);
    expect(leftovers).toEqual([]);
    expect(requested.some((url) => url.includes('/containers/applications'))).toBe(false);
    const cloudflare = deleted.filter((url) => url.includes('api.cloudflare.com'));
    expect(cloudflare).toHaveLength(1);
    expect(cloudflare[0]).toContain(`/workers/scripts/${fakeProvider}?`);
  });

  it('sweeps a Vercel lane’s leftover provider Worker', async () => {
    const old = new Date(Date.now() - LEFTOVER_AGE_MS - 60_000).toISOString();
    const stale = `awlj-0123abcd-${vercelLane.key}-provider`;
    const deleted: string[] = [];
    const request = ((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') deleted.push(url);
      const body = url.endsWith('/workers/scripts')
        ? { result: [{ id: stale, created_on: old }] }
        : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    await teardown(vercelLane, '42', env, request);
    expect(deleted.some((url) => url.includes(`/workers/scripts/${stale}?`))).toBe(true);
  });

  describe('the leftover sweep', () => {
    const now = Date.now();
    const old = new Date(now - LEFTOVER_AGE_MS - 60_000).toISOString();
    const young = new Date(now - LEFTOVER_AGE_MS + 60_000).toISOString();
    const other = '0123abcd';
    const mine = (lane: (typeof LANES)[number]) => resourceNames(lane, '42').project;
    const leftoverName = (lane: (typeof LANES)[number]) => `awlj-${other}-${lane.key}`;

    it('keeps young, undated, other-prefixed, other-lane and this run’s names; deletes old ones', () => {
      const leftover = isLeftover(cloudflareLane, '42', now);
      const name = leftoverName(cloudflareLane);
      expect(leftover(name, { created_on: old })).toBe(true);
      expect(leftover(`${name}-control-plane`, { modified_on: old })).toBe(true);
      expect(leftover(name, { createdAt: now - LEFTOVER_AGE_MS - 60_000 })).toBe(true);
      expect(leftover(name, { created_on: young })).toBe(false);
      expect(leftover(name, { created_on: old, modified_on: young })).toBe(false);
      expect(leftover(name, {})).toBe(false);
      expect(leftover(name, { created_on: 'not a date' })).toBe(false);
      expect(leftover(name, undefined)).toBe(false);
      expect(leftover(mine(cloudflareLane), { created_on: old })).toBe(false);
      expect(leftover(`${mine(cloudflareLane)}-manager`, { created_on: old })).toBe(false);
      expect(leftover(leftoverName(vercelLane), { created_on: old })).toBe(false);
      for (const production of [
        'main',
        'awlj',
        'awlj-',
        `awlj-${other}`,
        `awlj-${other}-${cloudflareLane.key}-extra`,
        `my-awlj-${other}-${cloudflareLane.key}`,
        `AWLJ-${other}-${cloudflareLane.key}`,
        'agent-workspace-sandbox-bridge-ci-1-1',
      ]) {
        expect(leftover(production, { created_on: old })).toBe(false);
      }
      expect(leftover(undefined, { created_on: old })).toBe(false);
    });

    const sweepFrom = async (
      lane: (typeof LANES)[number],
      pages: Record<string, unknown>,
      refuse: (url: string) => boolean = () => false,
    ) => {
      const deleted: string[] = [];
      const request = ((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deleted.push(url);
          return Promise.resolve(new Response('{}', { status: refuse(url) ? 403 : 200 }));
        }
        const key = Object.keys(pages).find((candidate) => url.includes(candidate));
        return Promise.resolve(
          new Response(JSON.stringify(pages[key ?? ''] ?? {}), { status: 200 }),
        );
      }) as unknown as typeof fetch;
      const result = await teardown(lane, '42', env, request);
      return { ...result, deleted };
    };

    it('deletes old Neon branches over every page and nothing else', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers, removed } = await sweepFrom(vercelLane, {
        'branches?limit=100&cursor=next-page': {
          branches: [{ id: 'br-old2', name, created_at: old }],
        },
        'branches?limit=100': {
          branches: [
            { id: 'br-old', name, created_at: old },
            { id: 'br-young', name: `awlj-1111aaaa-${vercelLane.key}`, created_at: young },
            { id: 'br-undated', name: `awlj-2222aaaa-${vercelLane.key}` },
            { id: 'br-main', name: 'main', created_at: old },
            { id: 'br-mine', name: mine(vercelLane), created_at: old },
          ],
          pagination: { next: 'next-page' },
        },
      });
      expect(leftovers).toEqual([]);
      const branches = deleted.filter((url) => url.includes('/branches/'));
      expect(branches.map((url) => url.split('/').pop()).sort()).toEqual([
        'br-mine',
        'br-old',
        'br-old2',
      ]);
      expect(removed).toContain(`neon branch ${name}`);
    });

    it('stops listing Neon branches at an empty page that still carries a cursor', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers } = await sweepFrom(vercelLane, {
        'branches?limit=100&cursor=x': { branches: [], pagination: { next: 'x' } },
        'branches?limit=100': {
          branches: [{ id: 'br-old', name, created_at: old }],
          pagination: { next: 'x' },
        },
      });
      expect(leftovers).toEqual([]);
      expect(deleted.some((url) => url.endsWith('/branches/br-old'))).toBe(true);
    });

    it('never sweeps a default or protected Neon branch', async () => {
      const name = leftoverName(vercelLane);
      const { deleted, leftovers } = await sweepFrom(vercelLane, {
        'branches?limit=100': {
          branches: [
            { id: 'br-protected', name, created_at: old, protected: true },
            { id: 'br-default', name, created_at: old, default: true },
            { id: 'br-old', name, created_at: old },
          ],
        },
      });
      expect(leftovers).toEqual([]);
      const branches = deleted.filter((url) => url.includes('/branches/'));
      expect(branches.map((url) => url.split('/').pop())).toEqual(['br-old']);
    });

    it('deletes old Vercel projects and Cloudflare Workers by exact name', async () => {
      const vercelName = leftoverName(vercelLane);
      const vercel = await sweepFrom(vercelLane, {
        '/v9/projects?': {
          projects: [
            { name: `${vercelName}-web`, createdAt: now - LEFTOVER_AGE_MS - 60_000 },
            { name: 'production-site', createdAt: 1 },
            { name: `awlj-${other}-${cloudflareLane.key}`, createdAt: 1 },
            { name: `${vercelName}-gateway`, createdAt: now },
          ],
        },
      });
      expect(vercel.leftovers).toEqual([]);
      expect(vercel.deleted).toContainEqual(
        expect.stringContaining(`/v9/projects/${vercelName}-web?`),
      );
      expect(vercel.deleted.join(' ')).not.toContain('production-site');
      expect(vercel.deleted.join(' ')).not.toContain(`${vercelName}-gateway`);
      expect(
        vercel.deleted.filter((url) => url.includes('api.vercel.com')).join(' '),
      ).not.toContain(cloudflareLane.key);

      const workerName = leftoverName(cloudflareLane);
      const cloudflare = await sweepFrom(cloudflareLane, {
        'workers/scripts?page=2': { result: [{ id: `${workerName}-web`, created_on: old }] },
        '/workers/scripts': {
          result: [
            { id: workerName, created_on: old },
            { id: 'production-api', created_on: old },
            { id: `${workerName}-manager`, created_on: young },
          ],
          result_info: { page: 1, total_pages: 2 },
        },
      });
      expect(cloudflare.leftovers).toEqual([]);
      const workers = cloudflare.deleted
        .filter((url) => url.includes('/workers/scripts/'))
        .map((url) => url.split('/workers/scripts/')[1]?.split('?')[0]);
      expect(workers).toContain(workerName);
      expect(workers).toContain(`${workerName}-web`);
      expect(workers).not.toContain('production-api');
      expect(workers).not.toContain(`${workerName}-manager`);
    });

    it('reports a refused sweep deletion as a leftover, naming only the resource and status', async () => {
      const name = leftoverName(vercelLane);
      const { leftovers } = await sweepFrom(
        vercelLane,
        { 'branches?limit=100': { branches: [{ id: 'br-old', name, created_at: old }] } },
        (url) => url.endsWith('/branches/br-old'),
      );
      expect(leftovers).toEqual([`neon branch ${name}: HTTP 403`]);
    });
  });

  it('removes nothing when its credentials are absent', async () => {
    const request = (() =>
      Promise.reject(new Error('no request expected'))) as unknown as typeof fetch;
    expect(await teardown(vercelLane, '42', {}, request)).toEqual({ removed: [], leftovers: [] });
  });
});

describe('the lightweight journey helpers (issue #832)', () => {
  it('replaces a set line, appends a missing one and keeps the rest of the file', () => {
    const text = 'A=1\nDATABASE_URL=\nB=2\n';
    expect(setDotEnv(text, { DATABASE_URL: 'postgres://x?a=b&c=d', C: '3' })).toBe(
      'A=1\nDATABASE_URL=postgres://x?a=b&c=d\nB=2\nC=3\n',
    );
    expect(setDotEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('writes a frontend whose build embeds the control plane url', () => {
    const files = frontendFiles();
    const manifest = JSON.parse(files['package.json']) as { scripts: { build: string } };
    expect(manifest.scripts.build).toBe('node build.mjs');
    expect(files['build.mjs']).toContain('VITE_AW_BASE_URL');
  });

  it('finds the credentials an answer carries, at any depth, and ignores the rest', () => {
    expect(
      responseSecrets({
        token: 'awt_live_abc_0123456789',
        sessionId: 'session-0123456789',
        nested: { apiKey: 'ak_live_abc_0123456789', password: 'short', count: 12345678 },
        list: [{ secret: 'declared-secret-value' }],
        tokens: ['awt_live_def_0123456789', 'short'],
        names: ['not-a-secret-value'],
      }),
    ).toEqual([
      'awt_live_abc_0123456789',
      'ak_live_abc_0123456789',
      'declared-secret-value',
      'awt_live_def_0123456789',
    ]);
    expect(responseSecrets(null)).toEqual([]);
  });

  it('prints no visitor token on an ok: line, whatever the order the token was learned in', () => {
    const token = 'awt_live_0a1b2c3d_4e5f6a7b8c9d0e1f';
    const session = { status: 201, text: JSON.stringify({ token, sessionId: 'sid-1' }) };
    const secrets: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = redactingCheck(() => secrets);
    secrets.push(...responseSecrets(JSON.parse(session.text)));
    check(true, `a visitor session opened (${String(session.status)} ${session.text})`);
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('ok: a visitor session opened (201 {"token":"[redacted]"');
    expect(printed).not.toContain('awt_');
    expect(() => check(false, `refused ${token}`)).toThrow(/refused \[redacted\]/u);
  });

  it('prints the setup answer through the redacting report it is given', () => {
    const lines: string[] = [];
    const report = redactingCheck(
      () => ['awt_live_abcdef0123456789'],
      (_ok, message) => {
        lines.push(message);
      },
    );
    const text = '{"token":"awt_live_abcdef0123456789"}';
    setupAnswered(undefined, { status: 201, text, json: JSON.parse(text) }, report);
    expect(lines.join('\n')).toContain('setup answered 201 {"token":"[redacted]"}');
    expect(lines.join('\n')).not.toContain('awt_');
  });
});

describe('the fake provider Worker (issue #831)', () => {
  const key = 'fake-key-for-the-test';
  const worker = (request: Request, env: { FAKE_PROVIDER_KEY?: string }) =>
    fakeProvider.fetch(request, env);
  const authorised = { 'x-api-key': key };

  it('answers 401 to a wrong or missing key and to a Worker with no secret', async () => {
    const url = 'https://provider.example/v1/models';
    expect((await worker(new Request(url), { FAKE_PROVIDER_KEY: key })).status).toBe(401);
    const wrong = new Request(url, { headers: { 'x-api-key': 'wrong' } });
    expect((await worker(wrong, { FAKE_PROVIDER_KEY: key })).status).toBe(401);
    const unset = new Request(url, { headers: authorised });
    expect((await worker(unset, {})).status).toBe(401);
  });

  it('lists models for the key, which is what setup’s probe asks', async () => {
    const response = await worker(
      new Request('https://provider.example/v1/models', { headers: authorised }),
      { FAKE_PROVIDER_KEY: key },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('claude');
  });

  it('answers a message exactly as the node handler does', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const viaWorker = await worker(
      new Request('https://provider.example/v1/messages', {
        method: 'POST',
        headers: { ...authorised, 'content-type': 'application/json' },
        body,
      }),
      { FAKE_PROVIDER_KEY: key },
    );
    const direct = createServer((request, response) => {
      void createAnthropicToolsHandler([], [])(request, response);
    });
    await new Promise<void>((resolve) => direct.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = direct.address() as AddressInfo;
      const reference = await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(viaWorker.status).toBe(reference.status);
      expect(await viaWorker.text()).toBe(await reference.text());
    } finally {
      direct.close();
    }
  });

  describe('deploys through wrangler error 10007 (the Worker is not visible yet)', () => {
    const workerName = 'awlj-42-cc-provider';
    const retry = { delaysMs: [1, 1, 1], sleep: () => Promise.resolve() };
    const uploaded = `Uploaded ${workerName}\nhttps://${workerName}.acme.workers.dev`;
    const failure = (code: number) =>
      new Error(
        `npx wrangler exited 1, not 0\n✘ [ERROR] This Worker does not exist. [code: ${String(code)}]`,
      );

    beforeEach(() => {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** A `run` whose `deploy` calls fail with `code` for the first `failures` times. */
    function wrangler(failures: number, code: number) {
      const commands: string[] = [];
      let deploys = 0;
      const run = (_command: string, args: readonly string[]) => {
        commands.push(args.includes('deploy') ? 'deploy' : 'secret');
        if (args.includes('deploy') && (deploys += 1) <= failures) throw failure(code);
        return uploaded;
      };
      return { run, commands };
    }

    it('runs the deploy again after a 10007 and then puts the secret', async () => {
      const { run, commands } = wrangler(2, 10007);
      const url = await deployFakeProvider({ workerName, key: 'k', run, retry });
      expect(url).toBe(`https://${workerName}.acme.workers.dev`);
      expect(commands).toEqual(['deploy', 'deploy', 'deploy', 'secret']);
    });

    it('stops at the attempt cap with the wrangler error', async () => {
      const { run, commands } = wrangler(Infinity, 10007);
      await expect(deployFakeProvider({ workerName, key: 'k', run, retry })).rejects.toThrow(
        '[code: 10007]',
      );
      expect(commands).toHaveLength(1 + retry.delaysMs.length);
    });

    it('does not retry another error code', async () => {
      const { run, commands } = wrangler(Infinity, 10000);
      await expect(deployFakeProvider({ workerName, key: 'k', run, retry })).rejects.toThrow(
        '[code: 10000]',
      );
      expect(commands).toEqual(['deploy']);
    });
  });

  it('is deployed under the run’s derived name with node compatibility and no secret in its config', () => {
    const config = wranglerConfig(resourceNames(cloudflareLane, '42').fakeProvider);
    expect(JSON.parse(config)).toMatchObject({
      name: resourceNames(cloudflareLane, '42').fakeProvider,
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
    });
    expect(config).not.toContain('FAKE_PROVIDER_KEY');
  });
});
