/**
 * The storage-connection routes, driven as Next.js imports them with real `Request` objects over
 * the in-memory repository and secret store (the storage design, §05 and §06 Phase 5). The
 * memory/PostgreSQL lifecycle lives in `handlers.lifecycle.test.ts`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/storage-connections';
import { createInMemoryStorageConnectionRepositoryProvider } from '@agent-workspace/core/db';

import { GET as getOne } from '../../app/api/storage-connections/[id]/route';
import { GET as list } from '../../app/api/storage-connections/route';
import { installTestDomains } from '../application-context-fixtures';
import { PROBE_TIMEOUT_MS } from '../models/probe';
import { log } from '../telemetry/logger';
import {
  ACTOR,
  accessKeyId,
  audits,
  body,
  change,
  connect,
  expectAudit,
  expectError,
  fileRoot,
  installRuntime,
  outsideRoot,
  post,
  reach,
  read,
  scopes,
  secretAccessKey,
  secrets,
  storedCredential,
  useStorageConnectionRoutes,
  WORKSPACE_A,
  WORKSPACE_B,
} from './handlers.test-support';

useStorageConnectionRoutes();

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
    const id = await connect(body);
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
    const id = await connect(body);
    await post(body);
    await post({ ...body, name: 'bad', url: pathToFileURL(outsideRoot).href });
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
    const id = await connect(body);
    const other = await getOne(read(`/${id}`, 'owner', WORKSPACE_B), {
      params: Promise.resolve({ id }),
    });
    await expectError(other, 404, 'storage_connection_not_found');
    expect(await (await list(read('', 'owner', WORKSPACE_B))).json()).toEqual({ connections: [] });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] an id that is not a UUID is not found', async () => {
    const response = await getOne(read('/not-a-uuid', 'owner'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    await expectError(response, 404, 'storage_connection_not_found');
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
      await expectError(response, 503, 'storage_connections_not_configured');
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
      url: pathToFileURL(outsideRoot).href,
      credential: undefined,
    });
    await expectError(outside, 422, 'storage_connection_endpoint_forbidden');
    const inside = await post({
      ...body,
      name: 'local',
      url: pathToFileURL(path.join(fileRoot, 'shared')).href,
      credential: undefined,
    });
    expect(inside.status).toBe(201);
    expect(await inside.json()).toMatchObject({ provider: 'file', hasCredential: false });
    const leaky = await post({ ...body, name: 'leaky', url: 's3://acme-data@host/x' });
    await expectError(leaky, 422, 'storage_connection_url_has_secret');
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
      const id = await connect(body);
      const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      expect((await change('DELETE', id)).status).toBe(204);
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
      expectAudit('storage-connection-deleted', id);
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
    const id = await connect({
      name: 'acme-gcs',
      url: 'gcs://acme-gcs/exports',
      allowedPrefixes: ['reports'],
      credential: key,
    });
    const token = { provider: 'gcs', accessToken: `ya29.${randomUUID()}` };

    const refused = [
      await change('PUT', id, token),
      await change('PATCH', id, { credential: token }),
      await change('PATCH', id, { url: 'gcs://acme-gcs/archive', credential: token }),
    ];
    for (const response of refused) {
      await expectError(response, 422, 'storage_connection_url_invalid');
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
    const id = await connect(body);
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
