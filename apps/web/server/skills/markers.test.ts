/**
 * The records a skill keeps beside its bytes — a pending delete and the digest of an installed
 * built-in — live on the skill's catalog row, never as marker objects (the storage design, §07 "Rules
 * CI enforces"). Each case runs on the in-memory catalog and on PostgreSQL; a skill that only has the
 * old marker object is still read, and its column backfilled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import { builtinSkillFiles } from '@agent-workspace/skills-office';

import { createStorageService } from '../storage/service';
import { digestOf, ensureBuiltinSkills } from './builtin';
import { deleteSkill } from './delete';
import { skillBuiltinMarkerKey, skillDeleteMarkerKey, skillMetaKey } from './keys';
import { pendingSkillDelete } from './pending-delete';
import {
  getSkillWithId,
  importSkillWithId,
  listSkillsWithIds,
  publishSkillRevisionWithId,
  type SkillPrincipal,
} from './service';
import type { SkillRowsAccess } from './tree';
import { listCatalogFiles } from '@agent-workspace/core/db';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const LEGACY_PREFIXES = ['skill-meta/', 'skill-deletes/', 'skill-builtin/'] as const;
const BUILTIN = 'office-reader';

interface Fixture {
  readonly principal: SkillPrincipal & { readonly workspaceId: string };
  readonly catalog: ResourceCatalogRepository;
  /** Assign the skill `name` to a new agent, as the catalog under test records it (no checks). */
  readonly assign: (name: string) => Promise<void>;
  /** Assign it the way an agent write does; `false` when the write refuses a skill being deleted. */
  readonly tryAssign: (name: string) => Promise<boolean>;
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const skillMd = (who: string): string => `---\nname: dup\n---\n\nfrom ${who}\n`;
const importBody = (who: string) => ({
  name: 'dup',
  files: [
    { path: 'SKILL.md', contentBase64: b64(skillMd(who)) },
    { path: 'scripts/run.sh', contentBase64: b64(`echo ${who}\n`) },
  ],
});

function memoryFixture(): Promise<Fixture> {
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

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  if (!hasDatabase) return;
  isolated = await createIsolatedTestDatabase('aw_skills_markers');
}, 180_000);

afterAll(async () => {
  if (isolated === undefined) return;
  await closeIsolatedTestResources(isolated);
});

async function postgresFixture(): Promise<Fixture> {
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

/** `inner` plus the key of every object put through it. */
function recording(inner: ObjectStore): {
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

const legacyPuts = (puts: readonly string[]): string[] =>
  puts.filter((key) => LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)));

function defineSuite(name: string, setup: () => Promise<Fixture>, ready: boolean): void {
  describe(`skill records on the ${name}`, () => {
    if (!ready) {
      it('has the database it needs', () => {
        throw new Error(
          'TEST_DATABASE_URL is not set; the PostgreSQL suite must run in `pnpm test`',
        );
      });
      return;
    }

    async function world() {
      const { principal, catalog, assign, tryAssign } = await setup();
      const traced = recording(
        createInMemoryObjectStoreProvider().forWorkspace(principal.workspaceId),
      );
      const shared = traced.store;
      const storage = createStorageService({
        catalog: () => Promise.resolve(catalog),
        objects: createInMemoryObjectStore(),
        log: noLog,
      });
      const rows: SkillRowsAccess = { storage, workspaceId: principal.workspaceId };
      const ctx = { workspaceId: principal.workspaceId, principalId: principal.ownerPrincipalId };
      const saveRow = async (path: string, text: string) => {
        const saved = await storage.save(
          { ...ctx, userId: principal.userId },
          {
            area: 'skills',
            path,
            maxBytes: 1024,
            replace: true,
            body: bytesToStream(new TextEncoder().encode(text)),
          },
        );
        if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      };
      const skillRowPaths = async (): Promise<string[]> =>
        (await listCatalogFiles(catalog))
          .filter((row) => row.kind === 'file' && row.path.startsWith('.skills/'))
          .map((row) => row.path)
          .sort();
      const putLegacy = (key: string, json: unknown) =>
        shared.write(key, new TextEncoder().encode(JSON.stringify(json)), {
          contentType: 'application/json',
        });
      return {
        principal,
        catalog,
        assign,
        tryAssign,
        shared,
        puts: traced.puts,
        storage,
        rows,
        saveRow,
        skillRowPaths,
        putLegacy,
      };
    }

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a skill delete interrupted half way is finished by its owner with no marker object', async () => {
      const { principal, catalog, shared, puts, storage, rows, skillRowPaths } = await world();
      let failRemove = false;
      const flaky: SkillRowsAccess = {
        ...rows,
        storage: {
          ...storage,
          remove: (ctx, area, path, options) =>
            failRemove
              ? Promise.reject(new Error('blip'))
              : storage.remove(ctx, area, path, options),
        },
      };
      expect(
        (await importSkillWithId(shared, catalog, principal, importBody('A'), rows)).status,
      ).toBe(201);
      const published = await publishSkillRevisionWithId(
        shared,
        catalog,
        principal,
        'dup',
        { files: importBody('A').files },
        rows,
      );
      expect(published.status).toBe(201);

      failRemove = true;
      await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');

      const [left] = await catalog.listSkills();
      expect(left).toMatchObject({
        name: 'dup',
        pendingDelete: { ownerPrincipalId: principal.ownerPrincipalId, revisions: [1] },
      });
      expect(await listAll(shared, 'skill-deletes')).toEqual([]);
      expect(await skillRowPaths()).toContain('.skills/dup@1/SKILL.md');

      failRemove = false;
      expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });
      expect(await catalog.listSkills()).toEqual([]);
      expect(await skillRowPaths()).toEqual([]);
      expect(legacyPuts(puts)).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a delete that cannot finish hides the skill from list and get', async () => {
      const { principal, catalog, shared, storage, rows } = await world();
      const flaky: SkillRowsAccess = {
        ...rows,
        storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
      };
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');

      const listed = await listSkillsWithIds(shared, catalog, principal, rows);
      expect(listed.body).toEqual({ skills: [] });
      expect(await getSkillWithId(shared, catalog, principal, 'dup', rows)).toMatchObject({
        status: 404,
      });
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a delete refused as in use leaves the skill live and unmarked', async () => {
      const { principal, catalog, assign, shared, puts, rows } = await world();
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      await assign('dup');

      expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({
        status: 409,
        body: { error: { code: 'skill_in_use' } },
      });

      expect((await catalog.listSkills())[0]).toMatchObject({ name: 'dup', pendingDelete: null });
      expect(legacyPuts(puts)).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a delete recorded only by a legacy marker object is finished by its owner', async () => {
      const { principal, catalog, shared, rows, saveRow, skillRowPaths, putLegacy } = await world();
      await saveRow('.skills/dup/SKILL.md', skillMd('A'));
      await saveRow('.skills/dup@1/SKILL.md', skillMd('A'));
      await putLegacy(skillDeleteMarkerKey('dup'), {
        ownerPrincipalId: principal.ownerPrincipalId,
        revisions: [1],
      });

      expect(await pendingSkillDelete(shared, catalog, 'dup')).toEqual({
        ownerPrincipalId: principal.ownerPrincipalId,
        revisions: [1],
      });
      expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });

      expect(await skillRowPaths()).toEqual([]);
      expect(await readWhole(shared, skillDeleteMarkerKey('dup'))).toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a legacy delete marker on a live row is read and its column backfilled', async () => {
      const { principal, catalog, shared, rows, putLegacy } = await world();
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      const pending = { ownerPrincipalId: principal.ownerPrincipalId, revisions: [2, 5] };
      await putLegacy(skillDeleteMarkerKey('dup'), pending);

      expect(await pendingSkillDelete(shared, catalog, 'dup')).toEqual(pending);

      expect((await catalog.listSkills())[0]?.pendingDelete).toEqual(pending);
      expect(await readWhole(shared, skillDeleteMarkerKey('dup'))).not.toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a built-in installed before the column existed is read from its marker and the column backfilled', async () => {
      const { principal, catalog, shared, puts, rows, putLegacy } = await world();
      const shipped = builtinSkillFiles(BUILTIN).map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64,
      }));
      const imported = await importSkillWithId(
        shared,
        catalog,
        principal,
        { name: BUILTIN, files: shipped },
        rows,
      );
      expect(imported.status, JSON.stringify(imported.body)).toBe(201);
      const digest = digestOf(
        shipped.map((file) => ({
          path: file.path,
          bytes: Buffer.from(file.contentBase64, 'base64'),
        })),
      );
      await putLegacy(skillBuiltinMarkerKey(BUILTIN), { digest });
      puts.length = 0;

      await ensureBuiltinSkills(shared, catalog, principal, [BUILTIN], rows);

      expect((await catalog.listSkills())[0]?.builtinDigest).toBe(digest);
      expect(await readWhole(shared, skillBuiltinMarkerKey(BUILTIN))).not.toBeNull();
      expect(puts).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a built-in install records its digest on the row and writes no marker object', async () => {
      const { principal, catalog, shared, puts, rows } = await world();

      await ensureBuiltinSkills(shared, catalog, principal, [BUILTIN], rows);

      const [row] = await catalog.listSkills();
      expect(row?.builtinDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.pendingDelete).toBeNull();
      expect(legacyPuts(puts)).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a skill whose delete is pending is refused to an assignment, and the delete still completes', async () => {
      const { principal, catalog, tryAssign, shared, storage, rows, skillRowPaths } = await world();
      const flaky: SkillRowsAccess = {
        ...rows,
        storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
      };
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');
      expect((await catalog.listSkills())[0]?.pendingDelete).not.toBeNull();

      expect(await tryAssign('dup')).toBe(false);

      expect(await deleteSkill(shared, catalog, 'dup', rows)).toEqual({ status: 204, body: null });
      expect(await catalog.listSkills()).toEqual([]);
      expect(await skillRowPaths()).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a skill assigned before the delete answers 409 and stays listed with its files', async () => {
      const { principal, catalog, tryAssign, shared, rows, skillRowPaths } = await world();
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      expect(await tryAssign('dup')).toBe(true);

      expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({
        status: 409,
        body: { error: { code: 'skill_in_use' } },
      });

      const listed = await listSkillsWithIds(shared, catalog, principal, rows);
      expect((listed.body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual([
        'dup',
      ]);
      expect(await skillRowPaths()).toContain('.skills/dup/scripts/run.sh');
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a delete refused as in use leaves an existing mark as it is', async () => {
      const { principal, catalog, assign, shared, storage, rows } = await world();
      const flaky: SkillRowsAccess = {
        ...rows,
        storage: { ...storage, remove: () => Promise.reject(new Error('blip')) },
      };
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      await expect(deleteSkill(shared, catalog, 'dup', flaky)).rejects.toThrow('blip');
      const marked = (await catalog.listSkills())[0]?.pendingDelete;
      expect(marked).not.toBeNull();
      await assign('dup');

      expect(await deleteSkill(shared, catalog, 'dup', rows)).toMatchObject({ status: 409 });

      expect((await catalog.listSkills())[0]?.pendingDelete).toEqual(marked);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a legacy delete marker beside a skill that is in use is not backfilled and hides nothing', async () => {
      const { principal, catalog, assign, shared, rows, putLegacy } = await world();
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      await assign('dup');
      await putLegacy(skillDeleteMarkerKey('dup'), {
        ownerPrincipalId: principal.ownerPrincipalId,
        revisions: [],
      });

      expect(await pendingSkillDelete(shared, catalog, 'dup')).toBeNull();
      const listed = await listSkillsWithIds(shared, catalog, principal, rows);

      expect((listed.body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual([
        'dup',
      ]);
      expect((await catalog.listSkills())[0]?.pendingDelete).toBeNull();
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] an import records the skill on its row and writes no skill-meta object', async () => {
      const { principal, catalog, shared, puts, rows } = await world();

      const imported = await importSkillWithId(shared, catalog, principal, importBody('A'), rows);

      expect(imported.status).toBe(201);
      expect((await catalog.listSkills())[0]?.meta).toMatchObject({ name: 'dup', enabled: true });
      expect(await listAll(shared, 'skill-meta')).toEqual([]);
      expect(legacyPuts(puts)).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][unit][sdk] a skill that only has its legacy skill-meta object is read and its column backfilled', async () => {
      const { principal, catalog, shared, puts, rows, putLegacy } = await world();
      await importSkillWithId(shared, catalog, principal, importBody('A'), rows);
      const legacy = {
        name: 'dup',
        enabled: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      };
      await catalog.setSkillMeta('dup', null);
      await putLegacy(skillMetaKey('dup'), legacy);
      puts.length = 0;

      const read = await getSkillWithId(shared, catalog, principal, 'dup', rows);

      expect(read.status).toBe(200);
      expect((read.body as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
      expect((await catalog.listSkills())[0]?.meta).toEqual(legacy);
      expect(await readWhole(shared, skillMetaKey('dup'))).not.toBeNull();
      expect(puts).toEqual([]);
    });
  });
}

defineSuite('in-memory catalog', memoryFixture, true);
defineSuite('PostgreSQL catalog', postgresFixture, hasDatabase);
