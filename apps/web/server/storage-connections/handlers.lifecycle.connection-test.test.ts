/**
 * Testing a storage connection through the route: who may test, what the outcome says and what is
 * audited (the storage design, §05 and §06 Phase 5).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { StorageConnectionTestOutcomeSchema } from '@indx-workspace/contracts/storage-connections';

import {
  ACTOR,
  audits,
  body,
  connect,
  expectError,
  fileRoot,
  reach,
  useStorageConnectionRoutes,
  WORKSPACE_A,
  WORKSPACE_B,
} from './handlers.test-support';
import {
  connectFolder,
  expectNoCredential,
  REPOSITORY_KINDS,
  seedFolder,
  testedAudits,
  useLifecycleRepository,
  type RepositoryKind,
} from './handlers.lifecycle.test-support';

useStorageConnectionRoutes();

function registerAccessTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a member can test and browse a connection, a viewer cannot', async () => {
    const id = await connectFolder(`readers-${kind}`);
    for (const role of ['owner', 'admin', 'builder'] as const) {
      expect((await reach('browse', id, '?prefix=reports', { role })).status, role).toBe(200);
      expect((await reach('test', id, '', { role })).status, role).toBe(200);
    }
    const viewer = { role: 'viewer' } as const;
    expect((await reach('browse', id, '?prefix=reports', viewer)).status).toBe(403);
    expect((await reach('test', id, '', viewer)).status).toBe(403);
    expect(testedAudits()).toHaveLength(3);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] another workspace gets 404 on test and browse', async () => {
    const id = await connectFolder(`hidden-${kind}`);
    const owner = { role: 'owner', workspace: WORKSPACE_B } as const;
    for (const target of [id, 'not-a-uuid', randomUUID()]) {
      for (const route of ['browse', 'test'] as const) {
        const response = await reach(route, target, '?prefix=reports', owner);
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
    await expectError(browsed, 422, 'storage_connection_endpoint_forbidden');
    expect(testedAudits()).toHaveLength(2);
  });
}

function registerEmptyFolderTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a test names the allowed folders it found nothing in', async () => {
    const name = `empty-${kind}`;
    const dir = path.join(fileRoot, name);
    mkdirSync(dir);
    seedFolder(dir, ['reports/a.txt', 'deep/2026/b.txt']);
    mkdirSync(path.join(dir, 'blank'));
    const id = await connect({
      name,
      url: pathToFileURL(dir).href,
      allowedPrefixes: ['reports', 'missing', 'deep', 'blank', 'reports/a.txt/x'],
    });
    const tested = await reach('test', id);
    expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
      ok: true,
      emptyFolders: ['missing', 'blank', 'reports/a.txt/x'],
    });
    expect(testedAudits()).toHaveLength(1);
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
        const id = await connect({
          ...body,
          name: `ssrf-${String(index)}-${kind}`,
          url: `s3://acme-data/exports?endpoint=${endpoint}`,
        });
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
    expectNoCredential([...seen, JSON.stringify(audits)].join('\n'));
  });
}

function registerNoCredentialTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a connection with no stored credential is unreachable, not an error', async () => {
    const id = await connect({ ...body, name: `bare-test-${kind}`, credential: undefined });
    const tested = await reach('test', id);
    expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
      ok: false,
      code: 'unreachable',
    });
    const browsed = await reach('browse', id, '?prefix=reports');
    await expectError(browsed, 409, 'storage_connection_credential_required');
  });
}

describe.each(REPOSITORY_KINDS)('storage connection lifecycle over the %s repository', (kind) => {
  useLifecycleRepository(kind);
  describe('test', () => {
    registerAccessTests(kind);
    registerEmptyFolderTests(kind);
    registerNoCredentialTests(kind);
  });
});
