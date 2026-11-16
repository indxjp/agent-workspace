/**
 * `GET /api/sessions/:engineSessionId/file-search`: a run finds text only in the files it was
 * granted, only a runner may ask, and a session that is not the run's own is not found.
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { FileSearchResponseSchema } from '@indx-workspace/contracts/files';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as searchRoute } from '../../app/api/sessions/[engineSessionId]/file-search/route';
import { createCatalogFilesWorld } from '../files/catalog-runtime-fixtures';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { createRepositorySessionsStoreProvider } from './store';
import { seedCatalogFile } from '@agent-workspace/core/db';

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '22222222-3333-4444-8555-666666666666';
const RUN = '33333333-4444-4555-8666-777777777777';

const RUNNER: SessionApiPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE,
  runId: RUN,
  sessionId: SESSION,
};
const USER: SessionApiPrincipal = {
  kind: 'user',
  principalId: 'c8b1f0de-6a2e-4a1f-9d3b-000000000009',
  ownerPrincipalId: 'c8b1f0de-6a2e-4a1f-9d3b-000000000009',
  userId: null,
  workspaceId: WORKSPACE,
  role: 'owner',
};

const session = (id: string): SessionRecord => ({
  id,
  workspaceId: WORKSPACE,
  ownerPrincipalId: USER.principalId,
  userId: null,
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: null,
  engineSessionId: id,
  engine: 'claude-agent-sdk',
  agentVersionId: null,
  title: 'search',
  status: 'active',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
});

const sessionRows: SessionRepositoryProvider = {
  forScope: () => ({
    ensure: () => Promise.reject(new Error('unused')),
    get: (id) => Promise.resolve(id === SESSION ? session(SESSION) : null),
    getByEngineSessionId: () => Promise.resolve(null),
    list: () => Promise.reject(new Error('unused')),
    update: () => Promise.reject(new Error('unused')),
    archive: () => Promise.reject(new Error('unused')),
    restore: () => Promise.reject(new Error('unused')),
    discardIfUnused: () => Promise.reject(new Error('unused')),
  }),
};

const PATHS = ['manuals/a.pdf', 'hr/b.pdf'];

function wire(principal: SessionApiPrincipal | null, grants: readonly string[]): void {
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(principal),
      canAccessSession: (caller, id) =>
        Promise.resolve(caller.kind === 'runner' ? caller.sessionId === id : true),
      runFileGrants: () => Promise.resolve(grants),
      store: new InMemoryTranscriptStore(),
      sessions: createRepositorySessionsStoreProvider({
        repositories: sessionRows,
        scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
      }),
    },
  });
}

beforeEach(async () => {
  const catalog = createInMemoryCatalogStore();
  const rows = catalog.forWorkspaceSync(WORKSPACE);
  const FILES = await Promise.all(
    PATHS.map((path) =>
      seedCatalogFile(rows, {
        path,
        kind: 'file',
        sizeBytes: 1,
        contentType: 'application/pdf',
        ownerPrincipalId: USER.principalId,
      }),
    ),
  );
  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        ...createCatalogFilesWorld({
          catalogs: catalog,
          scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
        }).runtime,
        texts: {
          forWorkspace: () =>
            Promise.resolve({
              listStale: () => Promise.resolve([]),
              replace: () => Promise.resolve(true),
              search: (_tsquery, _limit, allowed) =>
                Promise.resolve(
                  FILES.filter((file) => allowed === null || allowed.includes(file.id)).map(
                    (file) => ({
                      fileId: file.id,
                      path: file.path,
                      page: 1,
                      text: 'the pump',
                      score: 0.5,
                    }),
                  ),
                ),
            }),
        },
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

const search = (id = SESSION, query = 'q=pump') =>
  searchRoute(new NextRequest(`https://control.example/api/sessions/${id}/file-search?${query}`), {
    params: Promise.resolve({ engineSessionId: id }),
  });

describe('GET /api/sessions/:engineSessionId/file-search', () => {
  it('answers only from the paths the run was granted', async () => {
    wire(RUNNER, ['manuals']);
    const response = await search();
    expect(response.status).toBe(200);
    const body = FileSearchResponseSchema.parse(await response.json());
    expect(body.hits.map((hit) => hit.path)).toEqual(['manuals/a.pdf']);
  });

  it('finds nothing for a run with no grants', async () => {
    wire(RUNNER, []);
    expect(await (await search()).json()).toEqual({ hits: [], pending: 0 });
  });

  it('refuses a non-runner with 403, no credential with 401, and a stranger session with 404', async () => {
    wire(USER, ['manuals']);
    expect((await search()).status).toBe(403);
    wire(null, ['manuals']);
    expect((await search()).status).toBe(401);
    wire(RUNNER, ['manuals']);
    expect((await search(OTHER_SESSION)).status).toBe(404);
  });

  it('refuses a malformed query', async () => {
    wire(RUNNER, ['manuals']);
    const response = await search(SESSION, 'q=');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_search_query' } });
  });
});
