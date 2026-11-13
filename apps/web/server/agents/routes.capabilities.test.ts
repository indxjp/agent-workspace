import { afterEach, describe, expect, it } from 'vitest';

import { POST as createRoute, GET as listRoute } from '../../app/api/agents/route';
import type { AgentResourceAssignments } from '../../contracts/agents';
import { clearApplicationContext } from '../application-context';
import { clearEnginesRegisteredForTests, registerEngineForTests } from '../engines/registry';

import {
  bodyOf,
  CREATE_BODY,
  request,
  useMemoryRuntime,
  WORKSPACE_A,
} from './routes.fixture.test-support';
afterEach(() => {
  clearApplicationContext();
});

function registerClaudeWithout(capability: 'mcp' | 'skills'): void {
  registerEngineForTests({
    id: 'claude-agent-sdk',
    displayName: `Claude Agent SDK (test: no ${capability})`,
    version: 'test',
    capabilities: {
      mcp: capability !== 'mcp',
      skills: capability !== 'skills',
      subagents: false,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
  });
}

async function createWith(assignments: AgentResourceAssignments): Promise<Response> {
  return createRoute(
    request('POST', '/api/agents', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ agent: JSON.parse(CREATE_BODY) as unknown, assignments }),
    }),
  );
}

/**
 * ADR-0065 D3 at the one-call create (#318): an agent is never *saved* with connectors or skills
 * its engine cannot honour. A create body carries no policy, so the engine is the default arm —
 * which is why the test descriptor is a `claude-agent-sdk` descriptor with a capability removed
 * (see `apps/web/server/engines/registry.ts`) rather than a second engine.
 */
describe('engine capability check', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
  });

  it('refuses a compound create assigning a connector the engine cannot speak to', async () => {
    useMemoryRuntime();
    registerClaudeWithout('mcp');

    const response = await createWith({
      files: [],
      skillIds: [],
      connectorIds: ['44444444-4444-4444-8444-444444444444'],
      storageGrants: [],
    });

    expect(response.status).toBe(422);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['mcp'] },
    });
    // Refused before anything was written: no half-created agent is left for a retry to find.
    const list = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
    expect(await bodyOf(list)).toMatchObject({ agents: [] });
  });

  it('refuses a compound create assigning a skill the engine cannot materialise', async () => {
    useMemoryRuntime();
    registerClaudeWithout('skills');

    const response = await createWith({
      files: [],
      skillIds: ['55555555-5555-4555-8555-555555555555'],
      connectorIds: [],
      storageGrants: [],
    });

    expect(response.status).toBe(422);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('accepts the same create on the engine as this deployment really registers it', () => {
    // "Nothing changes for claude-agent-sdk agents" — the assertion above is about the test
    // descriptor, not about connectors becoming unassignable.
    useMemoryRuntime();
    return createWith({
      files: [],
      skillIds: [],
      connectorIds: ['44444444-4444-4444-8444-444444444444'],
      storageGrants: [],
    }).then(async (response) => {
      expect(response.status, JSON.stringify(await bodyOf(response))).toBe(201);
    });
  });
});
