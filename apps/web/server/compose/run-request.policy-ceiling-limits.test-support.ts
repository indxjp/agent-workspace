import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { claudeDeniedToolsFor } from '@indx-workspace/contracts/agents';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { expect, it } from 'vitest';

import type { createPolicyCeilingFixture } from './run-request.policy-ceiling.fixture.test-support';
import { ALL_ON } from './run-request.fixture.test-support';
export function registerLimitsCases({
  claudeArm,
  compose,
}: ReturnType<typeof createPolicyCeilingFixture>) {
  it('caps runCommands, so the adapter denies Bash after the stored deny, which keeps its place', async () => {
    const request = await compose(claudeArm(['WebFetch']), {
      permissions: { runCommands: false },
    });
    expect(request.portable.permissions).toEqual({ ...ALL_ON, runCommands: false });
    expect(claudeDeniedToolsFor(request.portable.permissions)).toEqual([
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
    // The adapter's own deny list: the stored arm first, then the met permission floor.
    expect(compileRunRequest(request).disallowedTools).toEqual([
      'WebFetch',
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
  });
  it('composes a stored maxBudgetUsd of 5 as 2, a null one as 2, and maxTurns 50 as 10', async () => {
    const ceiling: ProjectPolicy = { limits: { maxTurns: 10, maxBudgetUsd: 2 } };
    const stored = await compose(claudeArm([], { maxTurns: 50, maxBudgetUsd: 5 }), ceiling);
    expect(stored.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
    const unset = await compose(claudeArm([], { maxTurns: null, maxBudgetUsd: null }), ceiling);
    expect(unset.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
    // An agent with no stored policy has null limits, and composes at the ceiling too.
    const compiled = await compose(null, ceiling);
    expect(compiled.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 2 });
  });
  it("a trial run's budget is the lower of the agent's policy and the trial budget, and a larger override cannot raise it", async () => {
    const policy = claudeArm([], { maxTurns: 20, maxBudgetUsd: 1 });
    const lowered = await compose(policy, null, { limits: { maxBudgetUsd: 0.3, maxTurns: 5 } });
    expect(lowered.portable.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.3 });
    const larger = await compose(policy, null, { limits: { maxBudgetUsd: 5, maxTurns: 90 } });
    expect(larger.portable.limits).toEqual({ maxTurns: 20, maxBudgetUsd: 1 });
    const ceiling: ProjectPolicy = { limits: { maxTurns: 10, maxBudgetUsd: 0.5 } };
    const under = await compose(policy, ceiling, { limits: { maxBudgetUsd: 0.3 } });
    expect(under.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 0.3 });
    const over = await compose(policy, ceiling, { limits: { maxBudgetUsd: 0.9 } });
    expect(over.portable.limits).toEqual({ maxTurns: 10, maxBudgetUsd: 0.5 });
    const uncapped = await compose(null, null, { limits: { maxBudgetUsd: 0.3 } });
    expect(uncapped.portable.limits).toEqual({ maxTurns: null, maxBudgetUsd: 0.3 });
  });
  it("composes the run's stored spend ceiling as limits.maxBudgetUsd, never looser (ADR-0162)", async () => {
    const policy = claudeArm([], { maxTurns: 20, maxBudgetUsd: 1 });
    const narrowed = await compose(policy, null, { spendCeilingUsd: '0.250000' });
    expect(narrowed.portable.limits).toEqual({ maxTurns: 20, maxBudgetUsd: 0.25 });
    const unset = await compose(null, null, { spendCeilingUsd: '0.500000' });
    expect(unset.portable.limits).toEqual({ maxTurns: null, maxBudgetUsd: 0.5 });
    const looser = await compose(policy, null, { spendCeilingUsd: '3.000000' });
    expect(looser.portable.limits).toEqual({ maxTurns: 20, maxBudgetUsd: 1 });
  });
}
