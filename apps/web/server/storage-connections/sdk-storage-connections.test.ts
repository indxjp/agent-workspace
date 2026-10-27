/**
 * The SDK cell of US-STO-12 (the storage design, §06 Phase 5): `client.storage.connections`
 * drives the real `/api/storage-connections/**` route handlers in-process, over a `file://`
 * connection under an operator root, on both repository providers.
 *
 * It lives in the application, not in `packages/sdk`: a package may not import the web handlers.
 */
// @story US-STO-12
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';

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

const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-sdk-storage-')));
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
  const root = '/api/storage-connections';
  if (pathname === root) {
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

const client = () =>
  createClient({
    baseUrl: 'http://web.test',
    auth: { kind: 'api-key', apiKey: 'ak_test' },
    fetch: web,
  });

/** A connection over `<fileRoot>/<name>` holding the given object keys. */
function folder(name: string, keys: readonly string[]): string {
  const dir = path.join(fileRoot, name);
  mkdirSync(dir);
  for (const key of keys) {
    mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    writeFileSync(path.join(dir, key), key);
  }
  return `file://${dir}`;
}

describe.each(['memory', 'postgres'] as const)(
  'client.storage.connections over the %s repository',
  (kind) => {
    let isolated: IsolatedTestDatabase | undefined;

    // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
    beforeAll(async () => {
      if (kind !== 'postgres') return;
      isolated = await createIsolatedTestDatabase('aw_sdk_storage_connections');
      await isolated.db
        .insert(workspaces)
        .values({ id: WORKSPACE, slug: 'sdk-storage', name: 'S' });
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
                label: 'SDK storage test',
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
    it('[US-STO-12][api][sdk] create then browse round-trips against the test server', async () => {
      const url = folder(`roundtrip-${kind}`, ['reports/a.txt', 'reports/2026/b.txt']);
      const { connections } = client().storage;
      const created = await connections.create({
        name: `acme-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });

      const seen: Array<{ path: string; kind: string }> = [];
      for await (const entry of connections.browse(created.id, { prefix: 'reports/' })) {
        seen.push({ path: entry.path, kind: entry.kind });
      }
      expect(seen).toEqual([
        { path: 'reports/2026', kind: 'folder' },
        { path: 'reports/a.txt', kind: 'file' },
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] browse follows next across pages of the real route', async () => {
      const keys = Array.from({ length: 1001 }, (_, index) => `reports/many/f${String(index)}.txt`);
      const url = folder(`pages-${kind}`, keys);
      const { connections } = client().storage;
      const { id } = await connections.create({
        name: `pages-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });

      const pages: Request[] = [];
      const counting = createClient({
        baseUrl: 'http://web.test',
        auth: { kind: 'api-key', apiKey: 'ak_test' },
        fetch: (input, init) => {
          const request = new Request(input, init);
          if (request.url.includes('/browse')) pages.push(request);
          return web(request);
        },
      });
      const paths: string[] = [];
      for await (const entry of counting.storage.connections.browse(id, {
        prefix: 'reports/many',
      })) {
        paths.push(entry.path);
      }
      expect(paths).toHaveLength(1001);
      expect(new Set(paths)).toEqual(new Set(keys));
      expect(pages).toHaveLength(2);
      expect(new URL(pages[1]?.url ?? '').searchParams.get('cursor')).not.toBeNull();
    }, 60_000);

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a space in the prefix lists the folder', async () => {
      const url = folder(`space-${kind}`, ['reports/Q3 reports/n.txt']);
      const { connections } = client().storage;
      const { id } = await connections.create({
        name: `space-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });
      const paths: string[] = [];
      for await (const entry of connections.browse(id, { prefix: 'reports/Q3 reports/' })) {
        paths.push(entry.path);
      }
      expect(paths).toEqual(['reports/Q3 reports/n.txt']);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a folder named with é, + or & lists its entries', async () => {
      const names = ['café', 'a+b', 'a&b'];
      const url = folder(
        `names-${kind}`,
        names.map((name) => `reports/${name}/n.txt`),
      );
      const { connections } = client().storage;
      const { id } = await connections.create({
        name: `names-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });
      for (const name of names) {
        const paths: string[] = [];
        for await (const entry of connections.browse(id, { prefix: `reports/${name}` })) {
          paths.push(entry.path);
        }
        expect(paths, name).toEqual([`reports/${name}/n.txt`]);
      }
      // The object-store key guard refuses any key holding a `%` (ADR-0015), so no such folder
      // exists to list: the server answers the contract refusal, not a 5xx.
      for (const prefix of ['reports/50%', 'reports/50%25']) {
        await expect(connections.browse(id, { prefix }).next(), prefix).rejects.toMatchObject({
          status: 403,
          code: 'storage_connection_prefix_not_allowed',
        });
      }
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a prefix that escapes, or decodes to an escape, is refused', async () => {
      const url = folder(`escape-${kind}`, ['reports/a.txt', 'reports-old/c.txt', 'secret/d.txt']);
      const { connections } = client().storage;
      const { id } = await connections.create({
        name: `escape-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });
      const sent = [
        '%2e%2e',
        'reports/%2e%2e',
        'reports/%2e%2e/secret',
        '%2e',
        'reports%2f..%2fsecret',
        'reports%5c..',
        'reports%00',
        '%2freports',
        // Decoded once, this is the literal folder name `%2e%2e`, never `..`.
        '%252e%252e',
        'reports/%252e%252e',
        '%E0%A4%A',
        'reports-old',
      ];
      const expectRefused = async (response: Response, label: string): Promise<void> => {
        expect(response.status, label).toBe(403);
        const text = await response.text();
        expect(ApiProblemSchema.parse(JSON.parse(text)).error.code, label).toBe(
          'storage_connection_prefix_not_allowed',
        );
        expect(text, label).not.toContain('d.txt');
      };
      for (const prefix of sent) {
        await expectRefused(
          await web(`http://web.test/api/storage-connections/${id}/browse?prefix=${prefix}`),
          prefix,
        );
      }
      // Through the SDK, every decodable one: it is encoded, so the server sees exactly this.
      for (const prefix of sent.filter((value) => value !== '%E0%A4%A')) {
        const refused = await connections
          .browse(id, { prefix: decodeURIComponent(prefix) })
          .next()
          .catch((error: unknown) => error);
        expect(refused, prefix).toBeInstanceOf(ApiProblemError);
        expect(refused, prefix).toMatchObject({
          status: 403,
          code: 'storage_connection_prefix_not_allowed',
        });
      }
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a credential is never echoed by any method', async () => {
      const accessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
      const secretAccessKey = randomBytes(24).toString('base64');
      const rotated = randomBytes(24).toString('base64');
      const s3 = 's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com';
      const { connections } = client().storage;
      const results: unknown[] = [];

      const created = await connections.create({
        name: `lifecycle-${kind}`,
        url: s3,
        allowedPrefixes: ['reports'],
        credential: { provider: 's3', accessKeyId, secretAccessKey },
      });
      results.push(created, await connections.get(created.id), await connections.get(created.name));
      results.push(await connections.list());
      results.push(
        await connections.update(created.id, { writeAllowed: true }),
        await connections.rotateCredential(created.id, {
          provider: 's3',
          accessKeyId,
          secretAccessKey: rotated,
        }),
      );
      const refused = await connections
        .create({
          name: `lifecycle-${kind}`,
          url: s3,
          allowedPrefixes: ['reports'],
          credential: { provider: 's3', accessKeyId, secretAccessKey },
        })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ApiProblemError);
      expect(refused).toMatchObject({ status: 409, code: 'storage_connection_name_taken' });
      results.push(refused, String(refused), connections);

      const text = JSON.stringify(results);
      for (const secret of [accessKeyId, secretAccessKey, rotated]) {
        for (let at = 0; at + 6 <= secret.length; at += 1) {
          expect(text).not.toContain(secret.slice(at, at + 6));
        }
      }
      expect(created.hasCredential).toBe(true);
      expect(await connections.remove(created.id)).toBeUndefined();
      await expect(connections.get(created.name)).rejects.toMatchObject({
        status: 404,
        code: 'storage_connection_not_found',
      });
      await expect(connections.get(created.id)).rejects.toMatchObject({
        status: 404,
        code: 'storage_connection_not_found',
      });
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] test resolves the outcome of a probe', async () => {
      const url = folder(`probe-${kind}`, ['reports/a.txt']);
      const { connections } = client().storage;
      const { id } = await connections.create({
        name: `probe-${kind}`,
        url,
        allowedPrefixes: ['reports'],
      });
      expect(await connections.test(id)).toEqual({ ok: true });
      rmSync(path.join(fileRoot, `probe-${kind}`), { recursive: true });
      expect(await connections.test(id)).toMatchObject({ ok: false });
    });
  },
);
