/**
 * The SDK and run-entry API cells of US-STO-06 and US-STO-11 (the storage design, §07):
 * `client.runs.start`, and a plain HTTP request, drive the real `POST /api/agents/:id/runs` handler
 * in-process, and what reaches the runner is asserted: the
 * `/run` body's `read` reference and the `/files` archive's read-only member under the run's cwd.
 * A role that may not read the file is answered the concealed `404 file_not_found` (ADR-0146 D5).
 * Both catalogs, in memory and on PostgreSQL.
 *
 * It lives in the application, not in `packages/sdk`: a package may not import the web handlers.
 */
// @story US-STO-06
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
import { bytesToStream, createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService } from '../storage/service';
import { startRun } from './api';
import type { RunPrincipal } from './environment';
import { installDeliveringRunApi, type RunWorld } from './run-delivery-fixtures';
import { InMemoryRunStore } from './memory-store';

const TEXT = 'quarterly numbers';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_sdk_run_files');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(clearApplicationContext);

/** A {@link RunWorld} with a viewer of the same workspace beside its owner. */
interface MemberRunWorld extends RunWorld {
  readonly viewer: { readonly principalId: string; readonly userId: string };
}

const memoryRunWorld = (): Promise<MemberRunWorld> =>
  Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    workspaceId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    viewer: { principalId: crypto.randomUUID(), userId: crypto.randomUUID() },
  });

/** One member of `workspaceId` with its membership principal. */
async function seedMember(
  db: IsolatedTestDatabase['db'],
  workspaceId: string,
  role: 'owner' | 'viewer',
): Promise<{ readonly principalId: string; readonly userId: string }> {
  const [userId, membershipId, principalId] = [1, 2, 3].map(() => crypto.randomUUID()) as [
    string,
    string,
    string,
  ];
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: role });
  // In one transaction, so the deferred trigger finds this principal rather than making its own.
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { principalId, userId };
}

/**
 * A fresh workspace on the test database whose owner and viewer are both real members, so the
 * viewer's refusal is decided by its role, not by a principal with no row.
 */
async function postgresRunWorld(): Promise<MemberRunWorld> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const { db } = isolated;
  const workspaceId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'runs' });
  const owner = await seedMember(db, workspaceId, 'owner');
  const viewer = await seedMember(db, workspaceId, 'viewer');
  const repositories = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  const catalogs = createResourceCatalogStoreProvider({ repositories, scopes });
  return { catalogs, workspaceId, ...owner, viewer };
}

/** The web app in-process: the one route these tests call. */
function web(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const match = /^\/api\/agents\/([^/]+)\/runs$/u.exec(new URL(request.url).pathname);
  if (match?.[1] === undefined || request.method !== 'POST') {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return startRun(request, match[1]);
}

async function harness(world: MemberRunWorld, granted: boolean) {
  const storage = createStorageService({
    catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  const saved = await storage.save(
    { workspaceId: world.workspaceId, principalId: world.principalId, userId: world.userId },
    {
      area: 'files',
      path: 'reports/q3.txt',
      maxBytes: 1024,
      replace: false,
      body: bytesToStream(Buffer.from(TEXT)),
    },
  );
  if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        resolveWorkspace: () =>
          Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
        store: {} as never,
        catalog: world.catalogs,
        storage,
      },
    },
  });
  // Bearer values are random per test; each names one caller.
  const owner = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const principals = new Map<string, RunPrincipal>([
    [
      owner,
      {
        principalId: world.principalId,
        ownerPrincipalId: world.principalId,
        userId: world.userId,
        workspaceId: world.workspaceId,
        role: 'owner',
        scope: null,
      },
    ],
    [
      viewer,
      {
        principalId: world.viewer.principalId,
        ownerPrincipalId: world.viewer.principalId,
        userId: world.viewer.userId,
        workspaceId: world.workspaceId,
        role: 'viewer',
        scope: null,
      },
    ],
  ]);
  const runs = installDeliveringRunApi({
    world,
    storage,
    store: new InMemoryRunStore(),
    authenticate: (request) =>
      Promise.resolve(
        principals.get((request.headers.get('authorization') ?? '').replace(/^Bearer /u, '')) ??
          null,
      ),
    grants: granted ? [{ fileId: saved.row.id, access: 'read' }] : [],
  });
  const client = (apiKey: string) =>
    createClient({ baseUrl: 'http://web.test', auth: { kind: 'api-key', apiKey }, fetch: web });
  // The run-entry API without the SDK: one plain HTTP request.
  const post = (bearer: string, body: object) =>
    web(`http://web.test/api/agents/${runs.agentId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    runs,
    fileId: saved.row.id,
    owner: client(owner),
    viewer: client(viewer),
    http: {
      owner: (body: object) => post(owner, body),
      viewer: (body: object) => post(viewer, body),
    },
  };
}

/** The `read` reference and the read-only archive member under the run's cwd. */
function expectReadOnlyDelivery(
  world: RunWorld,
  sessionId: string,
  delivered: Awaited<ReturnType<ReturnType<typeof installDeliveringRunApi>['delivered']>>,
): void {
  expect(delivered.files).toEqual([
    {
      kind: 'file',
      path: 'reports/q3.txt',
      access: 'read',
      size: Buffer.byteLength(TEXT),
      sha256: createHash('sha256').update(TEXT).digest('hex'),
    },
  ]);
  // Where the runner checks the reference: `<cwd>/<path>`, read-only.
  expect(delivered.archive).toMatchObject([
    {
      path: `${world.workspaceId}/${sessionId}/reports/q3.txt`,
      type: 'file',
      mode: 0o444,
      data: Buffer.from(TEXT),
    },
  ]);
}

/** A Viewer may run the agent but holds no `files` grant: the owner's file is the concealed 404. */
async function expectConcealed(started: Promise<unknown>): Promise<void> {
  const refused = await started.then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ApiProblemError);
  expect(refused).toMatchObject({ status: 404, code: 'file_not_found' });
}

function defineSuite(name: string, setup: () => Promise<MemberRunWorld>) {
  describe(`client.runs.start delivers files on the ${name}`, () => {
    it('[US-STO-06][api][sdk] a granted file reaches the run read-only', async () => {
      const world = await setup();
      const { runs, fileId, owner, viewer } = await harness(world, true);

      const started = await owner.runs.start(runs.agentId, { prompt: 'summarise' });
      expectReadOnlyDelivery(world, started.run.sessionId, await runs.delivered(started.run.id));
      await expectConcealed(
        viewer.runs.start(runs.agentId, { prompt: 'summarise', attachments: [{ fileId }] }),
      );
    });

    it('[US-STO-11][api][sdk] an attachment reaches the run', async () => {
      const world = await setup();
      const { runs, fileId, owner, viewer } = await harness(world, false);

      const started = await owner.runs.start(runs.agentId, {
        prompt: 'summarise',
        attachments: [{ fileId }],
      });
      expectReadOnlyDelivery(world, started.run.sessionId, await runs.delivered(started.run.id));
      await expectConcealed(
        viewer.runs.start(runs.agentId, { prompt: 'summarise', attachments: [{ fileId }] }),
      );
    });
  });

  describe(`POST /api/agents/:id/runs delivers files on the ${name}`, () => {
    /** The owner's run over plain HTTP gets the file; a Viewer naming it is answered the 404. */
    async function startOverHttp(
      world: MemberRunWorld,
      granted: boolean,
      attach: boolean,
    ): Promise<void> {
      const { runs, fileId, http } = await harness(world, granted);
      const response = await http.owner(
        attach ? { prompt: 'summarise', attachments: [{ fileId }] } : { prompt: 'summarise' },
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const { run } = (await response.json()) as { run: { id: string; sessionId: string } };
      expectReadOnlyDelivery(world, run.sessionId, await runs.delivered(run.id));

      const refused = await http.viewer({ prompt: 'summarise', attachments: [{ fileId }] });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: 'file_not_found' } });
    }

    it('[US-STO-06][api][run] a granted file reaches the run read-only; a Viewer is answered 404', async () => {
      await startOverHttp(await setup(), true, false);
    });

    it('[US-STO-11][api][run] an attachment reaches the run; a Viewer is answered 404', async () => {
      await startOverHttp(await setup(), false, true);
    });
  });
}

defineSuite('in-memory catalog', memoryRunWorld);
defineSuite('PostgreSQL catalog', postgresRunWorld);
