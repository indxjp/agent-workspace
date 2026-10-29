import { log as webLogger } from '../telemetry/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryObjectStore, type ObjectStore } from '@agent-workspace/core/storage';
import { bytesToStream } from '@agent-workspace/core/storage/streams';
import {
  createInMemoryCatalog,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import {
  DELETE as deleteFileRoute,
  GET as downloadFileRoute,
  PATCH as renameFileRoute,
} from '../../app/api/files/[id]/route';
import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import { GET as listFilesRoute, POST as uploadFileRoute } from '../../app/api/files/route';
import { PATCH as patchProject } from '../../app/api/projects/[id]/route';
import { POST as createProject } from '../../app/api/projects/route';
import { DELETE as revokeShare } from '../../app/api/shares/[id]/route';
import { GET as listShares, POST as publishShare } from '../../app/api/shares/route';
import { PATCH as patchSharingPolicy } from '../../app/api/sharing-policies/route';
import type { WorkspaceSharing } from '../shares/core/runtime';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { encodeFileId } from '../files/file-id';
import { createCatalogFilesWorld } from '../files/catalog-runtime-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';

const SENTINEL = 'postgresql://admin:TOP-SECRET@internal.example/workspace';

function request(path: string, method: 'PATCH' | 'POST'): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

async function expectSafeInfrastructureFailure(
  response: Response,
  error = { code: 'internal_error', message: 'The request could not be completed.' },
  status = 500,
): Promise<void> {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(text).not.toContain(SENTINEL);
  expect(JSON.parse(text)).toEqual({ error });
}

describe('authenticated route error boundaries', () => {
  beforeEach(() => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clearApplicationContext();
    vi.restoreAllMocks();
  });

  it('does not turn project persistence failures into public 400 responses', async () => {
    installTestDomains({
      projects: {
        resolveActor: () =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId: 'workspace-1',
            principalId: 'principal-1',
            ownerPrincipalId: 'principal-1',
            userId: 'user-1',
            userLabel: 'owner@example.test',
          }),
        forWorkspace: () => Promise.reject(new Error(SENTINEL)),
      },
    });

    await expectSafeInfrastructureFailure(await createProject(request('/api/projects', 'POST')));
    await expectSafeInfrastructureFailure(
      await patchProject(request('/api/projects/project-1', 'PATCH'), {
        params: Promise.resolve({ id: 'project-1' }),
      }),
    );
  });

  it('does not expose sharing persistence failures from publish or policy routes', async () => {
    installTestDomains({
      shares: {
        resolveActor: () =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId: 'workspace-1',
            principalId: 'principal-1',
            ownerPrincipalId: 'principal-1',
            userId: 'user-1',
            userLabel: 'owner@example.test',
            role: 'owner',
          }),
        forWorkspace: () => Promise.reject(new Error(SENTINEL)),
        resolvePublic: () => Promise.reject(new Error('not used')),
        sharingMaterials: () => Promise.reject(new Error('not used')),
        sessionRuns: () => Promise.reject(new Error('not used')),
        subjectOwnership: () => Promise.reject(new Error('not used')),
        runPublic: () => Promise.reject(new Error('not used')),
      },
    });

    await expectSafeInfrastructureFailure(await publishShare(request('/api/shares', 'POST')));
    await expectSafeInfrastructureFailure(
      await listShares(new Request('http://localhost/api/shares')),
    );
    const id = '00000000-0000-4000-8000-000000000001';
    await expectSafeInfrastructureFailure(
      await revokeShare(new Request(`http://localhost/api/shares/${id}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id }),
      }),
    );
    await expectSafeInfrastructureFailure(
      await patchSharingPolicy(request('/api/sharing-policies', 'PATCH')),
    );
  });

  it('answers a non-UUID share id with 404 share_not_found, never reaching the uuid column', async () => {
    installTestDomains({
      shares: {
        resolveActor: () =>
          Promise.resolve({
            kind: 'workspace',
            workspaceId: 'workspace-1',
            principalId: 'principal-1',
            ownerPrincipalId: 'principal-1',
            userId: 'user-1',
            userLabel: 'owner@example.test',
            role: 'owner',
          }),
        forWorkspace: () =>
          Promise.resolve({
            shares: { get: () => Promise.reject(new Error('invalid input syntax for type uuid')) },
          } as unknown as WorkspaceSharing),
        resolvePublic: () => Promise.reject(new Error('not used')),
        sharingMaterials: () => Promise.reject(new Error('not used')),
        sessionRuns: () => Promise.reject(new Error('not used')),
        subjectOwnership: () => Promise.reject(new Error('not used')),
        runPublic: () => Promise.reject(new Error('not used')),
      },
    });
    const response = await revokeShare(
      new Request('http://localhost/api/shares/not-a-uuid', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'share_not_found' } });
  });

  it('does not expose a catalog or object store failure from any files route', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const failing = (): Promise<never> => Promise.reject(new Error(SENTINEL));
    const inner = createInMemoryObjectStore();
    let broken = false;
    // The row is written while the byte store works; after that every read, write and signature
    // fails.
    const objects: ObjectStore = {
      ...inner,
      capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
      read: (key, options) => (broken ? failing() : inner.read(key, options)),
      write: (key, body, options) => (broken ? failing() : inner.write(key, body, options)),
      createSignedUrl: failing,
    };
    const catalog = createInMemoryCatalog();
    const world = createCatalogFilesWorld({
      catalogs: { forWorkspace: (id) => Promise.resolve(catalog.forWorkspace(id)) },
      scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId }),
      objects,
    });
    const principalId = '37d41bbb-42d1-4a16-8f5d-de3fef42eed0';
    const saved = await world.storage.save(
      { workspaceId, principalId, userId: null },
      {
        area: 'files',
        path: 'docs/a.txt',
        body: bytesToStream(new TextEncoder().encode('bytes')),
        maxBytes: 1024,
        replace: false,
      },
    );
    expect(saved.ok).toBe(true);
    broken = true;
    installTestDomains({
      files: { kind: 'serving', runtime: world.runtime },
      rbac: {
        directory: createMemoryDirectory({
          users: [{ email: 'owner@example.test', name: 'Owner', workspaceId, role: 'owner' }],
        }),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId,
              apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workspaceId,
              role: 'owner',
              label: 'Route boundary test key',
            }),
          ),
      },
    });
    const id = encodeFileId('docs/a.txt');
    const url = `http://localhost/api/files/${id}`;
    const params = { params: Promise.resolve({ id }) };
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const catalogDown = (op: Parameters<typeof catalog.failNext>[0]) =>
      catalog.failNext(op, new Error(SENTINEL));
    // The two upload routes answer every failure of their write, bytes and signing included, with
    // their own typed 500.
    const catalogUnavailable = {
      code: 'catalog_unavailable',
      message: 'The file catalog could not be updated; retry the request.',
    };

    catalogDown('list');
    await expectSafeInfrastructureFailure(
      await listFilesRoute(new Request('http://localhost/api/files')),
    );
    await expectSafeInfrastructureFailure(
      await uploadFileRoute(
        new Request('http://localhost/api/files', {
          method: 'POST',
          headers: { 'x-file-path': 'docs/a.txt' },
          body: 'bytes',
        }),
      ),
      catalogUnavailable,
    );
    await expectSafeInfrastructureFailure(await downloadFileRoute(new Request(url), params));
    catalogDown('remove');
    await expectSafeInfrastructureFailure(
      await deleteFileRoute(new Request(url, { method: 'DELETE' }), params),
    );
    catalogDown('rename');
    await expectSafeInfrastructureFailure(
      await renameFileRoute(new Request(url, json('PATCH', { newPath: 'docs/b.txt' })), params),
    );
    const uploadLink = () =>
      uploadUrlRoute(new Request(`${url}/upload-urls`, json('POST', { sizeBytes: 5 })), params);
    catalogDown('reserve');
    await expectSafeInfrastructureFailure(await uploadLink(), catalogUnavailable);
    // A failed signature is the store's outage, answered without the provider's message.
    const signingFailed = {
      code: 'storage_unavailable',
      message: 'The object store could not sign a link; retry.',
    };
    await expectSafeInfrastructureFailure(await uploadLink(), signingFailed, 502);
    await expectSafeInfrastructureFailure(
      await downloadUrlRoute(new Request(`${url}/download-urls`, json('POST', {})), params),
      signingFailed,
      502,
    );
  });
});
