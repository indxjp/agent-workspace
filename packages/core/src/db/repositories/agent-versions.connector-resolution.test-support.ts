import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { mcpServers } from '../schema/mcp-servers.js';
import { type createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
import { seedCatalogFile } from './catalog-fixtures.js';
export function registerConnectorResolutionCases(
  fixture: ReturnType<typeof createAgentVersionFixture>,
) {
  const { workspaceA, workspaceB, userA, principalA, principalB, defaultConnectionB } = fixture;

  it('resolves a files() grant on a folder that only has a file uploaded under it (#899)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'manuals', access: 'read' as const }],
    };
    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
      missing: [{ kind: 'file', name: 'manuals' }],
    });

    await seedCatalogFile(fixture.catalogA, {
      path: 'manuals/hydraulic-unit.md',
      kind: 'file',
      sizeBytes: 1,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });

    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { files: [{ access: 'read' }] },
    });
    await expect(fixture.repoB.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
    });
  });

  it('resolves a files() grant on a folder a file was moved into (#899)', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [{ path: 'moved-into', access: 'read' as const }],
    };
    await seedCatalogFile(fixture.catalogA, {
      path: 'loose.md',
      kind: 'file',
      sizeBytes: 1,
      contentType: 'text/markdown',
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'unresolved',
      missing: [{ kind: 'file', name: 'moved-into' }],
    });

    await fixture.catalogA.rename('loose.md', 'moved-into/loose.md');

    await expect(fixture.repoA.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { files: [{ access: 'read' }] },
    });
  });

  // C15: a tool connector is referenced by its name, and compose hands it to the engine through
  // the gateway (S2-02f, #531), so it resolves as an agent connector.
  it('resolves a tool connector named as an agent connector', async () => {
    const toolId = crypto.randomUUID();
    await fixture.isolated.db.insert(mcpServers).values({
      id: toolId,
      workspaceId: workspaceA,
      name: 'pets-tool',
      kind: 'openapi',
      ownerPrincipalId: principalA,
      transport: null,
      toolConfig: { openapi: {} },
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });
    await expect(
      fixture.repoA.resolveDefinition({
        modelConnectionName: null,
        runtimeProfileName: null,
        skills: [],
        connectors: ['pets-tool'],
        files: [],
      }),
    ).resolves.toMatchObject({ kind: 'resolved', references: { connectorIds: [toolId] } });
  });

  it('C7: null and "default" resolve to the default connection, or to the deployment default', async () => {
    const references = {
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;
    for (const modelConnectionName of [null, 'default']) {
      await expect(
        fixture.repoA.resolveDefinition({ ...references, modelConnectionName }),
      ).resolves.toMatchObject({ kind: 'resolved', references: { modelConnectionId: null } });
      await expect(
        fixture.repoB.resolveDefinition({ ...references, modelConnectionName }),
      ).resolves.toMatchObject({
        kind: 'resolved',
        references: { modelConnectionId: defaultConnectionB },
      });
    }
    await expect(
      fixture.repoA.resolveDefinition({ ...references, modelConnectionName: 'GPT' }),
    ).resolves.toEqual({
      kind: 'unresolved',
      missing: [{ kind: 'model-connection', name: 'GPT' }],
      ambiguous: [],
    });
  });

  it('names which connectors launch a process, in its own workspace only (#793)', async () => {
    const stdio = (name: string, workspaceId: string, ownerPrincipalId: string) => ({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      ownerPrincipalId,
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'orders-mcp@1.2.3'],
      authType: 'none' as const,
      credentialSecretId: null,
      enabled: true,
    });
    await fixture.isolated.db
      .insert(mcpServers)
      .values([
        stdio('stdio-zeta', workspaceA, principalA),
        stdio('stdio-alpha', workspaceA, principalA),
        stdio('stdio-b-only', workspaceB, principalB),
      ]);

    // `github` is an http connector and `missing` does not exist: neither launches a process.
    await expect(
      fixture.repoA.stdioConnectorNames([
        'stdio-zeta',
        'github',
        'stdio-alpha',
        'missing',
        'stdio-b-only',
        'stdio-alpha',
      ]),
    ).resolves.toEqual(['stdio-alpha', 'stdio-zeta']);
    await expect(fixture.repoA.stdioConnectorNames([])).resolves.toEqual([]);
    await expect(
      fixture.repoB.stdioConnectorNames(['stdio-alpha', 'stdio-b-only']),
    ).resolves.toEqual(['stdio-b-only']);
  });

  it('finds MCP connector ids by name, in its own workspace only (#1109)', async () => {
    const mcp = (name: string, workspaceId: string, ownerPrincipalId: string) => ({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      ownerPrincipalId,
      transport: 'http' as const,
      url: 'https://mcp.example.test/mcp',
      authType: 'none' as const,
      credentialSecretId: null,
      enabled: true,
    });
    const finder = mcp('ids-finder', workspaceA, principalA);
    const foreign = mcp('ids-foreign', workspaceB, principalB);
    await fixture.isolated.db.insert(mcpServers).values([finder, foreign]);
    await fixture.isolated.db.insert(mcpServers).values({
      workspaceId: workspaceA,
      name: 'ids-tool',
      kind: 'openapi',
      ownerPrincipalId: principalA,
      transport: null,
      toolConfig: { openapi: {} },
      authType: 'none',
      credentialSecretId: null,
      enabled: true,
    });

    // `ids-tool` is a tool connector and `ids-foreign` is workspace B's: neither is answered.
    const ids = await fixture.repoA.mcpConnectorIdsByName([
      'ids-finder',
      'ids-tool',
      'ids-foreign',
      'missing',
    ]);
    expect([...ids]).toEqual([['ids-finder', finder.id]]);
    await expect(fixture.repoA.mcpConnectorIdsByName([])).resolves.toEqual(new Map());
  });
}
