/**
 * `createRepositoryConnectorsStoreProvider` against a real PostgreSQL — the acceptance criterion
 * The Wave 2 plan states for this task: *"a connector's credential is stored as a secret
 * reference and the raw value is never held on the connector row … prove the second by reading the
 * row back out of a real PostgreSQL after a create that supplied a raw credential, and pasting the
 * row."* This file does exactly that — `it('THE ACCEPTANCE CRITERION …')` below prints the row.
 *
 * Gated on `TEST_DATABASE_URL`, like every other database suite in this repository.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIsolatedTestDatabase,
  createDatabaseMcpServerRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';

import { createRepositoryConnectorsStoreProvider } from './store';
import { admitToolConnector } from './tools';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[server/connectors/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the DB-backed ' +
      "connectors store — and this task's proof that a credential is stored as a secret " +
      'reference, never a raw value — was NOT exercised. A green result without it says nothing.',
  );
}

describe.skipIf(!hasDatabase)(
  'createRepositoryConnectorsStoreProvider against real PostgreSQL',
  () => {
    let isolated: IsolatedTestDatabase;
    let secretsService: SecretsService;
    let store: ReturnType<
      ReturnType<typeof createRepositoryConnectorsStoreProvider>['forWorkspace']
    >;
    const workspace = { id: crypto.randomUUID(), slug: 'w2cp05-store', name: 'Store' };
    /** `mcp_servers.created_by` is tenant-paired to `memberships` (issue #117). */
    const OWNER_ID = crypto.randomUUID();
    const MEMBERSHIP_ID = crypto.randomUUID();
    const PRINCIPAL_ID = crypto.randomUUID();
    const PLAINTEXT_MARKER = 'sk-ant-ACCEPTANCE-CRITERION-2-DO-NOT-LEAK-9f3c7a1d';

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_w2cp05_store');
      await isolated.db.insert(workspaces).values([workspace]);
      await isolated.db
        .insert(users)
        .values([{ id: OWNER_ID, email: `${OWNER_ID}@example.test`, name: 'Store Owner' }]);
      await isolated.db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values([
            { id: MEMBERSHIP_ID, workspaceId: workspace.id, userId: OWNER_ID, role: 'owner' },
          ]);
        await tx.insert(workspacePrincipals).values({
          id: PRINCIPAL_ID,
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId: MEMBERSHIP_ID,
        });
      });

      secretsService = await createSecretsService({
        DATABASE_URL: isolated.url,
        MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      });

      const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
      const provider = createRepositoryConnectorsStoreProvider({
        mcpServers: createDatabaseMcpServerRepositoryProvider(isolated.db),
        secrets: secretsService,
        scopes,
      });
      store = provider.forWorkspace(workspace.id);
    }, 180_000);

    afterAll(async () => {
      await secretsService.close();
      await isolated.close();
    });

    it('THE ACCEPTANCE CRITERION: the raw credential is never held on the connector row', async () => {
      const outcome = await store.create(
        {
          name: 'GitHub',
          transport: 'http',
          command: null,
          args: null,
          url: 'https://api.example.test/mcp',
          authType: 'bearer',
          credential: PLAINTEXT_MARKER,
        },
        { principalId: PRINCIPAL_ID, userId: OWNER_ID },
      );
      expect(outcome.kind, JSON.stringify(outcome)).toBe('created');
      if (outcome.kind !== 'created') return;

      // Read the row back out of a REAL PostgreSQL — through Drizzle's relational query API (no
      // `drizzle-orm` import needed: the `eq` operator is injected into the `where` callback, and
      // apps/web does not declare `drizzle-orm` as its own dependency), not through the repository
      // that wrote it, and not a grep of this task's own source. `mcp_servers` first, then the
      // `secrets` row it references.
      const connectorRow = await isolated.db.query.mcpServers.findFirst({
        where: (row, { eq }) => eq(row.id, outcome.server.id),
      });
      expect(connectorRow).toBeDefined();

      const secretRow = await isolated.db.query.secrets.findFirst({
        where: (row, { eq }) => eq(row.id, outcome.server.credentialSecretId ?? ''),
      });
      expect(secretRow).toBeDefined();

      // Pasted verbatim into this task's PR report. `connectorRow` has NO column holding the value —
      // `credentialSecretId` is the only trace of it, an id pointing at the row printed second. The
      // secret row's `ciphertext` is a `Buffer`; printed as its byte length only, because the point
      // of this assertion is that nothing about the CONNECTOR row is the secret, not to paste raw
      // ciphertext bytes into a log for no reason.
      console.log('[acceptance] mcp_servers row:', JSON.stringify(connectorRow));
      console.log(
        '[acceptance] secrets row (ciphertext printed as byte length, not its bytes):',
        JSON.stringify({
          ...secretRow,
          ciphertext: `<${String(secretRow?.ciphertext.length)} bytes>`,
        }),
      );

      expect(JSON.stringify(connectorRow)).not.toContain(PLAINTEXT_MARKER);
      expect(connectorRow).toMatchObject({
        kind: 'mcp',
        toolConfig: null,
        openapiDocument: null,
        command: null,
        url: 'https://api.example.test/mcp',
        authType: 'bearer',
        credentialSecretId: outcome.server.credentialSecretId,
      });
      // Positive assertion, not merely "no forbidden substring": every key on the row is one of the
      // ones the schema declares, so a column added later that DID carry a plaintext would fail this
      // by name rather than by accidentally not containing today's marker string.
      expect(Object.keys(connectorRow as object).sort()).toEqual(
        [
          'id',
          'workspaceId',
          'name',
          'kind',
          'transport',
          'command',
          'args',
          'url',
          'toolConfig',
          'openapiDocument',
          'authType',
          'credentialSecretId',
          'identitySecretName',
          'enabled',
          'createdBy',
          'ownerPrincipalId',
          'createdAt',
          'updatedAt',
        ].sort(),
      );

      // And the secrets row itself never surfaces the plaintext either (this is W2-CP-02's own
      // acceptance criterion; re-asserted here because it is the row THIS task's create path wrote).
      // `ciphertext` is real encrypted bytes, so this is not a trivial "there is no string column"
      // check — an accidentally-unencrypted write would fail it.
      expect(secretRow?.ciphertext.toString('utf8')).not.toContain(PLAINTEXT_MARKER);
      expect(secretRow?.ciphertext.includes(Buffer.from(PLAINTEXT_MARKER, 'utf8'))).toBe(false);
    });

    it('resolveForProbe decrypts the real secret and the probe uses it correctly', async () => {
      const { spawn } = await import('node:child_process');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

      const child = spawn(process.execPath, [path.join(fixturesDir, 'http-server.mjs')], {
        env: { ...process.env, REQUIRE_TOKEN: PLAINTEXT_MARKER, PORT: '0' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      try {
        const port = await new Promise<number>((resolve, reject) => {
          let buffer = '';
          child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const match = /PORT=(\d+)/.exec(buffer);
            if (match?.[1] !== undefined) resolve(Number(match[1]));
          });
          child.once('error', reject);
        });

        const outcome = await store.create(
          {
            name: 'RealProbeTarget',
            transport: 'http',
            command: null,
            args: null,
            url: `http://127.0.0.1:${String(port)}/mcp`,
            authType: 'bearer',
            credential: PLAINTEXT_MARKER,
          },
          { principalId: PRINCIPAL_ID, userId: OWNER_ID },
        );
        if (outcome.kind !== 'created') throw new Error(`fixture setup failed: ${outcome.kind}`);

        const config = await store.resolveForProbe(outcome.server.id);
        expect(config).not.toBeNull();
        const { testConnection } = await import('./test-connection.js');
        const { restrictedBaseEnv } = await import('./base-env.js');
        const result = await testConnection(config!, { baseEnv: restrictedBaseEnv() });
        expect(result.ok, JSON.stringify(result)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('compensates a failed connector insert and deletes credentials with the connector', async () => {
      const input = {
        name: 'Compensated Connector',
        transport: 'http' as const,
        command: null,
        args: null,
        url: 'https://api.example.test/mcp',
        authType: 'bearer' as const,
        credential: 'temporary-credential-marker',
      };
      const first = await store.create(input, { principalId: PRINCIPAL_ID, userId: OWNER_ID });
      if (first.kind !== 'created') throw new Error(`fixture setup failed: ${first.kind}`);
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspace.id,
      );
      if (scope === null) throw new Error('fixture workspace does not resolve');
      const beforeConflict = await secretsService.list(scope);
      await expect(
        store.create(input, { principalId: PRINCIPAL_ID, userId: OWNER_ID }),
      ).resolves.toMatchObject({ kind: 'name-conflict' });
      expect(await secretsService.list(scope)).toHaveLength(beforeConflict.length);

      await expect(
        store.rotateCredential(first.server.id, 'rotated-credential-marker'),
      ).resolves.toMatchObject({ kind: 'rotated', connector: { id: first.server.id } });
      await expect(store.delete(first.server.id)).resolves.toEqual({ kind: 'deleted' });
      expect(
        (await secretsService.list(scope)).some(
          (row) => row.id === first.server.credentialSecretId,
        ),
      ).toBe(false);
    });

    it('stores tool connectors beside MCP ones, seals and retires their credentials, and deletes them', async () => {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspace.id,
      );
      if (scope === null) throw new Error('fixture workspace does not resolve');
      const open = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });
      const document = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Pets', version: '1' },
        servers: [{ url: 'https://93.184.216.34/v1' }],
        paths: {
          '/pets': { get: { operationId: 'listPets', responses: {} } },
          '/pets/{id}': { get: { operationId: 'showPet', responses: {} } },
        },
      });
      const admit = async (body: Record<string, unknown>) => {
        const admitted = await admitToolConnector(body, open);
        if (!admitted.ok) throw new Error(JSON.stringify(admitted.result));
        return admitted.write;
      };
      const owner = { principalId: PRINCIPAL_ID, userId: OWNER_ID };
      const openapiBody = {
        kind: 'openapi',
        name: 'Pets tool',
        document,
        allow: ['GET /pets'],
        auth: 'bearer',
        credential: PLAINTEXT_MARKER,
      };

      const created = await store.createToolConnector(await admit(openapiBody), owner);
      if (created.kind !== 'created') throw new Error(`fixture setup failed: ${created.kind}`);
      expect(created.connector).toMatchObject({
        kind: 'openapi',
        transport: null,
        hasCredential: true,
      });
      expect(JSON.stringify(created.connector)).not.toContain(PLAINTEXT_MARKER);
      const postgres = await store.createToolConnector(
        await admit({
          kind: 'postgres',
          name: 'Shop tool',
          credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
          tables: ['public.orders'],
          readOnly: true,
        }),
        owner,
      );
      expect(postgres).toMatchObject({ kind: 'created', connector: { kind: 'postgres' } });
      await expect(
        store.createToolConnector(await admit({ ...openapiBody, name: 'GitHub' }), owner),
      ).resolves.toEqual({ kind: 'name-conflict', name: 'GitHub' });

      const listed = await store.list();
      expect(listed.map((connector) => connector.name)).toEqual(
        expect.arrayContaining(['Pets tool', 'Shop tool']),
      );
      const firstSecrets = (await secretsService.list(scope)).map((row) => row.id);

      const replaced = await store.replaceToolConnector(
        created.connector.id,
        await admit({ ...openapiBody, allow: ['GET /pets', 'GET /pets/*'], credential: 'next' }),
      );
      expect(replaced).toMatchObject({ kind: 'updated' });
      if (replaced.kind === 'updated')
        expect(replaced.connector.openapi?.operations).toHaveLength(2);
      const afterReplace = (await secretsService.list(scope)).map((row) => row.id);
      expect(afterReplace).toHaveLength(firstSecrets.length);
      expect(afterReplace).not.toEqual(firstSecrets);

      const before = await secretsService.list(scope);
      await expect(store.delete(created.connector.id)).resolves.toEqual({ kind: 'deleted' });
      expect(await secretsService.list(scope)).toHaveLength(before.length - 1);
      await expect(store.get(created.connector.id)).resolves.toBeNull();
    });

    it('resolves the identity signing key by secret name, and reports an unresolvable one as null', async () => {
      const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(
        workspace.id,
      );
      if (scope === null) throw new Error('fixture workspace does not resolve');
      const owner = { principalId: PRINCIPAL_ID, userId: OWNER_ID };
      const sealed = await secretsService.create(scope, {
        name: 'IDENTITY_SIGNING_KEY',
        value: Buffer.from('identity-key-value', 'utf8'),
      });
      expect(sealed.kind).toBe('created');
      const input = {
        transport: 'http' as const,
        command: null,
        args: null,
        url: 'https://identity.example.test/mcp',
        authType: 'none' as const,
        credential: null,
      };
      const optedIn = await store.create(
        { ...input, name: 'identity-in', identity: { secret: 'IDENTITY_SIGNING_KEY' } },
        owner,
      );
      const dangling = await store.create(
        { ...input, name: 'identity-dangling', identity: { secret: 'NOT_A_SECRET' } },
        owner,
      );
      const plain = await store.create({ ...input, name: 'identity-plain' }, owner);
      if (optedIn.kind !== 'created' || dangling.kind !== 'created' || plain.kind !== 'created') {
        throw new Error('fixture connectors were not created');
      }
      await expect(store.resolveIdentityKey(optedIn.server.id)).resolves.toBe('identity-key-value');
      await expect(store.resolveIdentityKey(dangling.server.id)).resolves.toBeNull();
      await expect(store.resolveIdentityKey(plain.server.id)).resolves.toBeUndefined();

      // @story US-STO-12: a row stored before the contracts refused the name never reads it.
      const reserved = await secretsService.create(scope, {
        name: 'STORAGE_CONNECTION_77777777777747778777777777777777',
        value: Buffer.from('storage-credential-envelope', 'utf8'),
      });
      expect(reserved.kind).toBe('created');
      const storageNamed = await store.create(
        {
          ...input,
          name: 'identity-storage',
          identity: { secret: 'STORAGE_CONNECTION_77777777777747778777777777777777' },
        },
        owner,
      );
      if (storageNamed.kind !== 'created') throw new Error('fixture connector was not created');
      await expect(store.resolveIdentityKey(storageNamed.server.id)).resolves.toBeNull();

      // A webhook's signing secret is platform-owned too: a connector identity never reads it.
      const signing = await secretsService.create(scope, {
        name: 'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET',
        value: Buffer.from('whsec_c2lnbmluZw==', 'utf8'),
      });
      expect(signing.kind).toBe('created');
      const webhookNamed = await store.create(
        {
          ...input,
          name: 'identity-webhook',
          identity: { secret: 'WEBHOOK_77777777777747778777777777777777_SIGNING_SECRET' },
        },
        owner,
      );
      if (webhookNamed.kind !== 'created') throw new Error('fixture connector was not created');
      await expect(store.resolveIdentityKey(webhookNamed.server.id)).resolves.toBeNull();
      await expect(store.get(optedIn.server.id)).resolves.toMatchObject({
        identity: { secret: 'IDENTITY_SIGNING_KEY' },
      });

      const cleared = await store.update(optedIn.server.id, { identity: null });
      expect(cleared.kind).toBe('updated');
      await expect(store.resolveIdentityKey(optedIn.server.id)).resolves.toBeUndefined();
    });
  },
);
