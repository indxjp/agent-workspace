/**
 * Who may run an agent, as each integrations entry point answers it (refactoring part 08 step 3).
 * Pinned before the rule moves behind a port: the trigger and endpoint-client runtimes answer
 * `own`, `permitted`, `other` and `unknown` exactly as `agents/run-ownership.ts` does.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_PERMISSIONS } from './agent-versions/fixtures';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import { resolveAgentRunOwnership } from './agents/run-ownership';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { createRepositoryEndpointClientsRuntime } from './endpoint-clients/store';
import type { Principal } from './rbac/principal';
import { createRepositoryTriggersRuntime } from './triggers/store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const MISSING_AGENT = '44444444-4444-4444-8444-444444444444';

// The runtimes take a full Principal; the rule reads only these four facts.
const principal = (principalId: string, userId: string | null = null): Principal =>
  ({ workspaceId: WORKSPACE, principalId, ownerPrincipalId: principalId, userId }) as Principal;

async function installAgents(grants: ReadonlySet<string>): Promise<string> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'reporter',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture');
  installTestDomains({
    agents: {
      agents,
      agentGrants: {
        forWorkspace: () => ({
          hasGrant: (_agentId: string, userId: string) => Promise.resolve(grants.has(userId)),
        }),
      } as never,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
  return created.agent.id;
}

const runtimes = {
  triggers: () => createRepositoryTriggersRuntime({} as never, null, resolveAgentRunOwnership),
  'endpoint clients': () =>
    createRepositoryEndpointClientsRuntime({} as never, resolveAgentRunOwnership),
};

afterEach(() => clearApplicationContext());

describe.each(Object.entries(runtimes))('%s runtime: agentOwnership', (_name, build) => {
  it('answers own for the owner, permitted for a granted member, other otherwise', async () => {
    const agentId = await installAgents(new Set(['user-granted']));
    const runtime = build();
    expect(await runtime.agentOwnership(principal(OWNER), agentId)).toBe('own');
    expect(await runtime.agentOwnership(principal(MEMBER, 'user-granted'), agentId)).toBe(
      'permitted',
    );
    expect(await runtime.agentOwnership(principal(MEMBER, 'user-other'), agentId)).toBe('other');
    expect(await runtime.agentOwnership(principal(MEMBER), agentId)).toBe('other');
  });

  it('answers unknown for an agent that does not exist', async () => {
    await installAgents(new Set());
    expect(await build().agentOwnership(principal(OWNER), MISSING_AGENT)).toBe('unknown');
  });

  it('answers unknown when no agents runtime is installed', async () => {
    expect(await build().agentOwnership(principal(OWNER), MISSING_AGENT)).toBe('unknown');
  });

  it('answers what the injected rule answers, with the caller and the agent', async () => {
    const asked: string[] = [];
    const runtime =
      _name === 'triggers'
        ? createRepositoryTriggersRuntime({} as never, null, (who, agentId) => {
            asked.push(`${who.principalId}:${agentId}`);
            return Promise.resolve('permitted');
          })
        : createRepositoryEndpointClientsRuntime({} as never, (who, agentId) => {
            asked.push(`${who.principalId}:${agentId}`);
            return Promise.resolve('permitted');
          });
    expect(await runtime.agentOwnership(principal(MEMBER), MISSING_AGENT)).toBe('permitted');
    expect(asked).toEqual([`${MEMBER}:${MISSING_AGENT}`]);
  });
});
