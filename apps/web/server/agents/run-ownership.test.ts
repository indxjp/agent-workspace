/**
 * `resolveAgentRunOwnership` — the one function `apps/web/server/runs/api.ts` calls into from
 * this task's globs (issue #117; see `run-ownership.ts`'s own header for why the call site is a
 * declared out-of-bounds touch rather than a file this task owns).
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { isBuilderAgent } from '../builder/agent/is-builder-agent';
import { ownershipOf, resolveAgentRunOwnership } from './run-ownership';
import { createInMemoryAgentStoreProvider } from './memory-store';
import { type AgentsRuntime, type WorkspaceResolution } from './runtime';

const CREATE_INPUT = {
  name: 'Support',
  instructions: '',
  modelConnectionId: null,
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
} as const;

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CREATOR = '22222222-2222-4222-8222-222222222222';
const CREATOR_PRINCIPAL = '66666666-6666-4666-8666-666666666666';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OTHER_PRINCIPAL = '77777777-7777-4777-8777-777777777777';
const VIEWER = '44444444-4444-4444-8444-444444444444';
const VIEWER_PRINCIPAL = '88888888-8888-4888-8888-888888888888';
const ABSENT_AGENT = '55555555-5555-4555-8555-555555555555';

const resolveWorkspace = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE });

afterEach(() => {
  clearApplicationContext();
});

it('answers unknown when no agents runtime is configured', async () => {
  const ownership = await resolveAgentRunOwnership(
    {
      workspaceId: WORKSPACE,
      principalId: CREATOR_PRINCIPAL,
      ownerPrincipalId: CREATOR_PRINCIPAL,
      userId: CREATOR,
    },
    ABSENT_AGENT,
  );
  expect(ownership).toBe('unknown');
});

describe('with an agents runtime configured', () => {
  /** Configures a fresh runtime (optionally with `agentGrants`) and creates one agent in it. */
  async function setUp(agentGrants?: AgentsRuntime['agentGrants']): Promise<string> {
    const agents = createInMemoryAgentStoreProvider();
    installTestDomains({
      agents: {
        agents,
        resolveWorkspace,
        ...(agentGrants === undefined ? {} : { agentGrants }),
      },
    });
    const outcome = await agents.forWorkspace(WORKSPACE).create(CREATE_INPUT, {
      principalId: CREATOR_PRINCIPAL,
      userId: CREATOR,
    });
    if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);
    return outcome.agent.id;
  }

  it('answers unknown for an agent that does not exist in this workspace', async () => {
    await setUp();
    const ownership = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE,
        principalId: CREATOR_PRINCIPAL,
        ownerPrincipalId: CREATOR_PRINCIPAL,
        userId: CREATOR,
      },
      ABSENT_AGENT,
    );
    expect(ownership).toBe('unknown');
  });

  it('answers own for the agent’s creator', async () => {
    const agentId = await setUp();
    const ownership = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE,
        principalId: CREATOR_PRINCIPAL,
        ownerPrincipalId: CREATOR_PRINCIPAL,
        userId: CREATOR,
      },
      agentId,
    );
    expect(ownership).toBe('own');
  });

  it('answers other for a different member, when no agentGrants is wired', async () => {
    const agentId = await setUp();
    const ownership = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE,
        principalId: OTHER_PRINCIPAL,
        ownerPrincipalId: OTHER_PRINCIPAL,
        userId: OTHER,
      },
      agentId,
    );
    expect(ownership).toBe('other');
  });

  it('answers permitted only once an agent_grants row names the caller', async () => {
    const grants = new Set<string>();
    const agentId = await setUp({
      forWorkspace: () => ({
        hasGrant: (grantAgentId, userId) =>
          Promise.resolve(grants.has(`${grantAgentId}:${userId}`)),
        listPrincipalIds: () => Promise.resolve([]),
        replacePrincipalIds: (_agentId, principalIds) =>
          Promise.resolve({ kind: 'updated', principalIds }),
      }),
    });

    const beforeGrant = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE,
        principalId: VIEWER_PRINCIPAL,
        ownerPrincipalId: VIEWER_PRINCIPAL,
        userId: VIEWER,
      },
      agentId,
    );
    expect(beforeGrant).toBe('other');

    grants.add(`${agentId}:${VIEWER}`);
    const afterGrant = await resolveAgentRunOwnership(
      {
        workspaceId: WORKSPACE,
        principalId: VIEWER_PRINCIPAL,
        ownerPrincipalId: VIEWER_PRINCIPAL,
        userId: VIEWER,
      },
      agentId,
    );
    expect(afterGrant).toBe('permitted');
  });
});

describe('ownershipOf', () => {
  const principal = {
    workspaceId: WORKSPACE,
    principalId: VIEWER_PRINCIPAL,
    ownerPrincipalId: VIEWER_PRINCIPAL,
    userId: VIEWER,
  };
  const agent = { id: ABSENT_AGENT, ownerPrincipalId: CREATOR_PRINCIPAL };
  const grants = (granted: boolean) => ({ hasGrant: () => Promise.resolve(granted) });

  it('answers unknown for an agent that cannot be read', async () => {
    expect(await ownershipOf(principal, null, grants(true))).toBe('unknown');
  });

  it('answers own when the owner principal matches, without asking for grants', async () => {
    const owner = { ...principal, ownerPrincipalId: CREATOR_PRINCIPAL };
    expect(
      await ownershipOf(owner, agent, {
        hasGrant: () => Promise.reject(new Error('grants must not be read for the owner')),
      }),
    ).toBe('own');
  });

  it('answers permitted for a grant and other without one', async () => {
    expect(await ownershipOf(principal, agent, grants(true))).toBe('permitted');
    expect(await ownershipOf(principal, agent, grants(false))).toBe('other');
  });

  it('answers permitted for a person on a built-in agent, with no grant, and other without a user', async () => {
    const builtin = { ...agent, builtin: 'builder' as const };
    expect(await ownershipOf(principal, builtin, grants(false))).toBe('permitted');
    expect(await ownershipOf(principal, builtin, undefined)).toBe('permitted');
    expect(await ownershipOf({ ...principal, userId: null }, builtin, grants(false))).toBe('other');
    expect(await ownershipOf(principal, agent, grants(false))).toBe('other');
  });

  it('does not make a built-in other than the Builder runnable by every member', async () => {
    // `BuiltinAgentKey` has one member today; a future key must be decided on, not inherited, so
    // the rule follows `isBuilderAgent` and not "carries any built-in marker".
    const future = { ...agent, builtin: 'future' as unknown as 'builder' };
    expect(isBuilderAgent(future)).toBe(false);
    expect(await ownershipOf(principal, future, grants(false))).toBe('other');
  });

  it('answers other when no grant store is wired or the caller has no user', async () => {
    expect(await ownershipOf(principal, agent, undefined)).toBe('other');
    expect(await ownershipOf({ ...principal, userId: null }, agent, grants(true))).toBe('other');
  });
});
