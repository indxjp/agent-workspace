/**
 * The connectors store conformance suite — **one suite, every implementation of the port**.
 *
 * Written against {@link ConnectorsStoreProvider}, exported as
 * {@link describeConnectorsStoreConformance}, and run against the in-memory provider (always) and
 * the repository-backed one over a real PostgreSQL and a real database-backed secrets service
 * (when `TEST_DATABASE_URL` names one).
 *
 * Not covered here: an unknown workspace (PostgreSQL refuses it, the in-memory store has no
 * workspace registry), and the secret rows themselves, which only PostgreSQL has — the fixture's
 * optional `secretCount` lets the delete and refused-create cases check them where they exist. The
 * raw-row proof stays in `store.test.ts`.
 */
import crypto from 'node:crypto';

import {
  createDatabaseMcpServerRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ParsedCreateConnectorInput } from './contract';
import { createInMemoryConnectorsStoreProvider } from './memory-store';
import {
  createRepositoryConnectorsStoreProvider,
  type ConnectorsStoreProvider,
  type WorkspaceConnectorsProbeSource,
  type WorkspaceConnectorsStore,
} from './store';
import { admitToolConnector } from './tools';

const ABSENT = '55555555-5555-4555-8555-555555555555';
const KEY = 'sk-conformance-connector-key-1';
const OTHER_KEY = 'sk-conformance-connector-key-2';

const BASE: ParsedCreateConnectorInput = {
  name: 'GitHub',
  transport: 'http',
  command: null,
  args: null,
  url: 'https://api.example.test/mcp',
  authType: 'bearer',
  credential: KEY,
};

type Store = WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource;
type Owner = { readonly principalId: string; readonly userId: string | null };

/** One set-up for one test: a provider and two workspaces that really exist in it. */
export interface ConnectorsStoreFixture {
  readonly provider: ConnectorsStoreProvider;
  readonly workspaceA: string;
  readonly workspaceB: string;
  /** An owner that really exists in `workspaceId`. */
  readonly ownerIn: (workspaceId: string) => Promise<Owner>;
  /** How many secrets the workspace holds; absent where the store has no secret rows. */
  readonly secretCount?: (workspaceId: string) => Promise<number>;
}

export type MakeConnectorsStoreFixture = () => Promise<ConnectorsStoreFixture>;

const open = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });

async function toolWrite(body: Record<string, unknown>) {
  const admitted = await admitToolConnector(body, open);
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.result));
  return admitted.write;
}

const POSTGRES_TOOL = {
  kind: 'postgres',
  name: 'Shop tool',
  credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
  tables: ['public.orders'],
  readOnly: true,
};

export function describeConnectorsStoreConformance(
  label: string,
  makeFixture: MakeConnectorsStoreFixture,
): void {
  async function setup(): Promise<ConnectorsStoreFixture & { a: Store; owner: Owner }> {
    const fixture = await makeFixture();
    return {
      ...fixture,
      a: fixture.provider.forWorkspace(fixture.workspaceA),
      owner: await fixture.ownerIn(fixture.workspaceA),
    };
  }

  async function made(
    store: Store,
    owner: Owner,
    overrides: Partial<ParsedCreateConnectorInput> = {},
  ): Promise<string> {
    const outcome = await store.create({ ...BASE, ...overrides }, owner);
    if (outcome.kind !== 'created') {
      throw new Error(`expected the connector to be created, but the store said "${outcome.kind}"`);
    }
    return outcome.server.id;
  }

  describe(label, () => {
    it('creates a connector, stamped with workspace and owner, and reads it back', async () => {
      const { a, owner, workspaceA } = await setup();
      const id = await made(a, owner);
      expect(await a.get(id)).toMatchObject({
        id,
        workspaceId: workspaceA,
        name: BASE.name,
        transport: 'http',
        url: BASE.url,
        authType: 'bearer',
        hasCredential: true,
        enabled: true,
        ownerPrincipalId: owner.principalId,
        createdBy: owner.userId,
      });
      expect((await a.list()).map((row) => row.id)).toEqual([id]);
    });

    it('never returns the credential from create, get, list, update, rotate or delete', async () => {
      const { a, owner } = await setup();
      const created = await a.create(BASE, owner);
      if (created.kind !== 'created') throw new Error('expected created');
      const id = created.server.id;
      const seen = [
        created,
        await a.get(id),
        await a.list(),
        await a.update(id, { name: 'Renamed', credential: OTHER_KEY }),
        await a.rotateCredential(id, OTHER_KEY),
        await a.delete(id),
      ];
      const text = JSON.stringify(seen);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(OTHER_KEY);
    });

    it('hands the credential out only through resolveForProbe, and rotation replaces it', async () => {
      const { a, owner } = await setup();
      const id = await made(a, owner);
      expect(await a.resolveForProbe(id)).toMatchObject({
        transport: 'http',
        headers: { Authorization: `Bearer ${KEY}` },
        credentialConfigured: true,
      });
      expect(await a.rotateCredential(id, OTHER_KEY)).toMatchObject({ kind: 'rotated' });
      const probed = JSON.stringify(await a.resolveForProbe(id));
      expect(probed).toContain(OTHER_KEY);
      expect(probed).not.toContain(KEY);
    });

    it('rotates only a connector that has a credential', async () => {
      const { a, owner } = await setup();
      const bare = await made(a, owner, { name: 'Open', authType: 'none', credential: null });
      expect(await a.rotateCredential(bare, OTHER_KEY)).toEqual({
        kind: 'credential-not-configured',
      });
      expect(await a.rotateCredential(ABSENT, OTHER_KEY)).toEqual({ kind: 'not-found' });
    });

    it('refuses a duplicate name, across kinds, and allows the name in another workspace', async () => {
      const { a, owner, provider, workspaceB, ownerIn } = await setup();
      await made(a, owner);
      expect(await a.create(BASE, owner)).toEqual({ kind: 'name-conflict', name: BASE.name });
      const clash = await toolWrite({ ...POSTGRES_TOOL, name: BASE.name });
      expect(await a.createToolConnector(clash, owner)).toEqual({
        kind: 'name-conflict',
        name: BASE.name,
      });
      const tool = await a.createToolConnector(await toolWrite(POSTGRES_TOOL), owner);
      expect(tool.kind).toBe('created');
      expect(await a.create({ ...BASE, name: POSTGRES_TOOL.name }, owner)).toEqual({
        kind: 'name-conflict',
        name: POSTGRES_TOOL.name,
      });
      const b = provider.forWorkspace(workspaceB);
      expect((await b.create(BASE, await ownerIn(workspaceB))).kind).toBe('created');
    });

    it('leaves no orphan secret behind a refused duplicate', async () => {
      const { a, owner, secretCount, workspaceA } = await setup();
      await made(a, owner);
      const before = await secretCount?.(workspaceA);
      await a.create(BASE, owner);
      expect(await secretCount?.(workspaceA)).toBe(before);
    });

    it('updates only the given fields, and clears the credential when auth becomes none', async () => {
      const { a, owner } = await setup();
      const id = await made(a, owner);
      const outcome = await a.update(id, { enabled: false, url: 'https://other.example.test/mcp' });
      expect(outcome.kind).toBe('updated');
      expect(await a.get(id)).toMatchObject({
        name: BASE.name,
        enabled: false,
        url: 'https://other.example.test/mcp',
        hasCredential: true,
      });
      await a.update(id, { authType: 'none' });
      expect(await a.get(id)).toMatchObject({ authType: 'none', hasCredential: false });
    });

    it('refuses to rename onto a name another connector holds, but not onto its own', async () => {
      const { a, owner } = await setup();
      await made(a, owner, { name: 'One' });
      const two = await made(a, owner, { name: 'Two' });
      expect(await a.update(two, { name: 'One' })).toEqual({ kind: 'name-conflict', name: 'One' });
      expect((await a.update(two, { name: 'Two' })).kind).toBe('updated');
    });

    it('lists both kinds, only its own workspace, oldest first', async () => {
      const { a, owner, provider, workspaceB, ownerIn } = await setup();
      const first = await made(a, owner, { name: 'First' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const tool = await a.createToolConnector(await toolWrite(POSTGRES_TOOL), owner);
      if (tool.kind !== 'created') throw new Error('expected created');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const third = await made(a, owner, { name: 'Third' });
      const b = provider.forWorkspace(workspaceB);
      await made(b, await ownerIn(workspaceB), { name: 'Other' });
      expect((await a.list()).map((row) => row.id)).toEqual([first, tool.connector.id, third]);
    });

    it('stores a tool connector with a sealed credential, replaces it and renames it', async () => {
      const { a, owner } = await setup();
      const created = await a.createToolConnector(await toolWrite(POSTGRES_TOOL), owner);
      if (created.kind !== 'created') throw new Error('expected created');
      const id = created.connector.id;
      expect(created.connector).toMatchObject({ kind: 'postgres', hasCredential: true });
      expect(JSON.stringify(await a.list())).not.toContain('pw@');
      expect(await a.replaceToolConnector(id, { name: 'Renamed', enabled: false })).toMatchObject({
        kind: 'updated',
        connector: { name: 'Renamed', enabled: false },
      });
      const replaced = await a.replaceToolConnector(
        id,
        await toolWrite({ ...POSTGRES_TOOL, name: 'Renamed', tables: ['public.users'] }),
      );
      expect(replaced).toMatchObject({ kind: 'updated' });
      expect(JSON.stringify(await a.get(id))).toContain('public.users');
      expect(await a.replaceToolConnector(ABSENT, { name: 'x' })).toEqual({ kind: 'not-found' });
    });

    it('reports an absent id as absent on every operation', async () => {
      const { a } = await setup();
      expect(await a.get(ABSENT)).toBeNull();
      expect(await a.update(ABSENT, { enabled: false })).toEqual({ kind: 'not-found' });
      expect(await a.delete(ABSENT)).toEqual({ kind: 'not-found' });
      expect(await a.rotateCredential(ABSENT, OTHER_KEY)).toEqual({ kind: 'not-found' });
      expect(await a.resolveForProbe(ABSENT)).toBeNull();
      expect(await a.openapiDocument(ABSENT)).toBeNull();
    });

    it('deletes once with its credential, then reports not-found', async () => {
      const { a, owner, secretCount, workspaceA } = await setup();
      const before = await secretCount?.(workspaceA);
      const id = await made(a, owner);
      expect(await a.delete(id)).toEqual({ kind: 'deleted' });
      expect(await a.get(id)).toBeNull();
      expect(await a.resolveForProbe(id)).toBeNull();
      expect(await a.list()).toEqual([]);
      expect(await secretCount?.(workspaceA)).toBe(before);
      expect(await a.delete(id)).toEqual({ kind: 'not-found' });
    });

    it("never lets one workspace see, change, probe or delete another's connector", async () => {
      const { a, owner, provider, workspaceB } = await setup();
      const id = await made(a, owner);
      const b = provider.forWorkspace(workspaceB);
      expect(await b.list()).toEqual([]);
      expect(await b.get(id)).toBeNull();
      expect(await b.resolveForProbe(id)).toBeNull();
      expect(await b.update(id, { enabled: false })).toEqual({ kind: 'not-found' });
      expect(await b.rotateCredential(id, OTHER_KEY)).toEqual({ kind: 'not-found' });
      expect(await b.delete(id)).toEqual({ kind: 'not-found' });
      expect(await a.get(id)).toMatchObject({ name: BASE.name, enabled: true });
      expect(JSON.stringify(await a.resolveForProbe(id))).toContain(KEY);
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeConnectorsStoreConformance('the in-memory connectors store', () =>
  Promise.resolve({
    provider: createInMemoryConnectorsStoreProvider(),
    workspaceA: crypto.randomUUID(),
    workspaceB: crypto.randomUUID(),
    ownerIn: () => Promise.resolve({ principalId: crypto.randomUUID(), userId: null }),
  }),
);

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[connectors/conformance.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL ' +
      'half of this conformance suite did NOT run. A green result without it says nothing about ' +
      'whether the database-backed connectors store satisfies the same contract as the in-memory one.',
  );
}

describe.skipIf(!hasDatabase)('the PostgreSQL connectors store', () => {
  let isolated: IsolatedTestDatabase;
  let secretsService: SecretsService;
  let provider: ConnectorsStoreProvider;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w34_connectors_store');
    secretsService = await createSecretsService({
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });
    provider = createRepositoryConnectorsStoreProvider({
      mcpServers: createDatabaseMcpServerRepositoryProvider(isolated.db),
      secrets: secretsService,
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
    });
  }, 180_000);

  afterAll(async () => {
    await secretsService.close();
    await isolated.close();
  });

  /** `mcp_servers.created_by` and the owner are tenant-paired to a membership and its principal. */
  async function ownerIn(workspaceId: string): Promise<Owner> {
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
      await tx
        .insert(workspacePrincipals)
        .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
    });
    return { principalId, userId };
  }

  async function secretCount(workspaceId: string): Promise<number> {
    const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
      workspaceId,
    );
    if (scope === null) throw new Error('fixture workspace does not resolve');
    return (await secretsService.list(scope)).length;
  }

  describeConnectorsStoreConformance('over a real PostgreSQL, against the same suite', async () => {
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    await isolated.db.insert(workspaces).values([
      { id: workspaceA, slug: workspaceA, name: 'Workspace A' },
      { id: workspaceB, slug: workspaceB, name: 'Workspace B' },
    ]);
    return { provider, workspaceA, workspaceB, ownerIn, secretCount };
  });
});
