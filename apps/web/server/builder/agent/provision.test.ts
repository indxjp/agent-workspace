import { describe, expect, it, vi } from 'vitest';

import { ApiProblemSchema } from '@indx-workspace/contracts';
import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';

import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import type { AgentStoreProvider } from '../../agents/store';
import { versionRequest } from '../../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../../agent-versions/memory-store';
import type { WorkspaceAgentVersionStore } from '../../agent-versions/store';
import { ensureBuilderAgent } from './provision';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const OWNER = {
  principalId: PRINCIPAL,
  ownerPrincipalId: PRINCIPAL,
  userId: null,
  actorLabel: 'platform',
};

describe('ensureBuilderAgent', () => {
  it('answers the 409 after three saves that another call beat to the version number', async () => {
    const memoryAgents = createInMemoryAgentStoreProvider();
    const memory = createInMemoryAgentVersionStoreProvider({ agents: memoryAgents });
    // The memory agent store keeps no built-in marker (PostgreSQL does); mark every row it lists.
    const agents: AgentStoreProvider = {
      forWorkspace: (id) => {
        const store = memoryAgents.forWorkspace(id);
        return {
          ...store,
          list: async () => (await store.list()).map((r) => ({ ...r, builtin: 'builder' })),
        };
      },
    };
    const deps = (instructions: string) => ({
      shippedBody: versionRequest({ name: 'builder', instructions }).body,
      owner: OWNER,
      agents,
    });
    const first = await ensureBuilderAgent(WORKSPACE, { ...deps('Build.'), versions: memory });
    expect(first.kind).toBe('created');

    const store = await memory.forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    const create = vi
      .fn<WorkspaceAgentVersionStore['create']>()
      .mockResolvedValue({ kind: 'number-taken' });
    const versions = { forWorkspace: () => Promise.resolve({ ...store, create }) };
    const outcome = await ensureBuilderAgent(WORKSPACE, { ...deps('Build better.'), versions });

    expect(create).toHaveBeenCalledTimes(3);
    if (outcome.kind !== 'refused') throw new Error(`expected a refusal, got ${outcome.kind}`);
    expect(outcome.result.status).toBe(409);
    expect(ApiProblemSchema.parse(outcome.result.body).error.code).toBe(
      'agent_version_number_taken',
    );
  });

  it('stores the shipped body without aw-control however the name is spelled', async () => {
    const memoryAgents = createInMemoryAgentStoreProvider();
    const memory = createInMemoryAgentVersionStoreProvider({ agents: memoryAgents });
    const agents: AgentStoreProvider = {
      forWorkspace: (id) => {
        const store = memoryAgents.forWorkspace(id);
        return {
          ...store,
          list: async () => (await store.list()).map((r) => ({ ...r, builtin: 'builder' })),
        };
      },
    };
    const outcome = await ensureBuilderAgent(WORKSPACE, {
      shippedBody: versionRequest({
        name: 'builder',
        resources: { connectors: ['aw-control', ' AW-Control '] },
      }).body,
      owner: OWNER,
      agents,
      versions: memory,
    });

    if (outcome.kind !== 'created') {
      throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
    }
    const store = await memory.forWorkspace(WORKSPACE);
    const stored = await store?.find(outcome.agentId, outcome.version);
    const body = AgentVersionBodySchema.parse(stored?.body);
    expect(body.definition.resources.connectors).toEqual([]);
  });
});
