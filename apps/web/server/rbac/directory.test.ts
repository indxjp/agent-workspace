/**
 * The RBAC directory conformance suite (`directory.conformance.test-support.ts`), run against
 * every implementation of the port:
 *
 *   1. `createMemoryDirectory()` — no database, always;
 *   2. `createPostgresDirectory()` over the durable repository and a **real PostgreSQL**, whenever
 *      `TEST_DATABASE_URL` names one.
 *
 * The older in-memory-only checks live in `directory.memory-checks.test.ts`; they stay because some
 * of them pin fixture behaviour (seeding, display names) the port does not describe.
 */
import crypto from 'node:crypto';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships as membershipsTable,
  users as usersTable,
  workspacePrincipals,
  workspaces as workspacesTable,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe } from 'vitest';

import { describeDirectoryConformance } from './directory.conformance.test-support';
import { seededWorkspace, type SeededWorkspace } from './directory.test-support';
import { createMemoryDirectory } from './memory-directory';
import { createPostgresDirectory } from './postgres-directory';

// ── Implementation 1: memory ────────────────────────────────────────────────────────────────

describeDirectoryConformance('createMemoryDirectory — the DirectoryRoot contract', () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const a = seededWorkspace('alpha', tag);
  const b = seededWorkspace('bravo', tag);
  // A strictly increasing clock, so "newest first" is decided by write order and not by two writes
  // landing in the same millisecond; anchored at the real time so expiry checks stay meaningful.
  let now = Date.now();
  const root = createMemoryDirectory({
    users: [a, b].map((ws) => ({
      ...ws.owner,
      id: ws.owner.userId,
      workspaceId: ws.id,
      role: 'owner' as const,
    })),
    workspaces: [a, b].map(({ id, slug, name }) => ({ id, slug, name })),
    now: () => new Date((now += 1)),
    newId: () => crypto.randomUUID(),
  });
  return Promise.resolve({ root, a, b, email: (local) => `${local}-${tag}@example.test` });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[rbac/directory.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of ' +
      'this conformance suite did NOT run. A green result without it says nothing about whether ' +
      'the database-backed directory satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL RBAC directory', () => {
  let isolated: IsolatedTestDatabase;
  let database: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_rbac_directory');
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await isolated.close();
  });

  async function workspace(prefix: string, tag: string): Promise<SeededWorkspace> {
    const seeded = seededWorkspace(prefix, tag);
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(workspacesTable)
      .values({ id: seeded.id, slug: seeded.slug, name: seeded.name });
    await isolated.db
      .insert(usersTable)
      .values({ id: seeded.owner.userId, email: seeded.owner.email, name: seeded.owner.name });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(membershipsTable).values({
        id: membershipId,
        workspaceId: seeded.id,
        userId: seeded.owner.userId,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: crypto.randomUUID(),
        workspaceId: seeded.id,
        kind: 'membership',
        membershipId,
      });
    });
    return seeded;
  }

  describeDirectoryConformance('over a real PostgreSQL, against the same suite', async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    return {
      root: createPostgresDirectory(database.directory),
      a: await workspace('alpha', tag),
      b: await workspace('bravo', tag),
      email: (local) => `${local}-${tag}@example.test`,
    };
  });
});
