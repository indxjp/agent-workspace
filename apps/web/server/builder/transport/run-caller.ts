import type { BuilderRefusalCode } from '@indx-workspace/contracts/builder';
import { isStoppedRunStatus } from '@indx-workspace/contracts/runs';
import type { RunTokenCodec } from '@agent-workspace/gateway/tokens';

import type { AgentRecord } from '../../agents/contract';
import { verifyActiveRunToken, type RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { DirectoryRoot } from '../../rbac/directory';
import type { Role } from '../../rbac/roles';

/** The run a verified token names, with no person behind it. Every field comes from the token. */
export interface RunIdentity {
  readonly kind: 'run';
  readonly workspaceId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
}

/** The person behind a run, as the `aw-control` tools see them: the token's run and their membership. */
export interface RunCallerPrincipal extends Omit<RunIdentity, 'kind'> {
  readonly kind: 'run-caller';
  readonly principalId: string;
  readonly userId: string;
  readonly role: Role;
}

/**
 * `reads: true` is a verified Builder run with no person behind it: read tools may still run for
 * it, as `run`. Every token failure is `reads: false` and names no run.
 */
export type RunCallerRefusal =
  | {
      readonly ok: false;
      readonly code: Extract<
        BuilderRefusalCode,
        'not_permitted' | 'not_allowed_to_build' | 'no_caller'
      >;
      readonly reads: false;
    }
  | {
      readonly ok: false;
      readonly code: Extract<BuilderRefusalCode, 'no_caller'>;
      readonly reads: true;
      readonly run: RunIdentity;
    };

export interface RunCallerDeps<Scope> {
  readonly tokens: RunTokenCodec;
  readonly database: RunTokenDatabase<Scope>;
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  /** Where the run's agent is read: a run of an agent the workspace no longer has is refused. */
  readonly agents: {
    forWorkspace(workspaceId: string): {
      get(id: string): Promise<Pick<AgentRecord, 'builtin'> | null>;
    };
  };
}

const refuse = (code: RunCallerRefusal['code']): RunCallerRefusal => ({
  ok: false,
  code,
  reads: false,
});

/**
 * Turn a run token into the person it acts for (design §04 "Acting as the caller"). Workspace and
 * person come only from the signed claims; any failure is a refusal, never a default role.
 */
export async function verifyRunCaller<Scope>(
  authorization: string | null,
  deps: RunCallerDeps<Scope>,
): Promise<{ readonly ok: true; readonly caller: RunCallerPrincipal } | RunCallerRefusal> {
  try {
    const active = await verifyActiveRunToken(authorization, deps.tokens, deps.database);
    if (active === null || isStoppedRunStatus(active.run.status)) {
      return refuse('not_permitted');
    }
    const { claims } = active;
    const run: RunIdentity = {
      kind: 'run',
      workspaceId: claims.workspaceId,
      runId: claims.runId,
      sessionId: claims.sessionId,
      agentId: claims.agentId,
    };
    const readsOnly: RunCallerRefusal = { ok: false, code: 'no_caller', reads: true, run };
    // Any agent's run may knock; who it is, and what it may do, is decided downstream from the agent row.
    const agent = await deps.agents.forWorkspace(claims.workspaceId).get(claims.agentId);
    if (agent === null) return refuse('not_allowed_to_build');
    const caller = claims.caller;
    if (caller === undefined) return readsOnly;
    // ponytail: api-key callers stay read-only until the token names the key that started the run.
    if (caller.principalKind === 'api-key') return readsOnly;
    if (caller.principalKind !== 'membership') return refuse('no_caller');
    // ponytail: scans the member list; swap for a by-principal lookup if the port grows one.
    const members = await deps.directory.forWorkspace(claims.workspaceId).listMemberships();
    const member = members.find((candidate) => candidate.principalId === caller.sub);
    if (member === undefined) return refuse('no_caller');
    return {
      ok: true,
      caller: {
        ...run,
        kind: 'run-caller',
        principalId: member.principalId,
        userId: member.userId,
        role: member.role,
      },
    };
  } catch {
    return refuse('not_permitted');
  }
}
