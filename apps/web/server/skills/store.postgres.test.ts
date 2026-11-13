/**
 * The skills port on PostgreSQL: the same contract `store.test.ts` runs on the in-memory catalog
 * (refactoring plan part 07, steps 5–6).
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agents,
  agentSkills,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe } from 'vitest';

import { skillCatalogOf } from './store';
import { describeSkillCatalogContract } from './store.contract';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

describe.skipIf(!hasDatabase)('the skills port on PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_p07_skills_port');
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await root?.close();
    await isolated?.close();
  });

  async function seedWorkspace(slug: string) {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: slug });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('workspace scope did not resolve');
    return { workspaceId, userId, principalId, catalog: root.resourceCatalogs.forScope(scope) };
  }

  describeSkillCatalogContract('PostgreSQL', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await seedWorkspace(`skills-port-a-${suffix}`);
    const b = await seedWorkspace(`skills-port-b-${suffix}`);
    return {
      catalog: (workspace) => skillCatalogOf(workspace === 'a' ? a.catalog : b.catalog),
      ownerA: a.principalId,
      assign: async (skill) => {
        const agentId = crypto.randomUUID();
        await isolated.db.insert(agents).values({
          id: agentId,
          workspaceId: a.workspaceId,
          name: 'Skill assignee',
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
          ownerPrincipalId: a.principalId,
          createdBy: a.userId,
        });
        await isolated.db
          .insert(agentSkills)
          .values({ workspaceId: a.workspaceId, agentId, skillId: skill.id });
        return agentId;
      },
    };
  });
});
