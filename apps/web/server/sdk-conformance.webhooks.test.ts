/**
 * SDK conformance, webhooks: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiProblemError,
  createClient,
  verifyWebhookSignature,
  WebhookVerificationError,
} from '@indx-workspace/sdk';
import {
  CreateWebhookResponseSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_PER_WORKSPACE,
  WEBHOOK_PROBLEM_CODES,
  webhookEventTypeOf,
  WebhookEventSchema,
  WebhookListResponseSchema,
} from '@indx-workspace/contracts/webhooks';
import { DELETE as removeWebhookRoute } from '../app/api/webhooks/[id]/route';
import { GET as listWebhooksRoute, POST as createWebhookRoute } from '../app/api/webhooks/route';
import { callerHeaders, installRbacHarness } from './rbac/testing';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { fixedClock } from './clock';
import { createWebhookDeliveryPass } from './webhooks/delivery';
import type {
  ClaimedWebhookDelivery,
  WebhookDeliveryOutbox,
  WebhookRecord,
  WebhooksRuntime,
} from './webhooks/runtime';
import { finishedRun } from './webhooks/testing';

const HOOK_WORKSPACE = '12121212-1212-4212-8212-121212121212';

const RECEIVER_URL = 'http://127.0.0.1:8789/agent-workspace/hooks';

const owner = { email: 'owner@example.com' };

const builder = { email: 'builder@example.com' };

const viewer = { email: 'viewer@example.com' };

let rows: WebhookRecord[];

let signingSecrets: Map<string, string>;

/**
 * The routes' runtime in memory: the repository keeps the cap, the secrets port keeps what the
 * create handler stored, and the egress check allows the loopback receiver. Their PostgreSQL and
 * secrets-service halves are pinned by core's `webhooks.test.ts` and the composition's
 * `run-outcome-webhook.integration.test.ts`.
 */
function memoryWebhooksRuntime(): WebhooksRuntime {
  return {
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
            id: crypto.randomUUID(),
            workspaceId,
            url: input.url,
            events: [...input.events],
            createdAt: new Date('2026-10-31T00:00:00.000Z'),
          };
          rows.push(webhook);
          return Promise.resolve({ kind: 'created', webhook });
        },
        remove: (id) => {
          const before = rows.length;
          rows = rows.filter((row) => row.workspaceId !== workspaceId || row.id !== id);
          return Promise.resolve(rows.length < before);
        },
      });
    },
    secrets: {
      store: (_workspaceId, webhookId, secret) => {
        signingSecrets.set(webhookId, secret);
        return Promise.resolve();
      },
      remove: (_workspaceId, webhookId) => {
        signingSecrets.delete(webhookId);
        return Promise.resolve();
      },
      read: (_workspaceId, webhookId) => Promise.resolve(signingSecrets.get(webhookId) ?? null),
    },
    checkUrl: () => Promise.resolve({ ok: true }),
  };
}

/** The published client, its every request answered by the real route modules as `caller`. */
function clientAs(caller: { readonly email: string }) {
  return createClient({
    baseUrl: 'https://control-plane.test',
    auth: { kind: 'api-key', apiKey: 'ak_live_conformance' },
    fetch: (input, init) => {
      // The harness identifies the caller by its own header, so the key the SDK sends is dropped.
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      for (const [name, value] of Object.entries(callerHeaders(caller))) headers.set(name, value);
      const request = new Request(input, { ...init, headers });
      const { pathname } = new URL(request.url);
      const id = /^\/api\/webhooks\/([^/]+)$/u.exec(pathname)?.[1];
      const context = { params: Promise.resolve({ id: id ?? '' }) };
      if (id !== undefined && request.method === 'DELETE') {
        return removeWebhookRoute(request, context);
      }
      if (pathname === '/api/webhooks' && request.method === 'GET') {
        return listWebhooksRoute(request);
      }
      if (pathname === '/api/webhooks' && request.method === 'POST') {
        return createWebhookRoute(request);
      }
      throw new Error(`no webhook route for ${request.method} ${pathname}`);
    },
  });
}

async function refusalOf(call: () => Promise<unknown>): Promise<ApiProblemError> {
  const outcome = await call().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiProblemError)) {
    throw new Error(`expected an ApiProblemError, got ${String(outcome)}`);
  }
  return outcome;
}

/** Empty webhook rows, the three RBAC callers, and the in-memory webhooks runtime. */
function installWebhooksWorld(): void {
  rows = [];
  signingSecrets = new Map();
  installRbacHarness(
    [
      { email: owner.email, name: 'Owner', workspaceId: HOOK_WORKSPACE, role: 'owner' },
      { email: builder.email, name: 'Builder', workspaceId: HOOK_WORKSPACE, role: 'builder' },
      { email: viewer.email, name: 'Viewer', workspaceId: HOOK_WORKSPACE, role: 'viewer' },
    ],
    { workspaceId: HOOK_WORKSPACE },
  );
  installTestDomains({ webhooks: { kind: 'serving', runtime: memoryWebhooksRuntime() } });
}

interface PendingDelivery {
  readonly delivery: Omit<ClaimedWebhookDelivery, 'attempt'>;
  attempts: number;
  settled: boolean;
}

/**
 * What `stopIn` writes in the stop's own transaction: one pending row per webhook whose
 * `events` names the run's terminal status. Its SQL is pinned by core's
 * `webhook-deliveries.test.ts`, and the whole path by `run-outcome-webhook.integration.test.ts`.
 */
function pendingDeliveriesFor(
  run: ReturnType<typeof finishedRun>,
  endpoints: readonly {
    readonly id: string;
    readonly url: string;
    readonly events: readonly string[];
  }[],
  createdAt: Date,
): PendingDelivery[] {
  const eventType = webhookEventTypeOf(run.status);
  if (eventType === null) throw new Error('a completed run is terminal');
  return endpoints
    .filter((endpoint) => endpoint.events.includes(eventType))
    .map((endpoint) => ({
      delivery: {
        id: crypto.randomUUID(),
        workspaceId: HOOK_WORKSPACE,
        webhookId: endpoint.id,
        runId: run.id,
        eventType,
        url: endpoint.url,
        createdAt,
      },
      attempts: 0,
      settled: false,
    }));
}

/** An outbox over `pending` that claims every unsettled row and settles on the matching attempt. */
function outboxOver(pending: PendingDelivery[]): WebhookDeliveryOutbox {
  const settle = (id: string, attempt: number): Promise<boolean> => {
    const row = pending.find(
      (candidate) =>
        candidate.delivery.id === id && !candidate.settled && candidate.attempts === attempt,
    );
    if (row === undefined) return Promise.resolve(false);
    row.settled = true;
    return Promise.resolve(true);
  };
  return {
    claimDue: () => {
      const due = pending.filter((row) => !row.settled);
      for (const row of due) row.attempts += 1;
      return Promise.resolve(
        due.map((row): ClaimedWebhookDelivery => ({ ...row.delivery, attempt: row.attempts })),
      );
    },
    markDelivered: settle,
    scheduleRetry: () => Promise.resolve(false),
    markFailed: settle,
    deferClaim: () => Promise.resolve(false),
    pruneSettled: () => Promise.resolve(0),
  };
}

/** The fake receiver keeps the request as it arrived and answers a fast 2xx. */
function recordingReceiver(received: { readonly headers: Headers; readonly body: string }[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    received.push({ headers: request.headers, body: await request.text() });
    return new Response(null, { status: 204 });
  };
}

function deliveryPassOver(options: {
  readonly outbox: WebhookDeliveryOutbox;
  readonly run: ReturnType<typeof finishedRun>;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly transport: ReturnType<typeof recordingReceiver>;
}) {
  const { outbox, run, clock, transport } = options;
  return createWebhookDeliveryPass({
    outbox,
    readRun: (workspaceId, runId) =>
      Promise.resolve(workspaceId === run.workspaceId && runId === run.id ? run : null),
    secrets: {
      read: (_workspaceId, webhookId) => Promise.resolve(signingSecrets.get(webhookId) ?? null),
    },
    lease: { tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }) },
    clock,
    random: () => 0.5,
    egressPolicy: () => ({ production: false, allowHosts: [] }),
    transport,
  });
}

describe('webhooks (issue #250, N-3, ADR-SDK-18-N3-250)', () => {
  beforeEach(installWebhooksWorld);

  afterEach(() => {
    clearApplicationContext();
  });

  it('round-trips an Owner create, list and remove through the SDK in the published shapes', async () => {
    const aw = clientAs(owner);

    const created = await aw.webhooks.create({ url: RECEIVER_URL, events: ['run.completed'] });
    expect(CreateWebhookResponseSchema.parse(created)).toEqual(created);
    expect(created.webhook).toMatchObject({
      workspaceId: HOOK_WORKSPACE,
      url: RECEIVER_URL,
      events: ['run.completed'],
    });
    expect(signingSecrets.get(created.webhook.id)).toBe(created.secret);

    const everyEvent = await aw.webhooks.create({ url: RECEIVER_URL });
    expect(everyEvent.webhook.events).toEqual([...WEBHOOK_EVENT_TYPES]);

    const listed = await aw.webhooks.list();
    expect(WebhookListResponseSchema.parse({ webhooks: listed }).webhooks).toEqual([
      created.webhook,
      everyEvent.webhook,
    ]);
    // The secret is in the create answer and nowhere else.
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    await aw.webhooks.remove(created.webhook.id);
    expect((await aw.webhooks.list()).map((webhook) => webhook.id)).toEqual([
      everyEvent.webhook.id,
    ]);
    expect(signingSecrets.has(created.webhook.id)).toBe(false);

    const missing = await refusalOf(() => aw.webhooks.remove(created.webhook.id));
    expect([missing.status, missing.code]).toEqual([
      WEBHOOK_PROBLEM_CODES.webhook_not_found,
      'webhook_not_found',
    ]);
    const badId = await refusalOf(() => aw.webhooks.remove('not-a-uuid'));
    expect([badId.status, badId.code]).toEqual([
      WEBHOOK_PROBLEM_CODES.invalid_webhook_id,
      'invalid_webhook_id',
    ]);
  });
});

describe('webhooks (issue #250, N-3, ADR-SDK-18-N3-250)', () => {
  beforeEach(installWebhooksWorld);

  afterEach(() => {
    clearApplicationContext();
  });

  it('refuses a Builder and a Viewer every webhook route with 403, and writes nothing', async () => {
    const { webhook } = await clientAs(owner).webhooks.create({ url: RECEIVER_URL });
    for (const caller of [builder, viewer]) {
      const aw = clientAs(caller);
      for (const call of [
        () => aw.webhooks.list(),
        () => aw.webhooks.create({ url: RECEIVER_URL }),
        () => aw.webhooks.remove(webhook.id),
      ]) {
        const refused = await refusalOf(call);
        expect([caller.email, refused.status, refused.code]).toEqual([
          caller.email,
          403,
          'forbidden',
        ]);
      }
    }
    expect(rows.map((row) => row.id)).toEqual([webhook.id]);
  });
});

describe('webhooks (issue #250, N-3, ADR-SDK-18-N3-250)', () => {
  beforeEach(installWebhooksWorld);

  afterEach(() => {
    clearApplicationContext();
  });

  it('delivers a terminal run to its registered endpoint once, signed so the SDK helper verifies it', async () => {
    const aw = clientAs(owner);
    const { webhook, secret } = await aw.webhooks.create({ url: RECEIVER_URL });
    const failuresOnly = await aw.webhooks.create({ url: RECEIVER_URL, events: ['run.failed'] });
    const clock = fixedClock('2026-10-31T00:00:10.000Z');
    const run = finishedRun({ workspaceId: HOOK_WORKSPACE });

    const pending = pendingDeliveriesFor(run, await aw.webhooks.list(), clock.now());
    expect(pending.map((row) => row.delivery.webhookId)).toEqual([webhook.id]);

    const received: { readonly headers: Headers; readonly body: string }[] = [];
    const pass = deliveryPassOver({
      outbox: outboxOver(pending),
      run,
      clock,
      transport: recordingReceiver(received),
    });
    expect(await pass()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await pass()).toMatchObject({ claimed: 0 });
    expect(received).toHaveLength(1);
    const [delivery] = received;
    if (delivery === undefined) throw new Error('the receiver got the delivery');

    // The receiver verifies with the SDK's helper, as a customer backend would.
    const event = await verifyWebhookSignature({
      secret,
      headers: delivery.headers,
      body: delivery.body,
      now: clock.now(),
    });
    expect(WebhookEventSchema.parse(event)).toEqual(event);
    expect(event).toMatchObject({
      id: pending[0]?.delivery.id,
      type: 'run.completed',
      workspaceId: HOOK_WORKSPACE,
      data: { run: { id: run.id, status: 'completed', usage: run.usage, cost: run.cost } },
    });
    expect(delivery.headers.get('webhook-id')).toBe(event.id);
    // The payload carries the outcome, never the run's output.
    expect(delivery.body).not.toContain(run.output?.text ?? 'output');

    const forged: unknown = await verifyWebhookSignature({
      secret: failuresOnly.secret,
      headers: delivery.headers,
      body: delivery.body,
      now: clock.now(),
    }).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(WebhookVerificationError);
    expect((forged as WebhookVerificationError).code).toBe('signature_mismatch');
  });
});
