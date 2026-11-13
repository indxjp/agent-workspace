import { afterAll, expect } from 'vitest';
import {
  closeIsolatedTestResources,
  createDatabaseAgentResourceRepositoryProvider,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  agentSkills,
  agents,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import { type ObjectStore } from '@agent-workspace/core/storage';
import { type SkillPrincipal } from './service';

export const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const LEGACY_PREFIXES = ['skill-meta/', 'skill-deletes/', 'skill-builtin/'] as const;

export const BUILTIN = 'office-reader';

export interface Fixture {
  readonly principal: SkillPrincipal & { readonly workspaceId: string };
  readonly catalog: ResourceCatalogRepository;
  /** Assign the skill `name` to a new agent, as the catalog under test records it (no checks). */
  readonly assign: (name: string) => Promise<void>;
  /** Assign it the way an agent write does; `false` when the write refuses a skill being deleted. */
  readonly tryAssign: (name: string) => Promise<boolean>;
}

export const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export const skillMd = (who: string): string => `---\nname: dup\n---\n\nfrom ${who}\n`;

export const importBody = (who: string) => ({
  name: 'dup',
  files: [
    { path: 'SKILL.md', contentBase64: b64(skillMd(who)) },
    { path: 'scripts/run.sh', contentBase64: b64(`echo ${who}\n`) },
  ],
});

export function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  const workspaceId = crypto.randomUUID();
  const catalog = provider.forWorkspace(workspaceId);
  return Promise.resolve({
    principal: { ownerPrincipalId: crypto.randomUUID(), userId: null, workspaceId },
    catalog,
    assign: (name) => {
      catalog.assignSkill(name, crypto.randomUUID());
      return Promise.resolve();
    },
    tryAssign: (name) => Promise.resolve(catalog.tryAssignSkill(name, crypto.randomUUID())),
  });
}

export let isolated: IsolatedTestDatabase | undefined;

export async function startFixtureDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl?.trim()) return;
  isolated = await createIsolatedTestDatabase('aw_skills_markers');
}

afterAll(async () => {
  if (isolated === undefined) return;
  await closeIsolatedTestResources(isolated);
});

export async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) {
    throw new Error('the PostgreSQL suite needs TEST_DATABASE_URL; run it through `pnpm test`');
  }
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'skills' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  const catalog = createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope);
  const resources = createDatabaseAgentResourceRepositoryProvider(db).forScope(scope);
  const newAgent = async (): Promise<string> => {
    const agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
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
      ownerPrincipalId: principalId,
      createdBy: userId,
    });
    return agentId;
  };
  const skillIdOf = async (name: string): Promise<string> => {
    const skill = (await catalog.listSkills()).find((row) => row.name === name);
    if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
    return skill.id;
  };
  return {
    principal: { ownerPrincipalId: principalId, userId, workspaceId },
    catalog,
    assign: async (name) => {
      const skillId = await skillIdOf(name);
      await db.insert(agentSkills).values({ workspaceId, agentId: await newAgent(), skillId });
    },
    tryAssign: async (name) => {
      const outcome = await resources.replace(await newAgent(), {
        files: [],
        skillIds: [await skillIdOf(name)],
        connectorIds: [],
      });
      if (outcome.kind === 'skill-deleting') return false;
      expect(outcome.kind).toBe('updated');
      return true;
    },
  };
}

export function recording(inner: ObjectStore): {
  readonly store: ObjectStore;
  readonly puts: string[];
} {
  const puts: string[] = [];
  return {
    puts,
    store: {
      ...inner,
      write: (key, body, options) => {
        puts.push(key);
        return inner.write(key, body, options);
      },
    },
  };
}

export const legacyPuts = (puts: readonly string[]): string[] =>
  puts.filter((key) => LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)));
