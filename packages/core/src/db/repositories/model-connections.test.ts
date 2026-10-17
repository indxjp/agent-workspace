import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { projects } from '../schema/projects.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseModelConnectionRepositoryProvider,
  type ModelConnectionRepository,
} from './model-connections.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

/**
 * Assert a statement was refused by a specific named constraint. Drizzle wraps driver errors, so
 * the constraint name is not in `error.message` — matching on message text would pass for ANY
 * failure of the statement, including a typo in the test's own SQL.
 */
async function expectConstraintViolation(
  statement: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await statement;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${constraint} to reject the statement, but it succeeded`).toBeDefined();
  const names = [...postgresViolations(thrown)].map((violation) => violation.constraint);
  expect(names, `the rejection named no constraint; error was: ${String(thrown)}`).toContain(
    constraint,
  );
}

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase)
  console.warn('[repositories/model-connections.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');

describe.skipIf(!hasDatabase)('ModelConnectionRepository', () => {
  let isolated: IsolatedTestDatabase;
  let acme: ModelConnectionRepository;
  let globex: ModelConnectionRepository;
  const workspaceA = { id: crypto.randomUUID(), slug: 'models-acme', name: 'Models Acme' };
  const workspaceB = { id: crypto.randomUUID(), slug: 'models-globex', name: 'Models Globex' };
  /** `agents.created_by` is tenant-paired to `memberships` (issue #117); one owner is enough. */
  const ownerA = crypto.randomUUID();
  const membershipA = crypto.randomUUID();
  const principalA = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w4cp08_model_connections');
    await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
    await isolated.db
      .insert(users)
      .values([{ id: ownerA, email: `${ownerA}@example.test`, name: 'Owner A' }]);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values([{ id: membershipA, workspaceId: workspaceA.id, userId: ownerA, role: 'owner' }]);
      await tx.insert(workspacePrincipals).values({
        id: principalA,
        workspaceId: workspaceA.id,
        kind: 'membership',
        membershipId: membershipA,
      });
    });
    const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
    const [scopeA, scopeB] = await Promise.all([
      scopes.forWorkspaceId(workspaceA.id),
      scopes.forWorkspaceId(workspaceB.id),
    ]);
    if (scopeA === null || scopeB === null) throw new Error('fixture workspaces did not resolve');
    const provider = createDatabaseModelConnectionRepositoryProvider(isolated.db);
    acme = provider.forScope(scopeA);
    globex = provider.forScope(scopeB);
  }, 180_000);

  afterAll(async () => isolated.close());

  it('creates, reads, updates, lists and deletes a connection', async () => {
    const id = crypto.randomUUID();
    const created = await acme.create({ id, name: 'Claude', provider: 'anthropic', config: {} });
    expect(created.kind).toBe('created');
    expect(await acme.get(id)).toMatchObject({ id, name: 'Claude', provider: 'anthropic' });
    expect(await acme.update(id, { name: 'Claude primary' })).toMatchObject({
      kind: 'updated',
      connection: { name: 'Claude primary' },
    });
    expect((await acme.list()).map((row) => row.id)).toContain(id);
    expect(await acme.delete(id)).toMatchObject({ kind: 'deleted', connection: { id } });
    await expect(acme.get(id)).resolves.toBeNull();
  });

  it('scopes every operation to one workspace and classifies name conflicts', async () => {
    const id = crypto.randomUUID();
    await acme.create({ id, name: 'Isolated', provider: 'openai', config: {} });
    await expect(globex.get(id)).resolves.toBeNull();
    await expect(globex.update(id, { name: 'Nope' })).resolves.toEqual({ kind: 'not-found' });
    await expect(globex.delete(id)).resolves.toEqual({ kind: 'not-found' });
    await acme.create({
      id: crypto.randomUUID(),
      name: 'Conflict',
      provider: 'openai',
      config: {},
    });
    await expect(
      acme.create({ id: crypto.randomUUID(), name: 'Conflict', provider: 'anthropic', config: {} }),
    ).resolves.toEqual({ kind: 'name-conflict', name: 'Conflict' });
  });

  it('reports every referencing agent, and those agents fall back to the workspace default', async () => {
    const id = crypto.randomUUID();
    await acme.create({ id, name: 'Referenced', provider: 'anthropic', config: {} });
    const permissions = {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    };
    const agentId = crypto.randomUUID();
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId: workspaceA.id,
      name: 'Support Agent',
      instructions: '',
      modelConnectionId: id,
      model: null,
      runtimeProfileId: null,
      permissions,
      ownerPrincipalId: principalA,
      createdBy: ownerA,
    });

    const outcome = await acme.delete(id);
    expect(outcome).toMatchObject({
      kind: 'deleted',
      referencedBy: [{ agentId, agentName: 'Support Agent' }],
    });

    const [row] = await isolated.db
      .select({ modelConnectionId: agents.modelConnectionId })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.modelConnectionId).toBeNull();
  });

  it('reports no references for a connection nothing points at', async () => {
    const id = crypto.randomUUID();
    await acme.create({ id, name: 'Unreferenced', provider: 'anthropic', config: {} });
    await expect(acme.delete(id)).resolves.toMatchObject({ kind: 'deleted', referencedBy: [] });
  });

  // issue #129: `workspaces_default_model_pair` / `projects_default_model_pair` refuse a
  // connection id without its paired model text, and the FK's own `ON DELETE SET NULL` clears
  // only the id column — never the paired text one. So deleting a connection that is somebody's
  // default must null BOTH columns, together, or the delete itself would violate the pair check.
  it("nulls a workspace's and a project's default model together when their connection is deleted", async () => {
    const id = crypto.randomUUID();
    await acme.create({ id, name: 'Defaulted', provider: 'anthropic', config: {} });
    await isolated.db
      .update(workspaces)
      .set({ defaultModelConnectionId: id, defaultModel: 'claude-sonnet-4-5' })
      .where(eq(workspaces.id, workspaceA.id));

    const projectId = crypto.randomUUID();
    await isolated.db.insert(projects).values({
      id: projectId,
      workspaceId: workspaceA.id,
      name: 'Defaulted project',
      ownerPrincipalId: principalA,
      createdBy: ownerA,
      defaultModelConnectionId: id,
      defaultModel: 'claude-opus-4-5',
    });

    // The delete must succeed at all — if it did not null both columns of each pair in the same
    // statement, `workspaces_default_model_pair`/`projects_default_model_pair` would refuse the
    // FK's own `SET NULL` (which clears only the id column) and the whole delete would fail.
    await expect(acme.delete(id)).resolves.toMatchObject({ kind: 'deleted' });

    const [workspaceRow] = await isolated.db
      .select({
        defaultModelConnectionId: workspaces.defaultModelConnectionId,
        defaultModel: workspaces.defaultModel,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceA.id));
    expect(workspaceRow).toEqual({ defaultModelConnectionId: null, defaultModel: null });

    const [projectRow] = await isolated.db
      .select({
        defaultModelConnectionId: projects.defaultModelConnectionId,
        defaultModel: projects.defaultModel,
      })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(projectRow).toEqual({ defaultModelConnectionId: null, defaultModel: null });
  });

  it("leaves another workspace's default model alone when an unrelated connection is deleted", async () => {
    const untouchedId = crypto.randomUUID();
    await globex.create({
      id: untouchedId,
      name: 'Globex default',
      provider: 'openai',
      config: {},
    });
    await isolated.db
      .update(workspaces)
      .set({ defaultModelConnectionId: untouchedId, defaultModel: 'gpt-5.1' })
      .where(eq(workspaces.id, workspaceB.id));

    const otherId = crypto.randomUUID();
    await acme.create({ id: otherId, name: 'Acme unrelated', provider: 'anthropic', config: {} });
    await expect(acme.delete(otherId)).resolves.toMatchObject({ kind: 'deleted' });

    const [workspaceBRow] = await isolated.db
      .select({
        defaultModelConnectionId: workspaces.defaultModelConnectionId,
        defaultModel: workspaces.defaultModel,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceB.id));
    expect(workspaceBRow).toEqual({
      defaultModelConnectionId: untouchedId,
      defaultModel: 'gpt-5.1',
    });
  });

  it('refuses a workspace or project default that names only half of the (connection, model) pair', async () => {
    const id = crypto.randomUUID();
    await acme.create({ id, name: 'Half pair', provider: 'anthropic', config: {} });

    await expectConstraintViolation(
      isolated.db
        .update(workspaces)
        .set({ defaultModelConnectionId: id, defaultModel: null })
        .where(eq(workspaces.id, workspaceA.id)),
      'workspaces_default_model_pair',
    );

    await expectConstraintViolation(
      isolated.db
        .update(workspaces)
        .set({ defaultModelConnectionId: null, defaultModel: 'claude-sonnet-4-5' })
        .where(eq(workspaces.id, workspaceA.id)),
      'workspaces_default_model_pair',
    );

    const projectId = crypto.randomUUID();
    await isolated.db.insert(projects).values({
      id: projectId,
      workspaceId: workspaceA.id,
      name: 'Half pair project',
      ownerPrincipalId: principalA,
      createdBy: ownerA,
    });
    await expectConstraintViolation(
      isolated.db
        .update(projects)
        .set({ defaultModelConnectionId: id, defaultModel: null })
        .where(eq(projects.id, projectId)),
      'projects_default_model_pair',
    );
  });

  it('refuses a workspace or project default naming a connection from another workspace', async () => {
    const foreignId = crypto.randomUUID();
    await globex.create({ id: foreignId, name: 'Globex only', provider: 'openai', config: {} });

    // §25, via `workspaces_default_model_connection_workspace_fk`.
    await expectConstraintViolation(
      isolated.db
        .update(workspaces)
        .set({ defaultModelConnectionId: foreignId, defaultModel: 'gpt-5.1' })
        .where(eq(workspaces.id, workspaceA.id)),
      'workspaces_default_model_connection_workspace_fk',
    );

    // §25, via `projects_default_model_connection_workspace_fk`.
    const projectId = crypto.randomUUID();
    await isolated.db.insert(projects).values({
      id: projectId,
      workspaceId: workspaceA.id,
      name: 'Cross-tenant default project',
      ownerPrincipalId: principalA,
      createdBy: ownerA,
    });
    await expectConstraintViolation(
      isolated.db
        .update(projects)
        .set({ defaultModelConnectionId: foreignId, defaultModel: 'gpt-5.1' })
        .where(eq(projects.id, projectId)),
      'projects_default_model_connection_workspace_fk',
    );
  });
});
