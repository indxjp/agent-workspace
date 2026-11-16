/**
 * The delivery worker (ADR-SDK-18-N3-250 D4, D5) against a real HTTP receiver on 127.0.0.1, sent
 * through the real `guardedFetch` under a non-production egress posture, with a fake clock and an
 * in-memory outbox that keeps the core repository's claim rules (a claim bumps `attempts` and moves
 * the due time; every settle is guarded on the claim). The SQL of those rules is covered by core's
 * `webhook-deliveries.test.ts`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { RunResource } from '@indx-workspace/contracts/runs';
import {
  WEBHOOK_SIGNATURE_HEADERS,
  WebhookEventSchema,
  webhookSignedContent,
} from '@indx-workspace/contracts/webhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fixedClock, type FixedClock } from '../clock';
import {
  createWebhookDeliveryPass,
  WEBHOOK_ACCOUNTING_WAIT_MS,
  type WebhookDeliveryDependencies,
} from './delivery';
import { WEBHOOK_MAX_ATTEMPTS } from './retry-policy';
import type { ClaimedWebhookDelivery, WebhookDeliveryOutbox } from './runtime';
import { mintWebhookSecret } from './signature';
import { finishedRun, WEBHOOK_TEST_WORKSPACE_ID } from './testing';

const WEBHOOK_ID = '77777777-7777-4777-8777-777777777777';
const DELIVERY_ID = '88888888-8888-4888-8888-888888888888';

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Row {
  readonly delivery: Omit<ClaimedWebhookDelivery, 'attempt'>;
  state: 'pending' | 'delivered' | 'failed';
  attempts: number;
  dueAt: number;
  lastError: string | null;
  lastStatusCode: number | null;
}

function memoryOutbox(clock: FixedClock): WebhookDeliveryOutbox & { readonly rows: Row[] } {
  const rows: Row[] = [];
  const held = (id: string, attempt: number) =>
    rows.find(
      (row) => row.delivery.id === id && row.state === 'pending' && row.attempts === attempt,
    );
  const settle = (id: string, attempt: number, change: (row: Row) => void) => {
    const row = held(id, attempt);
    if (row === undefined) return Promise.resolve(false);
    change(row);
    return Promise.resolve(true);
  };
  return {
    rows,
    claimDue: ({ limit, claimMs, maxAttempts }) => {
      const now = clock.now().getTime();
      for (const row of rows) {
        if (row.state === 'pending' && row.dueAt <= now && row.attempts >= maxAttempts) {
          row.state = 'failed';
          row.lastError = 'attempts_exhausted';
        }
      }
      const due = rows
        .filter((row) => row.state === 'pending' && row.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.dueAt = now + claimMs;
      }
      return Promise.resolve(due.map((row) => ({ ...row.delivery, attempt: row.attempts })));
    },
    markDelivered: (id, attempt, statusCode) =>
      settle(id, attempt, (row) => {
        row.state = 'delivered';
        row.lastStatusCode = statusCode;
        row.lastError = null;
      }),
    scheduleRetry: (id, attempt, at, failure) =>
      settle(id, attempt, (row) => {
        row.dueAt = at.getTime();
        row.lastStatusCode = failure.statusCode;
        row.lastError = failure.error;
      }),
    markFailed: (id, attempt, failure) =>
      settle(id, attempt, (row) => {
        row.state = 'failed';
        row.lastStatusCode = failure.statusCode;
        row.lastError = failure.error;
      }),
    deferClaim: (id, attempt, at) =>
      settle(id, attempt, (row) => {
        row.attempts -= 1;
        row.dueAt = at.getTime();
      }),
    pruneSettled: () => Promise.resolve(0),
  };
}

let server: Server;
let receiverUrl: string;
let received: Received[];
let answers: number[];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.statusCode = answers.shift() ?? 200;
      response.end('receiver text that must never be stored');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

let clock: FixedClock;
let outbox: ReturnType<typeof memoryOutbox>;
let run: RunResource | null;
let secret: string | null;
let readSecret: () => Promise<string | null>;
let leaseHeld: boolean;
let fetched: string[];

beforeEach(() => {
  received = [];
  answers = [];
  fetched = [];
  clock = fixedClock('2026-10-31T00:00:00.000Z');
  outbox = memoryOutbox(clock);
  run = finishedRun();
  secret = mintWebhookSecret();
  readSecret = () => Promise.resolve(secret);
  leaseHeld = false;
});

function enqueue(url: string = receiverUrl): Row {
  const row: Row = {
    delivery: {
      id: DELIVERY_ID,
      workspaceId: WEBHOOK_TEST_WORKSPACE_ID,
      webhookId: WEBHOOK_ID,
      runId: finishedRun().id,
      eventType: 'run.completed',
      url,
      createdAt: clock.now(),
    },
    state: 'pending',
    attempts: 0,
    dueAt: clock.now().getTime(),
    lastError: null,
    lastStatusCode: null,
  };
  outbox.rows.push(row);
  return row;
}

function worker(): ReturnType<typeof createWebhookDeliveryPass> {
  const deps: WebhookDeliveryDependencies = {
    outbox,
    readRun: (workspaceId, runId) =>
      Promise.resolve(
        run !== null && run.workspaceId === workspaceId && run.id === runId ? run : null,
      ),
    secrets: { read: () => readSecret() },
    lease: {
      tryAcquire: () => {
        if (leaseHeld) return Promise.resolve(null);
        leaseHeld = true;
        return Promise.resolve({
          release: () => {
            leaseHeld = false;
            return Promise.resolve();
          },
        });
      },
    },
    clock,
    random: () => 0.5,
    egressPolicy: () => ({ production: false, allowHosts: [] }),
    transport: (input, init) => {
      fetched.push(input instanceof Request ? input.url : input.toString());
      return fetch(input, init);
    },
  };
  return createWebhookDeliveryPass(deps);
}

/** Verify a delivery the way a Standard Webhooks receiver does, independently of `signature.ts`. */
function verifies(delivery: Received, key: string): boolean {
  const id = String(delivery.headers[WEBHOOK_SIGNATURE_HEADERS.id]);
  const timestamp = String(delivery.headers[WEBHOOK_SIGNATURE_HEADERS.timestamp]);
  const expected = createHmac('sha256', Buffer.from(key.slice('whsec_'.length), 'base64'))
    .update(webhookSignedContent(id, timestamp, delivery.body))
    .digest();
  return String(delivery.headers[WEBHOOK_SIGNATURE_HEADERS.signature])
    .split(' ')
    .some((entry) => {
      const [version, signature] = entry.split(',');
      const given = Buffer.from(signature ?? '', 'base64');
      return (
        version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
}

describe('a receiver that answers 500, then 200', () => {
  it('gets the same webhook-id again only after the backoff, and never again once it answered 200', async () => {
    const row = enqueue();
    const pass = worker();
    answers.push(500);

    expect(await pass()).toMatchObject({ claimed: 1, retried: 1 });
    expect(received).toHaveLength(1);
    expect(row).toMatchObject({ state: 'pending', attempts: 1, lastStatusCode: 500 });
    expect(row.lastError).toBe('http_500');

    // Before the 30 s backoff (jitter 1.0 at a draw of 0.5) nothing is due.
    clock.advance(29_000);
    expect(await pass()).toMatchObject({ claimed: 0 });
    expect(received).toHaveLength(1);

    clock.advance(1_000);
    answers.push(200);
    expect(await pass()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(received).toHaveLength(2);
    expect(received[1]?.headers['webhook-id']).toBe(DELIVERY_ID);
    expect(received[0]?.headers['webhook-id']).toBe(DELIVERY_ID);
    expect(row).toMatchObject({ state: 'delivered', attempts: 2, lastStatusCode: 200 });

    // Further passes, and a second worker running concurrently, send nothing more.
    clock.advance(48 * 3_600_000);
    const second = worker();
    await Promise.all([pass(), second(), pass()]);
    expect(received).toHaveLength(2);
  });

  it('is sent once when two workers pass at the same time', async () => {
    enqueue();
    const outcomes = await Promise.all([worker()(), worker()()]);
    expect(received).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== null && outcome.delivered === 1)).toHaveLength(
      1,
    );
  });

  it('stores a code as the last error, never the receiver text or the URL', async () => {
    const row = enqueue();
    answers.push(503);
    await worker()();
    expect(row.lastError).toBe('http_503');
  });
});

describe('the signature', () => {
  it('verifies with the contract scheme and the secret, and fails with a wrong secret', async () => {
    enqueue();
    const key = secret ?? '';
    await worker()();
    const [delivery] = received;
    if (delivery === undefined) throw new Error('nothing was received');
    expect(delivery.headers['content-type']).toBe('application/json');
    expect(Number(delivery.headers['webhook-timestamp'])).toBe(
      Math.floor(clock.now().getTime() / 1000),
    );
    expect(verifies(delivery, key)).toBe(true);
    expect(verifies(delivery, mintWebhookSecret())).toBe(false);
    expect(verifies({ ...delivery, body: `${delivery.body} ` }, key)).toBe(false);
    const event = WebhookEventSchema.parse(JSON.parse(delivery.body));
    expect(event).toMatchObject({ id: DELIVERY_ID, type: 'run.completed' });
    expect(delivery.body).not.toContain('secret answer');
  });
});

describe('the egress policy', () => {
  it('never fetches a refused URL, and fails it once the attempts run out', async () => {
    const row = enqueue('https://169.254.169.254/latest/meta-data');
    const pass = worker();
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      expect(await pass()).toMatchObject({ claimed: 1 });
      expect(row.lastError).toBe('egress_refused');
      clock.advance(24 * 3_600_000);
    }
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(fetched).toEqual([]);
    expect(await pass()).toMatchObject({ claimed: 0 });
  });

  it('refuses a plain-http receiver under the production posture', async () => {
    const row = enqueue();
    const pass = createWebhookDeliveryPass({
      outbox,
      readRun: () => Promise.resolve(run),
      secrets: { read: () => Promise.resolve(secret) },
      lease: { tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }) },
      clock,
      egressPolicy: () => ({ production: true, allowHosts: [] }),
    });
    await pass();
    expect(received).toEqual([]);
    expect(row).toMatchObject({ state: 'pending', lastError: 'egress_refused' });
  });
});

describe('the attempt', () => {
  it('waits for accounting without spending an attempt, then sends what it has after two minutes', async () => {
    run = finishedRun({ accountingState: 'pending' });
    const row = enqueue();
    const pass = worker();
    expect(await pass()).toMatchObject({ claimed: 1, deferred: 1 });
    expect(row).toMatchObject({ attempts: 0, state: 'pending' });
    expect(received).toEqual([]);

    clock.advance(WEBHOOK_ACCOUNTING_WAIT_MS);
    expect(await pass()).toMatchObject({ delivered: 1 });
    expect(row.attempts).toBe(1);
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
      data: { run: { accountingState: 'pending' } },
    });
  });

  it('sends final numbers as soon as accounting settles', async () => {
    run = finishedRun({ accountingState: 'pending' });
    enqueue();
    const pass = worker();
    await pass();
    run = finishedRun({ accountingState: 'complete' });
    clock.advance(10_000);
    expect(await pass()).toMatchObject({ delivered: 1 });
  });

  it('counts a missing signing secret as a failed attempt', async () => {
    secret = null;
    const row = enqueue();
    expect(await worker()()).toMatchObject({ retried: 1 });
    expect(row).toMatchObject({ attempts: 1, lastError: 'signing_secret_missing' });
    expect(received).toEqual([]);
  });

  it.each([
    ['a secrets read that throws', () => Promise.reject(new Error('secrets service is down'))],
    ['an empty signing secret', () => Promise.resolve('whsec_')],
  ] as const)(
    'settles %s as a failed attempt, and fails the delivery once the attempts run out',
    async (_case, read) => {
      readSecret = read;
      const row = enqueue();
      const pass = worker();
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        expect(await pass()).toMatchObject({ claimed: 1 });
        expect(row).toMatchObject({ attempts: attempt, lastError: 'internal_error' });
        clock.advance(24 * 3_600_000);
      }
      expect(row).toMatchObject({ state: 'failed', attempts: WEBHOOK_MAX_ATTEMPTS });
      expect(await pass()).toMatchObject({ claimed: 0 });
      expect(received).toEqual([]);
    },
  );

  it('fails a malformed run instead of claiming it forever', async () => {
    const row = enqueue();
    const pass = createWebhookDeliveryPass({
      outbox,
      readRun: () => Promise.reject(new Error('the stored run does not parse')),
      secrets: { read: () => Promise.resolve(secret) },
      lease: { tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }) },
      clock,
      random: () => 0.5,
    });
    expect(await pass()).toMatchObject({ claimed: 1, retried: 1 });
    expect(row).toMatchObject({ state: 'pending', attempts: 1, lastError: 'internal_error' });
  });

  it('settles a row whose earlier claims lapsed unsettled once it has used every attempt', async () => {
    const row = enqueue();
    row.attempts = WEBHOOK_MAX_ATTEMPTS;
    expect(await worker()()).toMatchObject({ claimed: 0 });
    expect(row).toMatchObject({ state: 'failed', lastError: 'attempts_exhausted' });
    expect(received).toEqual([]);
  });

  it('fails a delivery whose run is gone', async () => {
    run = null;
    const row = enqueue();
    expect(await worker()()).toMatchObject({ failed: 1 });
    expect(row).toMatchObject({ state: 'failed', lastError: 'run_not_found' });
  });

  it('does nothing while another replica holds the lease', async () => {
    enqueue();
    leaseHeld = true;
    expect(await worker()()).toBeNull();
    expect(received).toEqual([]);
  });
});
