/**
 * `RuntimeProfileRepository` against a real PostgreSQL. Copies `root.test.ts`'s shape: an
 * isolated, migrated database per suite, skipped loudly (never silently) without
 * `TEST_DATABASE_URL`.
 *
 * This file is not on this task's `Owns` line as printed in the Wave 3 plan's 3a-2 cell,
 * which names only `runtime-profiles.ts` and `repositories/index.ts`. It is added anyway, declared
 * on this PR's `Owns globs:` line, for the reason this task's report states in full: the cell
 * grants no test file for the repository it asks for, `database-reachability.test.ts` (which does
 * exercise other resources against a real database) is a sibling task's file, and a repository
 * with no test the author is allowed to write is not verified at all. Every assertion below runs
 * only against files this task owns.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runtimeProfiles } from '../schema/runtime-profiles.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';
import {
  createDatabaseRuntimeProfileRepositoryProvider,
  type RuntimeProfileRepository,
} from './runtime-profiles.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[repositories/runtime-profiles.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'runtime-profile repository was NOT exercised against a real database. A green result ' +
      'without it says nothing about this file.',
  );
}

describe.skipIf(!hasDatabase)('RuntimeProfileRepository', () => {
  let isolated: IsolatedTestDatabase;
  let acmeScope: WorkspaceScope;
  let globexScope: WorkspaceScope;
  let acmeRepo: RuntimeProfileRepository;
  let globexRepo: RuntimeProfileRepository;

  const acme = { id: crypto.randomUUID(), slug: 'acme', name: 'Acme' };
  const globex = { id: crypto.randomUUID(), slug: 'globex', name: 'Globex' };

  const baseInput = {
    name: 'Standard',
    driver: 'docker' as const,
    runtimeConnectionId: null,
    cpu: 1,
    memoryMb: 1024,
    diskMb: 5120,
    networkPolicy: 'restricted' as const,
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-write' as const,
    persistPaths: ['/workspace/output'],
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 600,
    driverConfig: { note: 'default' },
  };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w3cp06_runtime_profiles');
    await isolated.db.insert(workspaces).values([acme, globex]);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const acmeResolved = await resolver.forWorkspaceId(acme.id);
    const globexResolved = await resolver.forWorkspaceId(globex.id);
    if (acmeResolved === null || globexResolved === null) {
      throw new Error('seeded workspaces did not resolve to a scope');
    }
    acmeScope = acmeResolved;
    globexScope = globexResolved;
    const provider = createDatabaseRuntimeProfileRepositoryProvider(isolated.db);
    acmeRepo = provider.forScope(acmeScope);
    globexRepo = provider.forScope(globexScope);
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('creates a profile and reads back every column unchanged', async () => {
    const outcome = await acmeRepo.create(baseInput);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.profile).toMatchObject(baseInput);
    expect(outcome.profile.workspaceId).toBe(acme.id);

    const fetched = await acmeRepo.get(outcome.profile.id);
    expect(fetched).toMatchObject(baseInput);
  });

  it('stores a cloudflare-sandbox profile (migration 0047 widens the driver CHECK)', async () => {
    const input = {
      ...baseInput,
      name: 'Cloudflare',
      driver: 'cloudflare-sandbox' as const,
      networkPolicy: 'none' as const,
      allowedDomains: [],
    };
    const outcome = await acmeRepo.create(input);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(await acmeRepo.get(outcome.profile.id)).toMatchObject(input);
  });

  it('stores a vercel-sandbox profile (migration 0045 widens the driver CHECK, ADR-0120)', async () => {
    const outcome = await acmeRepo.create({
      ...baseInput,
      name: 'Vercel',
      driver: 'vercel-sandbox',
      networkPolicy: 'none',
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.profile.driver).toBe('vercel-sandbox');
  });

  it('refuses a second profile with the same name in the same workspace', async () => {
    await acmeRepo.create({ ...baseInput, name: 'Read Only' });
    const outcome = await acmeRepo.create({ ...baseInput, name: 'Read Only' });
    expect(outcome).toEqual({ kind: 'name-conflict', name: 'Read Only' });
  });

  it('allows the same name in a different workspace', async () => {
    const outcome = await globexRepo.create({ ...baseInput, name: 'Read Only' });
    expect(outcome.kind).toBe('created');
  });

  it("does not let one workspace see, update or delete another workspace's profile", async () => {
    const created = await acmeRepo.create({ ...baseInput, name: 'Isolated' });
    if (created.kind !== 'created') throw new Error('setup failed');

    await expect(globexRepo.get(created.profile.id)).resolves.toBeNull();
    await expect(globexRepo.update(created.profile.id, { cpu: 4 })).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(globexRepo.delete(created.profile.id)).resolves.toEqual({ kind: 'not-found' });

    // Untouched from the other workspace's vantage point.
    const stillThere = await acmeRepo.get(created.profile.id);
    expect(stillThere?.cpu).toBe(baseInput.cpu);
  });

  it('updates only the given fields, and reports not-found for a bad id', async () => {
    const created = await acmeRepo.create({ ...baseInput, name: 'Patchable' });
    if (created.kind !== 'created') throw new Error('setup failed');

    const updated = await acmeRepo.update(created.profile.id, { cpu: 2, memoryMb: 2048 });
    expect(updated.kind).toBe('updated');
    if (updated.kind === 'updated') {
      expect(updated.profile.cpu).toBe(2);
      expect(updated.profile.memoryMb).toBe(2048);
      // Untouched fields survive the patch.
      expect(updated.profile.name).toBe('Patchable');
      expect(updated.profile.networkPolicy).toBe(baseInput.networkPolicy);
    }

    await expect(acmeRepo.update(crypto.randomUUID(), { cpu: 9 })).resolves.toEqual({
      kind: 'not-found',
    });
  });

  it('deletes a profile, and a second delete reports not-found', async () => {
    const created = await acmeRepo.create({ ...baseInput, name: 'Deletable' });
    if (created.kind !== 'created') throw new Error('setup failed');

    await expect(acmeRepo.delete(created.profile.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(acmeRepo.delete(created.profile.id)).resolves.toEqual({ kind: 'not-found' });
    await expect(acmeRepo.get(created.profile.id)).resolves.toBeNull();
  });

  it("lists every profile of one workspace and none of another's, oldest first", async () => {
    const listed = await globexRepo.list();
    expect(listed.length).toBeGreaterThan(0);
    for (const profile of listed) expect(profile.workspaceId).toBe(globex.id);
    const createdAts = listed.map((profile) => profile.createdAt.getTime());
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
  });

  it('rejects an unknown runtime connection id', async () => {
    const outcome = await acmeRepo.create({
      ...baseInput,
      name: 'Bad Connection',
      runtimeConnectionId: crypto.randomUUID(),
    });
    expect(outcome).toEqual({
      kind: 'unknown-runtime-connection',
      runtimeConnectionId: expect.any(String) as string,
    });
  });

  describe('the workspace default runtime profile (#504)', () => {
    /** Adopt any existing profile with the same name and driver. */
    const ADOPT_ANY = { adoptable: () => true };
    const localInput = {
      name: 'local',
      driver: 'local' as const,
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'open' as const,
      allowedDomains: null,
      filesystem: 'read-write' as const,
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    };

    /** A workspace of its own per case, so one case's default never reaches another. */
    async function freshWorkspace(): Promise<{ id: string; repo: RuntimeProfileRepository }> {
      const id = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id, slug: `default-${id.slice(0, 8)}`, name: 'Default' });
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(id);
      if (scope === null) throw new Error('seeded workspace did not resolve to a scope');
      return {
        id,
        repo: createDatabaseRuntimeProfileRepositoryProvider(isolated.db).forScope(scope),
      };
    }

    async function storedDefault(workspaceId: string): Promise<string | null> {
      const rows = await isolated.db
        .select({ id: runtimeProfiles.id })
        .from(runtimeProfiles)
        .where(
          and(
            eq(runtimeProfiles.workspaceId, workspaceId),
            eq(runtimeProfiles.workspaceDefault, true),
          ),
        );
      expect(rows.length).toBeLessThanOrEqual(1);
      return rows[0]?.id ?? null;
    }

    it('has no default until one is ensured, then creates it and keeps it on repeat', async () => {
      const { id, repo } = await freshWorkspace();
      await expect(repo.findWorkspaceDefault()).resolves.toBeNull();

      const first = await repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      expect(first).toMatchObject({ kind: 'created', profile: localInput });
      if (first.kind !== 'created') return;
      expect(first.profile.workspaceId).toBe(id);
      await expect(storedDefault(id)).resolves.toBe(first.profile.id);
      await expect(repo.findWorkspaceDefault()).resolves.toEqual(first.profile);

      const second = await repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      expect(second).toEqual({ kind: 'kept', profile: first.profile });
      await expect(repo.list()).resolves.toHaveLength(1);
    });

    it('never replaces a default someone chose, even with different input', async () => {
      const { repo } = await freshWorkspace();
      const chosen = await repo.ensureWorkspaceDefault({ ...baseInput, name: 'Chosen' }, ADOPT_ANY);
      if (chosen.kind !== 'created') throw new Error('setup failed');
      await expect(repo.ensureWorkspaceDefault(localInput, ADOPT_ANY)).resolves.toEqual({
        kind: 'kept',
        profile: chosen.profile,
      });
      await expect(repo.list()).resolves.toHaveLength(1);
    });

    it('adopts an existing profile with the same name and driver, leaving its settings alone', async () => {
      const { id, repo } = await freshWorkspace();
      const existing = await repo.create({ ...localInput, networkPolicy: 'none' });
      if (existing.kind !== 'created') throw new Error('setup failed');
      const adopted = await repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      expect(adopted).toEqual({
        kind: 'adopted',
        profile: { ...existing.profile, updatedAt: expect.any(Date) as Date },
      });
      if (adopted.kind !== 'adopted') return;
      await expect(storedDefault(id)).resolves.toBe(existing.profile.id);
      await expect(repo.ensureWorkspaceDefault(localInput, ADOPT_ANY)).resolves.toEqual({
        kind: 'kept',
        profile: adopted.profile,
      });
    });

    it('answers not-adoptable and writes nothing when the caller refuses the existing profile', async () => {
      const { id, repo } = await freshWorkspace();
      const existing = await repo.create({ ...localInput, networkPolicy: 'restricted' });
      if (existing.kind !== 'created') throw new Error('setup failed');
      const offered: string[] = [];
      const outcome = await repo.ensureWorkspaceDefault(localInput, {
        adoptable: (profile) => {
          offered.push(profile.id);
          return profile.networkPolicy === 'open';
        },
      });
      expect(outcome).toEqual({ kind: 'not-adoptable', profile: existing.profile });
      expect(offered).toEqual([existing.profile.id]);
      await expect(storedDefault(id)).resolves.toBeNull();
      await expect(repo.list()).resolves.toEqual([existing.profile]);
    });

    it('answers name-conflict and writes nothing when the name is taken by another driver', async () => {
      const { id, repo } = await freshWorkspace();
      const taken = await repo.create({ ...baseInput, name: 'local' });
      if (taken.kind !== 'created') throw new Error('setup failed');
      await expect(repo.ensureWorkspaceDefault(localInput, ADOPT_ANY)).resolves.toEqual({
        kind: 'name-conflict',
        name: 'local',
      });
      await expect(storedDefault(id)).resolves.toBeNull();
      await expect(repo.list()).resolves.toEqual([taken.profile]);
    });

    it('leaves exactly one profile when two ensures race', async () => {
      const { id, repo } = await freshWorkspace();
      const outcomes = await Promise.all([
        repo.ensureWorkspaceDefault(localInput, ADOPT_ANY),
        repo.ensureWorkspaceDefault(localInput, ADOPT_ANY),
      ]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['created', 'kept']);
      const listed = await repo.list();
      expect(listed).toHaveLength(1);
      await expect(storedDefault(id)).resolves.toBe(listed[0]?.id);
    });

    it('clears the default when its profile is deleted', async () => {
      const { id, repo } = await freshWorkspace();
      const ensured = await repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      if (ensured.kind !== 'created') throw new Error('setup failed');
      await expect(repo.delete(ensured.profile.id)).resolves.toEqual({ kind: 'deleted' });
      await expect(storedDefault(id)).resolves.toBeNull();
      await expect(repo.findWorkspaceDefault()).resolves.toBeNull();
    });

    it("never reads another workspace's default", async () => {
      const { repo } = await freshWorkspace();
      const other = await freshWorkspace();
      const ensured = await other.repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      if (ensured.kind !== 'created') throw new Error('setup failed');
      await expect(repo.findWorkspaceDefault()).resolves.toBeNull();
      await expect(repo.ensureWorkspaceDefault(localInput, ADOPT_ANY)).resolves.toMatchObject({
        kind: 'created',
      });
    });

    /** The Postgres violations a direct write raises, or none when it succeeds. */
    async function violationsOf(
      write: () => Promise<unknown>,
    ): Promise<readonly { code: string; constraint: string }[]> {
      try {
        await write();
        return [];
      } catch (error) {
        return [...postgresViolations(error)];
      }
    }

    it('refuses a second default in one workspace (runtime_profiles_workspace_default_key)', async () => {
      const { repo } = await freshWorkspace();
      const ensured = await repo.ensureWorkspaceDefault(localInput, ADOPT_ANY);
      const second = await repo.create({ ...baseInput, name: 'Second' });
      if (ensured.kind !== 'created' || second.kind !== 'created') throw new Error('setup failed');
      await expect(
        violationsOf(() =>
          isolated.db
            .update(runtimeProfiles)
            .set({ workspaceDefault: true })
            .where(eq(runtimeProfiles.id, second.profile.id)),
        ),
      ).resolves.toEqual([{ code: '23505', constraint: 'runtime_profiles_workspace_default_key' }]);
      await expect(repo.findWorkspaceDefault()).resolves.toEqual(ensured.profile);
    });

    it('refuses false as a mark (runtime_profiles_workspace_default_true_or_null)', async () => {
      const { repo } = await freshWorkspace();
      const created = await repo.create(localInput);
      if (created.kind !== 'created') throw new Error('setup failed');
      await expect(
        violationsOf(() =>
          isolated.db
            .update(runtimeProfiles)
            .set({ workspaceDefault: false })
            .where(eq(runtimeProfiles.id, created.profile.id)),
        ),
      ).resolves.toEqual([
        { code: '23514', constraint: 'runtime_profiles_workspace_default_true_or_null' },
      ]);
    });
  });
});
