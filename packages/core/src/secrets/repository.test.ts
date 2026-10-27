/**
 * The secrets repository conformance suite — one set of assertions, run against the in-memory
 * provider always, and against a real PostgreSQL whenever `TEST_DATABASE_URL` names one. Modelled
 * on `apps/web/server/agents/store.test.ts`: neither implementation was written by reading the
 * other, and this suite is the only reason to believe they agree.
 *
 * Fixture rows are read straight out of the database in the PostgreSQL half. This file lives
 * inside `packages/core` — the package that owns the database layer — so it reaches `db/**` by
 * **relative path** throughout, the same way `repository.ts` itself does (see that file's
 * header). It deliberately does NOT also import anything through the
 * `@agent-workspace/core/db/unscoped` package subpath: that subpath resolves, at run time, to the
 * package's *built* `dist/` output, a different module instantiation from the `src/` one every
 * relative import here loads — and `WorkspaceScope` is a nominally-typed class keyed to the
 * module instance that defined it. Mixing the two produced exactly the failure that predicts:
 * `ForgedWorkspaceScopeError` for a scope this file itself had just resolved, because the
 * repository under test checked it against a *different* `WorkspaceScope` class than the one that
 * minted it. One resolution mechanism, used consistently, is what avoids that.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '../db/repositories/testing.js';
import {
  createDatabaseWorkspaceScopeResolver,
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '../db/repositories/scope.js';
import { workspaces } from '../db/schema/workspaces.js';
import { generateDataKey, seal } from './crypto.js';
import type { SecretEnvelope } from './envelope.js';
import {
  createDatabaseSecretsRepositoryProvider,
  createInMemorySecretsRepositoryProvider,
  type CreateSecretOutcome,
  type ReplaceSecretOutcome,
  type SecretsRepositoryProvider,
} from './repository.js';

/** A syntactically valid envelope with a fresh, distinguishable ciphertext — never a real secret. */
function envelope(label: string): SecretEnvelope {
  const dataKey = generateDataKey();
  const value = seal(dataKey, Buffer.from(label, 'utf8'));
  const wrapped = seal(generateDataKey(), dataKey);
  return {
    algorithm: 'aes-256-gcm',
    masterKeyId: 'test-master-key',
    wrappedDataKey: wrapped.ciphertext,
    wrappedDataKeyNonce: wrapped.nonce,
    wrappedDataKeyTag: wrapped.tag,
    ciphertext: value.ciphertext,
    ciphertextNonce: value.nonce,
    ciphertextTag: value.tag,
  };
}

function created(outcome: CreateSecretOutcome): { id: string; workspaceId: string; name: string } {
  if (outcome.kind !== 'created') {
    throw new Error(`expected the secret to be created, but the repository said "${outcome.kind}"`);
  }
  return outcome.secret;
}

function replaced(outcome: ReplaceSecretOutcome): { id: string; name: string } {
  if (outcome.kind !== 'replaced') {
    throw new Error(
      `expected the secret to be replaced, but the repository said "${outcome.kind}"`,
    );
  }
  return outcome.secret;
}

interface Fixture {
  readonly provider: SecretsRepositoryProvider;
  readonly resolver: WorkspaceScopeResolver;
  readonly workspaceAId: string;
  readonly workspaceBId: string;
}

type MakeFixture = () => Promise<Fixture>;

function describeSecretsRepositoryConformance(label: string, makeFixture: MakeFixture): void {
  describe(`SecretsRepository — ${label}`, () => {
    it('creates a secret and returns metadata with no envelope field on it', async () => {
      const fixture = await makeFixture();
      const scope = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      if (scope === null) throw new Error('fixture workspace A does not resolve');
      const repo = fixture.provider.forScope(scope);

      const outcome = await repo.create({ name: 'ANTHROPIC_API_KEY', envelope: envelope('v1') });
      const secret = created(outcome);
      expect(secret.name).toBe('ANTHROPIC_API_KEY');
      expect(secret.workspaceId).toBe(fixture.workspaceAId);
      expect(Object.keys(secret).sort()).toEqual(
        ['id', 'workspaceId', 'name', 'algorithm', 'masterKeyId', 'createdAt', 'updatedAt'].sort(),
      );
    });

    it('rejects a duplicate name in the same workspace as a name-conflict, not a crash', async () => {
      const fixture = await makeFixture();
      const scope = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      if (scope === null) throw new Error('fixture workspace A does not resolve');
      const repo = fixture.provider.forScope(scope);

      created(await repo.create({ name: 'GITHUB_TOKEN', envelope: envelope('v1') }));
      const outcome = await repo.create({ name: 'GITHUB_TOKEN', envelope: envelope('v2') });
      expect(outcome).toEqual({ kind: 'name-conflict', name: 'GITHUB_TOKEN' });
    });

    it('refuses a name outside secrets_name_shape and stores nothing', async () => {
      const fixture = await makeFixture();
      const scope = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      if (scope === null) throw new Error('fixture workspace A does not resolve');
      const repo = fixture.provider.forScope(scope);

      await expect(repo.create({ name: 'lower_case', envelope: envelope('v1') })).rejects.toThrow();
      expect(await repo.list()).toEqual([]);
    });

    it('allows the same name in two different workspaces', async () => {
      const fixture = await makeFixture();
      const scopeA = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      const scopeB = await fixture.resolver.forWorkspaceId(fixture.workspaceBId);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');

      const a = created(
        await fixture.provider
          .forScope(scopeA)
          .create({ name: 'SHARED_NAME', envelope: envelope('a') }),
      );
      const b = created(
        await fixture.provider
          .forScope(scopeB)
          .create({ name: 'SHARED_NAME', envelope: envelope('b') }),
      );
      expect(a.id).not.toBe(b.id);
    });

    it("lists only the calling workspace's secrets, oldest first", async () => {
      const fixture = await makeFixture();
      const scopeA = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      const scopeB = await fixture.resolver.forWorkspaceId(fixture.workspaceBId);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');
      const repoA = fixture.provider.forScope(scopeA);
      const repoB = fixture.provider.forScope(scopeB);

      created(await repoA.create({ name: 'FIRST', envelope: envelope('1') }));
      created(await repoA.create({ name: 'SECOND', envelope: envelope('2') }));
      created(await repoB.create({ name: 'OTHER_WORKSPACE_SECRET', envelope: envelope('3') }));

      const listA = await repoA.list();
      expect(listA.map((s) => s.name)).toEqual(['FIRST', 'SECOND']);
      const listB = await repoB.list();
      expect(listB.map((s) => s.name)).toEqual(['OTHER_WORKSPACE_SECRET']);
    });

    it("replaces a secret's envelope by id, keeping its name", async () => {
      const fixture = await makeFixture();
      const scope = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      if (scope === null) throw new Error('fixture workspace A does not resolve');
      const repo = fixture.provider.forScope(scope);

      const secret = created(await repo.create({ name: 'ROTATE_ME', envelope: envelope('old') }));
      const outcome = await repo.replace(secret.id, envelope('new'));
      const updated = replaced(outcome);
      expect(updated.id).toBe(secret.id);
      expect(updated.name).toBe('ROTATE_ME');
    });

    it('answers not-found when replacing an id that does not exist', async () => {
      const fixture = await makeFixture();
      const scope = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      if (scope === null) throw new Error('fixture workspace A does not resolve');
      const repo = fixture.provider.forScope(scope);

      const outcome = await repo.replace(crypto.randomUUID(), envelope('x'));
      expect(outcome).toEqual({ kind: 'not-found' });
    });

    it("answers not-found — not the other workspace's row — when replacing across a tenant boundary", async () => {
      const fixture = await makeFixture();
      const scopeA = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      const scopeB = await fixture.resolver.forWorkspaceId(fixture.workspaceBId);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');

      const secretA = created(
        await fixture.provider
          .forScope(scopeA)
          .create({ name: 'BOUNDARY_TEST', envelope: envelope('a') }),
      );
      const outcome = await fixture.provider
        .forScope(scopeB)
        .replace(secretA.id, envelope('hijacked'));
      expect(outcome).toEqual({ kind: 'not-found' });

      // And workspace A's secret is unchanged by the attempt.
      const listA = await fixture.provider.forScope(scopeA).list();
      expect(listA.find((s) => s.id === secretA.id)?.name).toBe('BOUNDARY_TEST');
    });

    it("does not let workspace B see workspace A's secret through list", async () => {
      const fixture = await makeFixture();
      const scopeA = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      const scopeB = await fixture.resolver.forWorkspaceId(fixture.workspaceBId);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');

      created(
        await fixture.provider.forScope(scopeA).create({ name: 'ONLY_A', envelope: envelope('a') }),
      );
      const listB = await fixture.provider.forScope(scopeB).list();
      expect(listB.map((s) => s.name)).not.toContain('ONLY_A');
    });

    it('deletes only an unreferenced secret in the calling workspace and is idempotently not-found', async () => {
      const fixture = await makeFixture();
      const scopeA = await fixture.resolver.forWorkspaceId(fixture.workspaceAId);
      const scopeB = await fixture.resolver.forWorkspaceId(fixture.workspaceBId);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces do not resolve');
      const secret = created(
        await fixture.provider
          .forScope(scopeA)
          .create({ name: 'DELETE_ME', envelope: envelope('temporary') }),
      );

      await expect(fixture.provider.forScope(scopeB).delete(secret.id)).resolves.toEqual({
        kind: 'not-found',
      });
      const deleted = await fixture.provider.forScope(scopeA).delete(secret.id);
      expect(deleted.kind).toBe('deleted');
      expect(JSON.stringify(deleted)).not.toContain('temporary');
      await expect(fixture.provider.forScope(scopeA).delete(secret.id)).resolves.toEqual({
        kind: 'not-found',
      });
    });
  });
}

// ── In-memory: always runs ──────────────────────────────────────────────────────────────────────

describeSecretsRepositoryConformance('in-memory', () => {
  const provider = createInMemorySecretsRepositoryProvider();
  const workspaceAId = crypto.randomUUID();
  const workspaceBId = crypto.randomUUID();
  const resolver = createInMemoryWorkspaceScopeResolver([
    { id: workspaceAId, slug: 'a' },
    { id: workspaceBId, slug: 'b' },
  ]);
  return Promise.resolve({ provider, resolver, workspaceAId, workspaceBId });
});

// ── PostgreSQL: TEST_DATABASE_URL-gated ─────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[secrets/repository.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half ' +
      'of the secrets repository conformance suite was NOT exercised.',
  );
}

describe.skipIf(!hasDatabase)('SecretsRepository — PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w2cp02_secrets_repo');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  describeSecretsRepositoryConformance('PostgreSQL', async () => {
    const workspaceAId = crypto.randomUUID();
    const workspaceBId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values([
      { id: workspaceAId, slug: `a-${workspaceAId}`, name: 'Workspace A' },
      { id: workspaceBId, slug: `b-${workspaceBId}`, name: 'Workspace B' },
    ]);
    const provider = createDatabaseSecretsRepositoryProvider(isolated.db);
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    return { provider, resolver, workspaceAId, workspaceBId };
  });
});
