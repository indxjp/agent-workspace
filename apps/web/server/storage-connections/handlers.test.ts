/**
 * The storage-connection routes, driven as Next.js imports them with real `Request` objects over
 * the in-memory repository and secret store (the storage design, §05 and §06 Phase 5).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { normalizeCdnUrl } from 'next/dist/server/server-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StorageConnectionBrowseResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/storage-connections';
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

import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { PUT as rotate } from '../../app/api/storage-connections/[id]/credential/route';
import {
  DELETE as remove,
  GET as getOne,
  PATCH as patch,
} from '../../app/api/storage-connections/[id]/route';
import { POST as testRoute } from '../../app/api/storage-connections/[id]/test/route';
import { GET as list, POST as create } from '../../app/api/storage-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { PROBE_TIMEOUT_MS } from '../models/probe';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { log } from '../telemetry/logger';
import {
  createRepositoryStorageConnectionsStoreProvider,
  storageConnectionSecretName,
} from './store';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const ROLE_HEADER = 'x-test-role';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Built at runtime: a key-shaped literal in a test file trips the secret scanner.
const accessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
const secretAccessKey = randomBytes(24).toString('base64');

const body = {
  name: 'acme-data',
  url: 's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
  allowedPrefixes: ['reports'],
  credential: { provider: 's3', accessKeyId, secretAccessKey },
};

const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-storage-connections-')));
mkdirSync(path.join(fileRoot, 'shared'));
const outsideRoot = realpathSync(tmpdir());

let audits: Array<Record<string, unknown>> = [];
/** `workspaceId/connectionId` of every connection an agent version grants, as the runtime asks. */
const granted = new Set<string>();
const secrets = createInMemorySecretsService();
const scopes = createInMemoryWorkspaceScopeResolver([
  { id: WORKSPACE_A, slug: 'a' },
  { id: WORKSPACE_B, slug: 'b' },
]);

function installRuntime(
  repositories: StorageConnectionRepositoryProvider,
  resolver: WorkspaceScopeResolver,
  secretsService: SecretsService = secrets,
): void {
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER) ?? WORKSPACE_A;
        const role = (request.headers.get(ROLE_HEADER) ?? 'owner') as Role;
        return Promise.resolve(
          Principal.fromApiKey({
            principalId: ACTOR,
            apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workspaceId,
            role,
            label: 'Storage route test',
          }),
        );
      },
    },
    storageConnections: {
      kind: 'serving',
      runtime: {
        store: createRepositoryStorageConnectionsStoreProvider({
          repositories,
          scopes: resolver,
          secrets: secretsService,
        }),
        fileRoots: [fileRoot],
        egress: { production: true, allowHosts: [] },
        isConnectionGranted: (workspaceId, connectionId) =>
          Promise.resolve(granted.has(`${workspaceId}/${connectionId}`)),
        audit: (event) => {
          audits.push({ ...event });
          return Promise.resolve();
        },
      },
    },
  });
}

beforeEach(() => {
  audits = [];
  granted.clear();
  installRuntime(createInMemoryStorageConnectionRepositoryProvider(), scopes);
});

afterEach(() => {
  clearApplicationContext();
});

afterAll(() => {
  rmSync(fileRoot, { recursive: true, force: true });
});

function post(payload: unknown, role: Role = 'admin', workspace = WORKSPACE_A): Promise<Response> {
  return create(
    new Request('http://localhost/api/storage-connections', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ROLE_HEADER]: role,
        [WORKSPACE_HEADER]: workspace,
      },
      body: JSON.stringify(payload),
    }),
  );
}

function read(path: string, role: Role = 'admin', workspace = WORKSPACE_A): Request {
  return new Request(`http://localhost/api/storage-connections${path}`, {
    headers: { [ROLE_HEADER]: role, [WORKSPACE_HEADER]: workspace },
  });
}

describe('storage connections API', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] an admin connects a bucket', async () => {
    const response = await post(body);
    expect(response.status).toBe(201);
    const resource = StorageConnectionResourceSchema.parse(await response.json());
    expect(resource).toMatchObject({
      name: 'acme-data',
      provider: 's3',
      allowedPrefixes: ['reports'],
      writeAllowed: false,
      hasCredential: true,
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a member cannot connect a bucket, and a viewer cannot even look', async () => {
    expect((await post(body, 'builder')).status).toBe(403);
    expect((await post(body, 'viewer')).status).toBe(403);
    expect((await list(read('', 'viewer'))).status).toBe(403);
    expect((await list(read('', 'builder'))).status).toBe(200);
    expect(await (await list(read(''))).json()).toEqual({ connections: [] });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] credentials are never returned', async () => {
    const created = await post(body);
    const { id } = StorageConnectionResourceSchema.parse(await created.json());
    const texts = [
      await (await post({ ...body, name: 'again', credential: undefined })).text(),
      await (await list(read(''))).text(),
      await (await getOne(read(`/${id}`), { params: Promise.resolve({ id }) })).text(),
      await (await post(body)).text(),
      JSON.stringify(audits),
    ].join('\n');
    expect(texts).not.toContain(accessKeyId);
    expect(texts).not.toContain(secretAccessKey);

    expect(await storedCredential(id)).toEqual(body.credential);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] every change is audited', async () => {
    const created = await post(body);
    const { id } = StorageConnectionResourceSchema.parse(await created.json());
    await post(body);
    await post({ ...body, name: 'bad', url: `file://${outsideRoot}` });
    expect(audits).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_A,
        action: 'storage-connection-created',
        actorPrincipalId: ACTOR,
        subjectId: id,
        subjectLabel: 'acme-data',
      }),
    ]);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] another workspace cannot see a connection', async () => {
    const created = await post(body);
    const { id } = StorageConnectionResourceSchema.parse(await created.json());
    const other = await getOne(read(`/${id}`, 'owner', WORKSPACE_B), {
      params: Promise.resolve({ id }),
    });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({
      error: { code: 'storage_connection_not_found' },
    });
    expect(await (await list(read('', 'owner', WORKSPACE_B))).json()).toEqual({ connections: [] });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] an id that is not a UUID is not found', async () => {
    const response = await getOne(read('/not-a-uuid', 'owner'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'storage_connection_not_found' },
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] every route answers 503 when storage connections are not configured', async () => {
    installTestDomains({ storageConnections: { kind: 'unavailable' } });
    const id = randomUUID();
    const responses = [
      await list(read('', 'owner')),
      await post(body, 'owner'),
      await getOne(read(`/${id}`, 'owner'), { params: Promise.resolve({ id }) }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'storage_connections_not_configured' },
      });
    }
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a name is taken once, a folder URL must sit under an operator root, and a URL never carries a secret', async () => {
    expect((await post(body)).status).toBe(201);
    expect(await (await post(body)).json()).toMatchObject({
      error: { code: 'storage_connection_name_taken' },
    });
    const outside = await post({
      ...body,
      name: 'local',
      url: `file://${outsideRoot}`,
      credential: undefined,
    });
    expect(outside.status).toBe(422);
    expect(await outside.json()).toMatchObject({
      error: { code: 'storage_connection_endpoint_forbidden' },
    });
    const inside = await post({
      ...body,
      name: 'local',
      url: `file://${fileRoot}/shared`,
      credential: undefined,
    });
    expect(inside.status).toBe(201);
    expect(await inside.json()).toMatchObject({ provider: 'file', hasCredential: false });
    const leaky = await post({ ...body, name: 'leaky', url: 's3://acme-data@host/x' });
    expect(leaky.status).toBe(422);
    expect(await leaky.json()).toMatchObject({
      error: { code: 'storage_connection_url_has_secret' },
    });
  });

  // @story US-STO-12
  it.each([
    ['throws', () => Promise.reject(new Error('secret store unavailable'))],
    ['is refused', () => Promise.resolve({ kind: 'not-found' } as const)],
  ] as const)(
    '[US-STO-12][api][sdk] a delete still answers 204 when the secret delete %s',
    async (_outcome, failingDelete) => {
      installRuntime(createInMemoryStorageConnectionRepositoryProvider(), scopes, {
        ...secrets,
        delete: failingDelete,
      });
      const created = await post(body);
      const { id } = StorageConnectionResourceSchema.parse(await created.json());
      const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      expect((await change('DELETE', id)).status).toBe(204);
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
      expect(audits.slice(1)).toEqual([
        expect.objectContaining({ action: 'storage-connection-deleted', subjectId: id }),
      ]);
    },
  );

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a GCS token is refused by patch and rotate on a URL with no project', async () => {
    // A key connection takes its project from the key, so its URL names none.
    const key = {
      provider: 'gcs',
      serviceAccountJson: JSON.stringify({
        type: 'service_account',
        project_id: 'acme-prod',
        client_email: 'svc@acme-prod.iam.gserviceaccount.com',
        private_key: randomBytes(24).toString('base64'),
      }),
    };
    const created = await post({
      name: 'acme-gcs',
      url: 'gcs://acme-gcs/exports',
      allowedPrefixes: ['reports'],
      credential: key,
    });
    expect(created.status).toBe(201);
    const { id } = StorageConnectionResourceSchema.parse(await created.json());
    const token = { provider: 'gcs', accessToken: `ya29.${randomUUID()}` };

    const refused = [
      await change('PUT', id, token),
      await change('PATCH', id, { credential: token }),
      await change('PATCH', id, { url: 'gcs://acme-gcs/archive', credential: token }),
    ];
    for (const response of refused) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'storage_connection_url_invalid' },
      });
    }
    expect(await storedCredential(id)).toEqual(key);

    const moved = await change('PATCH', id, {
      url: 'gcs://acme-gcs/exports?project=acme-prod',
      credential: token,
    });
    expect(moved.status).toBe(200);
    expect(await storedCredential(id)).toEqual(token);
    expect((await change('PUT', id, token)).status).toBe(200);
  });

  it('[US-STO-12][api][sdk] a test whose secret store never answers is unreachable after the timeout', async () => {
    installRuntime(createInMemoryStorageConnectionRepositoryProvider(), scopes, {
      ...secrets,
      resolveByName: () => new Promise(() => undefined),
    });
    const { id } = StorageConnectionResourceSchema.parse(await (await post(body)).json());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = reach('test', id);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
      expect(StorageConnectionTestOutcomeSchema.parse(await (await pending).json())).toEqual({
        ok: false,
        code: 'unreachable',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Built at runtime, like the first credential.
const rotatedAccessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
const rotatedSecretAccessKey = randomBytes(24).toString('base64');
// A temporary (STS) credential: its session token is as secret as the key.
const rotatedSessionToken = randomBytes(32).toString('base64');
const rotated = {
  provider: 's3',
  accessKeyId: rotatedAccessKeyId,
  secretAccessKey: rotatedSecretAccessKey,
  sessionToken: rotatedSessionToken,
};
const credentialValues = [
  accessKeyId,
  secretAccessKey,
  rotatedAccessKeyId,
  rotatedSecretAccessKey,
  rotatedSessionToken,
];

function change(
  method: 'PATCH' | 'PUT' | 'DELETE',
  id: string,
  payload?: unknown,
  role: Role = 'admin',
  workspace = WORKSPACE_A,
): Promise<Response> {
  const handler = { PATCH: patch, PUT: rotate, DELETE: remove }[method];
  const suffix = method === 'PUT' ? '/credential' : '';
  return handler(
    new Request(`http://localhost/api/storage-connections/${id}${suffix}`, {
      method,
      headers: {
        'content-type': 'application/json',
        [ROLE_HEADER]: role,
        [WORKSPACE_HEADER]: workspace,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function connect(name: string): Promise<string> {
  const response = await post({ ...body, name });
  expect(response.status).toBe(201);
  return StorageConnectionResourceSchema.parse(await response.json()).id;
}

function readOne(id: string): Promise<Response> {
  return getOne(read(`/${id}`), { params: Promise.resolve({ id }) });
}

async function storedCredential(id: string): Promise<unknown> {
  const scope = await scopes.forWorkspaceId(WORKSPACE_A);
  if (scope === null) throw new Error('workspace A did not resolve');
  const stored = await secrets.resolveByName(scope, storageConnectionSecretName(id));
  if (stored === null) return null;
  // The secret is the credential bound to the target it was supplied for.
  const { target, credential } = JSON.parse(stored.value.toString('utf8')) as {
    target: unknown;
    credential: unknown;
  };
  expect(target).toEqual(expect.any(String));
  return credential;
}

function reach(
  route: 'browse' | 'test',
  id: string,
  query = '',
  role: Role = 'admin',
  workspace = WORKSPACE_A,
): Promise<Response> {
  const headers = { [ROLE_HEADER]: role, [WORKSPACE_HEADER]: workspace };
  const url = `http://localhost/api/storage-connections/${id}/${route}${query}`;
  const context = { params: Promise.resolve({ id }) };
  return route === 'browse'
    ? browseRoute(new Request(url, { headers }), context)
    : testRoute(new Request(url, { method: 'POST', headers }), context);
}

/** Plain files at `<dir>/<key>`, as a user's own folder holds them. */
function seedFolder(dir: string, keys: readonly string[]): void {
  for (const key of keys) {
    mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    writeFileSync(path.join(dir, key), key);
  }
}

/**
 * `query` as `next start` hands it to a route handler. Before the handler runs, Next rebuilds
 * `req.url`'s query from its parsed values (`normalizeCdnUrl`, called by the route module for
 * every request), so the handler never sees the bytes the client sent: `%20` arrives as `+`.
 */
function servedByNext(query: string): string {
  const message = new IncomingMessage(new Socket());
  message.url = `/browse${query}`;
  normalizeCdnUrl(message, []);
  return (message.url ?? '').slice('/browse'.length);
}

/** `browse` reached both as the bare handler is called and as `next start` serves it. */
async function browseBothWays(id: string, query: string): Promise<Response[]> {
  return [await reach('browse', id, query), await reach('browse', id, servedByNext(query))];
}

/** A `file` connection over a folder holding `reports/`, `reports-old/` and `secret/`. */
async function connectFolder(name: string): Promise<string> {
  const dir = path.join(fileRoot, name);
  mkdirSync(dir);
  seedFolder(dir, ['reports/a.txt', 'reports/2026/b.txt', 'reports-old/c.txt', 'secret/d.txt']);
  const response = await post({ name, url: `file://${dir}`, allowedPrefixes: ['reports'] });
  expect(response.status).toBe(201);
  return StorageConnectionResourceSchema.parse(await response.json()).id;
}

async function browsedPaths(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
  return page.entries.map((entry) => entry.path);
}

const testedAudits = () =>
  audits.filter((event) => event['action'] === 'storage-connection-tested');

describe.each(['memory', 'postgres'] as const)(
  'storage connection lifecycle over the %s repository',
  (kind) => {
    let isolated: IsolatedTestDatabase | undefined;

    // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
    beforeAll(async () => {
      if (kind !== 'postgres') return;
      isolated = await createIsolatedTestDatabase('aw_storage_lifecycle');
      await isolated.db.insert(workspaces).values([
        { id: WORKSPACE_A, slug: 'lifecycle-a', name: 'A' },
        { id: WORKSPACE_B, slug: 'lifecycle-b', name: 'B' },
      ]);
    }, 180_000);

    afterAll(async () => {
      await isolated?.close();
    });

    beforeEach(() => {
      if (isolated === undefined) return;
      installRuntime(
        createDatabaseStorageConnectionRepositoryProvider(isolated.db),
        createDatabaseWorkspaceScopeResolver(isolated.db),
      );
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] an admin renames a connection and narrows its folders', async () => {
      const id = await connect(`rename-${kind}`);
      const response = await change('PATCH', id, {
        name: `renamed-${kind}`,
        url: 's3://acme-other/exports',
        allowedPrefixes: ['reports/2026'],
        writeAllowed: true,
        credential: rotated,
      });
      expect(response.status).toBe(200);
      expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
        id,
        name: `renamed-${kind}`,
        url: 's3://acme-other/exports',
        allowedPrefixes: ['reports/2026'],
        writeAllowed: true,
        hasCredential: true,
      });
      expect(await storedCredential(id)).toEqual(rotated);
      expect(audits.slice(1)).toEqual([
        expect.objectContaining({
          action: 'storage-connection-updated',
          subjectId: id,
          subjectLabel: `renamed-${kind}`,
        }),
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] the stored credential never follows a connection to another endpoint, account or bucket', async () => {
      const id = await connect(`pinned-${kind}`);
      const before: unknown = await (await readOne(id)).json();
      const moves = [
        's3://acme-data/exports?endpoint=https://attacker.example',
        's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com&publicEndpoint=https://attacker.example',
        's3://acme-data/exports',
        's3://acme-other/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
      ];
      for (const url of moves) {
        const response = await change('PATCH', id, { url, allowedPrefixes: ['other'] });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: 'storage_connection_credential_required' },
        });
      }
      const mismatch = await change('PATCH', id, {
        url: moves[0],
        credential: { provider: 'gcs', serviceAccountJson: '{}' },
      });
      expect(mismatch.status).toBe(422);
      expect(await (await readOne(id)).json()).toEqual(before);
      expect(await storedCredential(id)).toEqual(body.credential);
      expect(audits).toHaveLength(1);

      const moved = await change('PATCH', id, { url: moves[0], credential: rotated });
      expect(moved.status).toBe(200);
      const text = await moved.text();
      expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
        url: moves[0],
        hasCredential: true,
      });
      expect(await storedCredential(id)).toEqual(rotated);
      for (const value of credentialValues) expect(text).not.toContain(value);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a prefix, name or write change keeps the stored credential', async () => {
      const id = await connect(`kept-${kind}`);
      const response = await change('PATCH', id, {
        name: `kept-renamed-${kind}`,
        url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
        allowedPrefixes: ['archive/2026'],
        writeAllowed: true,
      });
      expect(response.status).toBe(200);
      expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
        url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
        hasCredential: true,
      });
      expect(await storedCredential(id)).toEqual(body.credential);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a patch is refused for a taken name, another provider or a URL with a secret', async () => {
      const id = await connect(`patched-${kind}`);
      await connect(`taken-${kind}`);
      const refused = [
        [{ name: `taken-${kind}` }, 409, 'storage_connection_name_taken'],
        [{ url: 'gcs://acme-bucket/exports' }, 422, 'storage_connection_url_invalid'],
        [{ url: `file://${fileRoot}/shared` }, 422, 'storage_connection_url_invalid'],
        [{ url: 's3://acme-data@host/x' }, 422, 'storage_connection_url_has_secret'],
        [{}, 400, 'invalid_storage_connection'],
      ] as const;
      for (const [patchBody, status, code] of refused) {
        const response = await change('PATCH', id, patchBody);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
      expect(audits).toHaveLength(2);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a member cannot change, rotate or delete a connection', async () => {
      const id = await connect(`guarded-${kind}`);
      expect((await change('PATCH', id, { writeAllowed: true }, 'builder')).status).toBe(403);
      expect((await change('PUT', id, rotated, 'builder')).status).toBe(403);
      expect((await change('DELETE', id, undefined, 'builder')).status).toBe(403);
      expect((await change('DELETE', id, undefined, 'viewer')).status).toBe(403);
      expect(await storedCredential(id)).toEqual(body.credential);
      expect(audits).toHaveLength(1);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] rotating the credential replaces the secret and never returns it', async () => {
      const id = await connect(`rotated-${kind}`);
      const response = await change('PUT', id, rotated);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
        id,
        hasCredential: true,
      });
      expect(await storedCredential(id)).toEqual(rotated);
      const mismatch = await change('PUT', id, { provider: 'gcs', serviceAccountJson: '{}' });
      expect(mismatch.status).toBe(422);
      expect(await storedCredential(id)).toEqual(rotated);
      const seen = [text, JSON.stringify(audits)].join('\n');
      for (const value of credentialValues) expect(seen).not.toContain(value);
      expect(audits.slice(1)).toEqual([
        expect.objectContaining({ action: 'storage-connection-credential-changed', subjectId: id }),
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] rotating a connection created without a credential creates its secret', async () => {
      const created = await post({ ...body, name: `bare-${kind}`, credential: undefined });
      const { id } = StorageConnectionResourceSchema.parse(await created.json());
      expect(await storedCredential(id)).toBeNull();
      const response = await change('PUT', id, rotated);
      expect(response.status).toBe(200);
      expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
        id,
        hasCredential: true,
      });
      expect(await storedCredential(id)).toEqual(rotated);
      expect(audits.slice(1)).toEqual([
        expect.objectContaining({ action: 'storage-connection-credential-changed', subjectId: id }),
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] deleting a connection removes its row and then its secret', async () => {
      const id = await connect(`doomed-${kind}`);
      expect((await change('DELETE', id)).status).toBe(204);
      expect((await readOne(id)).status).toBe(404);
      expect(await storedCredential(id)).toBeNull();
      expect((await change('DELETE', id)).status).toBe(404);
      expect(audits.slice(1)).toEqual([
        expect.objectContaining({
          action: 'storage-connection-deleted',
          subjectId: id,
          subjectLabel: `doomed-${kind}`,
        }),
      ]);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a connection an agent version grants is not deleted', async () => {
      const id = await connect(`granted-${kind}`);
      granted.add(`${WORKSPACE_A}/${id}`);
      const refused = await change('DELETE', id);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'storage_connection_in_use' } });
      expect((await readOne(id)).status).toBe(200);
      expect(await storedCredential(id)).toEqual(body.credential);
      expect(audits).toHaveLength(1);
      // Another workspace's grant of the same id does not hold this one.
      granted.clear();
      granted.add(`${WORKSPACE_B}/${id}`);
      expect((await change('DELETE', id)).status).toBe(204);
    });

    // @story US-STO-12
    it.each([
      ['PATCH', { writeAllowed: true }],
      ['PUT', rotated],
      ['DELETE', undefined],
    ] as const)(
      '[US-STO-12][api][sdk] another workspace gets 404 on %s and changes nothing',
      async (method, payload) => {
        const id = await connect(`private-${method.toLowerCase()}-${kind}`);
        const response = await change(method, id, payload, 'owner', WORKSPACE_B);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          error: { code: 'storage_connection_not_found' },
        });
        expect(
          StorageConnectionResourceSchema.parse(await (await readOne(id)).json()),
        ).toMatchObject({
          writeAllowed: false,
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(body.credential);
        expect(audits).toHaveLength(1);
      },
    );

    // @story US-STO-12
    it('[US-STO-12][api][sdk] no response or audit row of the lifecycle holds a credential', async () => {
      const id = await connect(`clean-${kind}`);
      const texts = [
        await (await change('PATCH', id, { writeAllowed: true })).text(),
        await (await change('PUT', id, rotated)).text(),
        await (await change('PUT', id, { provider: 's3' })).text(),
        await (await change('PATCH', id, { url: 's3://acme-data@host/x' })).text(),
        await (await readOne(id)).text(),
        await (await change('DELETE', id)).text(),
        JSON.stringify(audits),
      ].join('\n');
      for (const value of credentialValues) expect(texts).not.toContain(value);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a file:// connection lists and reads the files already in the folder', async () => {
      const id = await connectFolder(`ondisk-${kind}`);
      const response = await reach('browse', id, '?prefix=reports');
      expect(response.status).toBe(200);
      const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
      expect(page.entries.map((entry) => entry.path)).toEqual(['reports/2026', 'reports/a.txt']);
      expect(page.entries.find((entry) => entry.path === 'reports/a.txt')).toMatchObject({
        size: 'reports/a.txt'.length,
      });
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] folder names with a space list their files', async () => {
      const id = await connectFolder(`spaces-${kind}`);
      seedFolder(path.join(fileRoot, `spaces-${kind}`), ['reports/Q3 reports/n.txt']);
      expect(
        await browsedPaths(await reach('browse', id, '?prefix=reports%2FQ3%20reports')),
      ).toEqual(['reports/Q3 reports/n.txt']);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] browse is limited to allowed folders', async () => {
      const id = await connectFolder(`folders-${kind}`);
      expect(await browsedPaths(await reach('browse', id, '?prefix=reports'))).toEqual([
        'reports/2026',
        'reports/a.txt',
      ]);
      expect(await browsedPaths(await reach('browse', id, '?prefix=reports/'))).toEqual([
        'reports/2026',
        'reports/a.txt',
      ]);
      expect(await browsedPaths(await reach('browse', id, '?prefix=reports/2026'))).toEqual([
        'reports/2026/b.txt',
      ]);
      expect(await browsedPaths(await reach('browse', id))).toEqual(['reports']);

      const refused = [
        'reports-old',
        'secret',
        'reports/..',
        '..',
        '%2e%2e',
        'reports/%2e%2e',
        'reports%2F..%2Fsecret',
        '/reports',
        'reports//2026',
        // The prefix is decoded exactly once, then checked.
        'reports/%2e%2e/secret',
        '%2e',
        'reports%2f..%2fsecret',
        'reports%5c..',
        'reports%00',
        '%2freports',
        '%252e%252e',
        'reports/%252e%252e',
        '%E0%A4%A',
        'reports/%E0%A4%A',
      ];
      for (const prefix of refused) {
        for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
          expect(response.status, prefix).toBe(403);
          const text = await response.text();
          expect(JSON.parse(text), prefix).toMatchObject({
            error: { code: 'storage_connection_prefix_not_allowed' },
          });
          expect(text).not.toContain('d.txt');
        }
      }
      expect(audits).toHaveLength(1);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a folder named with a space, an accent, a plus or an ampersand lists as the server serves it', async () => {
      const name = `names-${kind}`;
      const dir = path.join(fileRoot, name);
      mkdirSync(dir);
      // Through the store the product opens, so the seed lands wherever that store reads.
      const objects = await openConnectionStore(
        `file://${dir}`,
        { provider: 'file' },
        { writable: true, fileRoots: [fileRoot], egress: { production: false, allowHosts: [] } },
      );
      const keys = [
        'reports/Q3 drafts/z.txt',
        'reports/Q3+drafts/plus.txt',
        'reports/café/e.txt',
        'reports/a&b/amp.txt',
      ];
      for (const key of keys) await objects.write(key, new TextEncoder().encode(key), {});
      const created = await post({ name, url: `file://${dir}`, allowedPrefixes: ['reports'] });
      expect(created.status).toBe(201);
      const { id } = StorageConnectionResourceSchema.parse(await created.json());

      // What the SDK sends (`encodeURIComponent`), and the spellings a person types by hand.
      const listed: Record<string, string> = {
        'reports%2FQ3%20drafts': 'reports/Q3 drafts/z.txt',
        'reports/Q3%20drafts': 'reports/Q3 drafts/z.txt',
        'reports%2FQ3+drafts': 'reports/Q3 drafts/z.txt',
        'reports%2FQ3%2Bdrafts': 'reports/Q3+drafts/plus.txt',
        'reports%2Fcaf%C3%A9': 'reports/café/e.txt',
        'reports%2Fa%26b': 'reports/a&b/amp.txt',
      };
      for (const [prefix, file] of Object.entries(listed)) {
        for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
          expect(await browsedPaths(response), prefix).toEqual([file]);
        }
      }
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a tampered cursor never lists outside the prefix', async () => {
      const id = await connectFolder(`cursors-${kind}`);
      const cursors = [
        'file:../secret/d.txt',
        'file:secret/d.txt',
        'file:reports-old/c.txt',
        'folder:',
        'file:',
        'no-kind',
        'file:\u0000',
      ];
      for (const cursor of cursors) {
        const response = await reach(
          'browse',
          id,
          `?prefix=reports&cursor=${encodeURIComponent(cursor)}`,
        );
        for (const found of await browsedPaths(response)) {
          expect(found, cursor).toMatch(/^reports\//u);
        }
      }
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a member can test and browse a connection, a viewer cannot', async () => {
      const id = await connectFolder(`readers-${kind}`);
      for (const role of ['owner', 'admin', 'builder'] as const) {
        expect((await reach('browse', id, '?prefix=reports', role)).status, role).toBe(200);
        expect((await reach('test', id, '', role)).status, role).toBe(200);
      }
      expect((await reach('browse', id, '?prefix=reports', 'viewer')).status).toBe(403);
      expect((await reach('test', id, '', 'viewer')).status).toBe(403);
      expect(testedAudits()).toHaveLength(3);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] another workspace gets 404 on test and browse', async () => {
      const id = await connectFolder(`hidden-${kind}`);
      for (const target of [id, 'not-a-uuid', randomUUID()]) {
        for (const route of ['browse', 'test'] as const) {
          const response = await reach(route, target, '?prefix=reports', 'owner', WORKSPACE_B);
          expect(response.status, `${route} ${target}`).toBe(404);
          expect(await response.json()).toMatchObject({
            error: { code: 'storage_connection_not_found' },
          });
        }
      }
      expect(audits).toHaveLength(1);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a test answers the outcome schema and is audited once', async () => {
      const id = await connectFolder(`tested-${kind}`);
      const ok = await reach('test', id);
      expect(StorageConnectionTestOutcomeSchema.parse(await ok.json())).toEqual({ ok: true });
      expect(testedAudits()).toEqual([
        expect.objectContaining({
          workspaceId: WORKSPACE_A,
          actorPrincipalId: ACTOR,
          subjectId: id,
          subjectLabel: `tested-${kind}`,
        }),
      ]);
      await reach('browse', id, '?prefix=reports');
      expect(testedAudits()).toHaveLength(1);

      // The folder is gone, so the operator's root no longer holds it.
      rmSync(path.join(fileRoot, `tested-${kind}`), { recursive: true });
      const gone = await reach('test', id);
      expect(StorageConnectionTestOutcomeSchema.parse(await gone.json())).toEqual({
        ok: false,
        code: 'forbidden',
      });
      const browsed = await reach('browse', id, '?prefix=reports');
      expect(browsed.status).toBe(422);
      expect(await browsed.json()).toMatchObject({
        error: { code: 'storage_connection_endpoint_forbidden' },
      });
      expect(testedAudits()).toHaveLength(2);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] test and browse refuse a private, loopback or link-local endpoint', async () => {
      // The S3 client sends over Node's http module, not `fetch`, so both transports are watched.
      const fetched = vi.spyOn(globalThis, 'fetch');
      const sent = vi.spyOn(S3Client.prototype, 'send');
      const endpoints = ['https://10.0.0.5', 'https://127.0.0.1:9000', 'https://169.254.169.254'];
      const seen: string[] = [];
      try {
        for (const [index, endpoint] of endpoints.entries()) {
          const created = await post({
            ...body,
            name: `ssrf-${String(index)}-${kind}`,
            url: `s3://acme-data/exports?endpoint=${endpoint}`,
          });
          const { id } = StorageConnectionResourceSchema.parse(await created.json());
          const tested = await reach('test', id);
          seen.push(await tested.clone().text());
          expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
            ok: false,
            code: 'forbidden',
          });
          const browsed = await reach('browse', id, '?prefix=reports');
          seen.push(await browsed.clone().text());
          expect(browsed.status, endpoint).toBe(422);
          expect(await browsed.json()).toMatchObject({
            error: { code: 'storage_connection_endpoint_forbidden' },
          });
        }
        expect(fetched).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
      } finally {
        fetched.mockRestore();
        sent.mockRestore();
      }
      const everything = [...seen, JSON.stringify(audits)].join('\n');
      for (const value of credentialValues) expect(everything).not.toContain(value);
    });

    // @story US-STO-12
    it('[US-STO-12][api][sdk] a connection with no stored credential is unreachable, not an error', async () => {
      const created = await post({ ...body, name: `bare-test-${kind}`, credential: undefined });
      const { id } = StorageConnectionResourceSchema.parse(await created.json());
      const tested = await reach('test', id);
      expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
        ok: false,
        code: 'unreachable',
      });
      const browsed = await reach('browse', id, '?prefix=reports');
      expect(browsed.status).toBe(409);
      expect(await browsed.json()).toMatchObject({
        error: { code: 'storage_connection_credential_required' },
      });
    });
  },
);
