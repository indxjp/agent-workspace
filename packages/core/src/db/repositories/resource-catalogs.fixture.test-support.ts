import { and, eq, inArray, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { agentSkills } from '../schema/agent-skills.js';
import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  describeCatalogConformance,
  describeSkillCatalogConformance,
} from './resource-catalogs.contract.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  STALE_SKILL_REVISION_MS,
} from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

async function seedWorkspace(db: IsolatedTestDatabase['db'], slug: string) {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: `Owner ${slug}` });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return { scope, userId, principalId };
}

export let isolated: IsolatedTestDatabase;
export let scopeA: WorkspaceScope;
export let scopeB: WorkspaceScope;
export let userA: string;
export let userB: string;
export let principalA: string;
export let principalB: string;

export function defineCatalogPostgresFixture(): void {
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_resource_catalogs');
    const a = await seedWorkspace(isolated.db, 'catalog-a');
    const b = await seedWorkspace(isolated.db, 'catalog-b');
    ({ scope: scopeA, userId: userA, principalId: principalA } = a);
    ({ scope: scopeB, userId: userB, principalId: principalB } = b);
  }, 180_000);

  describeCatalogConformance('the PostgreSQL catalog', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await seedWorkspace(isolated.db, `conformance-a-${suffix}`);
    const b = await seedWorkspace(isolated.db, `conformance-b-${suffix}`);
    const provider = createDatabaseResourceCatalogRepositoryProvider(isolated.db);
    return {
      catalog: (workspace) => provider.forScope(workspace === 'a' ? a.scope : b.scope),
      ownerA: a.principalId,
      ownerB: b.principalId,
      actorA: a.userId,
      seed: async (workspace, row) => {
        const seeded = workspace === 'a' ? a : b;
        await isolated.db.insert(files).values({
          workspaceId: seeded.scope.workspaceId,
          path: row.path,
          kind: 'file',
          storageKey: row.path,
          ownerPrincipalId: seeded.principalId,
          status: row.status,
          objectId: row.objectId ?? null,
        });
      },
    };
  });

  describeSkillCatalogConformance('the PostgreSQL catalog', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await seedWorkspace(isolated.db, `skills-a-${suffix}`);
    const b = await seedWorkspace(isolated.db, `skills-b-${suffix}`);
    const provider = createDatabaseResourceCatalogRepositoryProvider(isolated.db);
    return {
      catalog: (workspace) => provider.forScope(workspace === 'a' ? a.scope : b.scope),
      ownerA: a.principalId,
      ownerB: b.principalId,
      actorA: a.userId,
      assign: async (workspace, skill) => {
        const seeded = workspace === 'a' ? a : b;
        const agentId = crypto.randomUUID();
        await isolated.db.insert(agents).values({
          id: agentId,
          workspaceId: seeded.scope.workspaceId,
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
          ownerPrincipalId: seeded.principalId,
          createdBy: seeded.userId,
        });
        await isolated.db
          .insert(agentSkills)
          .values({ workspaceId: seeded.scope.workspaceId, agentId, skillId: skill.id });
        return agentId;
      },
      unassign: async (workspace, skill, agentId) => {
        const seeded = workspace === 'a' ? a : b;
        await isolated.db
          .delete(agentSkills)
          .where(
            and(
              eq(agentSkills.workspaceId, seeded.scope.workspaceId),
              eq(agentSkills.agentId, agentId),
              eq(agentSkills.skillId, skill.id),
            ),
          );
      },
      ageRevisions: async (name) => {
        await isolated.db
          .update(skillRevisions)
          .set({
            createdAt: sql`${skillRevisions.createdAt} - make_interval(secs => ${STALE_SKILL_REVISION_MS / 1000 + 1})`,
          })
          .where(
            and(
              eq(skillRevisions.workspaceId, a.scope.workspaceId),
              eq(skillRevisions.pending, true),
              inArray(
                skillRevisions.skillId,
                isolated.db
                  .select({ id: skills.id })
                  .from(skills)
                  .where(and(eq(skills.workspaceId, a.scope.workspaceId), eq(skills.name, name))),
              ),
            ),
          );
      },
    };
  });

  afterAll(async () => isolated.close());
}
