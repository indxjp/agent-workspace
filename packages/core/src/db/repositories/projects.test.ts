/**
 * `ProjectRepository`'s archive/restore lifecycle against a real PostgreSQL (issue #182).
 *
 * The point of the suite is the two properties the column exists for and neither of which a
 * type-checker can see: archiving is **idempotent** (a second archive keeps the first timestamp,
 * which is `coalesce`, not `now()`), and it is **non-destructive** (the row survives and every
 * session and run stays attributed to the same project across both transitions). Both are asserted
 * positively — a row that is still there and a `project_id` that is byte-identical — rather than by
 * the absence of an error (ADR-0015).
 */
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { files } from '../schema/files.js';
import { createDatabaseProjectFileRepositoryProvider } from './project-files.js';
import {
  registerArchiveAttributionCases,
  registerArchiveTenancyCases,
  registerArchiveTransitionCases,
} from './projects.archive.test-support.js';
import {
  registerConnectorBindingCases,
  registerFileBindingCases,
} from './projects.bindings.test-support.js';
import { createProjectFixture, type ProjectFixture } from './projects.fixture.test-support.js';
import { registerMoveRaceCases } from './projects.move-race.test-support.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { seedCatalogFile } from './catalog-fixtures.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/projects.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

function registerPendingUploadCases(fixture: ProjectFixture) {
  // @story US-STO-02
  it('[US-STO-02][contract][sdk] refuses to bind a pending upload on every write path', async () => {
    const { isolated, repository, workspaceId, principalId, userId } = fixture;
    const plainId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    const row = (id: string, status: 'ready' | 'pending') => ({
      id,
      workspaceId,
      path: `bind/${id}.pdf`,
      kind: 'file' as const,
      storageKey: `bind/${id}.pdf`,
      objectId: crypto.randomUUID(),
      status,
      ownerPrincipalId: principalId,
      createdBy: userId,
    });
    await isolated.db.insert(files).values([row(plainId, 'ready'), row(pendingId, 'pending')]);
    const bindings = createDatabaseProjectFileRepositoryProvider(isolated.db).forScope(
      await fixture.scopeFor(workspaceId),
    );
    const refused = { name: 'ProjectFileReservedError' };
    const input = {
      name: `pending-${crypto.randomUUID()}`,
      ownerPrincipalId: principalId,
      createdBy: userId,
    };

    await expect(
      repository.createWithAssociations(input, [plainId, pendingId], []),
    ).rejects.toMatchObject(refused);
    const project = await repository.createWithAssociations(input, [plainId], []);
    await expect(
      repository.updateWithAssociations(project.id, {}, [pendingId], undefined),
    ).rejects.toMatchObject(refused);
    await expect(bindings.add(project.id, pendingId)).rejects.toMatchObject(refused);
    expect(await bindings.list(project.id)).toEqual([plainId]);
  });
}

function registerReplacementCases(fixture: ProjectFixture) {
  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a project file follows its path to the replacement row, and a removed row is not listed', async () => {
    const { isolated, repository, workspaceId, principalId, userId } = fixture;
    const scope = await fixture.scopeFor(workspaceId);
    const catalog = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scope);
    const bindings = createDatabaseProjectFileRepositoryProvider(isolated.db).forScope(scope);
    const old = await seedCatalogFile(catalog, {
      path: 'swap/report.pdf',
      kind: 'file',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalId,
      createdBy: userId,
    });
    const project = await repository.createWithAssociations(
      { name: `swap-${crypto.randomUUID()}`, ownerPrincipalId: principalId, createdBy: userId },
      [old.id],
      [],
    );

    const reserved = await catalog.reserve('swap/report.pdf', {
      ownerPrincipalId: principalId,
      sizeBytes: 2,
      contentType: null,
      objectId: crypto.randomUUID(),
    });
    await catalog.confirm(reserved.row, { sizeBytes: 2, contentType: null });
    expect(await bindings.list(project.id)).toEqual([reserved.row.id]);

    await catalog.remove('swap/report.pdf');
    expect(await bindings.list(project.id)).toEqual([]);
  });
}

describe.skipIf(!hasDatabase)('ProjectRepository archive lifecycle', () => {
  const fixture = createProjectFixture();
  registerArchiveTransitionCases(fixture);
  registerArchiveAttributionCases(fixture);
  registerMoveRaceCases(fixture);
  registerArchiveTenancyCases(fixture);
  registerConnectorBindingCases(fixture);
  registerFileBindingCases(fixture);
  registerPendingUploadCases(fixture);
  registerReplacementCases(fixture);
});
