/**
 * A webhook is delivered on run completion (issue #250, N-3, ADR-SDK-18-N3-250; Agent Portal Phase 1
 * exit criterion 3), end to end over a real PostgreSQL.
 *
 * An Owner registers two endpoints through the published SDK, answered by the real route modules
 * and the production wiring (`wireWebhooks`: the PostgreSQL repositories, the signing secret in a
 * real `SecretsService`, the egress check, and the in-process delivery worker on its 5-second
 * timer). A run then goes through the repository run store the way a runtime drives it: running,
 * one priced response, completed. The stop's own transaction writes the outbox row, the worker
 * posts it to a receiver on 127.0.0.1 (the non-production egress posture tolerates a loopback
 * `http:` target), and the receiver verifies it with `verifyWebhookSignature`. Nothing is sent to
 * the endpoint subscribed only to `run.failed`, and a further pass sends nothing again.
 *
 * Runs whenever `TEST_DATABASE_URL` names a database (`pnpm test` provides one, through Docker or
 * the embedded-postgres fallback); skipped, by name, otherwise. The retry-with-backoff half of the
 * acceptance runs on a fake clock in `delivery.test.ts`, and the outbox SQL in core's
 * `webhook-deliveries.test.ts`.
 */
import crypto from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  agents,
  createDatabaseRunEventRepositoryProvider,
  createDatabaseRunRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  findRunWorkspace,
  memberships,
  sessions,
  users,
  webhookDeliveries,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import {
  createClient,
  verifyWebhookSignature,
  WebhookVerificationError,
  type WebhookEvent,
} from '@indx-workspace/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DELETE as removeRoute } from '../../app/api/webhooks/[id]/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/webhooks/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { wireWebhooks } from '../composition/wiring/webhooks';
import { callerHeaders, installRbacHarness } from '../rbac/testing';
import { createRepositoryRunStore } from '../runs/repository-store';
import { createWebhookDeliveryPass } from './delivery';
import { createRepositoryWebhookDeliverySources } from './store';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[webhooks/run-outcome.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so a ' +
      'webhook was NOT proved delivered on run completion against PostgreSQL.',
  );
}

const OWNER = { email: 'owner@example.com' };
/** The worker ticks every 5 s; two ticks and the attempt fit well inside this. */
const DELIVERY_WAIT_MS = 30_000;

interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe.skipIf(!hasDatabase)('a webhook is delivered on run completion', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let secrets: SecretsService;
  let receiver: Server;
  let receiverBase: string;
  const received: Received[] = [];
  const stops: (() => void)[] = [];
  const workerErrors: unknown[] = [];
  let workspaceId: string;
  let agentId: string;
  let sessionId: string;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_n3_run_outcome_webhook');
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    secrets = await createSecretsService({
      MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      DATABASE_URL: isolated.url,
    });

    workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    agentId = crypto.randomUUID();
    sessionId = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Run-outcome webhooks' });
    await isolated.db.insert(users).values({ id: userId, email: OWNER.email, name: 'Owner' });
    await isolated.db
      .insert(memberships)
      .values({ id: membershipId, workspaceId, userId, role: 'owner' });
    const [principal] = await isolated.db
      .select()
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.membershipId, membershipId));
    if (principal === undefined) throw new Error('the membership trigger created no principal');
    await isolated.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: 'Reporter',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId: principal.id,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(sessions)
      .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId: principal.id });

    receiver = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({ path: request.url ?? '', headers: request.headers, body });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverBase = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;

    installRbacHarness([{ email: OWNER.email, name: 'Owner', workspaceId, role: 'owner' }], {
      workspaceId,
    });
    // The production wiring, worker included.
    installTestDomains({
      webhooks: wireWebhooks(root, secrets, {
        log: { info: () => undefined, error: (_message, fields) => workerErrors.push(fields) },
        stopOnClose: (stop) => stops.push(stop),
      }),
    });
  }, 180_000);

  afterAll(async () => {
    for (const stop of stops.splice(0)) stop();
    clearApplicationContext();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await secrets.close();
    await root.close();
    await isolated.close();
  });

  /** The published client, every request answered by the real route modules as the Owner. */
  const aw = createClient({
    baseUrl: 'https://control-plane.test',
    auth: { kind: 'api-key', apiKey: 'ak_live_run_outcome' },
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      for (const [name, value] of Object.entries(callerHeaders(OWNER))) headers.set(name, value);
      const request = new Request(input, { ...init, headers });
      const { pathname } = new URL(request.url);
      const id = /^\/api\/webhooks\/([^/]+)$/u.exec(pathname)?.[1];
      if (id !== undefined && request.method === 'DELETE') {
        return removeRoute(request, { params: Promise.resolve({ id }) });
      }
      if (pathname === '/api/webhooks') {
        return request.method === 'POST' ? createRoute(request) : listRoute(request);
      }
      throw new Error(`no webhook route for ${request.method} ${pathname}`);
    },
  });

  async function deliveredWithin(ms: number, count: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `no delivery within ${String(ms)} ms; worker errors: ${String(workerErrors)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('posts one signed run.completed to the subscribed endpoint, which the SDK helper verifies', async () => {
    const completed = await aw.webhooks.create({ url: `${receiverBase}/completed` });
    const failuresOnly = await aw.webhooks.create({
      url: `${receiverBase}/failures`,
      events: ['run.failed'],
    });
    expect((await aw.webhooks.list()).map((webhook) => webhook.id).sort()).toEqual(
      [completed.webhook.id, failuresOnly.webhook.id].sort(),
    );

    // The run, as a runtime drives it through the repository store.
    const store = createRepositoryRunStore({
      repositories: createDatabaseRunRepositoryProvider(isolated.db),
      events: createDatabaseRunEventRepositoryProvider(isolated.db),
      scopes: createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (id: string) => findRunWorkspace(isolated.db, id),
    });
    const runId = crypto.randomUUID();
    await store.create({ engine: 'claude-agent-sdk', id: runId, workspaceId, agentId, sessionId });
    expect(await store.markRunning(runId)).toBe(true);
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('the seeded workspace did not resolve');
    const usage = await root.runs.forScope(scope).recordUsage(runId, {
      providerResponseId: 'msg_run_outcome',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      toolCalls: 0,
      wireProtocol: 'anthropic-messages',
      costUsd: '0.000810',
      costCurrency: 'USD',
      priceTableVersion: 'conformance-v1',
    });
    expect(usage.kind).toBe('recorded');
    await store.finish(runId, 'completed', null, true);

    await deliveredWithin(DELIVERY_WAIT_MS, 1);
    const [delivery] = received;
    if (delivery === undefined) throw new Error('the receiver got the delivery');
    expect(delivery.path).toBe('/completed');

    const event: WebhookEvent = await verifyWebhookSignature({
      secret: completed.secret,
      headers: delivery.headers,
      body: delivery.body,
    });
    expect(event).toMatchObject({
      type: 'run.completed',
      workspaceId,
      data: {
        run: {
          id: runId,
          agentId,
          sessionId,
          status: 'completed',
          error: null,
          usage: { inputTokens: 120, outputTokens: 30 },
          cost: { amount: '0.000810', currency: 'USD', priceTableVersion: 'conformance-v1' },
          accountingState: 'complete',
        },
      },
    });
    expect(delivery.headers['webhook-id']).toBe(event.id);

    const wrongSecret: unknown = await verifyWebhookSignature({
      secret: failuresOnly.secret,
      headers: delivery.headers,
      body: delivery.body,
    }).catch((error: unknown) => error);
    expect(wrongSecret).toBeInstanceOf(WebhookVerificationError);
    expect((wrongSecret as WebhookVerificationError).code).toBe('signature_mismatch');

    // Exactly once: the row is settled, and another pass (another replica) finds nothing due.
    const rows = await isolated.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.runId, runId));
    expect(rows.map((row) => [row.webhookId, row.state, row.attempts, row.lastStatusCode])).toEqual(
      [[completed.webhook.id, 'delivered', 1, 204]],
    );
    const pass = createWebhookDeliveryPass(createRepositoryWebhookDeliverySources(root, secrets));
    expect(await pass()).toMatchObject({ claimed: 0 });
    expect(received).toHaveLength(1);
    expect(workerErrors).toEqual([]);
  }, 60_000);
});
