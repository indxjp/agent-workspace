/**
 * A stored credential is bound to the endpoint, account and bucket it was supplied for. A reader
 * that holds a row snapshot (browse, test, a run) gets it only for that snapshot's target; any other
 * pairing is refused before storage is opened.
 */
// @story US-STO-12
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
  type StorageConnectionRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createInMemorySecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { openConnectionStore } from '@agent-workspace/core/storage';
import {
  StorageConnectionCredentialSchema,
  type StorageConnectionCredential,
} from '@indx-workspace/contracts/storage-connections';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRunStorageConnections } from '../composition/wiring/run-resources';
import { Principal } from '../rbac/principal';
import { rotateStorageConnectionCredential, updateStorageConnection } from './handlers';
import type { StorageConnectionsRuntime } from './runtime';
import {
  boundCredential,
  createRepositoryStorageConnectionsStoreProvider,
  credentialTarget,
  storageConnectionSecretName,
  type StorageConnectionsStoreProvider,
} from './store';

// A stub, so no test dials a host: the assertions are about whether the opener was called at all.
vi.mock('@agent-workspace/core/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-workspace/core/storage')>();
  return { ...actual, openConnectionStore: vi.fn() };
});

const opener = vi.mocked(openConnectionStore);
const URL_A = 's3://bucket-a';
const URL_B = 's3://bucket-b';
const URL_C = 's3://bucket-c';

let root: string;
let isolated: IsolatedTestDatabase | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aw-credential-binding-'));
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL case is never skipped.
  isolated = await createIsolatedTestDatabase('aw_credential_binding');
}, 180_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await isolated?.close();
});
afterEach(() => {
  opener.mockReset();
  opener.mockResolvedValue({} as Awaited<ReturnType<typeof openConnectionStore>>);
});

/** Built at run time: a key-shaped literal would trip the secret scanner. */
const s3Credential = (): StorageConnectionCredential => ({
  provider: 's3',
  accessKeyId: ['AK', 'IA'].join('') + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  secretAccessKey: crypto.randomUUID() + crypto.randomUUID(),
});

/** A one-shot pause: `hold()` reports `reached` and waits for `release()`. */
function pause() {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const hold = async () => {
    entered();
    await released;
  };
  return { hold, reached, release };
}

/** Holds the next `resolveByName` or `replace` (after `skip` calls) until `release()`; may fail it. */
function gated(inner: SecretsService) {
  type Gate = { skip: number; fail: boolean; entered: () => void; released: Promise<void> };
  const gates: { resolveByName: Gate | null; replace: Gate | null } = {
    resolveByName: null,
    replace: null,
  };
  const hold = async (which: keyof typeof gates) => {
    const gate = gates[which];
    if (gate === null || gate.skip-- > 0) return;
    gates[which] = null;
    gate.entered();
    await gate.released;
    if (gate.fail) throw new Error('the secret store failed');
  };
  const service: SecretsService = {
    ...inner,
    async resolveByName(scope, name) {
      await hold('resolveByName');
      return inner.resolveByName(scope, name);
    },
    async replace(scope, id, value) {
      await hold('replace');
      return inner.replace(scope, id, value);
    },
  };
  const arm = (which: keyof typeof gates, options: { skip?: number; fail?: boolean } = {}) => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    gates[which] = { skip: options.skip ?? 0, fail: options.fail ?? false, entered, released };
    return { reached, release };
  };
  return { service, arm };
}

/** The repositories, with a pause armed for just after the next row update has been published. */
function gatedRepositories(inner: StorageConnectionRepositoryProvider) {
  let afterUpdate: (() => Promise<void>) | null = null;
  const repositories: StorageConnectionRepositoryProvider = {
    forScope(scope) {
      const repository = inner.forScope(scope);
      return {
        ...repository,
        async update(id, patch) {
          const outcome = await repository.update(id, patch);
          const hold = afterUpdate;
          afterUpdate = null;
          if (hold !== null) await hold();
          return outcome;
        },
      };
    },
  };
  const armAfterUpdate = () => {
    const gate = pause();
    afterUpdate = gate.hold;
    return gate;
  };
  return { repositories, armAfterUpdate };
}

/** A store provider whose next `update` or `rotate` waits, after the handler's read, for a release. */
function heldStoreProvider(inner: StorageConnectionsStoreProvider) {
  let next: (() => Promise<void>) | null = null;
  const take = async () => {
    const hold = next;
    next = null;
    if (hold !== null) await hold();
  };
  const provider: StorageConnectionsStoreProvider = {
    forWorkspace(workspaceId) {
      const store = inner.forWorkspace(workspaceId);
      return {
        ...store,
        async update(...args) {
          await take();
          return store.update(...args);
        },
        async rotate(...args) {
          await take();
          return store.rotate(...args);
        },
      };
    },
  };
  const armNextWrite = () => {
    const gate = pause();
    next = gate.hold;
    return gate;
  };
  return { provider, armNextWrite };
}

interface World {
  readonly repositories: StorageConnectionRepositoryProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspace: string;
}

const memoryWorld = (): Promise<World> => {
  const workspace = crypto.randomUUID();
  return Promise.resolve({
    repositories: createInMemoryStorageConnectionRepositoryProvider(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspace, slug: 'a' }]),
    workspace,
  });
};

const postgresWorld = async (): Promise<World> => {
  if (isolated === undefined) throw new Error('the test database did not start');
  const workspace = crypto.randomUUID();
  await isolated.db.insert(workspaces).values({ id: workspace, slug: `a-${workspace}`, name: 'A' });
  return {
    repositories: createDatabaseStorageConnectionRepositoryProvider(isolated.db),
    scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    workspace,
  };
};

/** The real store, handlers and run composition over one secret service, and a connection to `URL_A`. */
async function fixture(world: World, credential: StorageConnectionCredential | undefined) {
  const inner = createInMemorySecretsService();
  const secrets = gated(inner);
  const rows = gatedRepositories(world.repositories);
  const scope = await world.scopes.forWorkspaceId(world.workspace);
  if (scope === null) throw new Error('the workspace resolves');
  const base = createRepositoryStorageConnectionsStoreProvider({
    repositories: rows.repositories,
    scopes: world.scopes,
    secrets: secrets.service,
  });
  const held = heldStoreProvider(base);
  const store = base.forWorkspace(world.workspace);
  const created = await store.create({
    name: 'acme-data',
    url: URL_A,
    provider: 's3',
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    credential,
  });
  if (created.kind !== 'created') throw new Error('the connection is created');
  const id = created.connection.id;
  const runs = createRunStorageConnections({
    storage: { store: base, fileRoots: [root] },
    scopes: world.scopes,
  });
  const runtime: StorageConnectionsRuntime = {
    store: held.provider,
    fileRoots: [root],
    egress: { production: true, allowHosts: [] },
    isConnectionGranted: () => Promise.resolve(false),
    audit: () => Promise.resolve(),
  };
  const principal = Principal.fromApiKey({
    principalId: crypto.randomUUID(),
    apiKeyId: crypto.randomUUID(),
    workspaceId: world.workspace,
    role: 'owner',
    label: 'credential binding test',
  });
  /** `PATCH /api/storage-connections/:id` and `PUT …/credential`, through the real handlers. */
  const patch = (body: unknown) => updateStorageConnection(runtime, principal, id, body);
  const rotate = (body: unknown) => rotateStorageConnectionCredential(runtime, principal, id, body);
  /** What browse and test do: read the row, then ask for the credential of that exact URL. */
  const browse = async () => {
    const snapshot = await store.get(id);
    if (snapshot === null) throw new Error('the connection exists');
    return store.credential(id, snapshot.url);
  };
  const stored = () => inner.resolveByName(scope, storageConnectionSecretName(id));
  const storedTarget = async (): Promise<unknown> => {
    const value: unknown = JSON.parse((await stored())?.value.toString('utf8') ?? 'null');
    return typeof value === 'object' && value !== null && 'target' in value ? value.target : null;
  };
  /** Moves the row without the store, as an older revision's PATCH does. */
  const moveRowAround = async (url: string) => {
    await world.repositories.forScope(scope).update(id, { url });
  };
  const plantBare = (bare: StorageConnectionCredential) =>
    inner.create(scope, {
      name: storageConnectionSecretName(id),
      value: Buffer.from(JSON.stringify(bare)),
    });
  return {
    inner,
    secrets,
    rows,
    held,
    store,
    runs,
    id,
    patch,
    rotate,
    browse,
    stored,
    storedTarget,
    moveRowAround,
    plantBare,
    scope,
    workspace: world.workspace,
  };
}

async function runRefusal(open: Promise<unknown>): Promise<unknown> {
  const error: unknown = await open.then(
    () => null,
    (cause: unknown) => cause,
  );
  return error instanceof Error && 'code' in error ? error.code : null;
}

function problemCode(result: { readonly body: unknown }): unknown {
  const body = result.body;
  return typeof body === 'object' && body !== null && 'error' in body
    ? (body.error as { code?: unknown }).code
    : null;
}

/** Every credential the opener was handed, with the URL it was handed for. */
const openedPairs = () => opener.mock.calls.map((call) => [call[0], call[1]]);

describe('boundCredential', () => {
  it('[US-STO-12][unit][run] returns nothing for a bare (pre-binding) credential, whatever the URL', () => {
    const bare = Buffer.from(JSON.stringify(s3Credential()), 'utf8');
    expect(boundCredential(bare, URL_A)).toBeNull();
    expect(boundCredential(bare, URL_B)).toBeNull();
  });

  it('[US-STO-12][unit][run] returns the credential only for its own target', () => {
    const credential = s3Credential();
    const target = credentialTarget(URL_A);
    const sealed = Buffer.from(JSON.stringify({ target, credential }), 'utf8');
    expect(boundCredential(sealed, URL_A)).toEqual(credential);
    expect(boundCredential(sealed, URL_B)).toBeNull();
  });
});

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`credential binding over the ${name}`, () => {
    it('[US-STO-12][unit][run] refuses a run that read the old URL when the new secret lands first', async () => {
      const f = await fixture(await setup(), s3Credential());
      const next = s3Credential();
      const gate = f.secrets.arm('resolveByName');
      const opening = f.runs.open(f.workspace, f.id);
      await gate.reached;
      expect((await f.store.update(f.id, URL_A, { url: URL_B }, next)).kind).toBe('updated');
      gate.release();
      expect(await runRefusal(opening)).toBe('run_storage_grant_unavailable');
      expect(opener).not.toHaveBeenCalled();
    });

    it('[US-STO-12][unit][run] refuses a browse that read the old URL when the new secret lands before its credential read', async () => {
      const f = await fixture(await setup(), s3Credential());
      const gate = f.secrets.arm('resolveByName');
      const browsing = f.browse();
      await gate.reached;
      expect((await f.store.update(f.id, URL_A, { url: URL_B }, s3Credential())).kind).toBe(
        'updated',
      );
      gate.release();
      expect(await browsing).toBeNull();
    });

    it('[US-STO-12][unit][run] refuses the new URL while the old secret is still stored', async () => {
      const f = await fixture(await setup(), s3Credential());
      const next = s3Credential();
      const gate = f.secrets.arm('replace');
      const updating = f.store.update(f.id, URL_A, { url: URL_B }, next);
      await gate.reached;
      expect(await f.browse()).toBeNull();
      expect(await runRefusal(f.runs.open(f.workspace, f.id))).toBe(
        'run_storage_grant_unavailable',
      );
      expect(opener).not.toHaveBeenCalled();
      gate.release();
      await updating;
      expect(await f.browse()).toEqual(next);
    });

    it('[US-STO-12][unit][run] binds a pre-binding secret to the old target before a new URL is published', async () => {
      const bare = s3Credential();
      const next = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      // The first replace binds the secret; the second writes the new credential.
      const gate = f.secrets.arm('replace', { skip: 1 });
      const updating = f.store.update(f.id, URL_A, { url: URL_B }, next);
      await gate.reached;
      expect(await f.store.credential(f.id, URL_A)).toEqual(bare);
      expect(await f.browse()).toBeNull();
      expect(await runRefusal(f.runs.open(f.workspace, f.id))).toBe(
        'run_storage_grant_unavailable',
      );
      expect(opener).not.toHaveBeenCalled();
      gate.release();
      await updating;
      expect(await f.browse()).toEqual(next);
    });

    it('[US-STO-12][unit][run] has a pre-binding secret bound before the new URL is visible to any reader', async () => {
      const bare = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      const gate = f.rows.armAfterUpdate();
      const updating = f.store.update(f.id, URL_A, { url: URL_B }, s3Credential());
      await gate.reached;
      // The row is published at URL_B; the bare secret must already be bound to URL_A's target.
      expect((await f.store.get(f.id))?.url).toBe(URL_B);
      expect(await f.browse()).toBeNull();
      expect(await runRefusal(f.runs.open(f.workspace, f.id))).toBe(
        'run_storage_grant_unavailable',
      );
      expect(openedPairs()).toEqual([]);
      gate.release();
      await updating;
    });

    it('[US-STO-12][unit][run] binds a pre-binding secret on its first read, so a later move cannot carry it', async () => {
      const bare = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      expect(await f.storedTarget()).toBeNull();
      expect(await f.browse()).toEqual(bare);
      expect(await f.storedTarget()).not.toBeNull();
      // A move that bypasses the store (an older revision's PATCH) does not take it along.
      await f.moveRowAround(URL_B);
      expect(await f.browse()).toBeNull();
      expect(await runRefusal(f.runs.open(f.workspace, f.id))).toBe(
        'run_storage_grant_unavailable',
      );
      expect(opener).not.toHaveBeenCalled();
    });

    it("[US-STO-12][unit][run] a reader's bind of a pre-binding secret never undoes a rotation made since its read", async () => {
      const bare = s3Credential();
      const rotated = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      // The reader has read the bare secret; its second read, just before the bind, is held.
      const gate = f.secrets.arm('resolveByName', { skip: 1 });
      const reading = f.browse();
      await gate.reached;
      expect((await f.store.rotate(f.id, URL_A, rotated)).kind).toBe('changed');
      gate.release();
      expect(await reading).toEqual(rotated);
      expect(await f.browse()).toEqual(rotated);
    });

    it("[US-STO-12][unit][run] a PATCH's bind of a pre-binding secret never undoes a rotation made since its read", async () => {
      const bare = s3Credential();
      const rotated = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      // The PATCH has read the bare secret; its second read, just before the bind, is held.
      const gate = f.secrets.arm('resolveByName', { skip: 1 });
      const moving = f.store.update(f.id, URL_A, { url: URL_B });
      await gate.reached;
      expect((await f.store.rotate(f.id, URL_A, rotated)).kind).toBe('changed');
      gate.release();
      expect((await moving).kind).toBe('updated');
      // The rotation stays, bound to URL_A's target; the moved row cannot use it.
      expect(await f.store.credential(f.id, URL_A)).toEqual(rotated);
      expect(await f.browse()).toBeNull();
    });

    it('[US-STO-12][unit][run] refuses a pre-binding secret for a URL snapshot the row has left', async () => {
      const bare = s3Credential();
      const f = await fixture(await setup(), undefined);
      await f.plantBare(bare);
      await f.moveRowAround(URL_B);
      expect(await f.store.credential(f.id, URL_A)).toBeNull();
      expect(await f.storedTarget()).toBeNull();
    });

    it('[US-STO-12][unit][run] opens a run with the replacement credential for the matching URL, in a form older readers refuse', async () => {
      const f = await fixture(await setup(), s3Credential());
      const next = s3Credential();
      await f.store.update(f.id, URL_A, { url: URL_B }, next);
      await f.runs.open(f.workspace, f.id);
      expect(opener).toHaveBeenCalledTimes(1);
      expect(opener.mock.calls[0]?.slice(0, 2)).toEqual([URL_B, next]);
      const envelope: unknown = JSON.parse((await f.stored())?.value.toString('utf8') ?? 'null');
      expect(StorageConnectionCredentialSchema.safeParse(envelope).success).toBe(false);
    });

    it('[US-STO-12][unit][run] keeps the credential for a prefix-only change', async () => {
      const first = s3Credential();
      const f = await fixture(await setup(), first);
      await f.store.update(f.id, URL_A, { url: `${URL_A}/archive`, allowedPrefixes: ['archive'] });
      expect(await f.browse()).toEqual(first);
      await f.runs.open(f.workspace, f.id);
      expect(opener.mock.calls[0]?.slice(0, 2)).toEqual([`${URL_A}/archive`, first]);
    });

    it('[US-STO-12][unit][run] two concurrent changes never leave a credential for another URL', async () => {
      const f = await fixture(await setup(), s3Credential());
      const sent = new Map([
        [URL_B, s3Credential()],
        [URL_C, s3Credential()],
      ]);
      await Promise.all(
        [...sent].map(([url, credential]) => f.store.update(f.id, URL_A, { url }, credential)),
      );
      const row = await f.store.get(f.id);
      const read = await f.browse();
      expect([null, sent.get(row?.url ?? '')]).toContainEqual(read);
    });

    it("[US-STO-12][unit][run] a failed replacement leaves a newer writer's credential in place", async () => {
      const f = await fixture(await setup(), s3Credential());
      const newer = s3Credential();
      const gate = f.secrets.arm('replace', { fail: true });
      const failing = f.store.update(f.id, URL_A, { url: URL_B }, s3Credential());
      await gate.reached;
      expect((await f.store.update(f.id, URL_B, { url: URL_B }, newer)).kind).toBe('updated');
      gate.release();
      await expect(failing).rejects.toThrow('the secret store failed');
      expect(await f.browse()).toEqual(newer);
    });

    // C1: admin A's handler read the row at URL_A; admin B moves it to URL_B before A's write.
    for (const route of ['PATCH', 'PUT credential'] as const) {
      it(`[US-STO-12][unit][run] ${route}: a credential judged for the old URL is never paired with the new one`, async () => {
        const first = s3Credential();
        const f = await fixture(await setup(), first);
        const fromA = s3Credential();
        const fromB = s3Credential();
        const heldA = f.held.armNextWrite();
        const writingA = route === 'PATCH' ? f.patch({ credential: fromA }) : f.rotate(fromA);
        await heldA.reached;
        // B publishes URL_B and is paused before its secret is written.
        const heldB = f.secrets.arm('replace');
        const writingB = f.patch({ url: URL_B, credential: fromB });
        await heldB.reached;
        heldA.release();
        const answerA = await writingA;
        expect(answerA.status).toBe(409);
        expect(problemCode(answerA)).toBe('storage_connection_credential_required');
        expect(await f.browse()).toBeNull();
        expect(await runRefusal(f.runs.open(f.workspace, f.id))).toBe(
          'run_storage_grant_unavailable',
        );
        heldB.release();
        expect((await writingB).status).toBe(200);
        expect(await f.browse()).toEqual(fromB);
        await f.runs.open(f.workspace, f.id);
        expect(openedPairs()).toEqual([[URL_B, fromB]]);
      });
    }

    it("[US-STO-12][unit][run] a credential-only PATCH refused after another writer's move leaves that writer's secret", async () => {
      const f = await fixture(await setup(), s3Credential());
      const fromA = s3Credential();
      const fromB = s3Credential();
      // A passes the target check and is paused once its own row update has been applied.
      const heldA = f.rows.armAfterUpdate();
      const writingA = f.store.update(f.id, URL_A, { name: 'renamed' }, fromA);
      // A's row update is in the repository; B's move lands before A goes on.
      await heldA.reached;
      expect((await f.store.update(f.id, URL_A, { url: URL_B }, fromB)).kind).toBe('updated');
      heldA.release();
      expect((await writingA).kind).toBe('target-changed');
      expect(await f.browse()).toEqual(fromB);
    });
  });
}

defineSuite('in-memory repository', memoryWorld);
defineSuite('PostgreSQL repository', postgresWorld);
