/**
 * `/api/webhooks` (issue #250, N-3, ADR-SDK-18-N3-250): the Owner/Admin matrix, the egress check at
 * create, the problem codes of D9, the secret shown once and kept in the secrets port, and the
 * uniform 404 for another workspace's id. The repository is in memory; its SQL is covered in core's
 * `webhooks.test.ts`. The routes are driven through the real Next.js route modules.
 */
import { randomUUID } from 'node:crypto';

import { checkEgress } from '@agent-workspace/core';
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_PER_WORKSPACE,
  WebhookSecretSchema,
} from '@indx-workspace/contracts/webhooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE } from '../../app/api/webhooks/[id]/route';
import { GET as LIST, POST as CREATE } from '../../app/api/webhooks/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { WebhookRecord, WebhooksRuntime } from './runtime';

const owner = { email: 'owner@example.com' };
const admin = { email: 'admin@example.com' };
const builder = { email: 'builder@example.com' };
const viewer = { email: 'viewer@example.com' };
const OTHER_WORKSPACE = 'another-workspace';

let harness: RbacHarness;
let rows: WebhookRecord[];
let secrets: Map<string, string>;
let failSecretStore: boolean;

function installRuntime(): void {
  rows = [];
  secrets = new Map();
  failSecretStore = false;
  const runtime: WebhooksRuntime = {
    repository: (workspaceId) => {
      const mine = () => rows.filter((row) => row.workspaceId === workspaceId);
      return Promise.resolve({
        list: () => Promise.resolve(mine()),
        get: (id) => Promise.resolve(mine().find((row) => row.id === id) ?? null),
        create: (input) => {
          if (mine().length >= WEBHOOK_MAX_PER_WORKSPACE) {
            return Promise.resolve({ kind: 'limit-reached', limit: WEBHOOK_MAX_PER_WORKSPACE });
          }
          const webhook = {
            id: randomUUID(),
            workspaceId,
            url: input.url,
            events: [...input.events],
            createdAt: new Date('2026-10-31T00:00:00.000Z'),
          };
          rows.push(webhook);
          return Promise.resolve({ kind: 'created', webhook });
        },
        remove: (id) => {
          const index = rows.findIndex((row) => row.workspaceId === workspaceId && row.id === id);
          if (index === -1) return Promise.resolve(false);
          rows.splice(index, 1);
          return Promise.resolve(true);
        },
      });
    },
    secrets: {
      store: (_workspaceId, webhookId, secret) => {
        if (failSecretStore) return Promise.reject(new Error('secrets service unavailable'));
        secrets.set(webhookId, secret);
        return Promise.resolve();
      },
      remove: (_workspaceId, webhookId) => {
        secrets.delete(webhookId);
        return Promise.resolve();
      },
      read: (_workspaceId, webhookId) => Promise.resolve(secrets.get(webhookId) ?? null),
    },
    // The real egress policy under the production posture, with a resolver that answers a public
    // address for every name, so the test reaches no DNS.
    checkUrl: async (url) => {
      const decision = await checkEgress(url, { production: true, allowHosts: [] }, () =>
        Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      );
      return decision.ok
        ? { ok: true }
        : { ok: false, host: decision.host, reason: decision.reason };
    },
  };
  installTestDomains({ webhooks: { kind: 'serving', runtime } });
}

beforeEach(() => {
  harness = installRbacHarness([
    { email: owner.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    { email: admin.email, name: 'Admin', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
    { email: builder.email, name: 'Builder', workspaceId: TEST_WORKSPACE_ID, role: 'builder' },
    { email: viewer.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  installRuntime();
});

afterEach(() => {
  clearApplicationContext();
  harness.teardown();
});

const URL_OK = 'https://hooks.example.com/agent-workspace';

const createAs = (caller: { email: string } | null, body: unknown) =>
  harness.call(CREATE, { method: 'POST', path: '/api/webhooks', as: caller, body });
const listAs = (caller: { email: string } | null) =>
  harness.call(LIST, { method: 'GET', path: '/api/webhooks', as: caller });
const removeAs = (caller: { email: string } | null, id: string) =>
  harness.call(DELETE, { method: 'DELETE', path: `/api/webhooks/${id}`, as: caller, id });

const errorCode = (body: unknown): unknown => (body as { error?: { code?: unknown } }).error?.code;

interface Created {
  readonly webhook: { readonly id: string; readonly events: readonly string[] };
  readonly secret: string;
}

describe('the role matrix (ADR D6)', () => {
  for (const caller of [owner, admin]) {
    it(`lets ${caller.email} create, list and remove`, async () => {
      const created = await createAs(caller, { url: URL_OK });
      expect(created.status).toBe(201);
      const { webhook, secret } = created.body as Created;
      expect(webhook).toMatchObject({ workspaceId: TEST_WORKSPACE_ID, url: URL_OK });
      expect(webhook.events).toEqual([...WEBHOOK_EVENT_TYPES]);
      expect(WebhookSecretSchema.safeParse(secret).success).toBe(true);
      expect(secrets.get(webhook.id)).toBe(secret);

      const listed = await listAs(caller);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        webhooks: [{ ...webhook, createdAt: '2026-10-31T00:00:00.000Z' }],
      });

      const removed = await removeAs(caller, webhook.id);
      expect(removed.status).toBe(204);
      expect(removed.text).toBe('');
      expect(secrets.has(webhook.id)).toBe(false);
      expect((await listAs(caller)).body).toEqual({ webhooks: [] });
    });
  }

  for (const caller of [builder, viewer]) {
    it(`refuses ${caller.email} with 403 on every route`, async () => {
      const seeded = (await createAs(owner, { url: URL_OK })).body as Created;
      expect((await createAs(caller, { url: URL_OK })).status).toBe(403);
      expect((await listAs(caller)).status).toBe(403);
      expect((await removeAs(caller, seeded.webhook.id)).status).toBe(403);
      expect(rows).toHaveLength(1);
    });
  }

  it('answers 401 to a caller with no identity', async () => {
    expect((await listAs(null)).status).toBe(401);
  });
});

describe('create', () => {
  it('refuses a non-https URL with invalid_webhook_url', async () => {
    const response = await createAs(owner, { url: 'http://hooks.example.com/x' });
    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('invalid_webhook_url');
    expect(rows).toEqual([]);
  });

  it('refuses a private or metadata URL with webhook_url_refused, naming only the host', async () => {
    for (const url of ['https://10.0.0.5/hook?token=leak', 'https://169.254.169.254/latest']) {
      const response = await createAs(owner, { url });
      expect(response.status, url).toBe(400);
      expect(errorCode(response.body), url).toBe('webhook_url_refused');
      expect(response.text).not.toContain('token=leak');
    }
    expect(rows).toEqual([]);
  });

  it('refuses unknown keys and a repeated event with invalid_body', async () => {
    const unknown = await createAs(owner, { url: URL_OK, secret: 'mine' });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown.body)).toBe('invalid_body');
    const repeated = await createAs(owner, {
      url: URL_OK,
      events: ['run.failed', 'run.failed'],
    });
    expect(errorCode(repeated.body)).toBe('invalid_body');
    const empty = await createAs(owner, { url: URL_OK, events: [] });
    expect(errorCode(empty.body)).toBe('invalid_body');
    expect(rows).toEqual([]);
  });

  it('stores only the events asked for', async () => {
    const created = await createAs(admin, { url: URL_OK, events: ['run.failed'] });
    expect((created.body as Created).webhook.events).toEqual(['run.failed']);
  });

  it('answers 409 webhook_limit_reached past ten', async () => {
    for (let index = 0; index < WEBHOOK_MAX_PER_WORKSPACE; index += 1) {
      expect((await createAs(owner, { url: URL_OK })).status).toBe(201);
    }
    const response = await createAs(owner, { url: URL_OK });
    expect(response.status).toBe(409);
    expect(errorCode(response.body)).toBe('webhook_limit_reached');
  });

  it('takes the row back out when the secret cannot be stored', async () => {
    failSecretStore = true;
    // The route() boundary answers the thrown failure as a typed 500 that names no cause.
    const answer = await createAs(owner, { url: URL_OK });
    expect(answer.status).toBe(500);
    expect(answer.text).not.toContain('secrets service unavailable');
    expect(answer.text).not.toContain('whsec_');
    expect(rows).toEqual([]);
  });
});

describe('the secret is shown once', () => {
  it('appears in the create answer and in no list or remove answer', async () => {
    const { webhook, secret } = (await createAs(owner, { url: URL_OK })).body as Created;
    const listed = await listAs(owner);
    expect(listed.text).not.toContain(secret);
    expect(listed.text).not.toContain('whsec_');
    const removed = await removeAs(owner, webhook.id);
    expect(removed.text).not.toContain(secret);
  });
});

describe('list', () => {
  it('is unpaginated: every webhook in one answer, no cursor (spec §5.17)', async () => {
    for (let index = 0; index < 3; index += 1) await createAs(owner, { url: URL_OK });
    const body = (await listAs(owner)).body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['webhooks']);
    expect(body['webhooks']).toHaveLength(3);
  });

  it("never lists another workspace's webhook", async () => {
    rows.push({
      id: randomUUID(),
      workspaceId: OTHER_WORKSPACE,
      url: URL_OK,
      events: ['run.completed'],
      createdAt: new Date(),
    });
    expect((await listAs(owner)).body).toEqual({ webhooks: [] });
  });
});

describe('remove', () => {
  it("answers 404 webhook_not_found for another workspace's id and leaves it", async () => {
    const foreign = randomUUID();
    rows.push({
      id: foreign,
      workspaceId: OTHER_WORKSPACE,
      url: URL_OK,
      events: ['run.completed'],
      createdAt: new Date(),
    });
    const response = await removeAs(owner, foreign);
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('webhook_not_found');
    expect(rows).toHaveLength(1);
  });

  it('answers 404 for an id that never existed, and 400 invalid_webhook_id for a non-id', async () => {
    expect(errorCode((await removeAs(owner, randomUUID())).body)).toBe('webhook_not_found');
    const malformed = await removeAs(owner, 'not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(errorCode(malformed.body)).toBe('invalid_webhook_id');
  });
});

describe('not configured', () => {
  it('answers 503 webhook_api_not_configured with no secrets service', async () => {
    installTestDomains({ webhooks: { kind: 'unavailable' } });
    for (const response of [
      await listAs(owner),
      await createAs(owner, { url: URL_OK }),
      await removeAs(owner, randomUUID()),
    ]) {
      expect(response.status).toBe(503);
      expect(errorCode(response.body)).toBe('webhook_api_not_configured');
    }
  });
});
