/**
 * Migration 0051 — the parent folder rows every catalog write now adds (issue #899), against a real
 * PostgreSQL.
 *
 * The shape is `./engine-migration.test.ts`'s: migrate to the state before the change, write the
 * rows a live deployment already holds (files and folders without their parent folders), then apply the rest.
 * The seed is raw SQL over the columns that exist at that state: the typed `files` schema now
 * names columns (such as `status`) that a later migration adds.
 */
import crypto from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMigrationsDir, runMigrations } from '../migrate.js';
import { files } from '../schema/files.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createIsolatedTestDatabase,
  runMigrationsPastStorageProof,
  type IsolatedTestDatabase,
} from './testing.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = Boolean(databaseUrl?.trim());

const BACKFILL_MIGRATION = '0051_backfill_parent_folder_rows';
// By suffix: `pnpm migrations:renumber` may change the number.
const LEGACY_STORAGE_GUARD_SUFFIX = '_lively_nomad';

describe.skipIf(!hasDatabase)('0051 backfill of parent folder rows', () => {
  let isolated: IsolatedTestDatabase;
  let priorMigrationsDir: string;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  let principalId = '';
  let otherPrincipalId = '';
  const existingFolderId = crypto.randomUUID();
  const fileAtParentPathId = crypto.randomUUID();

  const seedRow = (
    id: string,
    workspace: string,
    owner: string,
    rowPath: string,
    kind: 'file' | 'folder' = 'file',
  ) =>
    sql`(${id}::uuid, ${workspace}::uuid, ${rowPath}, ${kind}, ${kind === 'file' ? rowPath : null}, ${kind === 'file' ? 1 : 0}, ${owner}::uuid)`;

  beforeAll(async () => {
    const migrationsDir = resolveMigrationsDir();
    priorMigrationsDir = await mkdtemp(path.join(tmpdir(), 'aw-pre-parent-folders-'));
    await mkdir(path.join(priorMigrationsDir, 'meta'));
    const journal = JSON.parse(
      await readFile(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    const entries = journal.entries.filter((entry) => entry.tag < BACKFILL_MIGRATION);
    expect(entries.length).toBe(
      journal.entries.findIndex((entry) => entry.tag === BACKFILL_MIGRATION),
    );
    await writeFile(
      path.join(priorMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    await Promise.all(
      entries.map((entry) =>
        cp(
          path.join(migrationsDir, `${entry.tag}.sql`),
          path.join(priorMigrationsDir, `${entry.tag}.sql`),
        ),
      ),
    );

    isolated = await createIsolatedTestDatabase(
      'aw_parent_folders',
      databaseUrl,
      priorMigrationsDir,
    );
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'parent-folders', name: 'Parent folders' },
      { id: otherWorkspaceId, slug: 'parent-folders-other', name: 'Other' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: 'parent-folders@example.test', name: 'Owner' });
    await isolated.db.insert(memberships).values([
      { workspaceId, userId, role: 'owner' },
      { workspaceId: otherWorkspaceId, userId, role: 'owner' },
    ]);
    // A trigger gives every membership its principal; read them rather than insert a second.
    const principalOf = async (workspace: string): Promise<string> => {
      const [row] = await isolated.db
        .select({ id: workspacePrincipals.id })
        .from(workspacePrincipals)
        .where(eq(workspacePrincipals.workspaceId, workspace));
      if (row === undefined) throw new Error('membership principal missing');
      return row.id;
    };
    principalId = await principalOf(workspaceId);
    otherPrincipalId = await principalOf(otherWorkspaceId);
    await isolated.db.execute(sql`
      insert into files (id, workspace_id, path, kind, storage_key, size_bytes, owner_principal_id)
      values ${sql.join(
        [
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'manuals/hydraulics/unit.md'),
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'manuals/other.md'),
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'top-level.md'),
          seedRow(existingFolderId, workspaceId, principalId, 'kept', 'folder'),
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'kept/a.md'),
          seedRow(fileAtParentPathId, workspaceId, principalId, 'shadowed'),
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'shadowed/b.md'),
          seedRow(crypto.randomUUID(), otherWorkspaceId, otherPrincipalId, 'elsewhere/x.md'),
          seedRow(crypto.randomUUID(), workspaceId, principalId, 'contracts/2026', 'folder'),
        ],
        sql`, `,
      )}
    `);

    // The storage guard refuses rows without an object id, so apply the migrations before it, give
    // the rows the id the storage migration would, then apply the rest.
    const guard = journal.entries.findIndex((entry) =>
      entry.tag.endsWith(LEGACY_STORAGE_GUARD_SUFFIX),
    );
    expect(guard).toBeGreaterThan(0);
    const beforeGuard = journal.entries.slice(0, guard);
    await writeFile(
      path.join(priorMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: beforeGuard }),
    );
    await Promise.all(
      beforeGuard.map((entry) =>
        cp(
          path.join(migrationsDir, `${entry.tag}.sql`),
          path.join(priorMigrationsDir, `${entry.tag}.sql`),
        ),
      ),
    );
    await runMigrations({ url: isolated.url, maxConnections: 4 }, priorMigrationsDir);
    await isolated.db.execute(sql`update files set object_id = id where kind = 'file'`);
    await runMigrationsPastStorageProof(isolated.url, migrationsDir);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
    if (priorMigrationsDir !== undefined) await rm(priorMigrationsDir, { recursive: true });
  });

  const rowsOf = (workspace: string) =>
    isolated.db.select().from(files).where(eq(files.workspaceId, workspace));

  it('adds a folder row for every proper prefix of an existing file, owned like the file', async () => {
    const rows = await rowsOf(workspaceId);
    for (const folder of ['manuals', 'manuals/hydraulics']) {
      expect(rows.find((row) => row.path === folder)).toMatchObject({
        kind: 'folder',
        storageKey: null,
        sizeBytes: 0,
        contentType: null,
        ownerPrincipalId: principalId,
      });
    }
    expect(rows.filter((row) => row.path === 'manuals')).toHaveLength(1);
  });

  it('adds a folder row for the parent of a nested folder', async () => {
    expect((await rowsOf(workspaceId)).find((row) => row.path === 'contracts')).toMatchObject({
      kind: 'folder',
      ownerPrincipalId: principalId,
    });
  });

  it('keeps an existing folder row and never turns a file row into a folder', async () => {
    const rows = await rowsOf(workspaceId);
    expect(rows.find((row) => row.path === 'kept')?.id).toBe(existingFolderId);
    expect(rows.find((row) => row.path === 'shadowed')).toMatchObject({
      id: fileAtParentPathId,
      kind: 'file',
    });
  });

  it('writes the rows into the workspace that owns the file, and no row for a top-level file', async () => {
    expect((await rowsOf(otherWorkspaceId)).map((row) => row.path).sort()).toEqual([
      'elsewhere',
      'elsewhere/x.md',
    ]);
    expect((await rowsOf(workspaceId)).map((row) => row.path).sort()).toEqual([
      'contracts',
      'contracts/2026',
      'kept',
      'kept/a.md',
      'manuals',
      'manuals/hydraulics',
      'manuals/hydraulics/unit.md',
      'manuals/other.md',
      'shadowed',
      'shadowed/b.md',
      'top-level.md',
    ]);
  });
});
