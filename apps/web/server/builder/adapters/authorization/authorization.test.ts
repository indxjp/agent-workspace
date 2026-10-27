import { describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import { draftBody } from '../checker/checker.contract';
import { callContextOf } from '../../testing/context';
import { describeAuthorizationConformance } from './authorization.contract';
import { createAuthorization } from './production';
import { MemoryAuthorization } from './memory';

describeAuthorizationConformance('the memory adapter', () => {
  const memory = new MemoryAuthorization();
  return {
    port: memory,
    agent: (workspaceId, ownerPrincipalId) =>
      Promise.resolve(memory.addAgent(workspaceId, ownerPrincipalId)),
    grant: (workspaceId, agentId, userId) =>
      Promise.resolve(memory.addGrant(workspaceId, agentId, userId)),
  };
});

describeAuthorizationConformance('production over the in-memory agent store', () => {
  const agents = createInMemoryAgentStoreProvider();
  const grants = new Set<string>();
  const key = (workspaceId: string, agentId: string, userId: string): string =>
    `${workspaceId}/${agentId}/${userId}`;
  return {
    port: createAuthorization({
      agents,
      versions: { forWorkspace: () => Promise.resolve(null) },
      ceiling: null,
      grants: {
        forWorkspace: (workspaceId) => ({
          hasGrant: (agentId, userId) =>
            Promise.resolve(grants.has(key(workspaceId, agentId, userId))),
        }),
      },
    }),
    agent: async (workspaceId, ownerPrincipalId) => {
      const created = await agents.forWorkspace(workspaceId).create(
        {
          name: `agent-${crypto.randomUUID()}`,
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
        { principalId: ownerPrincipalId, userId: null },
      );
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      return created.agent.id;
    },
    grant: (workspaceId, agentId, userId) => {
      grants.add(key(workspaceId, agentId, userId));
      return Promise.resolve();
    },
  };
});

describe('creator: who the verified door says is calling (#1851)', () => {
  const WORKSPACE = crypto.randomUUID();
  const AGENT = crypto.randomUUID();
  const body = draftBody('Planner');
  const run = (agentId = AGENT) =>
    callContextOf(WORKSPACE, 'builder', crypto.randomUUID(), null, 'run-1', {
      kind: 'run',
      agentId,
      agentVersion: 1,
    });
  const creatorOf = (
    agent: {
      name?: string;
      builtin?: 'builder';
      createdByAgent?: { agentId: string; version: number; runId: string };
    } | null,
    ceiling: Parameters<typeof createAuthorization>[0]['ceiling'],
    bodies: unknown = body,
    ctx = run(),
  ) =>
    createAuthorization({
      agents: {
        forWorkspace: () => ({
          get: (id) =>
            Promise.resolve(
              agent === null
                ? null
                : {
                    id,
                    ownerPrincipalId: crypto.randomUUID(),
                    name: 'planner',
                    ...agent,
                  },
            ),
        }),
      },
      versions: {
        forWorkspace: () =>
          Promise.resolve({
            find: () => Promise.resolve(bodies === null ? null : { body: bodies }),
          }),
      },
      ceiling,
    }).creator(ctx);

  it('is the external client for the OAuth door', async () => {
    const ctx = { ...run(), door: { kind: 'external' as const } };
    expect(await creatorOf(null, null, body, ctx)).toEqual({ kind: 'external' });
  });

  it('is the Builder only for the built-in Builder agent', async () => {
    expect(await creatorOf({ builtin: 'builder' }, null)).toEqual({ kind: 'builder' });
  });

  it('is nobody when the agent row is gone or its pinned version has no readable body', async () => {
    expect(await creatorOf(null, { builder: { allow: ['planner'] } })).toBeNull();
    expect(await creatorOf({}, { builder: { allow: ['planner'] } }, null)).toBeNull();
    expect(await creatorOf({}, { builder: { allow: ['planner'] } }, { not: 'a body' })).toBeNull();
  });

  it('is an agent, allowed to build only when the deployment ceiling names it exactly', async () => {
    const listed = { builder: { allow: ['planner'] } };
    expect(await creatorOf({}, listed)).toEqual({
      kind: 'agent',
      body,
      allowedToBuild: true,
      madeByAgent: false,
    });
    expect(await creatorOf({}, null)).toMatchObject({ kind: 'agent', allowedToBuild: false });
    expect(await creatorOf({ name: 'Planner' }, listed)).toMatchObject({ allowedToBuild: false });
  });

  it('is never allowed to build when an agent made it, even if the ceiling names it', async () => {
    const lineage = { agentId: crypto.randomUUID(), version: 1, runId: 'run-0' };
    expect(
      await creatorOf({ createdByAgent: lineage }, { builder: { allow: ['planner'] } }),
    ).toMatchObject({ kind: 'agent', allowedToBuild: false, madeByAgent: true });
  });
});

describe('target: the version a trial or evaluation names, for an agent creator (#1851)', () => {
  const WORKSPACE = crypto.randomUUID();
  const CREATOR = crypto.randomUUID();
  const TARGET = crypto.randomUUID();
  const body = draftBody('Child');
  const run = callContextOf(WORKSPACE, 'builder', crypto.randomUUID(), null, 'run-1', {
    kind: 'run',
    agentId: CREATOR,
    agentVersion: 1,
  });
  const targetOf = (
    agent: { createdByAgent?: { agentId: string; version: number; runId: string } } | null,
    bodies: unknown = body,
    ctx = run,
  ) =>
    createAuthorization({
      agents: {
        forWorkspace: () => ({
          get: (id) =>
            Promise.resolve(
              agent === null
                ? null
                : { id, ownerPrincipalId: crypto.randomUUID(), name: 'child', ...agent },
            ),
        }),
      },
      versions: {
        forWorkspace: () =>
          Promise.resolve({
            find: () => Promise.resolve(bodies === null ? null : { body: bodies }),
          }),
      },
      ceiling: null,
    }).target(ctx, TARGET, 1);

  it("is the target's body, even for an agent the caller made", async () => {
    const madeByCaller = { agentId: CREATOR, version: 3, runId: 'run-0' };
    expect(await targetOf({ createdByAgent: madeByCaller })).toEqual({ body });
  });

  it('is null for a missing agent, an unreadable version, and a door that is not a run', async () => {
    expect(await targetOf(null)).toBeNull();
    expect(await targetOf({}, null)).toBeNull();
    expect(await targetOf({}, { not: 'a body' })).toBeNull();
    expect(await targetOf({}, body, { ...run, door: { kind: 'external' } })).toBeNull();
  });
});
