/**
 * `POST /api/sessions/:id/attachments` (issue #1308, ADR-0146 D5-D6) saves through the catalog
 * service (the storage design, §04 "Saving a file", "Size limits"). Driven through the real route
 * with real `Request` objects on the in-memory catalog and on PostgreSQL.
 */
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
  workspaceFolder,
} from '@agent-workspace/core/storage';
import { listAll } from '@agent-workspace/core/storage/streams';
import { type SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import { afterAll, afterEach, expect } from 'vitest';

import { listCatalogFiles } from '@agent-workspace/core/db';
import { POST } from '../../../app/api/sessions/[engineSessionId]/attachments/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { createRepositoryObjectStoreProvider } from '../../files/store';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { Principal } from '../../rbac/principal';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../../storage/store';
import { createInMemoryCatalogStore } from '../../resources/catalog-store.memory';
import { createStorageService, type StorageService } from '../../storage/service';
import { resetSurfaceLimits } from './limits';

export const OTHER_ATTACHMENT_SESSION_ID = '44444444-4444-4444-8444-444444444444';
export const SURFACE_WITHOUT_ATTACHMENTS: SurfaceDefinition = { name: 'main', agent: 'support' };
export const ATTACHMENT_SESSION_ID = '33333333-3333-4333-8333-333333333333';
export const ATTACHMENT_ACTOR_HEADER = 'x-test-actor';
export const ATTACHMENT_SURFACE: SurfaceDefinition = {
  name: 'main',
  agent: 'support',
  parts: { attachments: true },
};

type Actor = 'visitor' | 'member' | 'admin' | 'run';

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspaceId: string;
  readonly principalId: string;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
export const streamOf = (size: number): ReadableStream<Uint8Array> =>
  new Blob([new Uint8Array(size)]).stream();
/** A one-byte body that records whether anything pulled on it; `highWaterMark: 0` pulls nothing up front. */
export function trackedBody(): {
  readonly body: ReadableStream<Uint8Array>;
  readonly read: () => boolean;
} {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, read: () => pulled };
}

export function memoryWorld(): Promise<World> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
    workspaceId,
    principalId: crypto.randomUUID(),
  });
}

let isolated: IsolatedTestDatabase | undefined;
export async function startAttachmentDatabase() {
  isolated = await createIsolatedTestDatabase('aw_surface_attachments');
}

export async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'attachments' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    workspaceId,
    principalId,
  };
}

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
  resetSurfaceLimits();
});

export function createAttachmentHarness(
  world: World,
  environment: NodeJS.ProcessEnv,
  legacy: ReturnType<typeof createInMemoryObjectStoreProvider>,
) {
  let root: ObjectStore;
  let storage: StorageService;
  const session: AttachmentSessionState = {
    surface: ATTACHMENT_SURFACE,
    projectArchivedAt: undefined,
    sessionOwner: undefined,
  };
  let visitor: Principal;
  const runtimeStore = () =>
    createRepositoryObjectStoreProvider({ store: legacy, scopes: world.scopes });

  /** Install the files runtime; without `withStorage` it has no catalog service. */
  function install(withStorage = true): void {
    root = createInMemoryObjectStore();
    storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects: root,
      log: noLog,
    });
    const principals = createAttachmentPrincipals(world);
    visitor = principals.visitor;
    installTestDomains({
      projects: createAttachmentProjects(session),
      files: {
        kind: 'serving',
        runtime: {
          store: runtimeStore(),
          catalog: world.catalogs,
          ...(withStorage ? { storage } : {}),
          resolveWorkspace: () =>
            Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
        },
      },
      rbac: createAttachmentRbac(world, principals),
      surfaces: createAttachmentSurfaces(world, session, environment),
    });
  }

  function upload(
    fileName: string | null,
    body: BodyInit = 'hello',
    options: { actor?: Actor | null; session?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const actor = options.actor === undefined ? 'visitor' : options.actor;
    const query = fileName === null ? '' : `?name=${encodeURIComponent(fileName)}`;
    // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        ...(actor === null ? {} : { [ATTACHMENT_ACTOR_HEADER]: actor }),
        ...options.headers,
      },
      body,
      duplex: 'half' as const,
    };
    const engineSessionId = options.session ?? ATTACHMENT_SESSION_ID;
    return POST(
      new Request(
        `https://example.invalid/api/sessions/${engineSessionId}/attachments${query}`,
        init,
      ),
      { params: Promise.resolve({ engineSessionId }) },
    );
  }

  async function code(response: Response): Promise<string> {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? '';
  }

  const catalog = () => world.catalogs.forWorkspace(world.workspaceId);
  const ctx = () => ({
    workspaceId: world.workspaceId,
    principalId: world.principalId,
    userId: null,
  });
  /** A seeded attachment written the way the route writes one, without the per-session rate limit. */
  async function seed(session: string, size: number): Promise<void> {
    const saved = await storage.save(ctx(), {
      area: 'files',
      path: `.attachments/${session}/${crypto.randomUUID()}/f.bin`,
      body: streamOf(size),
      maxBytes: size,
      replace: false,
    });
    expect(saved.ok).toBe(true);
  }
  const rootObjects = async () =>
    (
      await root.listPage(`${workspaceFolder(world.workspaceId)}files`, { recursive: true })
    ).entries.map((entry) => entry.key);
  const legacyObjects = async () =>
    (
      await listAll(legacy.forWorkspace(world.workspaceId), '.attachments', { recursive: true })
    ).map((entry) => entry.key);
  const readyFiles = async () =>
    (await listCatalogFiles(await catalog())).filter((row) => row.kind === 'file');
  /** What a refusal must leave unchanged: the ready rows, nothing pending or half-removed, the objects. */
  async function stored() {
    const rows = await catalog();
    return {
      files: (await readyFiles()).map((row) => row.path),
      pending: await rows.countPending(),
      deleting: (await rows.deleting()).length,
      objects: await rootObjects(),
      legacyObjects: await legacyObjects(),
    };
  }

  /** The console member's run principal: no token scope, the session's owner. */
  const consoleRunner = (workspaceId = world.workspaceId) => ({
    principalId: world.principalId,
    ownerPrincipalId: world.principalId,
    userId: null,
    workspaceId,
    role: 'builder' as const,
    scope: null,
  });

  install();
  return {
    get root() {
      return root;
    },
    get storage() {
      return storage;
    },
    get visitor() {
      return visitor;
    },
    session,
    world,
    upload,
    code,
    catalog,
    ctx,
    seed,
    rootObjects,
    legacyObjects,
    readyFiles,
    stored,
    install,
    consoleRunner,
  };
}

export type AttachmentHarness = ReturnType<typeof createAttachmentHarness>;

const PROJECT = '55555555-5555-4555-8555-555555555555';
interface AttachmentSessionState {
  surface: SurfaceDefinition | null;
  projectArchivedAt: Date | null | undefined;
  sessionOwner: string | undefined;
}

function createAttachmentProjects(
  session: AttachmentSessionState,
): NonNullable<Parameters<typeof installTestDomains>[0]['projects']> {
  return {
    resolveActor: () => Promise.reject(new Error('unused')),
    forWorkspace: () =>
      Promise.resolve({
        sessions: {
          get: () =>
            Promise.resolve({
              projectId: session.projectArchivedAt === undefined ? null : PROJECT,
              ownerPrincipalId: session.sessionOwner,
            }),
        },
        projects: {
          get: () =>
            Promise.resolve(
              session.projectArchivedAt === undefined
                ? null
                : { archivedAt: session.projectArchivedAt },
            ),
        },
      } as never),
  };
}

function createAttachmentRbac(
  world: World,
  principals: Record<Actor, Principal>,
): NonNullable<Parameters<typeof installTestDomains>[0]['rbac']> {
  return {
    directory: createMemoryDirectory({
      users: [
        {
          email: 'owner@example.test',
          name: 'Owner',
          workspaceId: world.workspaceId,
          role: 'owner',
        },
      ],
    }),
    identify(request: Request) {
      const actor = request.headers.get(ATTACHMENT_ACTOR_HEADER);
      return Promise.resolve(actor === null ? null : principals[actor as Actor]);
    },
  };
}

function createAttachmentSurfaces(
  world: World,
  session: AttachmentSessionState,
  environment: NodeJS.ProcessEnv,
): NonNullable<Parameters<typeof installTestDomains>[0]['surfaces']> {
  return {
    kind: 'serving',
    runtime: {
      env: () => environment,
      resolve: () => Promise.reject(new Error('unused')),
      open: () => Promise.reject(new Error('unused')),
      checkModel: () => Promise.reject(new Error('unused')),
      visitorSurface: (workspaceId, sessionId) =>
        Promise.resolve(
          workspaceId === world.workspaceId &&
            sessionId === ATTACHMENT_SESSION_ID &&
            session.surface !== null
            ? { surface: session.surface }
            : null,
        ),
      servedSurfaces: () => Promise.reject(new Error('unused')),
    },
  };
}

function createAttachmentPrincipals(world: World): Record<Actor, Principal> {
  const base = Principal.fromApiKey({
    principalId: world.principalId,
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: world.workspaceId,
    role: 'builder',
    label: 'Attachment route test key',
  });
  const visitor = Principal.fromBrowserToken(base, { kind: 'session', id: ATTACHMENT_SESSION_ID });
  const principals: Record<Actor, Principal> = {
    visitor,
    run: Principal.fromBrowserToken(base, { kind: 'run', id: ATTACHMENT_SESSION_ID }),
    member: base,
    admin: Principal.fromApiKey({
      principalId: world.principalId,
      apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId: world.workspaceId,
      role: 'admin',
      label: 'Attachment route admin key',
    }),
  };

  return principals;
}
