import { describe, expect, it } from 'vitest';

import { createAgent } from '../agents/handlers';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { RunTokenIssuer } from '../gateway/issuer';
import { InMemoryRunStore } from '../runs/memory-store';
import { buildRunRequestFor } from './run-request';

describe('Wave 4 model switching exit', () => {
  it('switches one UI-created agent from Claude to Azure per run without mutating its row', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const userId = '10000000-0000-4000-8000-000000000002';
    const anthropicId = '10000000-0000-4000-8000-000000000003';
    const azureId = '10000000-0000-4000-8000-000000000004';
    const sessionId = '10000000-0000-4000-8000-000000000005';
    const agentId = '10000000-0000-4000-8000-000000000006';
    const agents = createInMemoryAgentStoreProvider({
      knownModelConnectionIds: new Set([anthropicId, azureId]),
      newId: () => agentId,
    });
    const store = agents.forWorkspace(workspaceId);
    const created = await createAgent(
      store,
      {
        name: 'Portable agent',
        instructions: 'Use the selected model connection.',
        modelConnectionId: anthropicId,
        model: 'portable-model',
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      {
        principalId: '10000000-0000-4000-8000-000000000009',
        userId: '10000000-0000-4000-8000-000000000007',
      },
    );
    expect(created.status).toBe(201);
    const before = JSON.stringify(await store.get(agentId));
    const runs = new InMemoryRunStore();
    const selected: string[] = [];
    const issuer: RunTokenIssuer = {
      baseUrl: 'http://gateway:4000',
      issue(subject) {
        selected.push(subject.modelConnectionId);
        return Promise.resolve(`token-for-${subject.modelConnectionId}`);
      },
    };
    const stored = await store.get(agentId);
    if (stored === null) throw new Error('the agent was not created');
    const build = async (runId: string, modelConnectionId: string | null) => {
      const run = await runs.create({
        engine: 'claude-agent-sdk',
        id: runId,
        workspaceId,
        agentId,
        sessionId,
      });
      return buildRunRequestFor(
        {
          run,
          agent: { id: agentId, workspaceId, engine: 'claude-agent-sdk' },
          session: { id: sessionId, agentId, engine: null },
          principal: {
            principalId: '10000000-0000-4000-8000-000000000009',
            ownerPrincipalId: '10000000-0000-4000-8000-000000000009',
            userId,
            workspaceId,
            scope: null,
          },
          prompt: 'hello',
          modelConnectionId,
        },
        {
          agent: stored,
          assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
          toolBundles: [],
          subagents: [],
        },
        { runnerUrl: 'http://runner:8080', workspaceRoot: '/workspace' },
        issuer,
      );
    };

    await build('10000000-0000-4000-8000-000000000007', null);
    await build('10000000-0000-4000-8000-000000000008', azureId);

    expect(selected).toEqual([anthropicId, azureId]);
    expect(JSON.stringify(await store.get(agentId))).toBe(before);
  });
});
