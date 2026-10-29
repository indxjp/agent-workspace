/**
 * The negative control for `run-files.load.test.ts`'s memory bound (the storage design, §06 Phase
 * 4): buffering the run's input archive holds all of it, so at the same size, twice the bound, the
 * same measurement reads over that bound. That shows the bound can fail whatever the allocator, the
 * young generation and the working set did (the lowest reading seen on Windows was 88 MiB). A file of its own, as
 * `server/skills/multipart-buffering-control.test.ts` is, so its reading never shares a process heap
 * with the streaming test's.
 */
// @story US-STO-06
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RSS_BOUND,
  TOTAL_BYTES,
  grantedRun,
  newMember,
  type World,
} from './run-files-load-fixtures';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { measureRssGrowth, MiB, warmHttpTransport } from '../../../../tests/load/flat-memory';

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_run_files_control');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const userId = crypto.randomUUID();
  const member = newMember(userId);
  const { workspaceId, principalId } = member;
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'load' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId: id });
  });
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes: createDatabaseWorkspaceScopeResolver(db),
    }),
    member,
  };
}

const memoryWorld = (): Promise<World> =>
  Promise.resolve({ catalogs: createInMemoryCatalogStore(), member: newMember() });

function defineControl(name: string, setup: () => Promise<World>) {
  it(
    `[US-STO-06][load][run] negative control on the ${name}: a buffered archive reads over the bound`,
    { timeout: 300_000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'aw-run-files-control-'));
      try {
        const { lifecycle, context } = await grantedRun(await setup(), root);
        await warmHttpTransport();
        let held = 0;
        const { growth, newSpaceGrowth } = await measureRssGrowth(async (sample) => {
          const archive = await lifecycle.inputArchive(context);
          if (archive === null) throw new Error('the run has no archive');
          const buffered = await new Response(archive).arrayBuffer();
          sample();
          held = buffered.byteLength;
        });
        console.info(
          `[load] run files (${name}) negative control: peak RSS growth ${(growth / MiB).toFixed(1)} MiB of ${String(TOTAL_BYTES / MiB)} MiB, new space growth ${(newSpaceGrowth / MiB).toFixed(1)} MiB`,
        );
        expect(held).toBeGreaterThan(TOTAL_BYTES);
        expect(growth).toBeGreaterThan(RSS_BOUND);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

describe('run files buffering control', () => {
  defineControl('in-memory catalog', memoryWorld);
  defineControl('PostgreSQL catalog', () => postgresWorld());
});
