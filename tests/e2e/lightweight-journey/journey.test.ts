import { journeySource } from './journey-test-fixtures.js';

import { describe, expect, it } from 'vitest';
import {
  DECLARATION,
  DECLARED_SECRET,
  OFFLINE_DECLARATION,
  OFFLINE_RUN_FILE,
  TOOL_NAME,
} from '../tool-sandbox.e2e.mjs';
import { refusedPush, refusedRun, setupAnswered } from './journey.e2e.mjs';
import { LANES } from './lanes.mjs';

import {
  ALL_CHAPTERS,
  vercelLane,
  cloudflareLane,
  outcomes,
  credentials,
} from './journey-test-fixtures.js';
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
    expect(journeySource()).toContain('declaration: OFFLINE_DECLARATION');
  });
});
