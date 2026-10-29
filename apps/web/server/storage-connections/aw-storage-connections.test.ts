/**
 * The CLI cell of US-STO-12 (the storage design, §06 Phase 5): `aw storage connections create`
 * then `aw storage ls` drive the real `/api/storage-connections/**` route handlers in-process,
 * over a `file://` connection under an operator root, on both repository providers.
 *
 * It lives in the application, not in `packages/aw`: a package may not import the web handlers.
 */
// @story US-STO-12
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { openConnectionStore } from '@agent-workspace/core/storage';
import { main } from '@indx-workspace/aw';

import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { PUT as rotateRoute } from '../../app/api/storage-connections/[id]/credential/route';
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '../../app/api/storage-connections/[id]/route';
import { POST as testRoute } from '../../app/api/storage-connections/[id]/test/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/storage-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-cli-storage-')));
afterAll(() => {
  rmSync(fileRoot, { recursive: true, force: true });
});

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** The web app in-process: every storage-connection route, matched by method and path. */
function web(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === '/api/storage-connections') {
    return (request.method === 'GET' ? listRoute : createRoute)(request);
  }
  const match = /^\/api\/storage-connections\/([^/]+)(\/credential|\/test|\/browse)?$/u.exec(
    pathname,
  );
  if (match?.[1] === undefined) return Promise.resolve(new Response(null, { status: 404 }));
  const routes: Record<string, Handler | undefined> = {
    GET: match[2] === '/browse' ? browseRoute : getRoute,
    POST: testRoute,
    PUT: rotateRoute,
    PATCH: patchRoute,
    DELETE: deleteRoute,
  };
  const handler = routes[request.method];
  if (handler === undefined) return Promise.resolve(new Response(null, { status: 405 }));
  return handler(request, { params: Promise.resolve({ id: match[1] }) });
}

/** `aw <argv>` against {@link web}, with an in-memory process. */
async function aw(argv: readonly string[], stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdin: () => Promise.resolve(stdin),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000', AGENT_WORKSPACE_API_KEY: 'ak_live_test' },
    homeDir: path.join(fileRoot, 'no-home'),
    fetch: web,
    isTty: false,
    sleep: () => Promise.resolve(),
  });
  return { code, stdout, stderr };
}

/** A connection folder `<fileRoot>/<name>` holding the given object keys. */
async function folder(name: string, keys: readonly string[]): Promise<string> {
  const dir = path.join(fileRoot, name);
  mkdirSync(dir);
  // Through the store the product opens, so the seed lands wherever that store reads.
  const objects = await openConnectionStore(
    `file://${dir}`,
    { provider: 'file' },
    { writable: true, fileRoots: [fileRoot], egress: { production: false, allowHosts: [] } },
  );
  await Promise.all(keys.map((key) => objects.write(key, new TextEncoder().encode(key), {})));
  return `file://${dir}`;
}

describe.each(['memory', 'postgres'] as const)(
  'aw storage connections over the %s repository',
  (kind) => {
    let isolated: IsolatedTestDatabase | undefined;

    // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
    beforeAll(async () => {
      if (kind !== 'postgres') return;
      isolated = await createIsolatedTestDatabase('aw_cli_storage_connections');
      await isolated.db
        .insert(workspaces)
        .values({ id: WORKSPACE, slug: 'cli-storage', name: 'S' });
    }, 180_000);

    afterAll(async () => {
      await isolated?.close();
    });

    beforeEach(() => {
      const memoryScopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'a' }]);
      installTestDomains({
        rbac: {
          directory: createMemoryDirectory(),
          identify: () =>
            Promise.resolve(
              Principal.fromApiKey({
                principalId: ACTOR,
                apiKeyId: randomUUID(),
                workspaceId: WORKSPACE,
                role: 'owner',
                label: 'CLI storage test',
              }),
            ),
        },
        storageConnections: {
          kind: 'serving',
          runtime: {
            store: createRepositoryStorageConnectionsStoreProvider({
              repositories:
                isolated === undefined
                  ? createInMemoryStorageConnectionRepositoryProvider()
                  : createDatabaseStorageConnectionRepositoryProvider(isolated.db),
              scopes:
                isolated === undefined
                  ? memoryScopes
                  : createDatabaseWorkspaceScopeResolver(isolated.db),
              secrets: createInMemorySecretsService(),
            }),
            fileRoots: [fileRoot],
            egress: { production: true, allowHosts: [] },
            isConnectionGranted: () => Promise.resolve(false),
            audit: () => Promise.resolve(),
          },
        },
      });
    });

    afterEach(clearApplicationContext);

    // @story US-STO-12
    it('[US-STO-12][api][cli] connect a bucket and list a folder', async () => {
      const url = await folder(`cli-${kind}`, [
        'reports/a.txt',
        'reports/2026/b.txt',
        'reports/Q3 reports/n.txt',
      ]);
      const name = `acme-${kind}`;

      const created = await aw(
        [
          'storage',
          'connections',
          'create',
          '--name',
          name,
          '--storage-url',
          url,
          '--allow',
          'reports',
          '--credential-file',
          '-',
        ],
        '{"provider":"file"}',
      );
      expect(created.stderr).toBe('');
      expect(created.code).toBe(0);
      expect(created.stdout).toContain(name);

      const listed = await aw(['storage', 'ls', `${name}/reports/`]);
      expect(listed.stderr).toBe('');
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain('reports/2026');
      expect(listed.stdout).toContain('reports/a.txt');

      const asJson = await aw(['storage', 'ls', `${name}/reports/`, '--json']);
      expect(asJson.code).toBe(0);
      expect(JSON.parse(asJson.stdout)).toEqual([
        { path: 'reports/2026', kind: 'folder' },
        { path: 'reports/Q3 reports', kind: 'folder' },
        { path: 'reports/a.txt', kind: 'file', size: 'reports/a.txt'.length },
      ]);

      const spaced = await aw(['storage', 'ls', `${name}/reports/Q3 reports/`, '--json']);
      expect(spaced.code).toBe(0);
      expect(JSON.parse(spaced.stdout)).toEqual([
        { path: 'reports/Q3 reports/n.txt', kind: 'file', size: 'reports/Q3 reports/n.txt'.length },
      ]);
    });
  },
);
