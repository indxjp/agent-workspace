/**
 * `startRunOnSession` refusals that precede any session or run: an archived agent (#1851 slice 4)
 * and the workspace's daily cost cap (#1851 slice 3).
 */
import { ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRef } from './environment';
import { startRunOnSession } from './service';
import {
  AGENT,
  EXISTING_SESSION,
  PRINCIPAL,
  START,
  WORKSPACE,
  harness,
  sessionIds,
  withDailyCostCap,
} from './service.test-support';

const CAP_RESETS_AT = '2026-10-27T00:00:00.000Z';
const LEDGER_UNREACHABLE = () => Promise.reject(new Error('ledger unreachable'));

describe('startRunOnSession: an archived agent (#1851 slice 4)', () => {
  const ARCHIVED: AgentRef = { ...AGENT, archived: true };

  it('refuses 409 agent_archived before it opens a session or creates a run', async () => {
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');

    await expect(startRunOnSession(env, PRINCIPAL, ARCHIVED, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 409,
      code: 'agent_archived',
    });
    expect(create).not.toHaveBeenCalled();
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });

  it('refuses a follow-up in an existing session too, and starts nothing', async () => {
    const { env, store } = harness();
    const create = vi.spyOn(store, 'create');

    await expect(
      startRunOnSession(env, PRINCIPAL, ARCHIVED, { ...START, sessionId: EXISTING_SESSION }),
    ).resolves.toMatchObject({ kind: 'refused', status: 409, code: 'agent_archived' });
    expect(create).not.toHaveBeenCalled();
  });

  it('names the archive before the daily cost cap', async () => {
    const capped = withDailyCostCap(harness().env, LEDGER_UNREACHABLE);

    await expect(startRunOnSession(capped, PRINCIPAL, ARCHIVED, START)).resolves.toMatchObject({
      code: 'agent_archived',
    });
  });

  it('starts an agent without the archived mark', async () => {
    const { env } = harness();

    await expect(startRunOnSession(env, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'started',
    });
  });
});

describe('startRunOnSession: a start the daily cost cap refuses (#1851 slice 3)', () => {
  it('parses a policy with maxCostPerDayUsd: 5 and refuses a start once the workspace spent 5 USD today', async () => {
    expect(ProjectPolicySchema.parse({ maxCostPerDayUsd: 5 })).toEqual({ maxCostPerDayUsd: 5 });
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped = withDailyCostCap(env, () =>
      Promise.resolve({ capUsd: 5, spentUsd: 5, resetsAt: CAP_RESETS_AT }),
    );

    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 429,
      code: 'daily_cost_cap_reached',
      details: ['capUsd: 5', `resetsAt: ${CAP_RESETS_AT}`],
    });
    expect(create).not.toHaveBeenCalled();
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });

  it('fails closed: a spend read that throws is a 503 daily_cost_unavailable with no internals, before any session or run exists', async () => {
    const { env, sessions, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped = withDailyCostCap(env, LEDGER_UNREACHABLE);

    const refusal = await startRunOnSession(capped, PRINCIPAL, AGENT, START);
    expect(refusal).toMatchObject({
      kind: 'refused',
      status: 503,
      code: 'daily_cost_unavailable',
    });
    expect(JSON.stringify(refusal)).not.toContain('ledger unreachable');
    await expect(
      startRunOnSession(capped, PRINCIPAL, AGENT, { ...START, sessionId: EXISTING_SESSION }),
    ).resolves.toMatchObject({ kind: 'refused', status: 503, code: 'daily_cost_unavailable' });
    expect(create).not.toHaveBeenCalled();
    expect(sessionIds(sessions)).toEqual([EXISTING_SESSION]);
  });

  it('names unpriced usage in the refusal when the cap cannot be measured', async () => {
    const capped = withDailyCostCap(harness().env, () =>
      Promise.resolve({ capUsd: 5, spentUsd: 0, resetsAt: CAP_RESETS_AT, unpricedUsage: true }),
    );
    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 429,
      code: 'daily_cost_cap_reached',
      details: ['capUsd: 5', `resetsAt: ${CAP_RESETS_AT}`, 'unpricedUsage: true'],
    });
  });
});

describe('startRunOnSession: a start the daily cost cap admits', () => {
  it('starts the run unchanged while the workspace is under its cap', async () => {
    const { env, store } = harness();
    const create = vi.spyOn(store, 'create');
    const capped = withDailyCostCap(env, () => Promise.resolve(null));

    await expect(startRunOnSession(capped, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'started',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('judges the workspace of the principal that starts the run', async () => {
    const asked: string[] = [];
    const capped = withDailyCostCap(harness().env, (workspaceId) => {
      asked.push(workspaceId);
      return Promise.resolve(null);
    });
    await startRunOnSession(capped, PRINCIPAL, AGENT, START);
    expect(asked).toEqual([WORKSPACE]);
  });
});
