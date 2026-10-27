import { AgentCreatedByAgentSchema } from '@indx-workspace/contracts/agents';
import {
  AgentVersionResourceSchema,
  CreateAgentFromVersionResponseSchema,
} from '@indx-workspace/contracts/agent-versions';

import { createAgentFromVersion } from '../../../agent-versions/create-from-version';
import { BUILDER_ORIGIN, createAgentVersion } from '../../../agent-versions/handlers';
import { setAgentPointer } from '../../../agent-versions/pointers';
import { agentNotFound, refuseBuiltinWrite } from '../../../agents/handlers';
import type { ApiResult } from '../../../http/result';
import type { AgentStorePort, SaveResult } from '../../ports';
import type { ActorLabel } from '../actor-label';
import { mayCheck, mayRead } from '../checker/access';
import { FORBIDDEN, LINEAGE_REFUSED, NO_CALLER, QUOTA_EXCEEDED } from '../checker/failure';
import { failureOf, type CheckerDependencies } from '../checker/production';

export interface AgentStoreDependencies extends CheckerDependencies {
  readonly actorLabel: ActorLabel;
}

const DEFAULT_SUMMARY = 'Saved by the Builder';

function refused(result: ApiResult): SaveResult {
  const failed = failureOf(result);
  if (failed?.code === QUOTA_EXCEEDED.code) return QUOTA_EXCEEDED;
  if (failed !== null) return failed;
  throw new Error(`The version pipeline answered ${String(result.status)} to a Builder save.`);
}

/** Where `local` is now, from the `current:<n|none>` line of a `pointer_moved` problem. */
function movedTo(result: ApiResult): number | null | undefined {
  const failed = failureOf(result);
  if (failed?.code !== 'pointer_moved') return undefined;
  const current = failed.details.find((line) => line.startsWith('current:'))?.slice(8);
  return current === undefined || current === 'none' ? null : Number(current);
}

/**
 * `AgentStorePort` over the console's own handlers: a new agent is `createAgentFromVersion`, a new
 * version is `createAgentVersion` and then a compare-and-set `setAgentPointer` on `local`, as
 * `saveUiEdit` does. `production` is never named here.
 */
// ponytail: create then point is two transactions, so a refused point leaves an unpointed version
// by design (builder design §08 Data rule 2). One transaction needs a store method that does both.
export function createAgentStore(deps: AgentStoreDependencies): AgentStorePort {
  async function versionStore(workspaceId: string) {
    const store = await deps.versions.forWorkspace(workspaceId);
    if (store === null) {
      throw new Error('The version store does not resolve a workspace RBAC verified.');
    }
    return store;
  }

  return {
    async localVersion(ctx, agentId) {
      // The console's `GET /api/agents/:id/versions` answers a person who may read the agent, no one else.
      if (ctx.caller.kind === 'none') return null;
      const agent = await deps.agents.forWorkspace(ctx.workspaceId).get(agentId);
      if (agent === null || !mayRead(ctx.caller.principal, agent)) return null;
      const listing = await (await versionStore(ctx.workspaceId)).list(agentId);
      return listing?.pointers.find((pointer) => pointer.environment === 'local')?.number ?? null;
    },

    async creationsSince(ctx, since) {
      return (await versionStore(ctx.workspaceId)).agentsCreatedSince(since);
    },

    async save(ctx, req) {
      if (ctx.caller.kind === 'none') return NO_CALLER;
      const { principal } = ctx.caller;
      const store = await versionStore(ctx.workspaceId);
      const agents = deps.agents.forWorkspace(ctx.workspaceId);
      const pipeline = deps.pipeline(ctx);
      // The draft schema wants a client `via`; the origin replaces it, so a request never carries 'builder'.
      const draft = {
        body: req.body,
        summary: req.summary ?? DEFAULT_SUMMARY,
        via: 'api',
      } as const;
      const actor = await deps.actorLabel(ctx.workspaceId, principal.principalId);

      if (req.agentId === undefined) {
        if (!mayCheck(principal, undefined)) return FORBIDDEN;
        // The run id is the only part of the lineage that can be too long; refuse before any write.
        const lineage =
          req.createdByAgent === undefined
            ? undefined
            : AgentCreatedByAgentSchema.safeParse({ ...req.createdByAgent, runId: ctx.runId });
        if (lineage?.success === false) return LINEAGE_REFUSED;
        const created = await createAgentFromVersion(
          { version: draft },
          {
            principalId: principal.principalId,
            ownerPrincipalId: principal.ownerPrincipalId,
            userId: principal.userId,
            actorLabel: actor,
            ...(req.createdByAgent === undefined
              ? {}
              : { createdByAgent: { ...req.createdByAgent, runId: ctx.runId } }),
          },
          { ...pipeline, store, agents },
          {
            ...BUILDER_ORIGIN,
            builderRunId: ctx.runId,
            ...(req.quota === undefined ? {} : { quota: req.quota }),
          },
        );
        if (created.status !== 201) return refused(created);
        const { agent, version } = CreateAgentFromVersionResponseSchema.parse(created.body);
        return { ok: true, agentId: agent.id, version: version.number };
      }

      const agent = await agents.get(req.agentId);
      if (agent === null) return refused(agentNotFound());
      // The console route refuses a built-in agent before RBAC; a Builder save does too.
      const readOnly = refuseBuiltinWrite(agent, 'create-version');
      if (readOnly !== null) return refused(readOnly);
      if (!mayCheck(principal, agent)) return FORBIDDEN;
      const created = await createAgentVersion(
        draft,
        agent,
        principal.principalId,
        { ...pipeline, store },
        undefined,
        BUILDER_ORIGIN,
      );
      if (created.status !== 201) return refused(created);
      const { number } = AgentVersionResourceSchema.parse(created.body);
      const pointed = await setAgentPointer(
        { environment: 'local', version: number, expectedVersion: req.baseVersion },
        agent,
        { principalId: principal.principalId, userId: principal.userId, actor },
        { ...pipeline, store },
      );
      if (pointed.status === 200) return { ok: true, agentId: agent.id, version: number };
      const current = movedTo(pointed);
      return current === undefined
        ? refused(pointed)
        : { ok: false, code: 'pointer_moved', current };
    },
  };
}
