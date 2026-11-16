/**
 * The shared harness of the `files/*.routes.test.ts` suites: the files route handlers, imported as
 * Next.js will import them and driven with real `Request` objects. Mirrors
 * `apps/web/server/agents/routes.test.ts`'s shape — see that file's header for why a header-driven
 * test resolver is the strongest position to give an attacker, and what these suites cannot
 * exercise (Next.js's own routing — `tests/route-inventory.test.ts` covers that).
 */
import { expect } from 'vitest';

import { POST as uploadRoute } from '../../app/api/files/route';
import {
  DELETE as deleteRoute,
  GET as downloadRoute,
  PATCH as renameRoute,
} from '../../app/api/files/[id]/route';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import type { ObjectStore } from '../storage/objects';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { ResourceCatalogStoreProvider } from '../storage/store';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';
import type { WorkspaceResolution } from './runtime';

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
export const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, in the DB-backed suites. */
export const ACTOR_HEADER = 'x-test-actor';

/** The header-driven resolver the default harness uses: the workspace a test names. */
export function resolveWorkspaceFromHeader(request: Request): Promise<WorkspaceResolution> {
  const workspaceId = request.headers.get(WORKSPACE_HEADER);
  if (workspaceId === null) {
    return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
  }
  return Promise.resolve({ kind: 'workspace', workspaceId });
}

export const fixedWorkspaceA = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A });

/**
 * Workspaces A and B over in-memory stores, resolved from the workspace header, and an Owner API
 * key for whichever workspace a request names.
 */
export function installDefaultWorld(): CatalogFilesWorld {
  const world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_A, WORKSPACE_B].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: resolveWorkspaceFromHeader,
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  installTestDomains({
    rbac: {
      // Issue #117: every create/sync path resolves `created_by`, falling back to the workspace's
      // oldest Owner when the caller cannot be matched by email (true of every request here, which
      // authenticates as an API key) — so each fixture workspace needs at least one seeded member.
      directory: createMemoryDirectory({
        users: [
          {
            email: 'owner-a@example.test',
            name: 'Owner A',
            workspaceId: WORKSPACE_A,
            role: 'owner',
          },
          {
            email: 'owner-b@example.test',
            name: 'Owner B',
            workspaceId: WORKSPACE_B,
            role: 'owner',
          },
        ],
      }),
      identify(request: Request) {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
                apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId,
                role: 'owner',
                label: 'Files route test key',
              }),
        );
      },
    },
  });
  return world;
}

/** Workspace A alone, always resolved, as the files runtime; RBAC is left as it was installed. */
export function installSingleWorkspaceWorld(
  options: {
    readonly catalogs?: ResourceCatalogStoreProvider;
    readonly objects?: ObjectStore;
  } = {},
): CatalogFilesWorld {
  const world = createCatalogFilesWorld({
    catalogs: options.catalogs ?? createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE_A].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: fixedWorkspaceA,
    ...(options.objects === undefined ? {} : { objects: options.objects }),
  });
  installTestDomains({ files: { kind: 'serving', runtime: world.runtime } });
  return world;
}

export function req(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: BodyInit;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.contentType !== undefined && options.contentType !== null) {
    headers.set('content-type', options.contentType);
  }
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** Who a route call comes from: workspace A unless named, and the seeded member it acts as. */
export interface Caller {
  readonly workspace?: string;
  readonly actor?: string;
}

function callerHeaders(caller: Caller): Record<string, string> {
  return caller.actor === undefined ? {} : { [ACTOR_HEADER]: caller.actor };
}

/** `POST /api/files` of `text` at `filePath`. */
export function upload(
  filePath: string,
  text: string,
  options: Caller & { readonly contentType?: string | undefined } = {},
): Promise<Response> {
  return uploadRoute(
    req('POST', '/api/files', {
      workspace: options.workspace ?? WORKSPACE_A,
      body: new TextEncoder().encode(text),
      headers: { 'x-file-path': filePath, ...callerHeaders(options) },
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    }),
  );
}

/** `GET /api/files/:id` of the file at `filePath`. */
export function download(filePath: string, caller: Caller = {}): Promise<Response> {
  const id = encodeFileId(filePath);
  return downloadRoute(
    req('GET', `/api/files/${id}`, {
      workspace: caller.workspace ?? WORKSPACE_A,
      headers: callerHeaders(caller),
    }),
    idContext(id),
  );
}

/** `PATCH /api/files/:id` moving the file or folder at `fromPath` to `newPath`. */
export function rename(fromPath: string, newPath: string, caller: Caller = {}): Promise<Response> {
  const id = encodeFileId(fromPath);
  return renameRoute(
    req('PATCH', `/api/files/${id}`, {
      workspace: caller.workspace ?? WORKSPACE_A,
      body: JSON.stringify({ newPath }),
      contentType: 'application/json',
      headers: callerHeaders(caller),
    }),
    idContext(id),
  );
}

/** `DELETE /api/files/:id` of the file or folder at `filePath`. */
export function remove(
  filePath: string,
  options: Caller & { readonly recursive?: boolean } = {},
): Promise<Response> {
  const id = encodeFileId(filePath);
  const query = options.recursive === true ? '?recursive=true' : '';
  return deleteRoute(
    req('DELETE', `/api/files/${id}${query}`, {
      workspace: options.workspace ?? WORKSPACE_A,
      headers: callerHeaders(options),
    }),
    idContext(id),
  );
}

/** The response is `status` with the API error `code`. */
export async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
