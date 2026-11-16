import { expect, it } from 'vitest';

import { mcpServers } from '../schema/mcp-servers.js';
import {
  created,
  httpConnector,
  openapiConfig,
  type FreshWorkspace,
  type McpServerFixture,
} from './mcp-servers.fixture.test-support.js';
import { type CreateToolConnectorInput } from './mcp-servers.js';

/** An MCP connector and an OpenAPI tool connector side by side in a fresh workspace. */
async function bothSurfaces(fixture: McpServerFixture, ws: FreshWorkspace) {
  const repo = fixture.repo(ws.scope);
  const mcp = created(
    await repo.create(
      httpConnector({
        name: 'An MCP connector',
        url: 'https://mcp.example.test/apart',
        ownerPrincipalId: ws.principalId,
      }),
    ),
  ).server;
  const tool = created(
    await repo.createToolConnector(
      fixture.toolConnector({
        name: 'An OpenAPI connector',
        kind: 'openapi',
        ownerPrincipalId: ws.principalId,
      }),
    ),
  ).connector;
  expect(tool).toMatchObject({
    name: 'An OpenAPI connector',
    kind: 'openapi',
    toolConfig: openapiConfig,
    credentialSecretId: null,
    enabled: true,
    workspaceId: ws.workspaceId,
    ownerPrincipalId: ws.principalId,
    createdBy: null,
  });
  expect(tool).not.toHaveProperty('transport');
  expect(tool).not.toHaveProperty('authType');
  return { repo, mcpId: mcp.id, toolId: tool.id, tool };
}

/** The name is unique across kinds, in both directions. */
async function expectNamesUniqueAcrossKinds(
  { toolConnector }: McpServerFixture,
  ws: FreshWorkspace,
  { repo, mcpId, toolId }: Awaited<ReturnType<typeof bothSurfaces>>,
): Promise<void> {
  const conflict = (name: string) => ({ kind: 'name-conflict', name });
  await expect(
    repo.createToolConnector(
      toolConnector({
        name: 'An MCP connector',
        kind: 'postgres',
        credentialSecretId: ws.secretId,
        ownerPrincipalId: ws.principalId,
      }),
    ),
  ).resolves.toEqual(conflict('An MCP connector'));
  await expect(repo.updateToolConnector(toolId, { name: 'An MCP connector' })).resolves.toEqual(
    conflict('An MCP connector'),
  );
  await expect(repo.update(mcpId, { name: 'An OpenAPI connector' })).resolves.toEqual(
    conflict('An OpenAPI connector'),
  );
}

function registerSurfaceCases(fixture: McpServerFixture): void {
  it('keeps the MCP surface and the tool surface apart', async () => {
    const ws = await fixture.freshWorkspace();
    const surfaces = await bothSurfaces(fixture, ws);
    const { repo, mcpId, toolId, tool } = surfaces;

    expect((await repo.list()).map((row) => row.id)).toEqual([mcpId]);
    expect((await repo.listToolConnectors()).map((row) => row.id)).toEqual([toolId]);
    await expect(repo.get(toolId)).resolves.toBeNull();
    await expect(repo.getToolConnector(mcpId)).resolves.toBeNull();
    await expect(repo.getToolConnector(toolId)).resolves.toEqual(tool);

    const notFound = { kind: 'not-found' };
    await expect(repo.update(toolId, { name: 'Renamed' })).resolves.toEqual(notFound);
    await expect(repo.updateToolConnector(mcpId, { name: 'Renamed' })).resolves.toEqual(notFound);

    const toolConfig = { ...openapiConfig, baseUrl: 'https://api.example.test' };
    const updated = await repo.updateToolConnector(toolId, { enabled: false, toolConfig });
    expect(updated).toMatchObject({
      kind: 'updated',
      connector: { kind: 'openapi', enabled: false, toolConfig },
    });

    await expectNamesUniqueAcrossKinds(fixture, ws, surfaces);

    // delete is by id and kind-agnostic.
    await expect(repo.delete(toolId)).resolves.toEqual({ kind: 'deleted' });
    await expect(repo.listToolConnectors()).resolves.toEqual([]);
  });
}

function registerToolCredentialCases(fixture: McpServerFixture): void {
  const postgres = (name: string, credentialSecretId: string | null) =>
    fixture.toolConnector({ name, kind: 'postgres', credentialSecretId });
  const checkViolation = { cause: { code: '23514', constraint: 'mcp_servers_tool_credential' } };

  it("refuses another workspace's secret and conceals another workspace's connector", async () => {
    const { secretInB } = fixture;
    const repoA = fixture.repo(fixture.scopeA);
    const repoB = fixture.repo(fixture.scopeB);
    const unknownB = { kind: 'unknown-credential-secret', secretId: secretInB };
    await expect(
      repoA.createToolConnector(postgres('Borrowed credential', secretInB)),
    ).resolves.toEqual(unknownB);

    const { connector } = created(
      await repoA.createToolConnector(postgres('Workspace A database', fixture.secretInA)),
    );
    await expect(
      repoA.updateToolConnector(connector.id, { credentialSecretId: secretInB }),
    ).resolves.toEqual(unknownB);
    await expect(repoB.getToolConnector(connector.id)).resolves.toBeNull();
    await expect(repoB.updateToolConnector(connector.id, { enabled: false })).resolves.toEqual({
      kind: 'not-found',
    });
    expect((await repoB.listToolConnectors()).map((row) => row.id)).not.toContain(connector.id);
  });

  it('re-throws a CHECK violation rather than classifying it (ADR-0015)', async () => {
    const repoA = fixture.repo(fixture.scopeA);
    // A postgres connector without its credential is a programming error the server validates
    // first, so the repository surfaces it instead of inventing an outcome for it.
    await expect(repoA.createToolConnector(postgres('No credential', null))).rejects.toMatchObject(
      checkViolation,
    );

    // The update path carries the same precondition: clearing a postgres connector's
    // credential is the CHECK violation, re-thrown, and the row keeps its credential.
    const { connector } = created(
      await repoA.createToolConnector(postgres('Credential kept', fixture.secretInA)),
    );
    await expect(
      repoA.updateToolConnector(connector.id, { credentialSecretId: null }),
    ).rejects.toMatchObject(checkViolation);
    await expect(repoA.getToolConnector(connector.id)).resolves.toMatchObject({
      credentialSecretId: fixture.secretInA,
    });
  });
}

function registerMalformedInputCases(fixture: McpServerFixture): void {
  const postgres = (name: string, credentialSecretId: string) =>
    fixture.toolConnector({ name, kind: 'postgres', credentialSecretId });

  it('answers a malformed id as absent, never a database error', async () => {
    const repoA = fixture.repo(fixture.scopeA);
    const unknown = { kind: 'unknown-credential-secret', secretId: 'not-uuid' };
    await expect(repoA.getToolConnector('nope')).resolves.toBeNull();
    await expect(repoA.updateToolConnector('nope', { enabled: false })).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(
      repoA.createToolConnector(postgres('Malformed credential', 'not-uuid')),
    ).resolves.toEqual(unknown);
    const { connector } = created(
      await repoA.createToolConnector(postgres('Malformed credential patch', fixture.secretInA)),
    );
    await expect(
      repoA.updateToolConnector(connector.id, { credentialSecretId: 'not-uuid' }),
    ).resolves.toEqual(unknown);
  });

  it('refuses U+0000 in a tool configuration before it reaches jsonb', async () => {
    const repoA = fixture.repo(fixture.scopeA);
    const openapi = (name: string, toolConfig: CreateToolConnectorInput['toolConfig']) =>
      repoA.createToolConnector(fixture.toolConnector({ name, kind: 'openapi', toolConfig }));
    await expect(openapi('NUL in config', { ...openapiConfig, title: 'a\u0000b' })).rejects.toThrow(
      /U\+0000/u,
    );
    await expect(
      openapi('NUL in a nested key', { ...openapiConfig, headers: [{ 'x\u0000': 'v' }] }),
    ).rejects.toThrow(/U\+0000/u);
    expect((await repoA.listToolConnectors()).map((row) => row.name)).not.toContain(
      'NUL in config',
    );
  });
}

/** Another workspace, an MCP connector's id and a malformed id all read as absent. */
async function expectDocumentAbsentElsewhere(
  fixture: McpServerFixture,
  ws: FreshWorkspace,
  id: string,
): Promise<void> {
  const repo = fixture.repo(ws.scope);
  await expect(fixture.repo(fixture.scopeB).getOpenApiDocument(id)).resolves.toBeNull();
  const mcp = created(
    await repo.create(
      httpConnector({
        name: 'An MCP connector',
        url: 'https://mcp.example.test/doc',
        ownerPrincipalId: ws.principalId,
      }),
    ),
  );
  await expect(repo.getOpenApiDocument(mcp.server.id)).resolves.toBeNull();
  await expect(repo.getOpenApiDocument('nope')).resolves.toBeNull();
}

/** A row written by a revision that predates the column has no document. */
async function expectLegacyRowHasNoDocument(
  fixture: McpServerFixture,
  ws: FreshWorkspace,
): Promise<void> {
  const legacy = await fixture.isolated.db
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
  await expect(fixture.repo(ws.scope).getOpenApiDocument(legacyId)).resolves.toBeNull();
}

function registerOpenApiDocumentCases(fixture: McpServerFixture): void {
  it('keeps an openapi connector document tenant-scoped, out of every record, and across updates', async () => {
    const ws = await fixture.freshWorkspace();
    const repo = fixture.repo(ws.scope);
    const document = '{"openapi": "3.0.0",\n "info": {"title": "Pets \u00e9"}}\n';
    const { connector } = created(
      await repo.createToolConnector(
        fixture.toolConnector({
          name: 'Pets',
          kind: 'openapi',
          openapiDocument: document,
          ownerPrincipalId: ws.principalId,
        }),
      ),
    );
    const id = connector.id;

    // Byte-identical, and never part of a record.
    await expect(repo.getOpenApiDocument(id)).resolves.toBe(document);
    expect(connector).not.toHaveProperty('openapiDocument');
    expect(JSON.stringify(await repo.listToolConnectors())).not.toContain('3.0.0');
    expect(await repo.getToolConnector(id)).not.toHaveProperty('openapiDocument');

    await expectDocumentAbsentElsewhere(fixture, ws, id);

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

    await expectLegacyRowHasNoDocument(fixture, ws);
  });
}

/** The repository's tool-connector surface beside its MCP surface. */
export function registerToolConnectorCases(fixture: McpServerFixture): void {
  registerSurfaceCases(fixture);
  registerToolCredentialCases(fixture);
  registerMalformedInputCases(fixture);
  registerOpenApiDocumentCases(fixture);
}
