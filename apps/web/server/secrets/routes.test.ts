/**
 * The three secrets route handlers, imported as Next.js will import them and driven with real
 * `Request` objects — the same shape `apps/web/server/agents/routes.test.ts` uses, for the same
 * reason: the wiring in `apps/web/app/api/secrets/**` is code too.
 */
import { createInMemoryStorageConnectionRepositoryProvider } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as listRoute, POST as createRoute } from '../../app/api/secrets/route';
import { PUT as replaceRoute } from '../../app/api/secrets/[id]/route';
import { installSecretsApi } from '../composition/services';
import { captureLog } from '../telemetry/capture-log';
import { installWorkspaceHeaderRbac, TEST_ROLE_HEADER } from '../rbac/testing';
import { createInMemorySecretsStoreProvider } from './memory-store';
import type { WorkspaceResolution } from './runtime';
import type { SecretResource } from './contract';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** The workspace a request acts in, taken from a header **only in this test**. */
const WORKSPACE_HEADER = 'x-test-workspace';

type TestRole = 'owner' | 'admin' | 'builder' | 'viewer';

afterEach(() => {
  clearApplicationContext();
});

/** Every secrets route is gated by the shared decision table (issue #388; `DELETE` since #240). */
function useHeaderRbac(): void {
  installWorkspaceHeaderRbac(WORKSPACE_HEADER);
}

function useMemoryRuntime(): void {
  useHeaderRbac();
  const secrets = createInMemorySecretsStoreProvider();
  installTestDomains({
    secrets: {
      kind: 'serving',
      runtime: {
        secrets,
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
}

function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    role?: TestRole;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.role !== undefined) headers.set(TEST_ROLE_HEADER, options.role);
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null && options.body !== undefined) headers.set('content-type', contentType);
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function bodyOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

const PLAINTEXT = 'sk-ant-super-secret-do-not-leak-this-value';

function createBody(name = 'ANTHROPIC_API_KEY', value = PLAINTEXT): string {
  return JSON.stringify({ name, value });
}

async function createIn(workspace: string): Promise<SecretResource> {
  const response = await createRoute(
    request('POST', '/api/secrets', { workspace, body: createBody() }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await bodyOf(response)) as SecretResource;
}

describe('the secrets routes serve real responses once a runtime is wired', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    // The role gate lives in the same context, so with none installed it answers first; the
    // secrets runtime's own answer is the `unavailable` case below.
    const response = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'rbac_runtime_not_configured' },
    });
  });

  it('answers the same 503 while the secrets service is unavailable', async () => {
    useHeaderRbac();
    installTestDomains({ secrets: { kind: 'unavailable' } });
    const response = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'secrets_runtime_not_configured' },
    });
  });

  const noScopes = {
    forWorkspaceId: () => Promise.resolve(null),
    forWorkspaceSlug: () => Promise.resolve(null),
  };
  const workspaceA = () =>
    Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A } as const);

  it('builds no secrets runtime, and names no reason, when MASTER_ENCRYPTION_KEY is unset', async () => {
    vi.stubEnv('MASTER_KEY_PROVIDER', '');
    vi.stubEnv('MASTER_ENCRYPTION_KEY', undefined);
    try {
      const built = await installSecretsApi(
        workspaceA,
        noScopes,
        createInMemoryStorageConnectionRepositoryProvider(),
      );
      expect(built).toEqual({ secrets: { kind: 'unavailable' }, secretsService: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds no secrets runtime for a malformed MASTER_ENCRYPTION_KEY, names it, and never logs it', async () => {
    // Issue #1562 (owner decision D9): set-but-malformed is a misconfiguration readiness reports.
    const malformed = 'zz-not-a-hex-key-zz';
    vi.stubEnv('MASTER_KEY_PROVIDER', '');
    vi.stubEnv('MASTER_ENCRYPTION_KEY', malformed);
    const capture = captureLog();
    try {
      const built = await installSecretsApi(
        workspaceA,
        noScopes,
        createInMemoryStorageConnectionRepositoryProvider(),
      );
      expect(built).toEqual({
        secrets: { kind: 'unavailable', reason: 'malformed-master-key' },
        secretsService: null,
      });
      const logged = capture.text();
      expect(logged).toContain('MASTER_ENCRYPTION_KEY');
      expect(logged).toContain('64 hex characters');
      expect(logged).not.toContain(malformed);
    } finally {
      capture.restore();
      vi.unstubAllEnvs();
    }
  });

  it('creates a secret and returns its metadata at 201, with no value field at all', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/secrets', { workspace: WORKSPACE_A, body: createBody() }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const secret = (await bodyOf(response)) as Record<string, unknown>;
    expect(secret['name']).toBe('ANTHROPIC_API_KEY');
    expect(secret).not.toHaveProperty('value');
    expect(secret).not.toHaveProperty('ciphertext');
    expect(secret).not.toHaveProperty('wrappedDataKey');
  });

  it('lists and replaces that secret through the real handlers, never returning the value', async () => {
    useMemoryRuntime();
    const secret = await createIn(WORKSPACE_A);

    const list = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    expect(await bodyOf(list)).toMatchObject({ secrets: [{ id: secret.id, name: secret.name }] });

    const replaced = await replaceRoute(
      request('PUT', `/api/secrets/${secret.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ value: 'sk-ant-rotated-value' }),
      }),
      idContext(secret.id),
    );
    expect(replaced.status).toBe(200);
    const replacedBody = (await bodyOf(replaced)) as SecretResource;
    expect(replacedBody.id).toBe(secret.id);
    expect(replacedBody.name).toBe(secret.name);
  });

  it('filters the list by exact name, and answers 404 secret_not_found for an unknown or foreign name', async () => {
    useMemoryRuntime();
    const secret = await createIn(WORKSPACE_A);
    const get = (name: string, workspace: string) =>
      listRoute(request('GET', `/api/secrets?name=${name}`, { workspace }));

    const hit = await get(secret.name, WORKSPACE_A);
    expect(hit.status).toBe(200);
    expect(await bodyOf(hit)).toMatchObject({ secrets: [{ id: secret.id }] });

    for (const miss of [get('OTHER_KEY', WORKSPACE_A), get(secret.name, WORKSPACE_B)]) {
      const response = await miss;
      expect(response.status).toBe(404);
      expect(await bodyOf(response)).toMatchObject({ error: { code: 'secret_not_found' } });
    }
  });

  it('does not let another workspace see or replace the row', async () => {
    useMemoryRuntime();
    const secret = await createIn(WORKSPACE_A);

    const listB = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_B }));
    expect(await bodyOf(listB)).toEqual({ secrets: [] });

    const replaced = await replaceRoute(
      request('PUT', `/api/secrets/${secret.id}`, {
        workspace: WORKSPACE_B,
        body: JSON.stringify({ value: 'hijacked' }),
      }),
      idContext(secret.id),
    );
    expect(replaced.status).toBe(404);

    const listA = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A }));
    expect(await bodyOf(listA)).toMatchObject({ secrets: [{ id: secret.id }] });
  });

  it('rejects a duplicate name in the same workspace as 409, and a foreign name as its own row', async () => {
    useMemoryRuntime();
    await createIn(WORKSPACE_A);
    const conflict = await createRoute(
      request('POST', '/api/secrets', { workspace: WORKSPACE_A, body: createBody() }),
    );
    expect(conflict.status).toBe(409);

    const otherWorkspace = await createRoute(
      request('POST', '/api/secrets', { workspace: WORKSPACE_B, body: createBody() }),
    );
    expect(otherWorkspace.status).toBe(201);
  });

  it('rejects a malformed name with 400 and a helpful message', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/secrets', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'not-uppercase', value: 'x' }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'invalid_body' } });
  });

  it('rejects an attempt to rename through PUT', async () => {
    useMemoryRuntime();
    const secret = await createIn(WORKSPACE_A);
    const response = await replaceRoute(
      request('PUT', `/api/secrets/${secret.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'NEW_NAME', value: 'x' }),
      }),
      idContext(secret.id),
    );
    expect(response.status).toBe(400);
  });
});

describe('the workspace gate runs before the body is parsed', () => {
  it('answers 401 — not 400 — to an unauthenticated POST carrying a malformed body', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/secrets', { body: 'not json at all' }),
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('still reports a malformed body to a caller who did pass the gate', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/secrets', { workspace: WORKSPACE_A, body: 'not json at all' }),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'malformed_body' } });
  });
});

// Issue #388: `GET`, `POST` and `PUT` used to answer every member or API key of the workspace
// whatever its role, because they consulted only the workspace resolver. §21 makes secrets
// Owner-only (`permissions.ts`), so every other role is refused before the store is touched.
describe('only an Owner reaches the secrets routes', () => {
  it.each(['admin', 'builder', 'viewer'] as const)(
    'refuses a %s on list, create and replace with 403, and writes nothing',
    async (role) => {
      useMemoryRuntime();
      const existing = await createIn(WORKSPACE_A);

      const responses = [
        await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A, role })),
        await createRoute(
          request('POST', '/api/secrets', {
            workspace: WORKSPACE_A,
            role,
            body: createBody('SMUGGLED_KEY'),
          }),
        ),
        await replaceRoute(
          request('PUT', `/api/secrets/${existing.id}`, {
            workspace: WORKSPACE_A,
            role,
            body: JSON.stringify({ value: 'overwritten-by-a-non-owner' }),
          }),
          idContext(existing.id),
        ),
      ];
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(await bodyOf(response)).toMatchObject({ error: { code: 'forbidden' } });
      }

      const listed = await listRoute(request('GET', '/api/secrets', { workspace: WORKSPACE_A }));
      const body = (await bodyOf(listed)) as { secrets: SecretResource[] };
      expect(body.secrets.map((secret) => secret.name)).toEqual([existing.name]);
      expect(body.secrets[0]?.updatedAt).toBe(existing.updatedAt);
    },
  );
});
