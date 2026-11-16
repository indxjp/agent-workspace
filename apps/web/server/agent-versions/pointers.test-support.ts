/**
 * Shared setup for the `pointers.*.test.ts` suites: `setAgentPointer` (S1-06, issue #444) on the
 * memory stores, an agent with saved versions, and the dependency shapes the moves are run with.
 */
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import type { AgentRecord } from '../agents/contract';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { WorkspaceAgentStore } from '../agents/store';
import { FIXTURE_PERMISSIONS, versionRequest, type FixtureEdits } from './fixtures';
import { createAgentVersion } from './handlers';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from './memory-store';
import { OWNER, WORKSPACE } from './pipeline.test-support';
import { setAgentPointer, type PointerActor } from './pointers';
import type { WorkspaceAgentVersionStore } from './store';
import type { RequestCeiling } from '../policy-ceiling/ceiling';

export const ACTOR: PointerActor = { principalId: OWNER, userId: null, actor: 'builder key' };

export interface Harness {
  readonly agents: WorkspaceAgentStore;
  readonly provider: InMemoryAgentVersionStoreProvider;
  readonly store: WorkspaceAgentVersionStore;
  createAgent(name: string): Promise<AgentRecord>;
  save(agent: AgentRecord, edits?: FixtureEdits): Promise<void>;
  current(agentId: string): Promise<AgentRecord>;
  /** Archives the agent in the store, as a sweep committing behind a handler's earlier read. */
  archive(agentId: string): void;
}

/** A bundle lookup that holds every digest: it reports none missing. */
export const everyBundleStored = (): Promise<readonly string[]> => Promise.resolve([]);

export const DIGEST_A = 'a'.repeat(64);
export const DIGEST_B = 'b'.repeat(64);

/** The connector and the full bundle entry a code-tool version pins (ADR-0118 TS1, TS4). */
export function codeToolEdits(digest: string, instructions: string): FixtureEdits {
  return {
    instructions,
    resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
    toolBundles: [
      { tool: 'lookup', digest, description: 'Look a ticket up.', inputSchema: { type: 'object' } },
    ],
  };
}

/** A ceiling that sets only the promotion bar (issue #619). */
export function barOf(minEvalScore: number): RequestCeiling {
  return {
    policy: { promotion: { minEvalScore } },
    deploymentDefaultModel: () => Promise.resolve(null),
    connectorNames: () => Promise.resolve([]),
    recordRefusal: () => Promise.resolve(),
  };
}

export async function harness(): Promise<Harness> {
  const agentProvider = createInMemoryAgentStoreProvider();
  const agents = agentProvider.forWorkspace(WORKSPACE);
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    references: {
      [WORKSPACE]: {
        connector: [
          { id: 'c1', name: 'tickets' },
          { id: 'c2', name: AW_DEV_TOOLS_CONNECTOR },
          { id: 'c3', name: 'filesystem', stdio: true },
          { id: 'c4', name: 'git', stdio: true },
        ],
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const current = async (agentId: string): Promise<AgentRecord> => {
    const row = await agents.get(agentId);
    if (row === null) throw new Error(`agent ${agentId} exists`);
    return row;
  };
  return {
    agents,
    provider,
    store,
    async createAgent(name) {
      const created = await agents.create(
        {
          name,
          instructions: 'Before any version.',
          modelConnectionId: null,
          model: null,
          permissions: FIXTURE_PERMISSIONS,
        },
        { principalId: OWNER, userId: null },
      );
      if (created.kind !== 'created') throw new Error('the memory store creates the agent');
      return created.agent;
    },
    async save(agent, edits = {}) {
      const saved = await createAgentVersion(
        versionRequest({ name: agent.name, ...edits }),
        await current(agent.id),
        OWNER,
        { store, toolBundles: everyBundleStored },
      );
      if (saved.status !== 201) throw new Error(`the version saves: ${JSON.stringify(saved)}`);
    },
    current,
    archive: (agentId) => agentProvider.archive(WORKSPACE, agentId, new Date()),
  };
}

/** A `Support triage` agent with one saved version per edit, in order. */
export async function agentWithVersions(
  h: Harness,
  ...edits: readonly FixtureEdits[]
): Promise<AgentRecord> {
  const agent = await h.createAgent('Support triage');
  for (const edit of edits) await h.save(agent, edit);
  return agent;
}

type PointerDependencies = Parameters<typeof setAgentPointer>[3];

/** Points the environment at the version, as the builder key. */
export function point(
  agent: AgentRecord,
  environment: 'local' | 'production',
  version: number,
  deps: PointerDependencies,
) {
  return setAgentPointer({ environment, version }, agent, ACTOR, deps);
}

/** The dependencies of a deployment with a tool host that holds every bundle (ADR-0118 TS8). */
export function toolHostDeps(h: Harness) {
  return { store: h.store, toolBundles: everyBundleStored, toolHost: true };
}
