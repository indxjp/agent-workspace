import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import { files } from '../schema/files.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { createDatabaseProjectFileRepositoryProvider } from './project-files.js';
import { createDatabaseProjectMcpServerRepositoryProvider } from './project-mcp-servers.js';
import type { ProjectFixture } from './projects.fixture.test-support.js';

/** Insert one enabled MCP connector and one tool connector into the fixture workspace. */
async function seedConnectors(fixture: ProjectFixture, mcpId: string, toolId: string) {
  const { workspaceId, principalId } = fixture;
  await fixture.isolated.db.insert(mcpServers).values([
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
}

/** Insert one plain file and one visitor upload under `.attachments/` into the fixture workspace. */
async function seedFiles(fixture: ProjectFixture, plainId: string, uploadId: string) {
  const { workspaceId, principalId, userId } = fixture;
  await fixture.isolated.db.insert(files).values([
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
}

/** `project_mcp_servers` refuses a tool connector on every write path, writing no row. */
export function registerConnectorBindingCases(fixture: ProjectFixture) {
  // #586: a project binds MCP connectors only. A tool connector (ADR-0113 C15) is refused on every
  // project_mcp_servers write path and no row is written.
  it('refuses to bind a tool connector through project_mcp_servers on every write path', async () => {
    const { isolated, repository, principalId, userId } = fixture;
    const mcpId = crypto.randomUUID();
    const toolId = crypto.randomUUID();
    await seedConnectors(fixture, mcpId, toolId);
    const bindings = createDatabaseProjectMcpServerRepositoryProvider(isolated.db).forScope(
      await fixture.scopeFor(fixture.workspaceId),
    );
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
}

/** `project_files` refuses a visitor upload on every write path, writing no row. */
export function registerFileBindingCases(fixture: ProjectFixture) {
  // ADR-0146 D6: a visitor upload under `.attachments/` is renamed out before it is bound; every
  // project_files write path refuses it and writes no row.
  it('refuses to bind a file under .attachments/ on every write path', async () => {
    const { isolated, repository, principalId, userId } = fixture;
    const plainId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    await seedFiles(fixture, plainId, uploadId);
    const bindings = createDatabaseProjectFileRepositoryProvider(isolated.db).forScope(
      await fixture.scopeFor(fixture.workspaceId),
    );
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
}
