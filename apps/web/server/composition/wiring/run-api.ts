/**
 * The run API (`ApplicationContext.runs`) and the five domains that exist only with a run runtime:
 * the A2A and tool endpoints, `POST /api/tokens`, the triggers and the public surfaces. Built after
 * `wireRunRuntime` answers a runtime; with none, every one of them is `disabled` (503 by name).
 */
import { log } from '../../telemetry/logger';
import { createJsonLogger } from '@agent-workspace/core/telemetry';

import { engineOfVersion } from '../../agent-versions/session-version';
import type { ApplicationContext } from '../../application-context';
import { engineForStoredPolicy } from '../../engines/session-engine';
import { createModelJudge } from '../../evaluations/handlers';
import { createProjectRunGate } from '../../projects/archive-gate';
import { ownerPrincipalIdOf } from '../../rbac/owner-principal';
import type { AgentRef, RunApiEnvironment, RunPrincipal, SessionRef } from '../../runs/environment';
import { signalLiveRun } from '../../runs/interrupt';
import { admitSurfaceVisitorWrite } from '../../surfaces/public/limits';
import { dailyCostCapEnvironment } from '../../usage/daily-cost';
import type { AgentsWiring } from './agents';
import { wireEndpoints } from './endpoints';
import { createCompositionRunLauncher } from './run-launcher';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring, wireRunRuntime } from './run-runtime';
import { wireRuntimeResolver, type RuntimeResolverWiring } from './runtime-resolver';
import type { SubsystemsWiring } from './subsystems';
import { createTokensRuntime, wireSurfaces } from './tokens-surfaces';
import { wireTriggers } from './triggers';

/** Everything the composition root has wired before the run domains. */
type RunDomainsWiring = AgentsWiring &
  SubsystemsWiring &
  RunResourcesWiring &
  RunRuntimeWiring &
  Pick<Parameters<typeof wireRunRuntime>[0], 'root' | 'policyCeiling' | 'stopOnClose'>;

/** The context fields that need a run runtime. */
export type RunDomains = Pick<
  ApplicationContext,
  'a2a' | 'runs' | 'surfaces' | 'tokens' | 'toolEndpoint' | 'triggers'
>;

/** A deployment with no run runtime: each of these routes answers its own named 503. */
export const RUN_DOMAINS_DISABLED: RunDomains = {
  a2a: { kind: 'disabled' },
  runs: { kind: 'disabled' },
  surfaces: { kind: 'disabled' },
  tokens: { kind: 'disabled' },
  toolEndpoint: { kind: 'disabled' },
  triggers: { kind: 'disabled' },
};

/** Build the run domains, all serving. Starts the trigger schedule driver. */
export function wireRunDomains(wired: RunDomainsWiring): RunDomains {
  const resolver = wireRuntimeResolver(wired);
  const triggers = wireTriggers(wired.root, wired.secretsService, {
    cronSecret: process.env['CRON_SECRET'],
    log,
    stopOnClose: wired.stopOnClose,
  });
  const { evaluationsOf, a2a, toolEndpoint } = wireEndpoints(wired);
  const tokens = createTokensRuntime(wired);
  const surfaces = wireSurfaces({ ...wired, tokens });
  const environment = wireRunApi({ ...wired, ...resolver, evaluationsOf });
  const { runtime } = wired;
  log.info(
    `[compose] run API installed: agent runtime profiles select registered launch targets; ` +
      (runtime.ok
        ? `local relays through ${runtime.settings.runnerUrl} (spec §14.3)`
        : `no "local" target ("${runtime.reason}"); the runner manager provides the rest`),
  );
  return {
    a2a: { kind: 'serving', environment: a2a },
    runs: { kind: 'serving', environment },
    surfaces: { kind: 'serving', runtime: surfaces },
    tokens: { kind: 'serving', runtime: tokens },
    toolEndpoint: { kind: 'serving', environment: toolEndpoint },
    triggers: { kind: 'serving', runtime: triggers },
  };
}

/** The run API environment every run route reads from `ApplicationContext.runs`. */
export function wireRunApi(
  wired: RunDomainsWiring &
    RuntimeResolverWiring &
    Pick<ReturnType<typeof wireEndpoints>, 'evaluationsOf'>,
): RunApiEnvironment {
  const {
    root,
    scopes,
    agents,
    sessionRows,
    runGate,
    identify,
    withCeiling,
    policyCeiling,
    modelsApi,
    pinnedVersionFor,
    launchRef,
    readRunAgent,
    runs,
    runPreflight,
    sessionPin,
    runStartPreflight,
    evaluationsOf,
  } = wired;
  // Issue #235 (S-14): the interrupt route reuses exactly this revocation, so it is a function
  // rather than duplicated inline in both `revokeRunTokens` and `interruptRun` below.
  //
  // Issue #236 (SDK-04, S-1): every credential that reaches this run dies here, not just the
  // gateway's. §3.1 lists explicit revocation as one of three conditions that end a browser
  // token's life, alongside expiry and the run going terminal — and without this call that third
  // condition has no production caller at all, so an operator revoking a run's credentials
  // *before* any terminal transition leaves an `awt_live_…` token scoped to it still valid. The
  // browser-token count is deliberately not folded into `revoked`: that number is the run-token
  // outcome the route reports, and §34's response shape is about gateway tokens.
  const revokeAllRunTokensFor = async (
    principal: RunPrincipal,
    runId: string,
  ): Promise<{ readonly revoked: number; readonly outcome: string }> => {
    const scope = await scopes.forWorkspaceId(principal.workspaceId);
    if (scope === null) return { revoked: 0, outcome: 'not-found' };
    const repository = root.runTokens.forScope(scope);
    const revoked = await repository.revokeForRun(runId);
    await root.browserTokens.forScope(scope).revokeForRun(runId);
    return { revoked, outcome: revoked > 0 ? 'revoked' : 'already-revoked' };
  };
  const withDailyCostCap = dailyCostCapEnvironment(policyCeiling?.maxCostPerDayUsd, {
    now: () => new Date(),
    sumCostUsd: async (workspaceId, from, to) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null)
        throw new Error(`daily cost cap: workspace ${workspaceId} did not resolve`);
      return root.runs.forScope(scope).usageCostUsd(from, to);
    },
  });
  return {
    ...withCeiling,
    ...withDailyCostCap,
    store: runs,
    authenticate: async (request: Request): Promise<RunPrincipal | null> => identify(request),
    revokeRunTokens: async (principal, runId, tokenId) => {
      if (tokenId === null) return revokeAllRunTokensFor(principal, runId);
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return { revoked: 0, outcome: 'not-found' };
      const repository = root.runTokens.forScope(scope);
      const outcome = await repository.revoke(tokenId, runId);
      return { revoked: outcome === 'revoked' ? 1 : 0, outcome };
    },
    // Issue #235 (S-14): the control-plane transition is the security boundary (this file's own
    // `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`) — write the
    // terminal `cancelled` status and revoke this run's tokens BEFORE the best-effort runtime
    // signal, so a caller never sees success for a run whose credential is still live. Ordered the
    // same way `launcher.ts`'s own credential-lifetime timer already reads it.
    interruptRun: async (principal, run) => {
      await runs.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
      await revokeAllRunTokensFor(principal, run.id);
      await signalLiveRun(run.id, globalThis.fetch);
    },
    // Issue #539 (S2-05c, C19): one row per rating; the handler has already authorised the call.
    recordRunFeedback: async (principal, run, { rating, comment }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      await root.runFeedback
        .forScope(scope)
        .record({ runId: run.id, rating, comment: comment ?? null });
    },
    // Issue #620: the handler has authorised the call and decided the owner filter.
    // ponytail: one event read per row (at most 50); store the answer on the run if it gets slow.
    listAgentFeedback: async (principal, { agentId, ...filter }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      if ((await agents.forWorkspace(principal.workspaceId).get(agentId)) === null) return null;
      const events = root.runEvents.forScope(scope);
      const rows = await root.runFeedback.forScope(scope).listForAgent({ agentId, ...filter });
      return Promise.all(
        rows.map(async ({ prompt, ...row }) => ({
          ...row,
          input: prompt,
          events: await events.list(row.runId, null),
        })),
      );
    },
    // Issue #622 (#606): a surface visitor's turns and ratings are rate-limited and capped.
    admitVisitorWrite: admitSurfaceVisitorWrite,
    // Issue #618: one row per evaluation; the handler has already authorised it and run its cases.
    recordEvaluation: async (principal, evaluation) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`evaluation: workspace ${principal.workspaceId} did not resolve`);
      }
      return root.agentVersionEvaluations.forScope(scope).record({
        ...evaluation,
        createdByPrincipalId: principal.principalId,
      });
    },
    // Issue #799: an evaluation run's rows; every call opens this workspace's repository.
    evaluationRuns: {
      start: async (principal, run) =>
        (await evaluationsOf(principal.workspaceId)).start({
          ...run,
          createdByPrincipalId: principal.principalId,
        }),
      find: async (principal, id) => (await evaluationsOf(principal.workspaceId)).find(id),
      claim: async (principal, id, leaseMs) =>
        (await evaluationsOf(principal.workspaceId)).claim(id, leaseMs),
      progress: async (principal, id, progress) =>
        (await evaluationsOf(principal.workspaceId)).progress(id, progress),
    },
    judgeEvaluationCase: createModelJudge({
      // Judged by version n's model connection, like its runs, not by `local`'s row.
      resolveModel: async ({ agentVersionId, ...query }) =>
        runPreflight.resolveModel({
          ...query,
          agent: (await readRunAgent(query.workspaceId, query.agentId, agentVersionId)).agent,
        }),
      connection: async (workspaceId, connectionId) =>
        (await modelsApi?.models.forWorkspace(workspaceId)?.resolve(connectionId)) ?? null,
    }),
    describeRunTarget: (workspaceId, agentId) => runPreflight.describe(workspaceId, agentId),
    preflight: runStartPreflight,
    findAgentVersion: async (principal, agentId, number) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      return scope === null ? null : root.agentVersions.forScope(scope).find(agentId, number);
    },
    findAgent: async (
      principal: RunPrincipal,
      agentId: string,
      sessionId: string | null = null,
    ): Promise<AgentRef | null> => {
      // Issue #119: "Archived workspaces … are excluded from new run/session creation." Checked
      // before the agent lookup, so an archived workspace answers the same `agent_not_found` a
      // caller in no workspace at all would see — archiving does not disclose anything about the
      // agent that a non-member's request would not already fail to see (§25).
      if (!(await runGate.isUsable(principal.workspaceId))) return null;
      const agent = await agents.forWorkspace(principal.workspaceId).get(agentId);
      // The store is already scoped to the workspace, so an agent it returns is this principal's
      // by construction. The id is echoed from the record rather than from the path.
      if (agent === null) return null;
      // Issue #612: a follow-up in a pinned conversation runs its version's engine, not the row's
      // a push moved.
      const pin = await sessionPin(principal.workspaceId, agent.id, sessionId);
      const scope = pin === null ? null : await scopes.forWorkspaceId(principal.workspaceId);
      const version =
        scope === null || pin === null
          ? null
          : await root.agentVersions.forScope(scope).findById(pin);
      return {
        id: agent.id,
        workspaceId: principal.workspaceId,
        // ADR-0065: the agent's own engine, which `startRun` compares against the session's
        // pin. A NULL policy column reads as the compiled policy's arm, not as "unknown".
        engine: version === null ? engineForStoredPolicy(agent.policy) : engineOfVersion(version),
        ...(agent.archivedAt === undefined ? {} : { archived: true as const }),
      };
    },
    openSession: async (
      principal: RunPrincipal,
      agent: AgentRef,
      requested: string | null,
      agentVersionId?: string,
    ): Promise<SessionRef | null> => {
      // Defence in depth for a caller that reaches `openSession` some other way than the one
      // `findAgent`-then-`openSession` path this composition root wires today (issue #119).
      if (!(await runGate.isUsable(principal.workspaceId))) return null;
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return null;
      const sessions = sessionRows.forScope(scope);
      if (requested !== null) {
        const existing = await sessions.get(requested);
        if (
          existing === null ||
          existing.agentId !== agent.id ||
          existing.ownerPrincipalId !== ownerPrincipalIdOf(principal) ||
          existing.status !== 'active'
        ) {
          return null;
        }
        // Issue #183: `openSession` is always followed by a run being created (`startRun` in
        // `../runs/api.ts`), so resuming a session that lives in an archived project is a NEW run
        // in an archived project. `null` here is what `startRun` already turns into
        // `409 session_not_usable`, the same answer a session that is not the caller's produces —
        // so archiving discloses nothing a non-owner's request would not already fail to see.
        // The session itself is untouched: a run started before the archive still finishes.
        if (
          !(await createProjectRunGate(root.projects.forScope(scope)).isUsableForNewWork(
            existing.projectId,
          ))
        ) {
          return null;
        }
        return launchRef(scope, existing);
      }
      // The row must exist before `runs` can reference it: `runs_session_workspace_fk` is what
      // makes a run's workspace and its session's workspace the same value (spec §25). Wave 1
      // minted this id and stored nothing, which a `Map` did not mind and a foreign key does.
      const outcome = await sessions.ensure({
        id: crypto.randomUUID(),
        agentId: agent.id,
        ownerPrincipalId: ownerPrincipalIdOf(principal),
        userId: principal.userId,
        agentVersionId: agentVersionId ?? (await pinnedVersionFor(scope, agent.id)),
      });
      if (outcome.kind === 'created' || outcome.kind === 'existing') {
        return launchRef(scope, outcome.session);
      }
      // The explicit else. `unknown-agent` and `not-a-member` are real, different states — an
      // agent deleted between `findAgent` and here, a membership revoked mid-request — and the
      // route turns `null` into a 409. Logged by name so the 409 is diagnosable, because the
      // message the route prints is about `sessionId` and would be misleading on its own.
      log.error(
        `[compose] no session could be opened for agent ${agent.id}: ${outcome.kind}. The run route will answer 409.`,
      );
      return null;
    },
    discardSession: async (principal: RunPrincipal, sessionId: string) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope !== null) await sessionRows.forScope(scope).discardIfUnused(sessionId);
    },
    ownsRun: async (principal: RunPrincipal, run) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return false;
      const session = await sessionRows.forScope(scope).get(run.sessionId);
      return session?.ownerPrincipalId === ownerPrincipalIdOf(principal);
    },
    logger: createJsonLogger({ service: 'web' }),
    launch: createCompositionRunLauncher({ ...wired, revokeAllRunTokensFor }),
  };
}
