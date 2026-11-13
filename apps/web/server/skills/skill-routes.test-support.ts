import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { type ResourceCatalogStoreProvider } from '../storage/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService, type StorageService } from '../storage/service';
import { createRepositorySkillsStoreProvider } from '../storage/store';
import type { WorkspaceResolution } from './runtime';

export const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';

export const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';

export const WORKSPACE_HEADER = 'x-test-workspace';

export const ACTOR_HEADER = 'x-test-actor';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

let rootDir: string;

let skillsService: StorageService;

export function skillsStorage(catalogs: ResourceCatalogStoreProvider): StorageService {
  return createStorageService({
    catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
}

let catalogs: ReturnType<typeof createInMemoryCatalogStore>;

beforeEach(async () => {
  catalogs = createInMemoryCatalogStore();
  skillsService = skillsStorage(catalogs);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-routes-'));
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'acme' },
    { id: WORKSPACE_B, slug: 'globex' },
  ]);
  const store = createRepositorySkillsStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(rootDir),
    scopes,
  });
  installTestDomains({
    skills: {
      kind: 'serving',
      runtime: {
        store,
        catalog: catalogs,
        storage: skillsService,
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
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
                principalId: 'ab152b86-785a-4b7d-9e6a-6c329ca7e085',
                apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                workspaceId,
                role: 'owner',
                label: 'Skills route test key',
              }),
        );
      },
    },
  });
});

afterEach(async () => {
  clearApplicationContext();
  await rm(rootDir, { recursive: true, force: true });
});

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

export function nameContext(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) };
}

export function postJson(workspace: string, body: unknown): Request {
  return req('POST', '/api/skills', {
    workspace,
    body: JSON.stringify(body),
    contentType: 'application/json',
  });
}
export const fixture = {
  get rootDir() {
    return rootDir;
  },
  set rootDir(value: typeof rootDir) {
    rootDir = value;
  },
  get skillsService() {
    return skillsService;
  },
  set skillsService(value: typeof skillsService) {
    skillsService = value;
  },
  get catalogs() {
    return catalogs;
  },
  set catalogs(value: typeof catalogs) {
    catalogs = value;
  },
};
