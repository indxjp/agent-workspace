/**
 * `DELETE /api/secrets/:id` (issue #240, S-10), driven through the real route file: the role gate,
 * workspace concealment, the `409 secret_in_use` refusal that names every referrer, and the delete
 * itself. The PostgreSQL reference check is `packages/core/src/db/repositories/mcp-servers.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { POST as createRoute, GET as listRoute } from '../../app/api/secrets/route';
import { DELETE as deleteRoute } from '../../app/api/secrets/[id]/route';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { parseRole, type Role } from '../rbac/roles';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';
import type { SecretResource } from './contract';
import { createInMemorySecretsStoreProvider } from './memory-store';
import { clearSecretsRuntime, configureSecretsRuntime } from './runtime';
import type { SecretReferrers } from './store';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const CONNECTOR_ID = '55555555-5555-4555-8555-555555555555';
const MODEL_CONNECTION_ID = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';
const ROLE_HEADER = 'x-test-role';
const PLAINTEXT = 'sk-ant-delete-test-value-never-echoed';

const referenced = new Map<string, SecretReferrers>();

afterEach(() => {
  clearSecretsRuntime();
  clearRbacRuntime();
  referenced.clear();
});

function useRuntime(): void {
  configureSecretsRuntime({
    secrets: createInMemorySecretsStoreProvider((_workspaceId, secretId) => {
      return referenced.get(secretId) ?? null;
    }),
    resolveWorkspace(request) {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? { kind: 'unauthenticated', reason: 'no test workspace header' }
          : { kind: 'workspace', workspaceId },
      );
    },
  });
  configureRbacRuntime({
    directory: createMemoryDirectory(),
    identify(request) {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      const role = parseRole(request.headers.get(ROLE_HEADER)) ?? 'owner';
      return Promise.resolve(
        workspaceId === null
          ? null
          : Principal.fromApiKey({
              principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              workspaceId,
              role,
              label: 'Secret delete test',
            }),
      );
    },
  });
}

function request(method: string, url: string, workspace: string, role?: Role): Request {
  const headers = new Headers({ [WORKSPACE_HEADER]: workspace });
  if (role !== undefined) headers.set(ROLE_HEADER, role);
  if (method === 'POST') headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify({ name: 'DELETE_ME', value: PLAINTEXT }) } : {}),
  });
}

async function createIn(workspace: string): Promise<SecretResource> {
  const response = await createRoute(request('POST', '/api/secrets', workspace));
  expect(response.status).toBe(201);
  return (await response.json()) as SecretResource;
}

function remove(id: string, workspace: string, role?: Role): Promise<Response> {
  return deleteRoute(request('DELETE', `/api/secrets/${id}`, workspace, role), {
    params: Promise.resolve({ id }),
  });
}

describe('DELETE /api/secrets/:id', () => {
  it('is refused to every role but Owner, whether or not the id exists', async () => {
    useRuntime();
    const secret = await createIn(WORKSPACE_A);
    for (const role of ['admin', 'builder', 'viewer'] as const) {
      const response = await remove(secret.id, WORKSPACE_A, role);
      expect(response.status, role).toBe(403);
      const missing = await remove('99999999-9999-4999-8999-999999999999', WORKSPACE_A, role);
      expect(missing.status, role).toBe(403);
    }
    const listed = await listRoute(request('GET', '/api/secrets', WORKSPACE_A));
    expect(await listed.json()).toMatchObject({ secrets: [{ id: secret.id }] });
  });

  it("answers another workspace's id exactly like one that never existed", async () => {
    useRuntime();
    const secret = await createIn(WORKSPACE_A);
    const foreign = await remove(secret.id, WORKSPACE_B);
    const never = await remove('99999999-9999-4999-8999-999999999999', WORKSPACE_B);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await never.json());
    const listed = await listRoute(request('GET', '/api/secrets', WORKSPACE_A));
    expect(await listed.json()).toMatchObject({ secrets: [{ id: secret.id }] });
  });

  it('refuses a referenced secret with 409 secret_in_use naming every referrer, then deletes it', async () => {
    useRuntime();
    const secret = await createIn(WORKSPACE_A);
    referenced.set(secret.id, {
      connectorIds: [CONNECTOR_ID],
      modelConnectionIds: [MODEL_CONNECTION_ID],
    });

    const refused = await remove(secret.id, WORKSPACE_A);
    expect(refused.status).toBe(409);
    const text = await refused.text();
    expect(text).not.toContain(PLAINTEXT);
    expect(JSON.parse(text)).toMatchObject({
      error: {
        code: 'secret_in_use',
        details: [`connector:${CONNECTOR_ID}`, `model-connection:${MODEL_CONNECTION_ID}`],
      },
    });

    referenced.delete(secret.id);
    const deleted = await remove(secret.id, WORKSPACE_A);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    const listed = await listRoute(request('GET', '/api/secrets', WORKSPACE_A));
    expect(await listed.json()).toEqual({ secrets: [] });

    const again = await remove(secret.id, WORKSPACE_A);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: 'secret_not_found' } });
  });

  it('answers 400 invalid_secret_id for a malformed id', async () => {
    useRuntime();
    const response = await remove('not-a-uuid', WORKSPACE_A);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_secret_id' } });
  });
});
