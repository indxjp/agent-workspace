/**
 * Acceptance criterion 1's third clause: "no audit row." Exercised against a real PostgreSQL,
 * with the real `@agent-workspace/core/secrets` service wired the way a composition root would
 * wire it — `createRepositorySecretsStoreProvider` from `./store.js`, not the in-memory test
 * double `no-plaintext-leak.test.ts` uses — because an audit write, if this subsystem ever grew
 * one, would happen inside that real path.
 *
 * There is currently no code anywhere in `packages/core/src/secrets/**` that references
 * `audit_events`, so this is not expected to find a near-miss; it exists so that claim is checked
 * by a query against the real table rather than left as a sentence in this file's own header.
 */
import crypto from 'node:crypto';

import {
  auditEvents,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as createRoute } from '../../app/api/secrets/route';
import { PUT as replaceRoute } from '../../app/api/secrets/[id]/route';
import { clearRbacRuntime } from '../rbac/runtime';
import { installWorkspaceHeaderRbac } from '../rbac/testing';
import { createRepositorySecretsStoreProvider } from './store';
import { clearSecretsRuntime, configureSecretsRuntime, type WorkspaceResolution } from './runtime';

const WORKSPACE_HEADER = 'x-test-workspace';

function request(method: string, url: string, workspaceId: string, body?: string): Request {
  const headers = new Headers({ [WORKSPACE_HEADER]: workspaceId });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[secrets/no-audit-row.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the "no audit row" ' +
      'half of acceptance criterion 1 was NOT checked against a real PostgreSQL.',
  );
}

describe.skipIf(!hasDatabase)(
  'acceptance criterion 1 — no audit row, against real PostgreSQL',
  () => {
    let isolated: IsolatedTestDatabase;
    let service: SecretsService;
    let workspaceId: string;

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_w2cp02_no_audit');
      workspaceId = crypto.randomUUID();
      await isolated.db
        .insert(workspaces)
        .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: 'W' });
      service = await createSecretsService({
        MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        DATABASE_URL: isolated.url,
      });

      const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
      const secrets = createRepositorySecretsStoreProvider({ service, scopes });
      configureSecretsRuntime({
        secrets,
        resolveWorkspace(req: Request): Promise<WorkspaceResolution> {
          const id = req.headers.get(WORKSPACE_HEADER);
          if (id === null) return Promise.resolve({ kind: 'unauthenticated', reason: 'no header' });
          return Promise.resolve({ kind: 'workspace', workspaceId: id });
        },
      });
      // Every secrets route is gated by the shared decision table (issue #388); secrets are
      // Owner-only, and this identity is an Owner key of the header's workspace.
      installWorkspaceHeaderRbac(WORKSPACE_HEADER);
    }, 180_000);

    afterAll(async () => {
      clearSecretsRuntime();
      clearRbacRuntime();
      await service.close();
      await isolated.close();
    });

    it('creates, lists and replaces a secret through the real routes and writes zero audit_events rows', async () => {
      const created = await createRoute(
        request(
          'POST',
          '/api/secrets',
          workspaceId,
          JSON.stringify({ name: 'AUDIT_CHECK_SECRET', value: 'sk-ant-audit-check-value' }),
        ),
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const secret = (await created.clone().json()) as { id: string };

      const listed = await listRoute(request('GET', '/api/secrets', workspaceId));
      expect(listed.status).toBe(200);

      const replaced = await replaceRoute(
        request(
          'PUT',
          `/api/secrets/${secret.id}`,
          workspaceId,
          JSON.stringify({ value: 'sk-ant-audit-check-rotated' }),
        ),
        idContext(secret.id),
      );
      expect(replaced.status).toBe(200);

      const rows = await isolated.db.select().from(auditEvents);
      expect(rows).toHaveLength(0);
    });
  },
);
