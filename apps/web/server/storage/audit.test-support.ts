import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { createStorageService, type StorageAuditEvent, type StorageContext } from './service';

interface Fixture {
  readonly workspace: () => Promise<{ readonly id: string; readonly principalId: string }>;
  readonly catalog: (workspaceId: string) => Promise<ResourceCatalogRepository>;
}

export const noLog: Logger = { info() {}, warn() {}, error() {}, child: () => noLog };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const bytesOf = (text: string) => new TextEncoder().encode(text);
/** Built at run time: a signature-shaped value that no source file spells out. */
const sentinel = () => crypto.randomUUID().replaceAll('-', '');

function memoryFixture(): Promise<Fixture> {
  const provider = createInMemoryCatalog();
  return Promise.resolve({
    workspace: () => Promise.resolve({ id: crypto.randomUUID(), principalId: crypto.randomUUID() }),
    catalog: (workspaceId) => Promise.resolve(provider.forWorkspace(workspaceId)),
  });
}

/** Starts one isolated database for the calling test file and returns how to reach it. */
export function useIsolatedAuditDatabase(): () => IsolatedTestDatabase {
  let isolated: IsolatedTestDatabase | undefined;
  beforeAll(async () => {
    // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite is never skipped.
    isolated = await createIsolatedTestDatabase('aw_storage_audit');
  }, 180_000);
  afterAll(async () => isolated?.close());
  return () => {
    if (isolated === undefined) throw new Error('the test database did not start');
    return isolated;
  };
}

async function insertOwnedWorkspace(db: IsolatedTestDatabase['db']) {
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id, slug: `s-${id}`, name: 'storage audit' });
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
  });
  return { id, principalId };
}

function postgresFixture(database: () => IsolatedTestDatabase): Promise<Fixture> {
  const db = database().db;
  const provider = createDatabaseResourceCatalogRepositoryProvider(db);
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return Promise.resolve({
    workspace: () => insertOwnedWorkspace(db),
    catalog: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
      return provider.forScope(scope);
    },
  });
}

/** Fail the next `next` audit writes; `landed`: the row is written and only the reply is lost. */
interface AuditFailure {
  next: number;
  landed: boolean;
}

function signingObjectStore(signature: string): ObjectStore {
  const inner = createInMemoryObjectStore();
  return {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true, boundLengthSign: true },
    createSignedUrl: (key) =>
      Promise.resolve({
        url: `https://store.invalid/${key}?sig=${signature}`,
        headers: { 'x-signature': signature },
      }),
  };
}

/** Keyed by the event id, as the audit table's primary key keeps it: a key written again is not a second row. */
function recordingAudit(events: StorageAuditEvent[], failing: AuditFailure) {
  return (event: StorageAuditEvent) => {
    const lost = failing.next > 0;
    if (lost) failing.next -= 1;
    if ((!lost || failing.landed) && !events.some((seen) => seen.id === event.id)) {
      events.push(event);
    }
    return lost ? Promise.reject(new Error('audit down')) : Promise.resolve();
  };
}

async function buildHarness(fixture: Fixture) {
  const ws = await fixture.workspace();
  const signature = sentinel();
  const events: StorageAuditEvent[] = [];
  const failing: AuditFailure = { next: 0, landed: false };
  const objects = signingObjectStore(signature);
  const storage = createStorageService({
    catalog: fixture.catalog,
    objects,
    log: noLog,
    audit: recordingAudit(events, failing),
  });
  const actor = { principalId: ws.principalId, userId: null, label: 'Ito' };
  const ctx: StorageContext = {
    workspaceId: ws.id,
    principalId: ws.principalId,
    userId: null,
    actor,
  };
  const catalog = await fixture.catalog(ws.id);
  const save = async (path: string, text: string, area: 'files' | 'artifacts' = 'files') => {
    const saved = await storage.save(ctx, saveInput(path, text, 1024, area));
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    return saved.row;
  };
  return { fixture, ws, ctx, actor, catalog, objects, storage, events, failing, signature, save };
}

export type AuditHarness = Awaited<ReturnType<typeof buildHarness>>;

export const saveInput = (
  path: string,
  text: string,
  maxBytes: number,
  area: 'files' | 'artifacts' = 'files',
) => ({
  area,
  path,
  body: bytesToStream(bytesOf(text)),
  maxBytes,
  replace: true,
});

export const eventOf = (h: AuditHarness, rest: object) => ({
  id: expect.stringMatching(UUID) as unknown,
  workspaceId: h.ws.id,
  actorPrincipalId: h.actor.principalId,
  actorUserId: null,
  actorLabel: 'Ito',
  ...rest,
});

export const mintRequest = (path: string) => ({
  path,
  sizeBytes: 3,
  mayReplace: () => Promise.resolve(true),
});

export const link = { responseContentType: 'text/plain', responseDisposition: 'attachment' };

type AuditCase = (h: AuditHarness) => Promise<void>;

/** Runs the same audit cases once on the in-memory catalog and once on PostgreSQL. */
export function defineAuditSuites(
  database: () => IsolatedTestDatabase,
  register: (test: (title: string, run: AuditCase) => void) => void,
) {
  const catalogs: ReadonlyArray<readonly [string, () => Promise<Fixture>]> = [
    ['in-memory catalog', memoryFixture],
    ['PostgreSQL catalog', () => postgresFixture(database)],
  ];
  for (const [name, setup] of catalogs) {
    describe(`file actions are audited on the ${name}`, () => {
      register((title, run) => {
        it(title, async () => run(await buildHarness(await setup())));
      });
    });
  }
}
