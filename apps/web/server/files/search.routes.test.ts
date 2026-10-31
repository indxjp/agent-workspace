/**
 * `GET /api/files/search`, imported as Next.js imports it and driven with real `Request` objects.
 * The text cache is a fake keyed by workspace; the SQL itself is covered by the repository test.
 */
import { FileSearchResponseSchema } from '@indx-workspace/contracts/files';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as searchRoute } from '../../app/api/files/search/route';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createCatalogFilesWorld } from './catalog-runtime-fixtures';
import type { FileTextStore } from './store';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { seedCatalogFile } from '@agent-workspace/core/db';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_HEADER = 'x-test-workspace';
const SCOPE_HEADER = 'x-test-session-scope';

const ATTACHMENT = '.attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc/u1/scan.txt';

/** The ids the catalog gave a workspace's two seeded files. */
interface Seeded {
  readonly pump: string;
  readonly attachment: string;
}

function textsFor(workspaceId: string, ids: Seeded, fail = false): FileTextStore {
  const passages: Record<string, { fileId: string; path: string; text: string }> = {
    "'pump'": { fileId: ids.pump, path: `${workspaceId}/pump.pdf`, text: 'the pump' },
    "'zebracorn'": { fileId: ids.attachment, path: ATTACHMENT, text: 'a zebracorn invoice' },
  };
  return {
    listStale: () => Promise.resolve([]),
    replace: () => Promise.resolve(true),
    search: (tsquery, _limit, allowedFileIds) => {
      if (fail) return Promise.reject(new Error('select * from file_texts: password=hunter2'));
      const passage = passages[tsquery];
      return Promise.resolve(
        passage === undefined ||
          (allowedFileIds !== null && !allowedFileIds.includes(passage.fileId))
          ? []
          : [{ ...passage, page: 2, score: 0.25 }],
      );
    },
  };
}

/** A fresh catalog holding, in each workspace, one searchable file and one chat attachment. */
async function seedCatalogs() {
  const catalogs = createInMemoryCatalogStore();
  const ids = new Map<string, Seeded>();
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    const catalog = catalogs.forWorkspaceSync(workspaceId);
    const put = (path: string) =>
      seedCatalogFile(catalog, {
        path,
        kind: 'file',
        sizeBytes: 1,
        contentType: 'text/plain',
        ownerPrincipalId: crypto.randomUUID(),
      });
    const pump = await put(`${workspaceId}/pump.pdf`);
    const attachment = await put(ATTACHMENT);
    ids.set(workspaceId, { pump: pump.id, attachment: attachment.id });
  }
  const idsOf = (workspaceId: string): Seeded => {
    const seeded = ids.get(workspaceId);
    if (seeded === undefined) throw new Error(`no seeded files for ${workspaceId}`);
    return seeded;
  };
  return { catalogs, idsOf };
}

async function wire(options: { texts?: boolean; fail?: boolean } = {}): Promise<void> {
  const { catalogs, idsOf } = await seedCatalogs();
  const world = createCatalogFilesWorld({
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_A, WORKSPACE_B].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    catalogs,
    resolveWorkspace: (request) => {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? { kind: 'unauthenticated', reason: 'no test workspace header' }
          : { kind: 'workspace', workspaceId },
      );
    },
  });
  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        ...world.runtime,
        ...(options.texts === false
          ? {}
          : {
              texts: {
                forWorkspace: (id: string) =>
                  Promise.resolve(textsFor(id, idsOf(id), options.fail)),
              },
            }),
      },
    },
  });
}

beforeEach(async () => {
  await wire();
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [{ email: 'a@example.test', name: 'A', workspaceId: WORKSPACE_A, role: 'owner' }],
      }),
      identify(request: Request) {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const scopeId = request.headers.get(SCOPE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
                apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId,
                role: 'owner',
                label: 'Search route test key',
                ...(scopeId === null ? {} : { scope: { kind: 'session', id: scopeId } }),
              }),
        );
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
  vi.restoreAllMocks();
});

const get = (url: string, headers: Record<string, string> = { [WORKSPACE_HEADER]: WORKSPACE_A }) =>
  searchRoute(new Request(`https://example.invalid${url}`, { headers }));

describe('GET /api/files/search', () => {
  it('answers the contract shape for the caller workspace only', async () => {
    const a = await get('/api/files/search?q=pump');
    expect(a.status).toBe(200);
    const body = FileSearchResponseSchema.parse(await a.json());
    expect(body.hits.map((hit) => hit.path)).toEqual([`${WORKSPACE_A}/pump.pdf`]);
    const b = await get('/api/files/search?q=pump', { [WORKSPACE_HEADER]: WORKSPACE_B });
    expect(FileSearchResponseSchema.parse(await b.json()).hits[0]?.path).toBe(
      `${WORKSPACE_B}/pump.pdf`,
    );
  });

  it('never returns a file under .attachments/ to a workspace member', async () => {
    const response = await get('/api/files/search?q=zebracorn');
    expect(response.status).toBe(200);
    expect(FileSearchResponseSchema.parse(await response.json()).hits).toEqual([]);
  });

  it.each([
    ['an empty q', '/api/files/search?q='],
    ['a missing q', '/api/files/search'],
    ['a q of only operators', '/api/files/search?q=%26%7C!'],
    ['an unknown parameter', '/api/files/search?q=pump&workspace=other'],
    ['a repeated parameter', '/api/files/search?q=pump&q=pipe'],
    ['an oversize limit', '/api/files/search?q=pump&limit=51'],
  ])('refuses %s with invalid_search_query', async (_name, url) => {
    const response = await get(url);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_search_query' } });
  });

  it('is 401 unauthenticated and 403 for a session-scoped token', async () => {
    expect((await get('/api/files/search?q=pump', {})).status).toBe(401);
    const scoped = await get('/api/files/search?q=pump', {
      [WORKSPACE_HEADER]: WORKSPACE_A,
      [SCOPE_HEADER]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(scoped.status).toBe(403);
  });

  it('is 503 when no text cache is wired', async () => {
    await wire({ texts: false });
    const response = await get('/api/files/search?q=pump');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'files_runtime_not_configured' },
    });
  });

  it('answers a typed 500 that carries no SQL or provider text', async () => {
    await wire({ fail: true });
    const response = await get('/api/files/search?q=pump');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('search_unavailable');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('file_texts');
  });
});
