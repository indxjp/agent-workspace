import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  agentSkills,
  agents,
  closeIsolatedTestResources,
  connect,
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  readBytes,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { afterAll, beforeAll } from 'vitest';
import { createSkillRowsWorld } from './rows-fixture';
import { type SkillPrincipal } from './service';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

/** Connections in the second server's pool, so a test can run one more request than it holds. */
export const SECOND_POOL_SIZE = 4;

export interface Fixture {
  readonly principal: SkillPrincipal & { readonly workspaceId: string };
  /** One catalog handle per server. */
  readonly catalogs: readonly [ResourceCatalogRepository, ResourceCatalogRepository];
  /** Assign the skill `name` to a new agent, as the catalog under test records it. */
  readonly assign: (name: string) => Promise<void>;
}

export const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

export const skillMd = (who: string): string => `---\nname: dup\n---\n\nfrom ${who}\n`;

export const runSh = (who: string): string => `echo ${who}\n`;

export const importBody = (who: string) => ({
  name: 'dup',
  files: [
    { path: 'SKILL.md', contentBase64: b64(skillMd(who)) },
    { path: 'scripts/run.sh', contentBase64: b64(runSh(who)) },
  ],
});

/** Wraps an object store so its first `write` waits until `release()` is called. */
export function gatedFirstWrite() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let gated = false;
  const wrap = (inner: ObjectStore): ObjectStore => ({
    ...inner,
    write: async (name, body, options) => {
      if (!gated) {
        gated = true;
        enter();
        await released;
      }
      return inner.write(name, body, options);
    },
  });
  return { wrap, entered, release };
}

/** The rows of one server: its catalog handle, over `objects`, saving for the fixture's owner. */
function serverRows(
  principal: Fixture['principal'],
  catalog: ResourceCatalogRepository,
  objects: ObjectStore,
) {
  return createSkillRowsWorld(objects, principal.workspaceId, catalog, {
    principalId: principal.ownerPrincipalId,
    userId: principal.userId,
  }).rows;
}

export async function textAt(store: ObjectStore, key: string): Promise<string | null> {
  const object = await store.read(key);
  return object === null ? null : new TextDecoder().decode(await streamToBytes(object.body));
}

export function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    principal: { ownerPrincipalId: 'owner', userId: null, workspaceId },
    catalogs: [provider.forWorkspace(workspaceId), provider.forWorkspace(workspaceId)],
    assign: (name) => {
      provider.forWorkspace(workspaceId).assignSkill(name, crypto.randomUUID());
      return Promise.resolve();
    },
  });
}

let isolated: IsolatedTestDatabase | undefined;

let secondPool: { end(): Promise<void> } | undefined;

let secondDb: ReturnType<typeof connect>['db'] | undefined;

export async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined || secondDb === undefined) {
    throw new Error('the PostgreSQL suite needs TEST_DATABASE_URL; run it through `pnpm test`');
  }
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'skills' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const catalogOn = async (handle: typeof db): Promise<ResourceCatalogRepository> => {
    const scope = await createDatabaseWorkspaceScopeResolver(handle).forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('catalog scope did not resolve');
    return createDatabaseResourceCatalogRepositoryProvider(handle).forScope(scope);
  };
  return {
    principal: { ownerPrincipalId: principalId, userId, workspaceId },
    catalogs: [await catalogOn(db), await catalogOn(secondDb)],
    assign: async (name) => {
      const skill = (await (await catalogOn(db)).listSkills()).find((row) => row.name === name);
      if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
      const agentId = crypto.randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        name: 'Skill assignee',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principalId,
        createdBy: userId,
      });
      await db.insert(agentSkills).values({ workspaceId, agentId, skillId: skill.id });
    },
  };
}

export const legacyBody = {
  name: 'dup',
  files: [
    { path: 'SKILL.md', contentBase64: b64(skillMd('old')) },
    { path: 'references/notes.md', contentBase64: b64('notes') },
    { path: 'scripts/run.sh', contentBase64: b64(runSh('old')) },
  ],
};

export const addFile = (path: string, text: string) => ({
  files: [{ path, contentBase64: b64(text) }],
});
export function registerStorageFixture(hasDatabase: boolean): void {
  beforeAll(async () => {
    if (!hasDatabase) return;
    isolated = await createIsolatedTestDatabase('aw_skills_service_storage');
    const second = connect({ url: isolated.url, maxConnections: SECOND_POOL_SIZE });
    secondPool = second.pool;
    secondDb = second.db;
  }, 180_000);
  afterAll(async () => {
    if (isolated === undefined) return;
    await closeIsolatedTestResources(isolated, { close: async () => secondPool?.end() });
  });
}
export function createRowsWorld(setup: () => Promise<Fixture>) {
  /** The catalog service the rows are saved through, plus helpers to read what it holds. */
  async function rowsWorld(
    wrap: (objects: ObjectStore) => ObjectStore = (o) => o,
    server: 0 | 1 = 0,
  ) {
    const { principal, catalogs, assign } = await setup();
    const shared = createInMemoryObjectStoreProvider().forWorkspace(principal.workspaceId);
    const objects = createInMemoryObjectStore();
    /** The rows of one server (its catalog handle) over `over` objects, shared by default. */
    const onServer = (which: 0 | 1, over: ObjectStore = objects) =>
      serverRows(principal, catalogs[which], over);
    const { storage, rows } = createSkillRowsWorld(
      wrap(objects),
      principal.workspaceId,
      catalogs[server],
      { principalId: principal.ownerPrincipalId, userId: principal.userId },
    );
    const ctx = { workspaceId: principal.workspaceId, principalId: principal.ownerPrincipalId };
    const saveRow = async (path: string, text: string) => {
      const saved = await storage.save(
        { ...ctx, userId: principal.userId },
        {
          area: 'skills',
          path,
          maxBytes: 1024,
          replace: true,
          body: bytesToStream(new TextEncoder().encode(text)),
        },
      );
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    };
    const rowTexts = async (folder: string): Promise<Record<string, string>> => {
      const listed = await storage.list({ workspaceId: principal.workspaceId }, 'skills', folder);
      const out: Record<string, string> = {};
      for (const row of listed.rows) {
        const opened = await storage.open({ workspaceId: principal.workspaceId }, row);
        if (opened === null) throw new Error(`${row.path} has no bytes`);
        out[row.path] = new TextDecoder().decode((await readBytes(opened.body, 1024)) ?? undefined);
      }
      return out;
    };
    return {
      principal,
      catalogs,
      assign,
      shared,
      objects,
      storage,
      rows,
      onServer,
      saveRow,
      rowTexts,
    };
  }
  return rowsWorld;
}
export type RowsWorldFactory = ReturnType<typeof createRowsWorld>;
