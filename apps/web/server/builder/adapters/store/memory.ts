import crypto from 'node:crypto';

import type { AgentVersionVia } from '@indx-workspace/contracts/agent-versions';
import type { BuiltinAgentKey } from '@indx-workspace/contracts/agents';

import { AgentCreatedByAgentSchema } from '@indx-workspace/contracts/agents';
import { AgentCreatedAuditDetailsSchema } from '@indx-workspace/contracts/observability';

import type { AgentStorePort } from '../../ports';
import { refuseBuiltinWrite } from '../../../agents/handlers';
import type { ActorLabel } from '../actor-label';
import { mayCheck, mayRead } from '../checker/access';
import { failureOf } from '../checker/production';
import {
  failedCheck,
  FORBIDDEN,
  LINEAGE_REFUSED,
  NO_CALLER,
  QUOTA_EXCEEDED,
} from '../checker/failure';
import type { AgentState, AuditEventRow } from '../../testing/views';

type Agent = {
  readonly ownerPrincipalId: string;
  readonly versions: { number: number; via: AgentVersionVia; createdByPrincipalId: string }[];
  local: number | null;
  production: number | null;
  builtin?: BuiltinAgentKey;
};

/** Saves as the production adapter does for the rules the contract suite exercises. */
// ponytail: the draft is never run through the version pipeline; the production adapter does that.
export class MemoryAgentStore implements AgentStorePort {
  /** Keyed by `${workspaceId}:${agentId}`, so one workspace never reaches another's agent. */
  private readonly agents = new Map<string, Agent>();
  private readonly events: {
    readonly workspaceId: string;
    readonly createdAt: Date;
    readonly event: AuditEventRow;
  }[] = [];

  constructor(
    private readonly actorLabel: ActorLabel = (_workspaceId, id) => Promise.resolve(id),
    private readonly now: () => Date = () => new Date(),
  ) {}

  creationsSince: AgentStorePort['creationsSince'] = (ctx, since) =>
    Promise.resolve(
      this.events.filter((row) => row.workspaceId === ctx.workspaceId && row.createdAt >= since)
        .length,
    );

  localVersion: AgentStorePort['localVersion'] = (ctx, agentId) => {
    const agent = this.agents.get(`${ctx.workspaceId}:${agentId}`);
    if (ctx.caller.kind === 'none' || agent === undefined) return Promise.resolve(null);
    const readable = mayRead(ctx.caller.principal, {
      id: agentId,
      ownerPrincipalId: agent.ownerPrincipalId,
    });
    return Promise.resolve(readable ? agent.local : null);
  };

  save: AgentStorePort['save'] = async (ctx, req) => {
    if (ctx.caller.kind === 'none') return NO_CALLER;
    const { principal } = ctx.caller;
    const existing =
      req.agentId === undefined ? undefined : this.agents.get(`${ctx.workspaceId}:${req.agentId}`);
    if (req.agentId !== undefined && existing === undefined) {
      return failedCheck('agent_not_found', 'This workspace has no agent with that id.', []);
    }
    const readOnly = refuseBuiltinWrite(existing ?? null, 'create-version');
    const refusal = readOnly === null ? null : failureOf(readOnly);
    if (refusal !== null) return refusal;
    const target =
      req.agentId === undefined || existing === undefined
        ? undefined
        : { id: req.agentId, ownerPrincipalId: existing.ownerPrincipalId };
    if (!mayCheck(principal, target)) return FORBIDDEN;
    // ponytail: the lineage is validated as production does, but not kept; PostgreSQL holds it.
    if (
      req.agentId === undefined &&
      req.createdByAgent !== undefined &&
      !AgentCreatedByAgentSchema.safeParse({ ...req.createdByAgent, runId: ctx.runId }).success
    ) {
      return LINEAGE_REFUSED;
    }
    if (
      req.agentId === undefined &&
      req.quota !== undefined &&
      (await this.creationsSince(ctx, req.quota.since)) >= req.quota.limit
    ) {
      return QUOTA_EXCEEDED;
    }

    const actorLabel = await this.actorLabel(ctx.workspaceId, principal.principalId);
    const agentId = req.agentId ?? crypto.randomUUID();
    const agent: Agent = existing ?? {
      ownerPrincipalId: principal.ownerPrincipalId,
      versions: [],
      local: null,
      production: null,
    };
    const version = agent.versions.length + 1;
    // Built and parsed before any write, so a refused row leaves nothing behind.
    const created =
      req.agentId === undefined
        ? {
            workspaceId: ctx.workspaceId,
            createdAt: this.now(),
            event: {
              action: 'agent-created',
              subjectId: agentId,
              subjectLabel: req.body.definition.agent.name,
              actorPrincipalId: principal.principalId,
              actorUserId: principal.userId,
              actorLabel,
              details: AgentCreatedAuditDetailsSchema.parse({
                agentId,
                version,
                via: 'builder',
                builderRunId: ctx.runId,
              }),
            },
          }
        : null;
    this.agents.set(`${ctx.workspaceId}:${agentId}`, agent);
    agent.versions.push({
      number: version,
      via: 'builder',
      createdByPrincipalId: principal.principalId,
    });
    if (req.agentId !== undefined && agent.local !== req.baseVersion) {
      return { ok: false, code: 'pointer_moved', current: agent.local };
    }
    agent.local = version;
    // The same call writes the agent-created row, as the production store's one transaction does.
    if (created !== null) this.events.push(created);
    return { ok: true, agentId, version };
  };

  agentCount(workspaceId: string): number {
    return [...this.agents.keys()].filter((key) => key.startsWith(`${workspaceId}:`)).length;
  }

  auditEvents(workspaceId: string): AuditEventRow[] {
    return this.events.filter((row) => row.workspaceId === workspaceId).map((row) => row.event);
  }

  inspect(workspaceId: string, agentId: string): AgentState {
    const agent = this.agents.get(`${workspaceId}:${agentId}`);
    if (agent === undefined) throw new Error(`no agent ${agentId}`);
    return { versions: [...agent.versions], local: agent.local, production: agent.production };
  }

  /** Marks the agent a built-in one, as the platform seeds them. */
  markBuiltin(workspaceId: string, agentId: string): void {
    const agent = this.agents.get(`${workspaceId}:${agentId}`);
    if (agent === undefined) throw new Error(`no agent ${agentId}`);
    agent.builtin = 'builder';
  }

  seedProduction(workspaceId: string, agentId: string, version: number): void {
    const agent = this.agents.get(`${workspaceId}:${agentId}`);
    if (agent === undefined) throw new Error(`no agent ${agentId}`);
    agent.production = version;
  }
}
