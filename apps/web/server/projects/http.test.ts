import { describe, expect, it } from 'vitest';

import {
  parseProject,
  parseProjectListFilter,
  parseProjectPatch,
  projectConnectorKindRefusal,
} from './http';

describe('project request parsing', () => {
  it('keeps create defaults at the create boundary', () => {
    expect(parseProject({ name: ' New project ' })).toEqual({
      name: 'New project',
      visibility: 'private',
      fileIds: [],
      mcpServerIds: [],
    });
  });

  it('preserves omitted PATCH fields instead of replacing them with create defaults', () => {
    expect(parseProjectPatch({ name: ' Renamed ' })).toEqual({ name: 'Renamed' });
    expect(parseProjectPatch({ instructions: null, fileIds: [] })).toEqual({
      instructions: null,
      fileIds: [],
    });
  });

  it('rejects malformed association arrays rather than silently clearing them', () => {
    expect(() => parseProject({ name: 'Project', fileIds: 'not-an-array' })).toThrow(
      'fileIds must be an array of ids.',
    );
    expect(() => parseProjectPatch({ mcpServerIds: [1] })).toThrow(
      'mcpServerIds must be an array of ids.',
    );
  });

  it('deduplicates association ids before persistence', () => {
    expect(parseProjectPatch({ fileIds: ['one', 'one', 'two'] })).toEqual({
      fileIds: ['one', 'two'],
    });
  });

  it('accepts project model defaults only as a complete pair', () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    expect(
      parseProjectPatch({
        defaultModelConnectionId: connectionId,
        defaultModel: 'claude-sonnet-4-5',
      }),
    ).toEqual({
      defaultModelConnectionId: connectionId,
      defaultModel: 'claude-sonnet-4-5',
    });
    expect(parseProjectPatch({ defaultModelConnectionId: null, defaultModel: null })).toEqual({
      defaultModelConnectionId: null,
      defaultModel: null,
    });
    expect(() => parseProjectPatch({ defaultModelConnectionId: connectionId })).toThrow(
      'must be updated together',
    );
    expect(() =>
      parseProjectPatch({ defaultModelConnectionId: null, defaultModel: 'model-one' }),
    ).toThrow('must be a UUID');
  });

  it('rejects a defaultModelConnectionId that is not a UUID, rather than deferring to the database', () => {
    expect(() =>
      parseProjectPatch({ defaultModelConnectionId: 'connection-one', defaultModel: 'model-one' }),
    ).toThrow('must be a UUID');
    expect(() =>
      parseProjectPatch({ defaultModelConnectionId: '', defaultModel: 'model-one' }),
    ).toThrow('must be a UUID');
  });

  it('rejects an empty patch instead of accepting a no-op mutation', () => {
    expect(() => parseProjectPatch({})).toThrow('must not be empty');
  });

  it('rejects unknown fields rather than silently dropping a client typo', () => {
    expect(() => parseProjectPatch({ visiblity: 'private' })).toThrow(
      'Unknown project field: visiblity.',
    );
  });

  // issue #183: the `GET /api/projects` filter control `docs/adr/W9-PROJ-182-*.md` obliges the
  // task that ships the archive route to land with it.
  it('defaults the project list to active projects and refuses an unrecognised filter', () => {
    const filter = (query: string): string =>
      parseProjectListFilter(new Request(`https://example.invalid/api/projects${query}`));
    expect(filter('')).toBe('active');
    expect(filter('?archived=active')).toBe('active');
    expect(filter('?archived=archived')).toBe('archived');
    expect(filter('?archived=all')).toBe('all');
    // Never silently read as the default: a caller who misspells `all` must learn it saw a
    // filtered list rather than assume it saw everything.
    expect(() => filter('?archived=yes')).toThrow('archived must be one of');
    expect(() => filter('?archived=')).toThrow('archived must be one of');
  });
});

describe('projectConnectorKindRefusal (#586)', () => {
  it("answers the repository's tool connector refusal as 400 project_connector_not_mcp", async () => {
    const refused = Object.assign(new Error('a project binds MCP connectors only'), {
      name: 'ProjectConnectorKindError',
    });
    const response = projectConnectorKindRefusal(refused);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: 'project_connector_not_mcp' },
    });
  });

  it("answers a binding of an .attachments/ file as the agent assignment's 400 unknown_file (ADR-0146 D6)", async () => {
    const refused = Object.assign(new Error('reserved'), { name: 'ProjectFileReservedError' });
    const response = projectConnectorKindRefusal(refused);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: 'unknown_file' } });
  });

  it('leaves every other failure to the generic mapping', () => {
    expect(projectConnectorKindRefusal(new Error('boom'))).toBeNull();
    expect(projectConnectorKindRefusal({ name: 'ProjectConnectorKindError' })).toBeNull();
  });
});
