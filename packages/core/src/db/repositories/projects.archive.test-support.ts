import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { projects } from '../schema/projects.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { isProjectArchived } from './projects.js';
import { expectProject, type ProjectFixture } from './projects.fixture.test-support.js';

/** Archive stamps and restore clears `archived_at`, both idempotently, and `list()` filters on it. */
export function registerArchiveTransitionCases(fixture: ProjectFixture) {
  const { createProject } = fixture;

  it('archives a project by stamping archived_at, and restores it by clearing it', async () => {
    const { repository } = fixture;
    const created = await createProject('archive-and-restore');
    expect(created.archivedAt).toBeNull();
    expect(isProjectArchived(created)).toBe(false);

    const archived = expectProject(await repository.archive(created.id));
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(isProjectArchived(archived)).toBe(true);

    const restored = expectProject(await repository.restore(created.id));
    expect(restored.archivedAt).toBeNull();
    expect(isProjectArchived(restored)).toBe(false);
  });

  it('keeps the first archived_at when archiving twice, and stays cleared when restoring twice', async () => {
    const { repository } = fixture;
    const created = await createProject('idempotence');

    const first = expectProject(await repository.archive(created.id));
    const second = expectProject(await repository.archive(created.id));
    // `coalesce(archived_at, now())`, not `now()`: the moment archival happened does not move.
    expect(second.archivedAt).toEqual(first.archivedAt);

    const firstRestore = expectProject(await repository.restore(created.id));
    const secondRestore = expectProject(await repository.restore(created.id));
    expect(firstRestore.archivedAt).toBeNull();
    expect(secondRestore.archivedAt).toBeNull();
    expect(secondRestore.id).toBe(created.id);
  });

  it('list() excludes an archived project (load-bearing: deleting the active filter fails here)', async () => {
    const { repository } = fixture;
    const active = await createProject('filter-active');
    const archived = await createProject('filter-archived');
    await repository.archive(archived.id);

    const listedByDefault = (await repository.list()).map((project) => project.id);
    expect(listedByDefault).toContain(active.id);
    expect(listedByDefault).not.toContain(archived.id);

    const listedArchived = (await repository.list('archived')).map((project) => project.id);
    expect(listedArchived).toContain(archived.id);
    expect(listedArchived).not.toContain(active.id);

    const listedAll = (await repository.list('all')).map((project) => project.id);
    expect(listedAll).toEqual(expect.arrayContaining([active.id, archived.id]));
  });
}

/** Archiving is non-destructive: the row and every session and run attribution survive. */
export function registerArchiveAttributionCases(fixture: ProjectFixture) {
  it('keeps session and run attribution, the row itself, and get() across archive and restore', async () => {
    const { isolated, repository, createProject, seedSession, workspaceId } = fixture;
    const project = await createProject('attribution');
    const sessionId = await seedSession(project.id);
    const runId = crypto.randomUUID();
    await isolated.db.insert(runs).values({ id: runId, workspaceId, sessionId });

    const readAttribution = async (): Promise<{ projectId: string | null; runSession: string }> => {
      const session = (
        await isolated.db
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0];
      const run = (
        await isolated.db.select({ sessionId: runs.sessionId }).from(runs).where(eq(runs.id, runId))
      )[0];
      if (session === undefined || run === undefined) {
        throw new Error('the session or its run disappeared');
      }
      return { projectId: session.projectId, runSession: run.sessionId };
    };

    const before = await readAttribution();
    expect(before).toEqual({ projectId: project.id, runSession: sessionId });

    await repository.archive(project.id);
    expect(await readAttribution()).toEqual(before);
    // The archived project is still readable — history-shaped reads go through `get`, unfiltered.
    expect(expectProject(await repository.get(project.id)).id).toBe(project.id);
    // No hard delete: the row is positively still there, archived rather than gone.
    const rowsWhileArchived = await isolated.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(rowsWhileArchived).toHaveLength(1);

    await repository.restore(project.id);
    expect(await readAttribution()).toEqual(before);
    expect(expectProject(await repository.get(project.id)).archivedAt).toBeNull();
  });
}

/** Archive and restore never reach across the tenant boundary. */
export function registerArchiveTenancyCases(fixture: ProjectFixture) {
  it('refuses to archive or restore a project belonging to another workspace', async () => {
    const { isolated, repository, otherWorkspaceProjectId } = fixture;
    expect(await repository.archive(otherWorkspaceProjectId)).toBeNull();
    expect(await repository.restore(otherWorkspaceProjectId)).toBeNull();

    const untouched = (
      await isolated.db
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.id, otherWorkspaceProjectId))
    )[0];
    if (untouched === undefined) throw new Error('the other tenant’s project disappeared');
    expect(untouched.archivedAt).toBeNull();
  });
}
