import { isValidElement, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeChat } from '../../components/composer/home-chat';
import { createInMemoryAgentStoreProvider } from '../../server/agents/memory-store';
import type { AgentRecord } from '../../server/agents/contract';
import { clearApplicationContext } from '../../server/application-context';
import { installTestDomains } from '../../server/application-context-fixtures';
import HomePage from './page';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '__Host-aw_session=fixture' }),
  // The page reads Accept-Language for the composer's words (UX-15); English here.
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('../../server/auth', () => ({
  getSession: () => Promise.resolve(null),
}));

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const BUILDER = '44444444-4444-4444-8444-444444444444';
const CREATOR = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  clearApplicationContext();
});

/** A workspace whose list holds the built-in Builder and, with `withOwnAgent`, one agent of its own. */
async function installWorkspace(withOwnAgent: boolean): Promise<void> {
  const ids = withOwnAgent ? [AGENT, BUILDER] : [BUILDER];
  const provider = createInMemoryAgentStoreProvider({ newId: () => ids.shift() ?? 'unexpected' });
  const store = provider.forWorkspace(WORKSPACE);
  const input = {
    instructions: 'Answer briefly.',
    modelConnectionId: null,
    model: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  };
  const owner = { principalId: CREATOR, userId: CREATOR };
  if (withOwnAgent) await store.create({ ...input, name: 'Research' }, owner);
  const builder = await store.create({ ...input, name: 'builder' }, owner);
  if (builder.kind !== 'created') throw new Error(`builder fixture failed: ${builder.kind}`);
  // The in-memory store cannot mark a row built-in, so the list answers the Builder as provisioning stores it.
  const listed = async (): Promise<readonly AgentRecord[]> =>
    (await store.list()).map((row) =>
      row.id === BUILDER ? { ...row, builtin: 'builder' as const } : row,
    );
  installTestDomains({
    agents: {
      agents: { ...provider, forWorkspace: () => ({ ...store, list: listed }) },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
    models: { kind: 'unavailable' },
  });
}

async function homeAgents(): Promise<ComponentProps<typeof HomeChat>['agents']> {
  const home = await HomePage({ searchParams: Promise.resolve({}) });
  if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
    throw new Error('HomePage did not return the HomeChat boundary');
  }
  return home.props.agents;
}

describe('the New chat agent picker and the built-in Builder (UX-26)', () => {
  it('offers the workspace agents and leaves the Builder out', async () => {
    await installWorkspace(true);
    const agents = await homeAgents();
    if (agents.kind !== 'agents') throw new Error(agents.reason);
    expect(agents.agents.map((agent) => agent.id)).toEqual([AGENT]);
  });

  it('says the workspace has no agents yet when the Builder is the only one', async () => {
    await installWorkspace(false);
    expect(await homeAgents()).toEqual({
      kind: 'no-agents',
      reason: 'This workspace has no agents yet — create one to run a message.',
    });
  });
});
