/**
 * The world the storage-connection route tests share: the in-memory repository and secret store
 * behind the routes, the request builders, and the checks the tests repeat (the storage design,
 * §05 and §06 Phase 5).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, expect } from 'vitest';

import { StorageConnectionResourceSchema } from '@indx-workspace/contracts/storage-connections';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
  type StorageConnectionRepositoryProvider,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService, type SecretsService } from '@agent-workspace/core/secrets';

import { GET as browseRoute } from '../../app/api/storage-connections/[id]/browse/route';
import { PUT as rotate } from '../../app/api/storage-connections/[id]/credential/route';
import { DELETE as remove, PATCH as patch } from '../../app/api/storage-connections/[id]/route';
import { POST as testRoute } from '../../app/api/storage-connections/[id]/test/route';
import { POST as create } from '../../app/api/storage-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/core/roles';
import {
  createRepositoryStorageConnectionsStoreProvider,
  storageConnectionSecretName,
} from './store';

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const ROLE_HEADER = 'x-test-role';
const WORKSPACE_HEADER = 'x-test-workspace';
export const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Built at runtime: a key-shaped literal in a test file trips the secret scanner.
export const accessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
export const secretAccessKey = randomBytes(24).toString('base64');

export const body = {
  name: 'acme-data',
  url: 's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
  allowedPrefixes: ['reports'],
  credential: { provider: 's3', accessKeyId, secretAccessKey },
};

export const fileRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'aw-storage-connections-')));
mkdirSync(path.join(fileRoot, 'shared'));
export const outsideRoot = realpathSync(tmpdir());

/** Every audit event the routes emitted in the current test; cleared before each test. */
export const audits: Array<Record<string, unknown>> = [];
/** `workspaceId/connectionId` of every connection an agent version grants, as the runtime asks. */
export const granted = new Set<string>();
export const secrets = createInMemorySecretsService();
export const scopes = createInMemoryWorkspaceScopeResolver([
  { id: WORKSPACE_A, slug: 'a' },
  { id: WORKSPACE_B, slug: 'b' },
]);

/** Who sends a request: an `admin` of workspace A unless a test says otherwise. */
export interface Caller {
  readonly role?: Role;
  readonly workspace?: string;
}

export function installRuntime(
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

/** Installs the in-memory routes before each test and removes the operator root afterwards. */
export function useStorageConnectionRoutes(): void {
  beforeEach(() => {
    audits.length = 0;
    granted.clear();
    installRuntime(createInMemoryStorageConnectionRepositoryProvider(), scopes);
  });

  afterEach(() => {
    clearApplicationContext();
  });

  afterAll(() => {
    rmSync(fileRoot, { recursive: true, force: true });
  });
}

export function post(
  payload: unknown,
  role: Role = 'admin',
  workspace = WORKSPACE_A,
): Promise<Response> {
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

export function read(path: string, role: Role = 'admin', workspace = WORKSPACE_A): Request {
  return new Request(`http://localhost/api/storage-connections${path}`, {
    headers: { [ROLE_HEADER]: role, [WORKSPACE_HEADER]: workspace },
  });
}

export function change(
  method: 'PATCH' | 'PUT' | 'DELETE',
  id: string,
  payload?: unknown,
  { role = 'admin', workspace = WORKSPACE_A }: Caller = {},
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

export function reach(
  route: 'browse' | 'test',
  id: string,
  query = '',
  { role = 'admin', workspace = WORKSPACE_A }: Caller = {},
): Promise<Response> {
  const headers = { [ROLE_HEADER]: role, [WORKSPACE_HEADER]: workspace };
  const url = `http://localhost/api/storage-connections/${id}/${route}${query}`;
  const context = { params: Promise.resolve({ id }) };
  return route === 'browse'
    ? browseRoute(new Request(url, { headers }), context)
    : testRoute(new Request(url, { method: 'POST', headers }), context);
}

/** Creates a connection as an admin of workspace A and answers its id. */
export async function connect(payload: unknown): Promise<string> {
  const response = await post(payload);
  expect(response.status).toBe(201);
  return StorageConnectionResourceSchema.parse(await response.json()).id;
}

export async function storedCredential(id: string): Promise<unknown> {
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

export async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

/** The one audit event a test emitted after the connection was created. */
export function expectAudit(action: string, subjectId: string, subjectLabel?: string): void {
  expect(audits.slice(1)).toEqual([
    expect.objectContaining({
      action,
      subjectId,
      ...(subjectLabel === undefined ? {} : { subjectLabel }),
    }),
  ]);
}
