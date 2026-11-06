import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseAgentResourceRepositoryProvider } from './agent-resources.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { seedCatalogFile } from './catalog-fixtures.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('AgentResourceRepository against PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let scopeA: WorkspaceScope;
  let scopeB: WorkspaceScope;
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  const agentA = crypto.randomUUID();
  const agentB = crypto.randomUUID();
  /** Same workspace as `agentA`, but with `writeFiles: true` — the contrast case for issue #133's
   *  write-permission ceiling: a `'read-write'` grant is preserved here and narrowed on `agentA`. */
  const agentWriteAllowed = crypto.randomUUID();
  const fileA = crypto.randomUUID();
  const skillA = crypto.randomUUID();
  const connectorA = crypto.randomUUID();
  /** `created_by` is tenant-paired to `memberships` (issue #117); one owner per workspace. */
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const membershipA = crypto.randomUUID();
  const membershipB = crypto.randomUUID();
  const principalA = crypto.randomUUID();
  const principalB = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_agent_resources');
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: 'resource-a', name: 'Resource A' },
      { id: workspaceB, slug: 'resource-b', name: 'Resource B' },
    ]);
    await isolated.db.insert(users).values([
      { id: userA, email: `${userA}@example.test`, name: 'Owner A' },
      { id: userB, email: `${userB}@example.test`, name: 'Owner B' },
    ]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: membershipA, workspaceId: workspaceA, userId: userA, role: 'owner' },
        { id: membershipB, workspaceId: workspaceB, userId: userB, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        { id: principalA, workspaceId: workspaceA, kind: 'membership', membershipId: membershipA },
        { id: principalB, workspaceId: workspaceB, kind: 'membership', membershipId: membershipB },
      ]);
    });
    const permissions = {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    };
    await isolated.db.insert(agents).values([
      {
        id: agentA,
        workspaceId: workspaceA,
        name: 'A',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions,
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
      {
        id: agentB,
        workspaceId: workspaceB,
        name: 'B',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions,
        ownerPrincipalId: principalB,
        createdBy: userB,
      },
      {
        id: agentWriteAllowed,
        workspaceId: workspaceA,
        name: 'A (write allowed)',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: { ...permissions, writeFiles: true },
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
    ]);
    await isolated.db.insert(files).values({
      id: fileA,
      workspaceId: workspaceA,
      path: 'handbook',
      kind: 'folder',
      storageKey: null,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await isolated.db.insert(skills).values({
      id: skillA,
      workspaceId: workspaceA,
      name: 'reviewer',
      skillMd: '# Reviewer',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await isolated.db.insert(mcpServers).values({
      id: connectorA,
      workspaceId: workspaceA,
      name: 'GitHub',
      ownerPrincipalId: principalA,
      createdBy: userA,
      transport: 'http',
      command: null,
      args: null,
      url: 'https://example.test/mcp',
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const a = await resolver.forWorkspaceId(workspaceA);
    const b = await resolver.forWorkspaceId(workspaceB);
    if (a === null || b === null) throw new Error('workspace fixture did not resolve');
    scopeA = a;
    scopeB = b;
  }, 180_000);

  afterAll(async () => isolated.close());

  /** A fixed past instant, so "moved" and "unchanged" are exact comparisons, not timing races. */
  const backdated = new Date('2020-01-01T00:00:00Z');

  async function backdate(agentId: string): Promise<void> {
    await isolated.db.update(agents).set({ updatedAt: backdated }).where(eq(agents.id, agentId));
  }

  async function readUpdatedAt(agentId: string): Promise<Date> {
    const [row] = await isolated.db
      .select({ updatedAt: agents.updatedAt })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (row === undefined) throw new Error(`fixture agent ${agentId} is missing`);
    return row.updatedAt;
  }

  it('atomically replaces and reads every assignment kind', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const assignments = {
      files: [{ fileId: fileA, access: 'read' as const }],
      skillIds: [skillA],
      connectorIds: [connectorA],
      storageGrants: [],
    };
    await expect(repo.replace(agentA, assignments)).resolves.toMatchObject({
      kind: 'updated',
      assignments,
    });
    await expect(repo.get(agentA)).resolves.toEqual(assignments);
  });

  it('refuses a file under .attachments/ as an unknown file, whatever its case (ADR-0146 D6)', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    for (const path of ['.attachments/s1/u1/a.pdf', '.Attachments/s1/u2/b.pdf']) {
      const fileId = crypto.randomUUID();
      await isolated.db.insert(files).values({
        id: fileId,
        workspaceId: workspaceA,
        path,
        kind: 'file',
        storageKey: path,
        objectId: crypto.randomUUID(),
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      await expect(
        repo.replace(agentA, {
          files: [{ fileId, access: 'read' }],
          skillIds: [],
          connectorIds: [],
        }),
      ).resolves.toEqual({ kind: 'unknown-file', id: fileId });
    }
  });

  // @story US-STO-02
  it('[US-STO-02][contract][sdk] refuses a pending upload as an unknown file', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const fileId = crypto.randomUUID();
    await isolated.db.insert(files).values({
      id: fileId,
      workspaceId: workspaceA,
      path: 'pending/upload.pdf',
      kind: 'file',
      storageKey: 'pending/upload.pdf',
      objectId: crypto.randomUUID(),
      status: 'pending',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await expect(
      repo.replace(agentA, { files: [{ fileId, access: 'read' }], skillIds: [], connectorIds: [] }),
    ).resolves.toEqual({ kind: 'unknown-file', id: fileId });
  });

  // @story US-STO-14
  it('[US-STO-14][contract][sdk] a grant follows its path to the replacement row, and a removed row grants nothing', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const catalog = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
    const old = await seedCatalogFile(catalog, {
      path: 'granted/report.pdf',
      kind: 'file',
      sizeBytes: 1,
      contentType: null,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await repo.replace(agentA, {
      files: [{ fileId: old.id, access: 'read' }],
      skillIds: [],
      connectorIds: [],
    });

    const reserved = await catalog.reserve('granted/report.pdf', {
      ownerPrincipalId: principalA,
      sizeBytes: 2,
      contentType: null,
      objectId: crypto.randomUUID(),
    });
    const done = await catalog.confirm(reserved.row, { sizeBytes: 2, contentType: null });
    expect(done?.replaced?.id).toBe(old.id);
    await expect(repo.get(agentA)).resolves.toMatchObject({
      files: [{ fileId: reserved.row.id, access: 'read' }],
    });

    await catalog.remove('granted/report.pdf');
    await expect(repo.get(agentA)).resolves.toMatchObject({ files: [] });
    await repo.replace(agentA, { files: [], skillIds: [], connectorIds: [] });
  });

  it("does not see another workspace's agent and refuses its resources", async () => {
    const repoB = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeB);
    await expect(repoB.get(agentA)).resolves.toBeNull();
    await expect(
      repoB.replace(agentA, { files: [], skillIds: [], connectorIds: [] }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(
      repoB.replace(agentB, {
        files: [{ fileId: fileA, access: 'read' }],
        skillIds: [],
        connectorIds: [],
      }),
    ).resolves.toEqual({ kind: 'unknown-file', id: fileA });
  });

  /**
   * Issue #133: an agent's own `writeFiles` permission is a ceiling on a `'read-write'` grant it
   * is asked to persist (`docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`'s "narrow,
   * never widen" rule, applied to an agent's own direct assignment). Two agents, identical grant,
   * only `writeFiles` differs — the contrast is what proves the ceiling is actually read from
   * *this* agent's permissions and not simply hardcoded.
   */
  it("narrows a 'read-write' file grant to 'read' when the agent's writeFiles permission is off, and leaves it alone when writeFiles is on", async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const grant = {
      files: [{ fileId: fileA, access: 'read-write' as const }],
      skillIds: [],
      connectorIds: [],
    };

    await expect(repo.replace(agentA, grant)).resolves.toMatchObject({
      kind: 'updated',
      assignments: { files: [{ fileId: fileA, access: 'read' }] },
    });
    await expect(repo.get(agentA)).resolves.toMatchObject({
      files: [{ fileId: fileA, access: 'read' }],
    });

    await expect(repo.replace(agentWriteAllowed, grant)).resolves.toMatchObject({
      kind: 'updated',
      assignments: { files: [{ fileId: fileA, access: 'read-write' }] },
    });
    await expect(repo.get(agentWriteAllowed)).resolves.toMatchObject({
      files: [{ fileId: fileA, access: 'read-write' }],
    });
  });

  /**
   * Verification round 1, finding 1: a `'read-write'` row written while `writeFiles` was on
   * survives untouched in the database if the agent's permissions are changed by some *other*
   * write afterward — `replace`'s own narrowing only ever sees the assignment it is currently
   * persisting, never a row it left alone. A stale row like that must still read back as `'read'`,
   * because `get` (aliased here as `read` inside the repository) is what
   * `createAgentRunResourceLoader` calls to compose a run's file grants
   * (`apps/web/server/compose/resource-loader.ts`) — narrowing only at `replace`-time would leave
   * every such run writable on disk despite the operator having turned `writeFiles` off. This
   * agent is dedicated to this one test (unlike `agentA`/`agentWriteAllowed` above) so flipping its
   * permissions directly cannot leak into any other test's fixture state.
   */
  it("reads a 'read-write' row back as 'read' once the agent's writeFiles permission is turned off after the row was written, with no further replace()", async () => {
    const staleWriteAgent = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: staleWriteAgent,
      workspaceId: workspaceA,
      name: 'Stale write ceiling',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);

    // Written while writeFiles is on: persisted read-write, exactly as `replace` intends.
    await expect(
      repo.replace(staleWriteAgent, {
        files: [{ fileId: fileA, access: 'read-write' }],
        skillIds: [],
        connectorIds: [],
      }),
    ).resolves.toMatchObject({
      kind: 'updated',
      assignments: { files: [{ fileId: fileA, access: 'read-write' }] },
    });

    // Some *other* write turns writeFiles off — a `PATCH /api/agents/:id` in the real app — without
    // touching agent_files at all. This is a raw update, not `replace()`: the row is now stale by
    // construction, standing in for the app's own PATCH-then-failed-PUT partial-save sequence.
    await isolated.db
      .update(agents)
      .set({
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      })
      .where(eq(agents.id, staleWriteAgent));

    await expect(repo.get(staleWriteAgent)).resolves.toMatchObject({
      files: [{ fileId: fileA, access: 'read' }],
    });
  });

  /**
   * Verifier attack #2: a deleted/unknown skill id and an unknown connector id are each refused,
   * the same way an unknown file id already is above — and, load-bearingly, refusing one kind
   * writes nothing of the others either. `agentWriteAllowed` starts from the known-good state the
   * previous test left it in and must still read back exactly that after every refusal below.
   */
  it('refuses an unknown skill id and an unknown connector id, writing nothing of a partially-valid request', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const before = await repo.get(agentWriteAllowed);

    await expect(
      repo.replace(agentWriteAllowed, {
        files: [{ fileId: fileA, access: 'read' }],
        skillIds: [crypto.randomUUID()],
        connectorIds: [],
      }),
    ).resolves.toMatchObject({ kind: 'unknown-skill' });
    await expect(repo.get(agentWriteAllowed)).resolves.toEqual(before);

    await expect(
      repo.replace(agentWriteAllowed, {
        files: [{ fileId: fileA, access: 'read' }],
        skillIds: [skillA],
        connectorIds: [crypto.randomUUID()],
      }),
    ).resolves.toMatchObject({ kind: 'unknown-connector' });
    await expect(repo.get(agentWriteAllowed)).resolves.toEqual(before);
  });

  it('stores and reads a skill revision pin, refuses one that was never published, and clears it on replace', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    const base = { files: [], skillIds: [skillA], connectorIds: [] };
    await expect(
      repo.replace(agentWriteAllowed, { ...base, skillRevisions: { [skillA]: 1 } }),
    ).resolves.toEqual({ kind: 'unknown-skill-revision', id: skillA, revision: 1 });

    await isolated.db
      .insert(skillRevisions)
      .values({ workspaceId: workspaceA, skillId: skillA, number: 1, fileCount: 1 });
    await expect(
      repo.replace(agentWriteAllowed, { ...base, skillRevisions: { [skillA]: 1 } }),
    ).resolves.toMatchObject({ kind: 'updated' });
    await expect(repo.get(agentWriteAllowed)).resolves.toMatchObject({
      skillRevisions: { [skillA]: 1 },
    });

    await repo.replace(agentWriteAllowed, base);
    const unpinned = await repo.get(agentWriteAllowed);
    expect(unpinned).not.toHaveProperty('skillRevisions');
  });

  // A tool connector (ADR-0113 C15) is assignable: compose hands it to the engine as a gateway
  // MCP server (S2-02f, #531). A project binding still refuses one (#586).
  it('assigns a tool connector as an agent connector', async () => {
    const toolConnector = crypto.randomUUID();
    await isolated.db.insert(mcpServers).values({
      id: toolConnector,
      workspaceId: workspaceA,
      name: 'Pets tool',
      kind: 'openapi',
      ownerPrincipalId: principalA,
      transport: null,
      toolConfig: { openapi: {} },
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    await expect(
      repo.replace(agentWriteAllowed, { files: [], skillIds: [], connectorIds: [toolConnector] }),
    ).resolves.toMatchObject({ kind: 'updated', assignments: { connectorIds: [toolConnector] } });
  });

  // C21 (plan §4, S2-07a): an edit to an agent's assignments is an edit of the agent.
  it("moves the agent's updated_at when its assignments are replaced", async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    await backdate(agentA);
    await expect(
      repo.replace(agentA, {
        files: [{ fileId: fileA, access: 'read' }],
        skillIds: [skillA],
        connectorIds: [connectorA],
      }),
    ).resolves.toMatchObject({ kind: 'updated' });
    expect((await readUpdatedAt(agentA)).getTime()).toBeGreaterThan(backdated.getTime());
  });

  it('leaves updated_at alone when a replace is refused for an unknown skill or connector', async () => {
    const repo = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeA);
    await backdate(agentA);
    await expect(
      repo.replace(agentA, { files: [], skillIds: [crypto.randomUUID()], connectorIds: [] }),
    ).resolves.toMatchObject({ kind: 'unknown-skill' });
    expect(await readUpdatedAt(agentA)).toEqual(backdated);
    await expect(
      repo.replace(agentA, { files: [], skillIds: [], connectorIds: [crypto.randomUUID()] }),
    ).resolves.toMatchObject({ kind: 'unknown-connector' });
    expect(await readUpdatedAt(agentA)).toEqual(backdated);
  });

  it("does not move another workspace's agent's updated_at through a not-found replace", async () => {
    const repoB = createDatabaseAgentResourceRepositoryProvider(isolated.db).forScope(scopeB);
    await backdate(agentA);
    await expect(
      repoB.replace(agentA, { files: [], skillIds: [], connectorIds: [] }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(await readUpdatedAt(agentA)).toEqual(backdated);
  });
});
