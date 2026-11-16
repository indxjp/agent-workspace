/**
 * Shared fixtures for `sdk-conformance.files` suites.
 */
import { createInMemoryCatalogStore } from './resources/catalog-store.memory';
import { resourcePathHeaders } from '@indx-workspace/contracts/files';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { encodeFileId } from './files/file-id';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './files/catalog-runtime-fixtures';
import { type ObjectStore } from '@agent-workspace/core/storage';
import { GET as listFilesRoute, POST as uploadFileRoute } from '../app/api/files/route';
import {
  DELETE as deleteFileRoute,
  GET as downloadFileRoute,
  PATCH as renameFileRoute,
} from '../app/api/files/[id]/route';
import { POST as uploadUrlsRoute } from '../app/api/files/[id]/upload-urls/route';
import { POST as completeUploadRoute } from '../app/api/files/[id]/upload-complete/route';
import { createMemoryDirectory } from './rbac/memory-directory';
import { Principal } from './rbac/principal';
import { installTestDomains } from './application-context-fixtures';

export const FILES_WORKSPACE = '44444444-4444-4444-8444-444444444444';

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const idContext = (id: string) => ({ params: Promise.resolve({ id }) });

let world: CatalogFilesWorld;

export const currentWorld = (): CatalogFilesWorld => world;

export function install(objects?: ObjectStore): void {
  world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [FILES_WORKSPACE].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: FILES_WORKSPACE }),
    ...(objects === undefined ? {} : { objects }),
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          {
            email: 'owner@example.test',
            name: 'Owner',
            workspaceId: FILES_WORKSPACE,
            role: 'owner',
          },
        ],
      }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
            apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: FILES_WORKSPACE,
            role: 'owner',
            label: 'conformance',
          }),
        ),
    },
  });
}

export const call = (method: string, url: string, init: RequestInit = {}): Request =>
  new Request(`https://example.invalid${url}`, { method, ...init });

export const upload = (filePath: string, body: string, contentType?: string): Promise<Response> =>
  uploadFileRoute(
    call('POST', '/api/files', {
      body,
      headers: {
        ...resourcePathHeaders('x-file-path', filePath),
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
    }),
  );

export const folder = (folderPath: string): Promise<Response> =>
  uploadFileRoute(call('POST', '/api/files', { headers: { 'x-folder-path': folderPath } }));

export const list = (under: string | null): Promise<Response> =>
  listFilesRoute(
    call('GET', under === null ? '/api/files' : `/api/files?path=${encodeURIComponent(under)}`),
  );

export const download = (filePath: string): Promise<Response> =>
  downloadFileRoute(
    call('GET', `/api/files/${encodeFileId(filePath)}`),
    idContext(encodeFileId(filePath)),
  );

export const rename = (filePath: string, newPath: string): Promise<Response> =>
  renameFileRoute(
    call('PATCH', `/api/files/${encodeFileId(filePath)}`, {
      body: JSON.stringify({ newPath }),
      headers: { 'content-type': 'application/json' },
    }),
    idContext(encodeFileId(filePath)),
  );

export const remove = (filePath: string, recursive: boolean): Promise<Response> =>
  deleteFileRoute(
    call('DELETE', `/api/files/${encodeFileId(filePath)}${recursive ? '?recursive=true' : ''}`),
    idContext(encodeFileId(filePath)),
  );

export const mint = (
  route: typeof uploadUrlsRoute,
  sub: 'upload-urls' | 'download-urls',
  filePath: string,
  body: unknown,
): Promise<Response> =>
  route(
    call('POST', `/api/files/${encodeFileId(filePath)}/${sub}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    idContext(encodeFileId(filePath)),
  );

export const complete = (filePath: string): Promise<Response> =>
  completeUploadRoute(
    call('POST', `/api/files/${encodeFileId(filePath)}/upload-complete`),
    idContext(encodeFileId(filePath)),
  );

export async function problemOf(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}
