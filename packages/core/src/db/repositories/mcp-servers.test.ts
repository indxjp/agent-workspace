/**
 * `McpServerRepository` against a real PostgreSQL — the conformance suite `./mcp-servers.ts`'s
 * header promises. Copies `./root.test.ts`'s isolated-database shape.
 *
 * A real `secrets` row is inserted through `@agent-workspace/core/secrets`'s own
 * `createSecretsService`, against the SAME database, rather than by hand-crafting envelope bytes —
 * this suite is about the connector row's shape, not about re-testing envelope encryption, and a
 * hand-rolled envelope would drift from what `secrets_wrapped_data_key_size` etc. actually require.
 */
import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSecretsService, type SecretsService } from '../../secrets/index.js';
import { mcpServers, type NewMcpServer } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { modelConnections } from '../schema/model-connections.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations, type PostgresViolation } from './violations.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[repositories/mcp-servers.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the connector ' +
      'repository was NOT exercised against a real PostgreSQL. A green result without it says ' +
      'nothing about McpServerRepository.',
  );
}

describe.skipIf(!hasDatabase)('McpServerRepository against real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let secretsService: SecretsService;
  let scopeA: WorkspaceScope;
  let scopeB: WorkspaceScope;
  let secretInA: string;
  let secretInB: string;

  const workspaceA = { id: crypto.randomUUID(), slug: 'w2cp05-a', name: 'A' };
  const workspaceB = { id: crypto.randomUUID(), slug: 'w2cp05-b', name: 'B' };
  /** `created_by` is tenant-paired to `memberships` (issue #117); one owner per workspace. */
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const membershipA = crypto.randomUUID();
  const membershipB = crypto.randomUUID();
  const principalA = crypto.randomUUID();
  const principalB = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w2cp05_mcp_servers');
    await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
    await isolated.db.insert(users).values([
      { id: userA, email: `${userA}@example.test`, name: 'Owner A' },
      { id: userB, email: `${userB}@example.test`, name: 'Owner B' },
    ]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: membershipA, workspaceId: workspaceA.id, userId: userA, role: 'owner' },
        { id: membershipB, workspaceId: workspaceB.id, userId: userB, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        {
          id: principalA,
          workspaceId: workspaceA.id,
          kind: 'membership',
          membershipId: membershipA,
        },
        {
          id: principalB,
          workspaceId: workspaceB.id,
          kind: 'membership',
          membershipId: membershipB,
        },
      ]);
    });

    // A scope minted the same way a request's would be — through the resolver, never a cast.
    const resolver = createDatabaseWorkspaceScopeResolver(isolated.db);
    const resolvedA = await resolver.forWorkspaceId(workspaceA.id);
    const resolvedB = await resolver.forWorkspaceId(workspaceB.id);
    if (resolvedA === null || resolvedB === null) {
      throw new Error('fixture setup failed: workspace scope did not resolve');
    }
    scopeA = resolvedA;
    scopeB = resolvedB;

    secretsService = await createSecretsService({
      DATABASE_URL: isolated.url,
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    });
    const createdInA = await secretsService.create(scopeA, {
      name: 'GITHUB_TOKEN',
      value: Buffer.from('gh-real-token', 'utf8'),
    });
    if (createdInA.kind !== 'created') throw new Error(`fixture setup failed: ${createdInA.kind}`);
    secretInA = createdInA.secret.id;

    const createdInB = await secretsService.create(scopeB, {
      name: 'GITHUB_TOKEN',
      value: Buffer.from('gh-real-token-b', 'utf8'),
    });
    if (createdInB.kind !== 'created') throw new Error(`fixture setup failed: ${createdInB.kind}`);
    secretInB = createdInB.secret.id;
  }, 180_000);

  afterAll(async () => {
    await secretsService.close();
    await isolated.close();
  });

  it('creates a stdio connector with no credential and lists it back', async () => {
    const provider = createDatabaseMcpServerRepositoryProvider(isolated.db);
    const repo = provider.forScope(scopeA);

    const outcome = await repo.create({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.server).toMatchObject({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      workspaceId: workspaceA.id,
    });

    const listed = await repo.list();
    expect(listed.map((s) => s.id)).toContain(outcome.server.id);
  });

  it('creates an http connector referencing a real secret row, by id — never by value', async () => {
    const provider = createDatabaseMcpServerRepositoryProvider(isolated.db);
    const repo = provider.forScope(scopeA);

    const outcome = await repo.create({
      name: 'GitHub',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://api.example.test/mcp',
      authType: 'bearer',
      credentialSecretId: secretInA,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.server.credentialSecretId).toBe(secretInA);
    // The point of the whole exercise: nothing on the record type or the row this reads back
    // could ever hold the plaintext "gh-real-token" — it is a reference, structurally.
    expect(JSON.stringify(outcome.server)).not.toContain('gh-real-token');

    const fetched = await repo.get(outcome.server.id);
    expect(fetched?.credentialSecretId).toBe(secretInA);
  });

  it('refuses a duplicate name in the same workspace', async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    await repo.create({
      name: 'Duplicate',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const second = await repo.create({
      name: 'Duplicate',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(second).toEqual({ kind: 'name-conflict', name: 'Duplicate' });
  });

  it('allows the same name in a different workspace (tenant isolation)', async () => {
    const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const repoB = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeB);
    await repoA.create({
      name: 'SameName',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const inB = await repoB.create({
      name: 'SameName',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalB,
      createdBy: userB,
    });
    expect(inB.kind).toBe('created');
  });

  it('refuses a credential secret id that does not exist', async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const bogus = crypto.randomUUID();
    const outcome = await repo.create({
      name: 'BadSecretRef',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://example.test/mcp',
      authType: 'bearer',
      credentialSecretId: bogus,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(outcome).toEqual({ kind: 'unknown-credential-secret', secretId: bogus });
  });

  it("refuses another workspace's secret as a credential reference (spec §25)", async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const outcome = await repo.create({
      name: 'CrossTenantSecretRef',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://example.test/mcp',
      authType: 'bearer',
      credentialSecretId: secretInB,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    expect(outcome).toEqual({ kind: 'unknown-credential-secret', secretId: secretInB });
  });

  it('deletes a connector, and a second delete answers not-found', async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const created = await repo.create({
      name: 'ToDelete',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    await expect(repo.delete(created.server.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(repo.delete(created.server.id)).resolves.toEqual({ kind: 'not-found' });
  });

  it("does not see another workspace's connector by id", async () => {
    const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const repoB = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeB);
    const created = await repoA.create({
      name: 'OnlyA',
      transport: 'stdio',
      command: 'true',
      args: null,
      url: null,
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');
    await expect(repoB.get(created.server.id)).resolves.toBeNull();
  });
  it('updates fields in place without moving the owner, and conceals another workspace (#240)', async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const repoB = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeB);
    const created = await repo.create({
      name: 'Update me',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://mcp.example.test/before',
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    if (created.kind !== 'created') throw new Error('fixture setup failed');

    await expect(repoB.update(created.server.id, { enabled: false })).resolves.toEqual({
      kind: 'not-found',
    });
    const updated = await repo.update(created.server.id, {
      name: 'Updated',
      enabled: false,
      url: 'https://mcp.example.test/after',
    });
    expect(updated).toMatchObject({
      kind: 'updated',
      server: {
        name: 'Updated',
        enabled: false,
        url: 'https://mcp.example.test/after',
        ownerPrincipalId: principalA,
        createdBy: userA,
      },
    });
    await expect(repo.update(created.server.id, { name: 'Filesystem' })).resolves.toEqual({
      kind: 'name-conflict',
      name: 'Filesystem',
    });
  });

  it('refuses to delete a secret a connector or a model connection references, naming both (#240)', async () => {
    const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
    const sealed = await secretsService.create(scopeA, {
      name: 'REFERENCED_BY_CONNECTOR',
      value: Buffer.from('referenced-value', 'utf8'),
    });
    if (sealed.kind !== 'created') throw new Error('fixture setup failed');
    const connector = await repo.create({
      name: 'Holds a credential',
      transport: 'http',
      command: null,
      args: null,
      url: 'https://mcp.example.test/credentialed',
      authType: 'bearer',
      credentialSecretId: sealed.secret.id,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    if (connector.kind !== 'created') throw new Error('fixture setup failed');

    // Another workspace cannot even find it; the referenced secret stays.
    await expect(secretsService.delete(scopeB, sealed.secret.id)).resolves.toEqual({
      kind: 'not-found',
    });
    const refused = await secretsService.delete(scopeA, sealed.secret.id);
    expect(refused).toEqual({
      kind: 'in-use',
      referrers: { connectorIds: [connector.server.id], modelConnectionIds: [] },
    });
    expect(JSON.stringify(refused)).not.toContain('referenced-value');

    // A model connection owns the secret its id names, by the MODEL_CONNECTION_* convention.
    const modelConnectionId = crypto.randomUUID();
    const owned = await secretsService.create(scopeA, {
      name: `MODEL_CONNECTION_${modelConnectionId.replace(/-/g, '').toUpperCase()}`,
      value: Buffer.from('model-key', 'utf8'),
    });
    if (owned.kind !== 'created') throw new Error('fixture setup failed');
    await isolated.db.insert(modelConnections).values({
      id: modelConnectionId,
      workspaceId: workspaceA.id,
      name: 'Model connection',
      provider: 'anthropic',
      config: {},
    });
    await expect(secretsService.delete(scopeA, owned.secret.id)).resolves.toEqual({
      kind: 'in-use',
      referrers: { connectorIds: [], modelConnectionIds: [modelConnectionId] },
    });

    // Once the connector stops referencing it, the delete succeeds and the row is gone.
    await expect(repo.delete(connector.server.id)).resolves.toEqual({ kind: 'deleted' });
    await expect(secretsService.delete(scopeA, sealed.secret.id)).resolves.toMatchObject({
      kind: 'deleted',
      secret: { id: sealed.secret.id },
    });
    const remaining = await secretsService.list(scopeA);
    expect(remaining.map((secret) => secret.id)).not.toContain(sealed.secret.id);
  });

  describe('connector kinds (issue #527, ADR-0113 C15)', () => {
    let rowCounter = 0;
    /** A raw row in workspace A, bypassing the repository, with a fresh name. */
    const rawRow = (overrides: Partial<NewMcpServer>): NewMcpServer => {
      rowCounter += 1;
      return {
        workspaceId: workspaceA.id,
        name: `kind-matrix-${String(rowCounter)}`,
        ownerPrincipalId: principalA,
        ...overrides,
      };
    };
    const insertRaw = (overrides: Partial<NewMcpServer>): Promise<unknown> =>
      isolated.db.insert(mcpServers).values(rawRow(overrides));
    async function violationsOf(write: Promise<unknown>): Promise<readonly PostgresViolation[]> {
      try {
        await write;
      } catch (error) {
        return [...postgresViolations(error)];
      }
      throw new Error('the write was expected to be refused');
    }
    const refusedBy = async (
      overrides: Partial<NewMcpServer>,
      constraint: string,
    ): Promise<void> => {
      expect(await violationsOf(insertRaw(overrides))).toContainEqual({
        code: '23514',
        constraint,
      });
    };
    const openapiConfig = {
      specUrl: 'https://api.example.test/openapi.json',
      auth: { type: 'none' },
    };
    const postgresConfig = { readOnly: true };

    const stdio: Partial<NewMcpServer> = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    };
    const http: Partial<NewMcpServer> = { transport: 'http', url: 'https://mcp.example.test/mcp' };
    const sse: Partial<NewMcpServer> = { transport: 'sse', url: 'https://mcp.example.test/sse' };

    it('accepts MCP stdio, http and sse rows as kind mcp with no tool_config', async () => {
      for (const shape of [stdio, http, sse]) {
        const rows = await isolated.db
          .insert(mcpServers)
          .values(rawRow(shape))
          .returning({ kind: mcpServers.kind, toolConfig: mcpServers.toolConfig });
        expect(rows).toEqual([{ kind: 'mcp', toolConfig: null }]);
      }
    });

    it('refuses an MCP row with no transport', async () => {
      await refusedBy(
        { kind: 'mcp', transport: null, url: 'https://x.example.test' },
        'mcp_servers_transport_by_kind',
      );
    });

    it('refuses a tool row that carries any MCP-only field', async () => {
      for (const kind of ['openapi', 'postgres'] as const) {
        const base = {
          kind,
          toolConfig: kind === 'openapi' ? openapiConfig : postgresConfig,
          credentialSecretId: secretInA,
        };
        await refusedBy({ ...base, transport: 'http' }, 'mcp_servers_transport_by_kind');
        await refusedBy({ ...base, command: 'npx' }, 'mcp_servers_tool_kind_fields');
        await refusedBy({ ...base, url: 'https://x.example.test' }, 'mcp_servers_tool_kind_fields');
        await refusedBy({ ...base, args: ['-y'] }, 'mcp_servers_tool_kind_fields');
      }
    });

    it('pairs tool_config with the kind and requires a JSON object', async () => {
      await refusedBy({ kind: 'openapi' }, 'mcp_servers_tool_config_by_kind');
      await refusedBy({ ...stdio, toolConfig: openapiConfig }, 'mcp_servers_tool_config_by_kind');
      // `$type` is a compile-time hint, so the non-object values are written as raw SQL.
      for (const [index, json] of ['[1, 2]', '"text"'].entries()) {
        const write = isolated.db.execute(sql`
          insert into mcp_servers (workspace_id, name, kind, tool_config, owner_principal_id)
          values (${workspaceA.id}, ${`kind-matrix-json-${String(index)}`}, 'openapi',
                  ${json}::jsonb, ${principalA})
        `);
        expect(await violationsOf(write)).toContainEqual({
          code: '23514',
          constraint: 'mcp_servers_tool_config_is_object',
        });
      }
    });

    it('pins a tool row to auth_type none and a postgres row to a credential', async () => {
      await refusedBy(
        {
          kind: 'openapi',
          toolConfig: openapiConfig,
          authType: 'bearer',
          credentialSecretId: secretInA,
        },
        'mcp_servers_tool_credential',
      );
      await refusedBy(
        { kind: 'postgres', toolConfig: postgresConfig },
        'mcp_servers_tool_credential',
      );
      await expect(
        insertRaw({ kind: 'openapi', toolConfig: openapiConfig }),
      ).resolves.toBeDefined();
      await expect(
        insertRaw({ kind: 'postgres', toolConfig: postgresConfig, credentialSecretId: secretInA }),
      ).resolves.toBeDefined();
    });

    it('keeps the MCP transport and credential checks for MCP rows', async () => {
      await refusedBy({ ...stdio, authType: 'bearer' }, 'mcp_servers_credential_required');
      await refusedBy({ transport: 'stdio' }, 'mcp_servers_stdio_has_command');
      await refusedBy({ transport: 'http' }, 'mcp_servers_remote_has_url');
      await refusedBy({ ...http, args: ['-y'] }, 'mcp_servers_args_are_stdio_only');
    });

    it('refuses an unknown kind', async () => {
      const write = isolated.db.execute(sql`
        insert into mcp_servers (workspace_id, name, kind, tool_config, owner_principal_id)
        values (${workspaceA.id}, 'kind-matrix-grpc', 'grpc', '{}'::jsonb, ${principalA})
      `);
      expect(await violationsOf(write)).toContainEqual({
        code: '23514',
        constraint: 'mcp_servers_kind_valid',
      });
    });

    it('keeps the MCP surface and the tool surface apart', async () => {
      const ws = await freshWorkspace();
      const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(ws.scope);
      const mcp = await repo.create({
        name: 'An MCP connector',
        transport: 'http',
        command: null,
        args: null,
        url: 'https://mcp.example.test/apart',
        authType: 'none',
        credentialSecretId: null,
        enabled: true,
        ownerPrincipalId: ws.principalId,
      });
      if (mcp.kind !== 'created') throw new Error(`fixture setup failed: ${mcp.kind}`);
      const tool = await repo.createToolConnector({
        name: 'An OpenAPI connector',
        kind: 'openapi',
        toolConfig: openapiConfig,
        credentialSecretId: null,
        enabled: true,
        ownerPrincipalId: ws.principalId,
      });
      if (tool.kind !== 'created') throw new Error(`fixture setup failed: ${tool.kind}`);
      expect(tool.connector).toMatchObject({
        name: 'An OpenAPI connector',
        kind: 'openapi',
        toolConfig: openapiConfig,
        credentialSecretId: null,
        enabled: true,
        workspaceId: ws.workspaceId,
        ownerPrincipalId: ws.principalId,
        createdBy: null,
      });
      expect(tool.connector).not.toHaveProperty('transport');
      expect(tool.connector).not.toHaveProperty('authType');

      expect((await repo.list()).map((row) => row.id)).toEqual([mcp.server.id]);
      expect((await repo.listToolConnectors()).map((row) => row.id)).toEqual([tool.connector.id]);
      await expect(repo.get(tool.connector.id)).resolves.toBeNull();
      await expect(repo.getToolConnector(mcp.server.id)).resolves.toBeNull();
      await expect(repo.getToolConnector(tool.connector.id)).resolves.toEqual(tool.connector);

      await expect(repo.update(tool.connector.id, { name: 'Renamed' })).resolves.toEqual({
        kind: 'not-found',
      });
      await expect(repo.updateToolConnector(mcp.server.id, { name: 'Renamed' })).resolves.toEqual({
        kind: 'not-found',
      });

      const updated = await repo.updateToolConnector(tool.connector.id, {
        enabled: false,
        toolConfig: { ...openapiConfig, baseUrl: 'https://api.example.test' },
      });
      expect(updated).toMatchObject({
        kind: 'updated',
        connector: {
          kind: 'openapi',
          enabled: false,
          toolConfig: { ...openapiConfig, baseUrl: 'https://api.example.test' },
        },
      });

      // The name is unique across kinds, in both directions.
      await expect(
        repo.createToolConnector({
          name: 'An MCP connector',
          kind: 'postgres',
          toolConfig: postgresConfig,
          credentialSecretId: ws.secretId,
          enabled: true,
          ownerPrincipalId: ws.principalId,
        }),
      ).resolves.toEqual({ kind: 'name-conflict', name: 'An MCP connector' });
      await expect(
        repo.updateToolConnector(tool.connector.id, { name: 'An MCP connector' }),
      ).resolves.toEqual({ kind: 'name-conflict', name: 'An MCP connector' });
      await expect(repo.update(mcp.server.id, { name: 'An OpenAPI connector' })).resolves.toEqual({
        kind: 'name-conflict',
        name: 'An OpenAPI connector',
      });

      // delete is by id and kind-agnostic.
      await expect(repo.delete(tool.connector.id)).resolves.toEqual({ kind: 'deleted' });
      await expect(repo.listToolConnectors()).resolves.toEqual([]);
    });

    it("refuses another workspace's secret and conceals another workspace's connector", async () => {
      const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
      const repoB = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeB);
      await expect(
        repoA.createToolConnector({
          name: 'Borrowed credential',
          kind: 'postgres',
          toolConfig: postgresConfig,
          credentialSecretId: secretInB,
          enabled: true,
          ownerPrincipalId: principalA,
        }),
      ).resolves.toEqual({ kind: 'unknown-credential-secret', secretId: secretInB });

      const created = await repoA.createToolConnector({
        name: 'Workspace A database',
        kind: 'postgres',
        toolConfig: postgresConfig,
        credentialSecretId: secretInA,
        enabled: true,
        ownerPrincipalId: principalA,
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      await expect(
        repoA.updateToolConnector(created.connector.id, { credentialSecretId: secretInB }),
      ).resolves.toEqual({ kind: 'unknown-credential-secret', secretId: secretInB });
      await expect(repoB.getToolConnector(created.connector.id)).resolves.toBeNull();
      await expect(
        repoB.updateToolConnector(created.connector.id, { enabled: false }),
      ).resolves.toEqual({ kind: 'not-found' });
      expect((await repoB.listToolConnectors()).map((row) => row.id)).not.toContain(
        created.connector.id,
      );
    });

    it('re-throws a CHECK violation rather than classifying it (ADR-0015)', async () => {
      const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
      // A postgres connector without its credential is a programming error the server validates
      // first, so the repository surfaces it instead of inventing an outcome for it.
      await expect(
        repoA.createToolConnector({
          name: 'No credential',
          kind: 'postgres',
          toolConfig: postgresConfig,
          credentialSecretId: null,
          enabled: true,
          ownerPrincipalId: principalA,
        }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'mcp_servers_tool_credential' },
      });

      // The update path carries the same precondition: clearing a postgres connector's
      // credential is the CHECK violation, re-thrown, and the row keeps its credential.
      const created = await repoA.createToolConnector({
        name: 'Credential kept',
        kind: 'postgres',
        toolConfig: postgresConfig,
        credentialSecretId: secretInA,
        enabled: true,
        ownerPrincipalId: principalA,
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      await expect(
        repoA.updateToolConnector(created.connector.id, { credentialSecretId: null }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'mcp_servers_tool_credential' },
      });
      await expect(repoA.getToolConnector(created.connector.id)).resolves.toMatchObject({
        credentialSecretId: secretInA,
      });
    });

    it('answers a malformed id as absent, never a database error', async () => {
      const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
      await expect(repoA.getToolConnector('nope')).resolves.toBeNull();
      await expect(repoA.updateToolConnector('nope', { enabled: false })).resolves.toEqual({
        kind: 'not-found',
      });
      await expect(
        repoA.createToolConnector({
          name: 'Malformed credential',
          kind: 'postgres',
          toolConfig: postgresConfig,
          credentialSecretId: 'not-uuid',
          enabled: true,
          ownerPrincipalId: principalA,
        }),
      ).resolves.toEqual({ kind: 'unknown-credential-secret', secretId: 'not-uuid' });
      const created = await repoA.createToolConnector({
        name: 'Malformed credential patch',
        kind: 'postgres',
        toolConfig: postgresConfig,
        credentialSecretId: secretInA,
        enabled: true,
        ownerPrincipalId: principalA,
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      await expect(
        repoA.updateToolConnector(created.connector.id, { credentialSecretId: 'not-uuid' }),
      ).resolves.toEqual({ kind: 'unknown-credential-secret', secretId: 'not-uuid' });
    });

    it('refuses U+0000 in a tool configuration before it reaches jsonb', async () => {
      const repoA = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeA);
      await expect(
        repoA.createToolConnector({
          name: 'NUL in config',
          kind: 'openapi',
          toolConfig: { ...openapiConfig, title: 'a\u0000b' },
          credentialSecretId: null,
          enabled: true,
          ownerPrincipalId: principalA,
        }),
      ).rejects.toThrow(/U\+0000/u);
      await expect(
        repoA.createToolConnector({
          name: 'NUL in a nested key',
          kind: 'openapi',
          toolConfig: { ...openapiConfig, headers: [{ 'x\u0000': 'v' }] },
          credentialSecretId: null,
          enabled: true,
          ownerPrincipalId: principalA,
        }),
      ).rejects.toThrow(/U\+0000/u);
      expect((await repoA.listToolConnectors()).map((row) => row.name)).not.toContain(
        'NUL in config',
      );
    });

    it('keeps an openapi connector document tenant-scoped, out of every record, and across updates', async () => {
      const ws = await freshWorkspace();
      const repo = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(ws.scope);
      const repoOther = createDatabaseMcpServerRepositoryProvider(isolated.db).forScope(scopeB);
      const document = '{"openapi": "3.0.0",\n "info": {"title": "Pets \u00e9"}}\n';
      const created = await repo.createToolConnector({
        name: 'Pets',
        kind: 'openapi',
        toolConfig: openapiConfig,
        openapiDocument: document,
        credentialSecretId: null,
        enabled: true,
        ownerPrincipalId: ws.principalId,
      });
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      const id = created.connector.id;

      // Byte-identical, and never part of a record.
      await expect(repo.getOpenApiDocument(id)).resolves.toBe(document);
      expect(created.connector).not.toHaveProperty('openapiDocument');
      expect(JSON.stringify(await repo.listToolConnectors())).not.toContain('3.0.0');
      expect(await repo.getToolConnector(id)).not.toHaveProperty('openapiDocument');

      // Another workspace, an MCP connector's id and a malformed id all read as absent.
      await expect(repoOther.getOpenApiDocument(id)).resolves.toBeNull();
      const mcp = await repo.create({
        name: 'An MCP connector',
        transport: 'http',
        command: null,
        args: null,
        url: 'https://mcp.example.test/doc',
        authType: 'none',
        credentialSecretId: null,
        enabled: true,
        ownerPrincipalId: ws.principalId,
      });
      if (mcp.kind !== 'created') throw new Error(`fixture setup failed: ${mcp.kind}`);
      await expect(repo.getOpenApiDocument(mcp.server.id)).resolves.toBeNull();
      await expect(repo.getOpenApiDocument('nope')).resolves.toBeNull();

      // A rename keeps it; a full replacement swaps it; a later update without it keeps the swap.
      await repo.updateToolConnector(id, { name: 'Pets renamed' });
      await expect(repo.getOpenApiDocument(id)).resolves.toBe(document);
      await repo.updateToolConnector(id, {
        toolConfig: openapiConfig,
        openapiDocument: 'openapi: 3.1.0\n',
      });
      await expect(repo.getOpenApiDocument(id)).resolves.toBe('openapi: 3.1.0\n');
      await repo.updateToolConnector(id, { enabled: false });
      await expect(repo.getOpenApiDocument(id)).resolves.toBe('openapi: 3.1.0\n');

      // A row written by a revision that predates the column has no document.
      const legacy = await isolated.db
        .insert(mcpServers)
        .values({
          workspaceId: ws.workspaceId,
          name: 'Legacy pets',
          kind: 'openapi',
          toolConfig: openapiConfig,
          ownerPrincipalId: ws.principalId,
        })
        .returning({ id: mcpServers.id });
      const legacyId = legacy[0]?.id;
      if (legacyId === undefined) throw new Error('fixture setup failed: no legacy row');
      await expect(repo.getOpenApiDocument(legacyId)).resolves.toBeNull();
    });

    /** A workspace of its own, so list assertions see only this test's rows. */
    async function freshWorkspace(): Promise<{
      workspaceId: string;
      principalId: string;
      secretId: string;
      scope: WorkspaceScope;
    }> {
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: `kinds-${workspaceId.slice(0, 8)}`, name: 'Kinds' });
      await isolated.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, name: 'Kinds owner' });
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId, userId, role: 'owner' });
        await tx
          .insert(workspacePrincipals)
          .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
      });
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspaceId,
      );
      if (scope === null) throw new Error('fixture setup failed: workspace scope did not resolve');
      const secret = await secretsService.create(scope, {
        name: 'DATABASE_URL',
        value: Buffer.from('postgres://example', 'utf8'),
      });
      if (secret.kind !== 'created') throw new Error(`fixture setup failed: ${secret.kind}`);
      return { workspaceId, principalId, secretId: secret.secret.id, scope };
    }
  });
});
