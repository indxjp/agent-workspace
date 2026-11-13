import { randomUUID } from 'node:crypto';

import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import { randomIds, type IdGenerator } from '../ids';
import { Principal } from '../rbac/principal';
import { TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { AgentRef, LaunchContext, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { TriggerRecord, TriggersRuntime } from './runtime';
import { triggerRepository } from './triggers.repository.test-support';

export interface TriggerTestState {
  readonly rows: Map<string, TriggerRecord>;
  readonly hashes: Map<string, string>;
  readonly deliveries: Map<string, string | null>;
  readonly zoomTokens: Map<string, string>;
  readonly agentOwners: Map<string, string>;
  readonly revoked: Set<string>;
  readonly store: InMemoryRunStore;
  readonly launches: LaunchContext[];
  recentDeliveries: number | null;
  unfinishedRuns: number;
  refuseStart: boolean;
  agentGone: boolean;
  agentEngine: string;
  failRecordRun: boolean;
  /** The run start throws (a database error), and so does freeing the claim when `failRelease`. */
  failStart: boolean;
  failRelease: boolean;
  /** The runtime's id generator; `null` leaves it to the production default. */
  ids: IdGenerator | null;
}

function createTriggerState(): TriggerTestState {
  return {
    rows: new Map(),
    hashes: new Map(),
    deliveries: new Map(),
    zoomTokens: new Map(),
    agentOwners: new Map(),
    revoked: new Set(),
    store: new InMemoryRunStore(),
    launches: [],
    recentDeliveries: null,
    unfinishedRuns: 0,
    refuseStart: false,
    agentGone: false,
    agentEngine: 'claude-agent-sdk',
    failRecordRun: false,
    failStart: false,
    failRelease: false,
    ids: null,
  };
}

/** The workspace member behind `principalId` as a principal, or `null` when revoked or gone. */
async function memberPrincipal(
  state: TriggerTestState,
  harness: RbacHarness,
  workspaceId: string,
  principalId: string,
): Promise<Principal | null> {
  if (state.revoked.has(principalId)) return null;
  const memberships = await harness.directory.forWorkspace(workspaceId).listMemberships();
  const member = memberships.find((m) => m.principalId === principalId);
  if (member === undefined) return null;
  return Principal.fromDirectoryRecord({
    principalId,
    kind: 'membership',
    workspaceId,
    role: member.role,
    label: member.name,
    userId: member.userId,
    apiKeyId: null,
    actsForPrincipalId: null,
  });
}

function zoomTokenStore(state: TriggerTestState): NonNullable<TriggersRuntime['zoomTokens']> {
  return {
    configured: (_ws, ids) =>
      Promise.resolve(new Set(ids.filter((id) => state.zoomTokens.has(id)))),
    set: (_ws, id, token) => {
      state.zoomTokens.set(id, token);
      return Promise.resolve();
    },
    clear: (_ws, id) => {
      state.zoomTokens.delete(id);
      return Promise.resolve();
    },
    read: (_ws, id) => Promise.resolve(state.zoomTokens.get(id) ?? null),
  };
}

function triggerRuntime(state: TriggerTestState, harness: RbacHarness): TriggersRuntime {
  const repo = triggerRepository(state);
  return {
    repository: () => Promise.resolve(repo),
    findForIngress: (id) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve({ trigger: row, secretHash: state.hashes.get(id) ?? null });
    },
    owner: (workspaceId, principalId) => memberPrincipal(state, harness, workspaceId, principalId),
    agentOwnership: (principal, agentId) => {
      const owner = state.agentOwners.get(agentId);
      if (owner === undefined) return Promise.resolve('unknown');
      return Promise.resolve(owner === principal.ownerPrincipalId ? 'own' : 'other');
    },
    zoomTokens: zoomTokenStore(state),
    now: () => new Date(),
    ids: { newId: () => (state.ids ?? randomIds).newId() },
  };
}

const PROFILE_MISSING = {
  code: 'agent_runtime_profile_missing',
  message: 'the agent has no runtime profile.',
} as const;

/** The run start's preflight: throws, refuses or passes as the state says. */
function preflight(
  state: TriggerTestState,
): ReturnType<NonNullable<RunApiEnvironment['preflight']>> {
  if (state.failStart) return Promise.reject(new Error('start unavailable'));
  return Promise.resolve(state.refuseStart ? PROFILE_MISSING : null);
}

function runEnvironment(state: TriggerTestState): RunApiEnvironment {
  return {
    authenticate: () => Promise.reject(new Error('the fire route does not authenticate')),
    findAgent: (_principal, agentId): Promise<AgentRef | null> =>
      Promise.resolve(
        state.agentOwners.has(agentId) && !state.agentGone
          ? { id: agentId, workspaceId: TEST_WORKSPACE_ID, engine: state.agentEngine }
          : null,
      ),
    openSession: (_principal, agent) =>
      Promise.resolve({ id: randomUUID(), agentId: agent.id, engine: null }),
    discardSession: () => Promise.resolve(),
    ownsRun: () => Promise.resolve(true),
    preflight: () => preflight(state),
    store: state.store,
    launch: (context) => {
      state.launches.push(context);
    },
  };
}

export function installTriggerFakes(harness: RbacHarness): TriggerTestState {
  const state = createTriggerState();
  installTestDomains({ triggers: { kind: 'serving', runtime: triggerRuntime(state, harness) } });
  installTestRunApi(runEnvironment(state));
  return state;
}
