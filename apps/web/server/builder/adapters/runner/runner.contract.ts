import crypto from 'node:crypto';

import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { MAX_PROMPT_CHARS } from '../../../runs/service';
import type { CallContext, RunnerPort } from '../../ports';

export interface RunnerFixture {
  readonly port: RunnerPort;
  /** A builder who owns `agentId`. */
  readonly ctx: CallContext;
  readonly viewer: CallContext;
  /** An admin in the workspace who does not own the agent: the console lets an admin evaluate any agent. */
  readonly admin: CallContext;
  readonly noCaller: CallContext;
  /** A builder in the workspace who does not own the agent. */
  readonly otherOwner: CallContext;
  /** A builder in another workspace, who must never reach this workspace's agents. */
  readonly otherWorkspace: CallContext;
  readonly agentId: string;
  /** A saved version of the agent. */
  readonly version: number;
  /** How many runs the evaluations and trials have started so far. */
  readonly started: () => number;
  /** Marks the agent built-in, as the platform does for the Builder. */
  readonly markBuiltin: (agentId: string) => Promise<void>;
  /** The last run started: the version it pins, the limit passed in, and the budget it ran under. */
  readonly lastRun: () =>
    | {
        readonly version: number | null;
        readonly overrideUsd: number | undefined;
        readonly maxBudgetUsd: number | null;
      }
    | undefined;
}

/** The budget in the agent's own policy that every fixture's runs resolve before the override lowers it. */
export const POLICY_BUDGET_USD = 0.2;

/** What every fixture's runs answer: longer than the Builder lets one tool result be. */
export const LONG_ANSWER = 'a'.repeat(BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes + 500);

/** The case every fixture's runtime answers: it uses the tool and says "shipped". */
export const ORDER_CASE = {
  name: 'order status uses the tool',
  input: 'Where is order 1042?',
  expect: { tool: 'orders_getOrder', contains: ['shipped'] },
};

/** Memory and production evaluate as the caller and refuse whoever the console would refuse. */
export function describeRunnerConformance(label: string, make: () => Promise<RunnerFixture>): void {
  describe(`RunnerPort.evaluate: ${label}`, () => {
    it('scores a saved version and answers the stored evaluation', async () => {
      const { port, ctx, agentId, version, started } = await make();
      const result = await port.evaluate(ctx, agentId, version, [ORDER_CASE]);
      if (!result.ok) throw new Error(`the evaluation was refused: ${result.code}`);
      expect(result.evaluation).toMatchObject({ agentId, version, passed: 1, total: 1 });
      expect(started()).toBe(1);
    });

    it("starts each case's run under the trial budget, lowering the agent's own budget and never raising it", async () => {
      const { port, ctx, agentId, version, lastRun } = await make();
      await port.evaluate(ctx, agentId, version, [ORDER_CASE]);
      expect(lastRun()).toMatchObject({
        version,
        overrideUsd: BUILDER_DEFAULT_LIMITS.trialBudgetUsd,
        maxBudgetUsd: Math.min(POLICY_BUDGET_USD, BUILDER_DEFAULT_LIMITS.trialBudgetUsd),
      });
    });

    it('answers the console route’s refusal for a version that does not exist', async () => {
      const { port, ctx, agentId, version, started } = await make();
      const result = await port.evaluate(ctx, agentId, version + 1, [ORDER_CASE]);
      expect(result).toMatchObject({ ok: false, code: 'agent_version_not_found' });
      expect(started()).toBe(0);
    });

    it('answers the console route’s refusal for an agent that does not exist', async () => {
      const { port, ctx, version, started } = await make();
      const result = await port.evaluate(ctx, crypto.randomUUID(), version, [ORDER_CASE]);
      expect(result).toMatchObject({ ok: false, code: 'agent_not_found' });
      expect(started()).toBe(0);
    });

    it('answers the console route’s refusal for an agent id that is not a UUID', async () => {
      const { port, ctx, version, started } = await make();
      const result = await port.evaluate(ctx, 'not-a-uuid', version, [ORDER_CASE]);
      expect(result).toMatchObject({ ok: false, code: 'invalid_agent_id' });
      expect(started()).toBe(0);
    });

    it('refuses a request with no cases', async () => {
      const { port, ctx, agentId, version, started } = await make();
      const result = await port.evaluate(ctx, agentId, version);
      expect(result).toMatchObject({ ok: false, code: 'invalid_body' });
      expect(started()).toBe(0);
    });

    it('starts nothing for a viewer', async () => {
      const { port, viewer, agentId, version, started } = await make();
      expect(await port.evaluate(viewer, agentId, version, [ORDER_CASE])).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(started()).toBe(0);
    });

    it('starts nothing for a builder who does not own the agent', async () => {
      const { port, otherOwner, agentId, version, started } = await make();
      expect(await port.evaluate(otherOwner, agentId, version, [ORDER_CASE])).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(started()).toBe(0);
    });

    it('lets an admin evaluate an agent they do not own', async () => {
      const { port, admin, agentId, version, started } = await make();
      const result = await port.evaluate(admin, agentId, version, [ORDER_CASE]);
      if (!result.ok) throw new Error(`the evaluation was refused: ${result.code}`);
      expect(result.evaluation).toMatchObject({ agentId, version, passed: 1, total: 1 });
      expect(started()).toBe(1);
    });

    it('starts nothing when no person is behind the run', async () => {
      const { port, noCaller, agentId, version, started } = await make();
      expect(await port.evaluate(noCaller, agentId, version, [ORDER_CASE])).toMatchObject({
        ok: false,
        code: 'no_caller',
      });
      expect(started()).toBe(0);
    });

    it('does not reach another workspace’s agent', async () => {
      const { port, otherWorkspace, agentId, version, started } = await make();
      expect(await port.evaluate(otherWorkspace, agentId, version, [ORDER_CASE])).toMatchObject({
        ok: false,
        code: 'agent_not_found',
      });
      expect(started()).toBe(0);
    });
  });
}

/** Memory and production start the trial as the caller, pin its version and lower its budget. */
export function describeTrialConformance(label: string, make: () => Promise<RunnerFixture>): void {
  const INPUT = 'Where is order 1042?';

  describe(`RunnerPort.trial: ${label}`, () => {
    it("a trial run's budget is the lower of the agent's policy and the trial budget, and a larger override cannot raise it", async () => {
      const { port, ctx, agentId, version, lastRun } = await make();
      const small = await port.trial(ctx, agentId, version, INPUT, 0.1, 'small');
      expect(small).toMatchObject({ ok: true, status: 'completed', costUsd: 0 });
      expect(lastRun()).toMatchObject({ overrideUsd: 0.1, maxBudgetUsd: 0.1 });
      await port.trial(ctx, agentId, version, INPUT, 5, 'large');
      expect(lastRun()).toMatchObject({
        overrideUsd: BUILDER_DEFAULT_LIMITS.trialBudgetUsd,
        maxBudgetUsd: POLICY_BUDGET_USD,
      });
    });

    it('pins the version it was asked for', async () => {
      const { port, ctx, agentId, version, lastRun, started } = await make();
      await port.trial(ctx, agentId, version, INPUT, 0.1, 'pinned');
      expect(lastRun()).toMatchObject({ version });
      expect(await port.trial(ctx, agentId, version + 1, INPUT, 0.1, 'missing')).toMatchObject({
        ok: false,
        code: 'agent_version_not_found',
      });
      for (const bad of [0, -1, 0.5]) {
        const result = await port.trial(ctx, agentId, bad, INPUT, 0.1, `bad-${String(bad)}`);
        expect(result).toMatchObject({ ok: false, code: 'agent_version_not_found' });
      }
      expect(started()).toBe(1);
    });

    it('starts one run for a repeated idempotency key and returns the first run’s result', async () => {
      const { port, ctx, agentId, version, started } = await make();
      const first = await port.trial(ctx, agentId, version, INPUT, 0.1, 'same');
      const again = await port.trial(ctx, agentId, version, INPUT, 0.1, 'same');
      if (!first.ok || !again.ok) throw new Error('the trial was refused');
      expect(again).toEqual(first);
      expect(started()).toBe(1);
      expect(await port.trial(ctx, agentId, version, 'Another input', 0.1, 'same')).toMatchObject({
        ok: false,
        code: 'run_idempotency_conflict',
      });
      expect(started()).toBe(1);
    });

    it('caps the output', async () => {
      const { port, ctx, agentId, version } = await make();
      const result = await port.trial(ctx, agentId, version, INPUT, 0.1, 'long');
      if (!result.ok) throw new Error(`the trial was refused: ${result.code}`);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
        BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes,
      );
      expect(LONG_ANSWER.startsWith(result.output)).toBe(true);
    });

    it('refuses a built-in agent and starts nothing', async () => {
      const { port, ctx, agentId, version, markBuiltin, started } = await make();
      await markBuiltin(agentId);
      expect(await port.trial(ctx, agentId, version, INPUT, 0.1, 'builtin')).toMatchObject({
        ok: false,
        code: 'builtin_agent_read_only',
      });
      expect(started()).toBe(0);
    });

    it('starts nothing for a caller without run rights', async () => {
      const f = await make();
      const refusals = [
        [f.viewer, 'forbidden'],
        [f.otherOwner, 'forbidden'],
        [f.noCaller, 'no_caller'],
        [f.otherWorkspace, 'agent_not_found'],
      ] as const;
      for (const [caller, code] of refusals) {
        expect(await f.port.trial(caller, f.agentId, f.version, INPUT, 0.1, code)).toMatchObject({
          ok: false,
          code,
        });
      }
      expect(f.started()).toBe(0);
    });

    it('refuses a bad agent id, input, key or budget before it starts anything', async () => {
      const { port, ctx, agentId, version, started } = await make();
      expect(await port.trial(ctx, 'not-a-uuid', version, INPUT, 0.1, 'k')).toMatchObject({
        code: 'invalid_agent_id',
      });
      for (const input of ['', '  \n', 'a'.repeat(MAX_PROMPT_CHARS + 1)]) {
        expect(await port.trial(ctx, agentId, version, input, 0.1, 'k')).toMatchObject({
          ok: false,
          code: 'invalid_trial_input',
        });
      }
      expect(await port.trial(ctx, agentId, version, INPUT, 0.1, '')).toMatchObject({
        code: 'invalid_idempotency_key',
      });
      expect(await port.trial(ctx, agentId, version, INPUT, 0, 'k')).toMatchObject({
        code: 'invalid_run_limits',
      });
      expect(started()).toBe(0);
    });
  });
}
