/**
 * The chat cell of US-STO-11 (the storage design, §07): a public surface visitor uploads through
 * `POST /api/sessions/:id/attachments`, its next turn starts a run through `POST
 * /api/agents/:id/runs`, and the runner receives the attachment as a `read` reference and a
 * read-only archive member under the run's cwd. A visitor of another session naming that file id is
 * answered the concealed `404 file_not_found` (ADR-0146 D5). Both catalogs.
 */
// @story US-STO-11
import { createHash } from 'node:crypto';
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
} from '@agent-workspace/core/storage';
import {
  SurfaceAttachmentResponseSchema,
  type SurfaceDefinition,
} from '@indx-workspace/contracts/surfaces';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { POST as uploadRoute } from '../../../app/api/sessions/[engineSessionId]/attachments/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { Principal } from '../../rbac/principal';
import { startRun } from '../../runs/api';
import type { RunPrincipal } from '../../runs/environment';
import { installDeliveringRunApi, type RunWorld } from '../../runs/run-delivery-fixtures';
import { InMemoryRunStore } from '../../runs/memory-store';
import { createResourceCatalogStoreProvider } from '../../resources/catalog-store';
import { createInMemoryCatalogStore } from '../../resources/catalog-store.memory';
import { createStorageService } from '../../storage/service';
import { resetSurfaceLimits } from './limits';

const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const SURFACE: SurfaceDefinition = { name: 'main', agent: 'support', parts: { attachments: true } };
const TEXT = 'scanned receipt';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_surface_attachments_run');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
  resetSurfaceLimits();
});

const memoryRunWorld = (): Promise<RunWorld> =>
  Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    workspaceId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
  });

/** The surface key's owner, a membership principal in a fresh workspace on the test database. */
async function postgresRunWorld(): Promise<RunWorld> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const [workspaceId, userId, membershipId, principalId] = [1, 2, 3, 4].map(() =>
    crypto.randomUUID(),
  ) as [string, string, string, string];
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'chat' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  // In one transaction, so the deferred trigger finds this principal rather than making its own.
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const repositories = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const catalogs = createResourceCatalogStoreProvider({ repositories, scopes });
  return { catalogs, workspaceId, principalId, userId };
}

/** One public surface session's visitor, and a visitor of another session, over `world`. */
function install(world: RunWorld) {
  const storage = createStorageService({
    catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  const base = Principal.fromApiKey({
    principalId: world.principalId,
    apiKeyId: crypto.randomUUID(),
    workspaceId: world.workspaceId,
    role: 'builder',
    label: 'Surface backend key',
  });
  // The run API's view of each visitor's browser token: the key it was minted from, scoped.
  const visitorOf = (session: string): RunPrincipal => ({
    principalId: world.principalId,
    ownerPrincipalId: world.principalId,
    userId: null,
    workspaceId: world.workspaceId,
    role: 'builder',
    scope: { kind: 'session', id: session },
  });
  installTestDomains({
    projects: { forWorkspace: () => Promise.resolve(undefined) } as never,
    files: {
      kind: 'serving',
      runtime: {
        resolveWorkspace: () =>
          Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
        // The legacy per-area store: wired, never written while the catalog service is.
        store: createInMemoryObjectStoreProvider(),
        catalog: world.catalogs,
        storage,
      },
    },
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(Principal.fromBrowserToken(base, { kind: 'session', id: SESSION })),
    },
    surfaces: {
      kind: 'serving',
      runtime: {
        resolve: () => Promise.reject(new Error('unused')),
        open: () => Promise.reject(new Error('unused')),
        checkModel: () => Promise.reject(new Error('unused')),
        visitorSurface: (workspaceId, sessionId) =>
          Promise.resolve(
            workspaceId === world.workspaceId && sessionId === SESSION
              ? { surface: SURFACE }
              : null,
          ),
        servedSurfaces: () => Promise.reject(new Error('unused')),
      },
    },
  });
  const runs = installDeliveringRunApi({
    world,
    storage,
    store: new InMemoryRunStore(),
    sessionId: SESSION,
    // The turn names its session; the bearer value says whose token it is.
    authenticate: (request) =>
      Promise.resolve(
        visitorOf(request.headers.get('authorization') === 'other' ? OTHER_SESSION : SESSION),
      ),
  });
  const turn = (session: string, fileId: string) =>
    startRun(
      new Request(`http://web.test/api/agents/${runs.agentId}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(session === SESSION ? {} : { authorization: 'other' }),
        },
        body: JSON.stringify({
          prompt: 'what is this?',
          sessionId: session,
          attachments: [{ fileId }],
        }),
      }),
      runs.agentId,
    );
  return { runs, turn };
}

async function upload(name: string): Promise<{ fileId: string; path: string }> {
  const response = await uploadRoute(
    new Request(
      `http://web.test/api/sessions/${SESSION}/attachments?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: TEXT },
    ),
    { params: Promise.resolve({ engineSessionId: SESSION }) },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return SurfaceAttachmentResponseSchema.parse(await response.json());
}

function defineSuite(name: string, setup: () => Promise<RunWorld>) {
  describe(`a surface turn with an attachment on the ${name}`, () => {
    it('[US-STO-11][api][chat] a chat attachment reaches the agent', async () => {
      const world = await setup();
      const { runs, turn } = install(world);
      const uploaded = await upload('receipt.txt');

      const started = await turn(SESSION, uploaded.fileId);
      expect(started.status, await started.clone().text()).toBe(202);
      const { run } = (await started.json()) as { run: { id: string; sessionId: string } };
      expect(run.sessionId).toBe(SESSION);
      const delivered = await runs.delivered(run.id);

      expect(delivered.files).toEqual([
        {
          kind: 'file',
          path: uploaded.path,
          access: 'read',
          size: Buffer.byteLength(TEXT),
          sha256: createHash('sha256').update(TEXT).digest('hex'),
        },
      ]);
      expect(delivered.archive).toMatchObject([
        {
          path: `${world.workspaceId}/${SESSION}/${uploaded.path}`,
          type: 'file',
          mode: 0o444,
          data: Buffer.from(TEXT),
        },
      ]);

      const refused = await turn(OTHER_SESSION, uploaded.fileId);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: 'file_not_found' } });
    });
  });
}

defineSuite('in-memory catalog', memoryRunWorld);
defineSuite('PostgreSQL catalog', postgresRunWorld);
