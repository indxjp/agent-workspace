/**
 * #1991 C1: a write that replaces a file is authorized against the ready file its reserve locked,
 * not against the path the route checked earlier. Between the route's ownership read and the
 * reserve, another Builder can create the path; between the reserve and the decision, that file can
 * be renamed away (its pending replacement follows it) and the path reused. The gates below hold
 * one Builder's request at those two points, on the in-memory catalog and on PostgreSQL. Harness:
 * `routes.test-support.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
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
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../storage/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createCatalogFilesWorld } from './catalog-runtime-fixtures';
import { encodeFileId } from './file-id';
import {
  ACTOR_HEADER,
  download,
  expectError,
  idContext,
  req,
  upload as uploadFile,
} from './routes.test-support';

afterEach(() => {
  clearApplicationContext();
});

interface ReplacementMember {
  readonly email: string;
  readonly principalId: string;
  readonly userId: string;
}

interface ReplacementWorld {
  readonly workspaceId: string;
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: Parameters<typeof createCatalogFilesWorld>[0]['scopes'];
  readonly builderA: ReplacementMember;
  readonly builderB: ReplacementMember;
  readonly admin: ReplacementMember;
}

type ReplacementRole = 'builderA' | 'builderB' | 'admin';

const memberOf = (label: string): ReplacementMember => ({
  email: `${label}@example.test`,
  principalId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
});

/** Holds a member's next `reserve` just before or just after it runs, until `release()`. */
function gatedReserves(inner: ResourceCatalogStoreProvider) {
  interface Gate {
    readonly stage: 'before' | 'after';
    readonly ownerPrincipalId: string;
    readonly entered: () => void;
    readonly released: Promise<void>;
  }
  const gates: Gate[] = [];
  const hold = async (stage: Gate['stage'], ownerPrincipalId: string): Promise<void> => {
    const index = gates.findIndex(
      (gate) => gate.stage === stage && gate.ownerPrincipalId === ownerPrincipalId,
    );
    const [gate] = index === -1 ? [] : gates.splice(index, 1);
    if (gate === undefined) return;
    gate.entered();
    await gate.released;
  };
  const catalogs: ResourceCatalogStoreProvider = {
    async forWorkspace(workspaceId) {
      const catalog = await inner.forWorkspace(workspaceId);
      return {
        ...catalog,
        async reserve(path, input) {
          await hold('before', input.ownerPrincipalId);
          const reserved = await catalog.reserve(path, input);
          await hold('after', input.ownerPrincipalId);
          return reserved;
        },
      };
    },
  };
  const arm = (stage: Gate['stage'], member: ReplacementMember) => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    gates.push({ stage, ownerPrincipalId: member.principalId, entered, released });
    return { reached, release };
  };
  return { catalogs, arm };
}

/** An in-memory object store that signs, so the signed-upload route reaches its reserve. */
function signingStore() {
  const inner = createInMemoryObjectStore();
  return {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
    createSignedUrl: (key: string) =>
      Promise.resolve({ url: `https://store.invalid/${key}`, headers: {} }),
  };
}

function memoryReplacementWorld(): Promise<ReplacementWorld> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'replace-memory' }]),
    builderA: memberOf('replace-builder-a'),
    builderB: memberOf('replace-builder-b'),
    admin: memberOf('replace-admin'),
  });
}

let replacementDatabase: IsolatedTestDatabase | undefined;

async function postgresReplacementWorld(): Promise<ReplacementWorld> {
  if (replacementDatabase === undefined) throw new Error('the test database did not start');
  const db = replacementDatabase.db;
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `replace-${workspaceId}`, name: 'Replace' });
  const member = async (label: string, role: 'builder' | 'admin') => {
    const seeded = memberOf(label);
    const membershipId = crypto.randomUUID();
    await db.insert(users).values({ id: seeded.userId, email: seeded.email, name: label });
    await db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId, userId: seeded.userId, role });
      await tx
        .insert(workspacePrincipals)
        .values({ id: seeded.principalId, workspaceId, kind: 'membership', membershipId });
    });
    return seeded;
  };
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return {
    workspaceId,
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    builderA: await member(`replace-a-${workspaceId}`, 'builder'),
    builderB: await member(`replace-b-${workspaceId}`, 'builder'),
    admin: await member(`replace-admin-${workspaceId}`, 'admin'),
  };
}

/**
 * Installs `replacement`'s workspace, always resolved, over gated reserves and a signing store, and
 * its three members as user tokens picked by the actor header.
 */
function installReplacementWorld(replacement: ReplacementWorld): ReturnType<typeof gatedReserves> {
  const gates = gatedReserves(replacement.catalogs);
  const roles = new Map<string, { member: ReplacementMember; role: 'builder' | 'admin' }>([
    [replacement.builderA.email, { member: replacement.builderA, role: 'builder' }],
    [replacement.builderB.email, { member: replacement.builderB, role: 'builder' }],
    [replacement.admin.email, { member: replacement.admin, role: 'admin' }],
  ]);
  const { workspaceId } = replacement;
  const files = createCatalogFilesWorld({
    catalogs: gates.catalogs,
    scopes: replacement.scopes,
    objects: signingStore(),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId }),
  });
  installTestDomains({ files: { kind: 'serving', runtime: files.runtime } });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify(request: Request) {
        const known = roles.get(request.headers.get(ACTOR_HEADER) ?? '');
        return Promise.resolve(
          known === undefined
            ? null
            : Principal.fromUserToken(workspaceId, known.member.email, known.role, {
                principalId: known.member.principalId,
                userId: known.member.userId,
                label: known.member.email,
              }),
        );
      },
    },
  });
  return gates;
}

function defineReplacementSuite(name: string, setup: () => Promise<ReplacementWorld>) {
  describe(`a replacement is authorized against the file its reserve locked, on the ${name} (#1991 C1)`, () => {
    let replacement: ReplacementWorld;
    let gates: ReturnType<typeof gatedReserves>;

    beforeEach(async () => {
      replacement = await setup();
      gates = installReplacementWorld(replacement);
    });

    const actor = (role: ReplacementRole): ReplacementMember => replacement[role];

    const upload = (role: ReplacementRole, filePath: string, text: string): Promise<Response> =>
      uploadFile(filePath, text, { actor: actor(role).email, contentType: 'text/plain' });

    function mintUpload(role: ReplacementRole, filePath: string): Promise<Response> {
      const id = encodeFileId(filePath);
      return uploadUrlRoute(
        req('POST', `/api/files/${id}/upload-urls`, {
          body: JSON.stringify({ sizeBytes: 4 }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: actor(role).email },
        }),
        idContext(id),
      );
    }

    async function contentOf(filePath: string): Promise<string> {
      const response = await download(filePath, { actor: actor('admin').email });
      expect(response.status, filePath).toBe(200);
      return response.text();
    }

    const catalog = () => replacement.catalogs.forWorkspace(replacement.workspaceId);

    it('a Builder cannot replace a file another Builder creates after the ownership check', async () => {
      const beforeReserve = gates.arm('before', actor('builderA'));
      const late = upload('builderA', 'race.txt', 'A bytes');
      await beforeReserve.reached;

      expect((await upload('builderB', 'race.txt', 'B bytes')).status).toBe(201);
      beforeReserve.release();

      await expectError(await late, 403, 'forbidden');
      expect(await contentOf('race.txt')).toBe('B bytes');
      await expect((await catalog()).get('race.txt')).resolves.toMatchObject({
        ownerPrincipalId: actor('builderB').principalId,
        status: 'ready',
      });
      await expect((await catalog()).countPending()).resolves.toBe(0);
    });

    it('an owner still replaces its own file, by relay and by a signed link', async () => {
      expect((await upload('builderA', 'own.txt', 'first')).status).toBe(201);
      expect((await upload('builderA', 'own.txt', 'second')).status).toBe(201);
      expect(await contentOf('own.txt')).toBe('second');
      expect((await mintUpload('builderA', 'own.txt')).status).toBe(201);
    });

    it("an Admin still replaces any member's file", async () => {
      expect((await upload('builderB', 'theirs.txt', 'B bytes')).status).toBe(201);
      expect((await upload('admin', 'theirs.txt', 'Admin bytes')).status).toBe(201);
      expect(await contentOf('theirs.txt')).toBe('Admin bytes');
      expect((await mintUpload('admin', 'theirs.txt')).status).toBe(201);
    });
  });
}

defineReplacementSuite('in-memory catalog', memoryReplacementWorld);

describe('on PostgreSQL', () => {
  beforeAll(async () => {
    replacementDatabase = await createIsolatedTestDatabase('aw_files_replace');
  }, 180_000);

  afterAll(async () => replacementDatabase?.close());

  defineReplacementSuite('PostgreSQL catalog', postgresReplacementWorld);
});
