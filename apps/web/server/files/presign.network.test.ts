/**
 * Issue #251's network acceptance test: the bytes of a presigned upload go from the client straight
 * to the object store, and the control plane's store is never asked to carry them. Needs a live
 * S3-compatible endpoint (`TEST_S3_ENDPOINT`, SeaweedFS in CI); skipped without one, like
 * `packages/core/src/storage/s3-store.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';

import { openRootObjectStore, type ObjectStoreV2 } from '@agent-workspace/core/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as completeRoute } from '../../app/api/files/[id]/upload-complete/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { encodeFileId } from './file-id';
import { createCatalogFilesWorld } from './catalog-runtime-fixtures';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';

const endpoint = process.env['TEST_S3_ENDPOINT'];
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';

if (endpoint === undefined || endpoint.trim() === '') {
  describe.skip('presigned file transfer against a live object store', () => {
    it('requires TEST_S3_ENDPOINT (the repository test launcher supplies it)', () => undefined);
  });
} else {
  /** Every call the control plane's store sees; a presigned transfer must add none. */
  const calls: string[] = [];

  function spied(store: ObjectStoreV2): ObjectStoreV2 {
    return {
      ...store,
      write: (key, body, options) => {
        calls.push(`write ${key}`);
        return store.write(key, body, options);
      },
      read: (key, options) => {
        calls.push(`read ${key}`);
        return store.read(key, options);
      },
    };
  }

  beforeEach(async () => {
    calls.length = 0;
    const live = await openRootObjectStore(
      {
        kind: 's3',
        bucket: `aw-presign-${randomUUID()}`,
        prefix: '',
        endpoint,
        region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
        forcePathStyle: true,
      },
      {
        credentials: {
          accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace',
          secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace',
        },
      },
    );
    const world = createCatalogFilesWorld({
      catalogs: createInMemoryCatalogStore(),
      scopes: createInMemoryWorkspaceScopeResolver(
        [WORKSPACE].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
      ),
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      objects: spied(live),
    });
    installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
    const minter = Principal.fromApiKey({
      principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: WORKSPACE,
      role: 'admin',
      label: 'Presign network test key',
    });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({
          users: [
            { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE, role: 'owner' },
          ],
        }),
        identify: (request: Request) =>
          Promise.resolve(
            request.headers.get('x-test-actor') === 'session'
              ? Principal.fromBrowserToken(minter, { kind: 'session', id: SESSION })
              : minter,
          ),
      },
    });
  });

  afterEach(() => {
    clearApplicationContext();
  });

  function mint(
    route: typeof uploadUrlRoute,
    sub: 'upload-urls' | 'download-urls',
    filePath: string,
    body: unknown,
    actor: 'member' | 'session' = 'member',
  ): Promise<Response> {
    return route(
      new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/${sub}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(actor === 'session' ? { 'x-test-actor': 'session' } : {}),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: encodeFileId(filePath) }) },
    );
  }

  function complete(filePath: string): Promise<Response> {
    return completeRoute(
      new Request(`https://example.invalid/api/files/${encodeFileId(filePath)}/upload-complete`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: encodeFileId(filePath) }) },
    );
  }

  describe('presigned file transfer against a live object store', () => {
    it('moves the bytes browser-to-store with the control plane never carrying them', async () => {
      const filePath = 'docs/hello.txt';
      const bytes = new TextEncoder().encode('straight to the store');

      const minted = await mint(uploadUrlRoute, 'upload-urls', filePath, {
        sizeBytes: bytes.byteLength,
        contentType: 'text/plain',
      });
      expect(minted.status, await minted.clone().text()).toBe(201);
      const signed = (await minted.json()) as {
        url: string;
        method: string;
        headers: Record<string, string>;
      };
      expect(new URL(signed.url).origin).toBe(new URL(endpoint).origin);

      const put = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: bytes,
      });
      expect(put.status, await put.clone().text()).toBeLessThan(300);
      expect(calls).toEqual([]);

      const completed = await complete(filePath);
      expect(completed.status, await completed.clone().text()).toBe(200);

      const download = await mint(downloadUrlRoute, 'download-urls', filePath, {});
      expect(download.status, await download.clone().text()).toBe(201);
      const readUrl = (await download.json()) as { url: string; method: string };
      const got = await fetch(readUrl.url, { method: readUrl.method });
      expect(got.status).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
      expect(got.headers.get('content-disposition')).toContain('attachment');
    });

    it('refuses a session token an upload URL, so nothing is writable through one', async () => {
      for (const target of [`.attachments/${SESSION}/u1/hello.txt`, 'elsewhere/hello.txt']) {
        const response = await mint(
          uploadUrlRoute,
          'upload-urls',
          target,
          { sizeBytes: 1 },
          'session',
        );
        expect(response.status, target).toBe(403);
        expect(await response.json(), target).toMatchObject({
          error: { code: 'token_out_of_scope' },
        });
      }
      expect(calls).toEqual([]);
    });
  });
}
