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
import { setTimeout as delay } from 'node:timers/promises';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { projects } from '../schema/projects.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseProjectRepositoryProvider,
  isProjectArchived,
  type ProjectRecord,
  type ProjectRepository,
} from './projects.js';
import { createDatabaseProjectFileRepositoryProvider } from './project-files.js';
import { createDatabaseProjectMcpServerRepositoryProvider } from './project-mcp-servers.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseRunRepositoryProvider } from './runs.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { seedCatalogFile } from './catalog-fixtures.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/projects.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

/** Narrow a nullable repository answer without a non-null assertion, failing the test if it is null. */
function expectProject(project: ProjectRecord | null): ProjectRecord {
  expect(project).not.toBeNull();
  if (project === null) throw new Error('expected the repository to return a project row');
  return project;
}

describe.skipIf(!hasDatabase)('ProjectRepository archive lifecycle', () => {
  let isolated: IsolatedTestDatabase;
  let repository: ProjectRepository;
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const otherMembershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const otherPrincipalId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const otherWorkspaceProjectId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_projects_lifecycle');
    await isolated.db.insert(workspaces).values([
      { id: workspaceId, slug: 'projects-lifecycle', name: 'Projects Lifecycle' },
      { id: otherWorkspaceId, slug: 'projects-lifecycle-other', name: 'Other Tenant' },
    ]);
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: membershipId, workspaceId, userId, role: 'owner' },
        { id: otherMembershipId, workspaceId: otherWorkspaceId, userId, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        { id: principalId, workspaceId, kind: 'membership', membershipId },
        {
          id: otherPrincipalId,
          workspaceId: otherWorkspaceId,
          kind: 'membership',
          membershipId: otherMembershipId,
        },
      ]);
    });
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Lifecycle agent',
      instructions: '',
      ownerPrincipalId: principalId,
      createdBy: userId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db.insert(projects).values({
      id: otherWorkspaceProjectId,
      workspaceId: otherWorkspaceId,
      name: 'Other tenant project',
      ownerPrincipalId: otherPrincipalId,
      createdBy: userId,
    });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    repository = createDatabaseProjectRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  /** A fresh project per test: `projects_workspace_name_key` makes the name the isolation. */
  async function createProject(label: string): Promise<ProjectRecord> {
    return repository.create({
      name: `${label}-${crypto.randomUUID()}`,
      ownerPrincipalId: principalId,
      createdBy: userId,
      instructions: null,
      defaultAgentId: null,
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
    });
  }

  it('archives a project by stamping archived_at, and restores it by clearing it', async () => {
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

  it('keeps session and run attribution, the row itself, and get() across archive and restore', async () => {
    const project = await createProject('attribution');
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId,
      projectId: project.id,
    });
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

  it('does not move a session after a concurrent run creation has entered', async () => {
    const source = await createProject('move-race-source');
    const destination = await createProject('move-race-destination');
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId,
      projectId: source.id,
    });
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const runRepository = createDatabaseRunRepositoryProvider(isolated.db).forScope(scope);

    // Hold an unrelated lock in an UPDATE trigger after the move has checked for runs. This
    // exposes the gap where the old implementation admitted a run before committing the move.
    await isolated.db.execute(sql`
      create function hold_project_move() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(42021, 1);
        return new;
      end;
      $$
    `);
    await isolated.db.execute(sql`
      create trigger hold_project_move_trigger before update of project_id on sessions
      for each row execute function hold_project_move()
    `);
    const blocker = new pg.Client({ connectionString: isolated.url });
    await blocker.connect();
    try {
      await blocker.query('select pg_advisory_lock(42021, 1)');
      const moving = repository.moveSession(destination.id, sessionId);
      const deadline = Date.now() + 10_000;
      while (true) {
        const waiting = await blocker.query<{ count: number }>(
          "select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted",
        );
        if ((waiting.rows[0]?.count ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('session move did not reach the update trigger');
        await delay(20);
      }

      const creating = runRepository.create({ id: runId, sessionId, engine: 'claude-agent-sdk' });
      let runCreatedBeforeMove = false;
      while (true) {
        const existing = await isolated.db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.id, runId));
        if (existing.length > 0) {
          runCreatedBeforeMove = true;
          break;
        }
        const waiting = await blocker.query<{ count: number }>(
          "select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted",
        );
        if ((waiting.rows[0]?.count ?? 0) > 1) break;
        if (Date.now() > deadline) throw new Error('run creation did not settle or wait for move');
        await delay(20);
      }
      await blocker.query('select pg_advisory_unlock(42021, 1)');
      expect(await moving).toEqual({ kind: 'moved' });
      expect((await creating).kind).toBe('created');
      const session = (
        await isolated.db
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0];
      expect(runCreatedBeforeMove).toBe(false);
      expect(session?.projectId).toBe(destination.id);
    } finally {
      await blocker.query('select pg_advisory_unlock(42021, 1)');
      await blocker.end();
    }
  });

  it('refuses to archive or restore a project belonging to another workspace', async () => {
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

  // #586: a project binds MCP connectors only. A tool connector (ADR-0113 C15) is refused on every
  // project_mcp_servers write path and no row is written.
  it('refuses to bind a tool connector through project_mcp_servers on every write path', async () => {
    const mcpId = crypto.randomUUID();
    const toolId = crypto.randomUUID();
    await isolated.db.insert(mcpServers).values([
      {
        id: mcpId,
        workspaceId,
        name: `mcp-${mcpId}`,
        ownerPrincipalId: principalId,
        transport: 'http',
        url: 'https://mcp.example.test/mcp',
        authType: 'none',
        credentialSecretId: null,
        enabled: true,
      },
      {
        id: toolId,
        workspaceId,
        name: `tool-${toolId}`,
        kind: 'openapi',
        ownerPrincipalId: principalId,
        transport: null,
        toolConfig: { openapi: {} },
        authType: 'none',
        credentialSecretId: null,
        enabled: true,
      },
    ]);
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const bindings = createDatabaseProjectMcpServerRepositoryProvider(isolated.db).forScope(scope);
    const refused = { name: 'ProjectConnectorKindError', connectorIds: [toolId] };
    const input = {
      name: `bindings-${crypto.randomUUID()}`,
      ownerPrincipalId: principalId,
      createdBy: userId,
    };

    await expect(
      repository.createWithAssociations(input, [], [mcpId, toolId]),
    ).rejects.toMatchObject(refused);
    const names = (await repository.list('all')).map((project) => project.name);
    expect(names).not.toContain(input.name);

    const project = await repository.createWithAssociations(input, [], [mcpId]);
    await expect(
      repository.updateWithAssociations(project.id, {}, undefined, [toolId]),
    ).rejects.toMatchObject(refused);
    await expect(bindings.add(project.id, toolId)).rejects.toMatchObject(refused);
    expect(await bindings.list(project.id)).toEqual([mcpId]);
  });

  // ADR-0146 D6: a visitor upload under `.attachments/` is renamed out before it is bound; every
  // project_files write path refuses it and writes no row.
  it('refuses to bind a file under .attachments/ on every write path', async () => {
    const plainId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    await isolated.db.insert(files).values([
      {
        id: plainId,
        workspaceId,
        path: `docs/${plainId}.pdf`,
        kind: 'file',
        storageKey: `docs/${plainId}.pdf`,
        objectId: crypto.randomUUID(),
        ownerPrincipalId: principalId,
        createdBy: userId,
      },
      {
        id: uploadId,
        workspaceId,
        path: `.attachments/s/${uploadId}/a.pdf`,
        kind: 'file',
        storageKey: `.attachments/s/${uploadId}/a.pdf`,
        objectId: crypto.randomUUID(),
        ownerPrincipalId: principalId,
        createdBy: userId,
      },
    ]);
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const bindings = createDatabaseProjectFileRepositoryProvider(isolated.db).forScope(scope);
    const refused = { name: 'ProjectFileReservedError' };
    const input = {
      name: `files-${crypto.randomUUID()}`,
      ownerPrincipalId: principalId,
      createdBy: userId,
    };

    await expect(
      repository.createWithAssociations(input, [plainId, uploadId], []),
    ).rejects.toMatchObject(refused);
    const names = (await repository.list('all')).map((project) => project.name);
    expect(names).not.toContain(input.name);

    const project = await repository.createWithAssociations(input, [plainId], []);
    await expect(
      repository.updateWithAssociations(project.id, {}, [uploadId], undefined),
    ).rejects.toMatchObject(refused);
    await expect(bindings.add(project.id, uploadId)).rejects.toMatchObject(refused);
    expect(await bindings.list(project.id)).toEqual([plainId]);
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] refuses to bind a pending upload on every write path', async () => {
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
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
    const bindings = createDatabaseProjectFileRepositoryProvider(isolated.db).forScope(scope);
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

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a project file follows its path to the replacement row, and a removed row is not listed', async () => {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace did not resolve');
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
});
