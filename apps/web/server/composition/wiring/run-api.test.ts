/**
 * The run API environment's daily cost cap wiring (issue #1851): `policyCeiling.maxCostPerDayUsd`
 * must reach a run start, so a start over the cap is refused and a deployment with no cap reads no
 * spend at all.
 */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it, vi } from 'vitest';

import { startRunOnSession } from '../../runs/service';
import { wireRunApi } from './run-api';

vi.mock('./run-launcher', () => ({ createCompositionRunLauncher: () => vi.fn() }));

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const PRINCIPAL = {
  principalId: '00000000-0000-4000-8000-000000000004',
  ownerPrincipalId: '00000000-0000-4000-8000-000000000004',
  userId: '00000000-0000-4000-8000-000000000003',
  workspaceId: WORKSPACE,
  scope: null,
};
const START = { prompt: 'hi', sessionId: null, modelOverride: null } as const;
const AGENT = { id: 'agent-1', workspaceId: WORKSPACE, engine: 'claude-code' } as const;

/** The run API wired over fakes for everything but the cap: `usageCostUsd` is the ledger. */
function wireWith(
  policyCeiling: ProjectPolicy | null,
  usageCostUsd: (from: Date, to: Date) => Promise<{ costUsd: string; unpricedUsage: boolean }>,
) {
  const create = vi.fn();
  const environment = wireRunApi({
    root: { runs: { forScope: () => ({ usageCostUsd }) } },
    scopes: { forWorkspaceId: () => Promise.resolve({ workspaceId: WORKSPACE }) },
    withCeiling: {},
    policyCeiling,
    runs: { create },
  } as unknown as Parameters<typeof wireRunApi>[0]);
  return { environment, create };
}

describe('wireRunApi daily cost cap', () => {
  it('refuses a run start for a workspace over the policy ceiling cap, and creates no run', async () => {
    const usageCostUsd = vi.fn(() => Promise.resolve({ costUsd: '5', unpricedUsage: false }));
    const { environment, create } = wireWith({ maxCostPerDayUsd: 5 }, usageCostUsd);

    await expect(startRunOnSession(environment, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 429,
      code: 'daily_cost_cap_reached',
    });
    expect(usageCostUsd).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses with a 503 when the ledger cannot be read', async () => {
    const { environment } = wireWith({ maxCostPerDayUsd: 5 }, () =>
      Promise.reject(new Error('database down')),
    );
    await expect(startRunOnSession(environment, PRINCIPAL, AGENT, START)).resolves.toMatchObject({
      kind: 'refused',
      status: 503,
      code: 'daily_cost_unavailable',
    });
  });

  it('installs no cap, and reads no spend, when the policy ceiling sets none', () => {
    const usageCostUsd = vi.fn();
    expect(wireWith({ limits: { maxTurns: 3 } }, usageCostUsd).environment.dailyCostCap).toBe(
      undefined,
    );
    expect(wireWith(null, usageCostUsd).environment.dailyCostCap).toBe(undefined);
    expect(usageCostUsd).not.toHaveBeenCalled();
  });
});
