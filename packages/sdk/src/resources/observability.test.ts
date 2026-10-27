import { describe, expect, it } from 'vitest';

import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { AuditClient, MetricsClient, ObservabilityClient } from './observability.js';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';

const telemetry = {
  runId: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE,
  agentId: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  durationMs: 4000,
  costUsd: 0.001234,
};

const event = {
  id: '77777777-7777-4777-8777-777777777777',
  workspaceId: WORKSPACE,
  actorUserId: null,
  actorPrincipalId: '99999999-9999-4999-8999-999999999999',
  actorLabel: 'Ops key',
  action: 'api-key-created',
  subjectId: '66666666-6666-4666-8666-666666666666',
  subjectLabel: 'CI key',
  createdAt: '2026-09-21T10:00:00.000Z',
};

const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

function client(route: (request: RecordedRequest) => Response): {
  readonly observability: ObservabilityClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/prefix',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { observability: new ObservabilityClient(http), calls: api.calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectProblem(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(ApiProblemError);
  expect((error as ApiProblemError).status).toBe(status);
  expect((error as ApiProblemError).code).toBe(code);
}

describe('ObservabilityClient', () => {
  it('exposes one sub-client per route family', () => {
    const { observability } = client(() => json(200, {}));
    expect(observability.metrics).toBeInstanceOf(MetricsClient);
    expect(observability.audit).toBeInstanceOf(AuditClient);
  });
});

describe('MetricsClient.recentRuns', () => {
  it('reads the projection with the bearer, from the base path, and unwraps the envelope', async () => {
    const { observability, calls } = client(() => json(200, { runs: [telemetry] }));
    expect(await observability.metrics.recentRuns()).toEqual([telemetry]);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/prefix/api/metrics');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.json).toBeUndefined();
  });

  it('returns an empty list for a workspace this process has observed nothing for', async () => {
    const { observability } = client(() => json(200, { runs: [] }));
    expect(await observability.metrics.recentRuns()).toEqual([]);
  });

  it('surfaces the gate refusals by status and code', async () => {
    expectProblem(
      await failure(
        client(() => problem(401, 'unauthenticated')).observability.metrics.recentRuns(),
      ),
      401,
      'unauthenticated',
    );
    expectProblem(
      await failure(client(() => problem(403, 'forbidden')).observability.metrics.recentRuns()),
      403,
      'forbidden',
    );
    expectProblem(
      await failure(
        client(() =>
          problem(503, 'rbac_runtime_not_configured'),
        ).observability.metrics.recentRuns(),
      ),
      503,
      'rbac_runtime_not_configured',
    );
    expectProblem(
      await failure(
        client(() => problem(500, 'authorisation_undecidable')).observability.metrics.recentRuns(),
      ),
      500,
      'authorisation_undecidable',
    );
  });

  it('reads the code of a refusal from a deployment that still renders the `detail`-only envelope', async () => {
    // Before SDK unit 6 (#238) the rbac gate rendered `{ error: { code, detail } }`; the SDK still
    // maps that onto `message`, so the code survives an older deployment.
    const { observability } = client(() =>
      json(401, { error: { code: 'unauthenticated', detail: 'No credential.' } }),
    );
    const error = await failure(observability.metrics.recentRuns());
    expectProblem(error, 401, 'unauthenticated');
    expect((error as ApiProblemError).message).toBe('No credential.');
  });

  it('refuses a run whose cost is a decimal string, and a summary the route does not send', async () => {
    const stringCost = client(() => json(200, { runs: [{ ...telemetry, costUsd: '0.001234' }] }));
    const violation = await failure(stringCost.observability.metrics.recentRuns());
    expect(violation).toBeInstanceOf(ContractViolationError);
    expect((violation as ContractViolationError).issues[0]).toContain('runs.0.costUsd');
    const summarised = client(() => json(200, { runs: [], summary: { count: 0 } }));
    expect(await failure(summarised.observability.metrics.recentRuns())).toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { observability } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await failure(observability.metrics.recentRuns({ signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('AuditClient.list', () => {
  it('reads the newest rows with no query when no limit is given', async () => {
    const { observability, calls } = client(() => json(200, { events: [event], nextCursor: null }));
    expect(await observability.audit.list()).toEqual({ events: [event], nextCursor: null });
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/prefix/api/audit-events');
    expect(call?.url.search).toBe('');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.json).toBeUndefined();
  });

  it('[US-BLD-05][api][sdk] lists the agent-created row of a Builder save under the person', async () => {
    const created = {
      ...event,
      action: 'agent-created',
      actorLabel: 'Ada',
      builderRunId: 'run-1',
    };
    const { observability } = client(() =>
      json(200, { events: [created, event], nextCursor: null }),
    );
    const page = await observability.audit.list({ action: 'agent-created' });
    expect(page.events.map((row) => [row.action, row.actorLabel, row.builderRunId])).toEqual([
      ['agent-created', 'Ada', 'run-1'],
      ['api-key-created', 'Ops key', undefined],
    ]);
  });

  it('renders the limit and the cursor as the route spells them', async () => {
    const { observability, calls } = client(() => json(200, { events: [], nextCursor: null }));
    expect(await observability.audit.list({ limit: 25, cursor: 'c-1' })).toEqual({
      events: [],
      nextCursor: null,
    });
    expect(calls[0]?.url.pathname).toBe('/prefix/api/audit-events');
    expect(calls[0]?.url.search).toBe('?limit=25&cursor=c-1');
  });

  it('sends the action filter as a query param, on list and on every listAll page', async () => {
    const { observability, calls } = client(() => json(200, { events: [], nextCursor: null }));
    await observability.audit.list({ action: 'file-deleted' });
    for await (const row of observability.audit.listAll({ action: 'file-deleted' })) void row;
    expect(calls.map((call) => call.url.search)).toEqual([
      '?action=file-deleted',
      '?action=file-deleted',
    ]);
  });

  it('surfaces the route refusals by status and code', async () => {
    expectProblem(
      await failure(
        client(() => problem(400, 'invalid_limit')).observability.audit.list({ limit: 0 }),
      ),
      400,
      'invalid_limit',
    );
    expectProblem(
      await failure(client(() => problem(401, 'unauthenticated')).observability.audit.list()),
      401,
      'unauthenticated',
    );
    expectProblem(
      await failure(
        client(() => problem(503, 'audit_runtime_not_configured')).observability.audit.list(),
      ),
      503,
      'audit_runtime_not_configured',
    );
  });

  it('reads the owner-only refusal the route renders in the standard envelope', async () => {
    const { observability } = client(() =>
      json(403, {
        error: {
          code: 'forbidden',
          message: 'Your role cannot do this.',
          detail: 'Your role cannot do this.',
        },
      }),
    );
    const error = await failure(observability.audit.list());
    expectProblem(error, 403, 'forbidden');
    expect((error as ApiProblemError).message).toBe('Your role cannot do this.');
  });

  it('reads the code of a refusal from a deployment that still renders a bare `{ error: "<code>" }`', async () => {
    // Before SDK unit 6 (#238) `GET /api/audit-events` answered a string where the platform
    // envelope has an object; the SDK still reads the code from an older deployment.
    const { observability } = client(() => json(400, { error: 'invalid_limit' }));
    expectProblem(await failure(observability.audit.list({ limit: 501 })), 400, 'invalid_limit');
  });

  it('refuses a row with an action outside the recorded set, and a body that is not a page', async () => {
    const unknownAction = client(() =>
      json(200, { events: [{ ...event, action: 'secret-read' }], nextCursor: null }),
    );
    const violation = await failure(unknownAction.observability.audit.list());
    expect(violation).toBeInstanceOf(ContractViolationError);
    expect((violation as ContractViolationError).issues[0]).toContain('events.0.action');
    const paged = client(() => json(200, { items: [event], nextCursor: null }));
    expect(await failure(paged.observability.audit.list())).toBeInstanceOf(ContractViolationError);
    const cursorless = client(() => json(200, { events: [event] }));
    expect(await failure(cursorless.observability.audit.list())).toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { observability } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await failure(observability.audit.list({}, { signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});

describe('AuditClient.listAll', () => {
  const second = { ...event, id: '88888888-8888-4888-8888-888888888888' };

  it('walks limit=1 pages until nextCursor is null, sending each cursor back once', async () => {
    const pages: Readonly<Record<string, unknown>> = {
      '': { events: [event], nextCursor: 'c-2' },
      'c-2': { events: [second], nextCursor: 'c-3' },
      'c-3': { events: [], nextCursor: null },
    };
    const { observability, calls } = client((request) =>
      json(200, pages[request.url.searchParams.get('cursor') ?? '']),
    );
    const walked = [];
    for await (const row of observability.audit.listAll({ limit: 1 })) walked.push(row.id);
    expect(walked).toEqual([event.id, second.id]);
    expect(calls.map((call) => call.url.search)).toEqual([
      '?limit=1',
      '?limit=1&cursor=c-2',
      '?limit=1&cursor=c-3',
    ]);
    // Every page request carries the contracts version (ADR-0078), not only the first.
    for (const call of calls) {
      expect(call.headers.get(CONTRACTS_VERSION_HEADER)).toBe(CONTRACTS_VERSION);
    }
  });

  it('refuses a server that hands back a cursor it was already sent, instead of looping', async () => {
    const { observability } = client(() => json(200, { events: [event], nextCursor: 'same' }));
    const walked: string[] = [];
    const error = await failure(
      (async () => {
        for await (const row of observability.audit.listAll({ cursor: 'same' })) {
          walked.push(row.id);
        }
      })(),
    );
    expect(error).toBeInstanceOf(ContractViolationError);
    expect(walked).toEqual([event.id]);
  });

  it('surfaces a refused cursor as the route answered it', async () => {
    const { observability } = client(() => problem(400, 'invalid_cursor'));
    const error = await failure(
      (async () => {
        for await (const row of observability.audit.listAll({ cursor: 'foreign' })) void row;
      })(),
    );
    expectProblem(error, 400, 'invalid_cursor');
  });
});
