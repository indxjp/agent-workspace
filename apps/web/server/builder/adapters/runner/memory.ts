import crypto from 'node:crypto';

import { BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';

import { agentVersionNotFound } from '../../../agent-versions/problems';
import { isUuid } from '../../../agents/contract';
import { agentNotFound, refuseBuiltinWrite } from '../../../agents/handlers';
import type { RunnerPort, TrialResult } from '../../ports';
import { mayEvaluate, mayRun } from '../checker/access';
import {
  cappedBudget,
  capOutput,
  FORBIDDEN,
  FORBIDDEN_TO_RUN,
  IDEMPOTENCY_CODES,
  INVALID_AGENT_ID,
  NO_CALLER,
  refusalOf,
  trialArgumentRefusal,
  trialRequestHash,
} from './production';

type Agent = { readonly ownerPrincipalId: string; readonly versions: number; builtin?: true };

/** Answers the cases it is given as passed, and counts them as started; refuses as the console route does. */
// ponytail: no run is scored; the production adapter does that through the evaluations handler.
export class MemoryRunner implements RunnerPort {
  /** Keyed by `${workspaceId}:${agentId}`, so one workspace never reaches another's agent. */
  private readonly agents = new Map<string, Agent>();
  private readonly trials = new Map<
    string,
    { readonly hash: string; readonly result: TrialResult }
  >();
  started = 0;
  /** What every trial run answers. */
  answer = 'ok';
  /** The last trial or evaluation started: its version and the budget limit its runs were started with. */
  last: { readonly version: number; readonly overrideUsd: number } | undefined;

  seedAgent(
    workspaceId: string,
    agentId: string,
    ownerPrincipalId: string,
    versions: number,
  ): void {
    this.agents.set(`${workspaceId}:${agentId}`, { ownerPrincipalId, versions });
  }

  /** Marks the agent a built-in one, as the platform seeds them. */
  markBuiltin(workspaceId: string, agentId: string): void {
    const agent = this.agents.get(`${workspaceId}:${agentId}`);
    if (agent === undefined) throw new Error(`no agent ${agentId}`);
    agent.builtin = true;
  }

  evaluate: RunnerPort['evaluate'] = (ctx, agentId, version, cases) => {
    if (ctx.caller.kind === 'none') return Promise.resolve(NO_CALLER);
    if (!isUuid(agentId)) return Promise.resolve(INVALID_AGENT_ID);
    const agent = this.agents.get(`${ctx.workspaceId}:${agentId}`);
    if (agent === undefined) return Promise.resolve(refusalOf(agentNotFound()));
    if (
      !mayEvaluate(ctx.caller.principal, { id: agentId, ownerPrincipalId: agent.ownerPrincipalId })
    ) {
      return Promise.resolve(FORBIDDEN);
    }
    if (cases === undefined) {
      return Promise.resolve({ ok: false, code: 'invalid_body', message: 'No cases.' });
    }
    if (version > agent.versions) return Promise.resolve(refusalOf(agentVersionNotFound(version)));
    this.started += cases.length;
    this.last = { version, overrideUsd: BUILDER_DEFAULT_LIMITS.trialBudgetUsd };
    return Promise.resolve({
      ok: true,
      evaluation: {
        id: crypto.randomUUID(),
        agentId,
        version,
        passed: cases.length,
        total: cases.length,
        score: 1,
        results: cases.map(({ name }) => ({ name, passed: true, runId: null, failures: [] })),
        createdAt: new Date().toISOString(),
      },
    });
  };

  trial: RunnerPort['trial'] = (ctx, agentId, version, input, budgetUsd, idempotencyKey) => {
    if (ctx.caller.kind === 'none') return Promise.resolve(NO_CALLER);
    const { principal } = ctx.caller;
    const invalid = trialArgumentRefusal(agentId, input, budgetUsd, idempotencyKey);
    if (invalid !== null) return Promise.resolve(invalid);
    const agent = this.agents.get(`${ctx.workspaceId}:${agentId}`);
    if (agent === undefined) return Promise.resolve(refusalOf(agentNotFound()));
    const readOnly = refuseBuiltinWrite(
      agent.builtin === true ? { builtin: 'builder' } : null,
      'create-version',
    );
    if (readOnly !== null) return Promise.resolve(refusalOf(readOnly));
    const ownership = agent.ownerPrincipalId === principal.ownerPrincipalId ? 'own' : 'other';
    if (!mayRun(principal, { id: agentId }, ownership)) return Promise.resolve(FORBIDDEN_TO_RUN);
    if (!Number.isInteger(version) || version < 1 || version > agent.versions) {
      return Promise.resolve(refusalOf(agentVersionNotFound(version)));
    }
    const slot = `${ctx.workspaceId}:${principal.principalId}:${idempotencyKey.trim()}`;
    const hash = trialRequestHash(agentId, version, input, budgetUsd);
    const held = this.trials.get(slot);
    if (held !== undefined) {
      return Promise.resolve(
        held.hash === hash
          ? held.result
          : {
              ok: false,
              code: IDEMPOTENCY_CODES.conflict,
              message: 'This idempotency key was already used with a different trial.',
            },
      );
    }
    this.started += 1;
    this.last = { version, overrideUsd: cappedBudget(budgetUsd) };
    const result: TrialResult = {
      ok: true,
      runId: crypto.randomUUID(),
      status: 'completed',
      ...capOutput(this.answer),
      costUsd: 0,
    };
    this.trials.set(slot, { hash, result });
    return Promise.resolve(result);
  };
}
