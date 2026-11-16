/**
 * The agent-team runtime contract (`conformance.ts`) held against both implementations: the
 * in-memory runtime the route tests drive, and the PostgreSQL runtime (`store.ts` over the core
 * repository) the composition installs (F-13).
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agentVersions,
  agents,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe } from 'vitest';

import { describeAgentTeamStoreConformance } from './conformance';
import { createInMemoryAgentTeamsRuntime } from './memory-store';
import { createRepositoryAgentTeamsRuntime } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeAgentTeamStoreConformance('the in-memory runtime', () => {
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const pin = () => ({ agentId: crypto.randomUUID(), agentVersionId: crypto.randomUUID() });
  const lead = pin();
  const member = pin();
  const foreign = pin();
  const agents = new Map([
    [`${workspaceId}:${lead.agentVersionId}`, { ...lead, name: 'lead' }],
    [`${workspaceId}:${member.agentVersionId}`, { ...member, name: 'researcher' }],
    [`${otherWorkspaceId}:${foreign.agentVersionId}`, { ...foreign, name: 'foreign' }],
  ]);
  return Promise.resolve({
    runtime: createInMemoryAgentTeamsRuntime({
      lookup: (workspace, agentId, agentVersionId) => {
        const found = agents.get(`${workspace}:${agentVersionId}`);
        return found?.agentId === agentId ? found.name : null;
      },
    }),
    workspaceId,
    otherWorkspaceId,
    ownerPrincipalId: crypto.randomUUID(),
    lead,
    member,
    memberName: 'researcher',
    foreign,
  });
});

describe.skipIf(!hasDatabase)('the PostgreSQL runtime', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;

  /** A workspace with an owner principal, and one agent with one version per name. */
  async function seedWorkspace(agentNames: readonly string[]) {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const { db } = isolated;
    await db.insert(workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Teams' });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const pins = [];
    for (const name of agentNames) {
      const agentId = crypto.randomUUID();
      const agentVersionId = crypto.randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        name,
        instructions: '',
        ownerPrincipalId: principalId,
        createdBy: userId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await db.insert(agentVersions).values({
        id: agentVersionId,
        workspaceId,
        agentId,
        number: 1,
        summary: 'first',
        via: 'api',
        body: {},
        createdByPrincipalId: principalId,
      });
      pins.push({ agentId, agentVersionId });
    }
    return { workspaceId, principalId, pins };
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_teams_runtime');
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  describeAgentTeamStoreConformance('the PostgreSQL runtime', async () => {
    const mine = await seedWorkspace(['lead', 'researcher']);
    const theirs = await seedWorkspace(['foreign']);
    const [lead, member] = mine.pins;
    const [foreign] = theirs.pins;
    if (lead === undefined || member === undefined || foreign === undefined) {
      throw new Error('the seeded agents are missing');
    }
    return {
      runtime: createRepositoryAgentTeamsRuntime(root),
      workspaceId: mine.workspaceId,
      otherWorkspaceId: theirs.workspaceId,
      ownerPrincipalId: mine.principalId,
      lead,
      member,
      memberName: 'researcher',
      foreign,
    };
  });
});
