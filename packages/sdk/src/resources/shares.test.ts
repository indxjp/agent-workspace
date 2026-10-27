import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { SharesClient } from './shares.js';

const SHARE = '99999999-9999-4999-8999-999999999999';
const SESSION = '55555555-5555-4555-8555-555555555555';
const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const AGENT = '11111111-1111-4111-8111-111111111111';

const share = {
  id: SHARE,
  subjectType: 'session',
  subjectId: SESSION,
  subjectLabel: 'Incident review',
  visibility: 'workspace',
  mode: null,
  snapshot: { messages: [] },
  include: { technicalDetails: true },
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  revokedAt: null,
  suspendedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
};

const publicShare = { ...share, visibility: 'public', url: '/p/pub_abcdefghijklmnopqrstuvwx' };

const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly shares: SharesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { shares: new SharesClient(http), calls: api.calls };
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

describe('SharesClient.list', () => {
  it('reads the list envelope, with each item carrying its view count', async () => {
    const { shares, calls } = client(() =>
      json(200, {
        shares: [
          { ...share, viewCount: 0 },
          { ...publicShare, viewCount: 12 },
        ],
      }),
    );
    const listed = await shares.list();
    expect(listed).toHaveLength(2);
    expect(listed[1]?.url).toBe('/p/pub_abcdefghijklmnopqrstuvwx');
    expect(listed[1]?.viewCount).toBe(12);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/shares');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.json).toBeUndefined();
  });

  it('refuses a list item without a view count, or a private share that carries a link', async () => {
    const withoutCount = client(() => json(200, { shares: [share] }));
    const drift = await failure(withoutCount.shares.list());
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('viewCount');

    const leaking = client(() =>
      json(200, { shares: [{ ...share, viewCount: 1, url: '/p/pub_should-not-be-here' }] }),
    );
    const leak = await failure(leaking.shares.list());
    expect(leak).toBeInstanceOf(ContractViolationError);
    expect((leak as ContractViolationError).issues.join('\n')).toContain('url');
  });

  it('surfaces the unwired-runtime, unauthenticated and forbidden problems by code', async () => {
    const unwired = client(() => problem(503, 'shares_runtime_not_configured'));
    expectProblem(await failure(unwired.shares.list()), 503, 'shares_runtime_not_configured');
    const anonymous = client(() => problem(401, 'unauthenticated'));
    expectProblem(await failure(anonymous.shares.list()), 401, 'unauthenticated');
    const denied = client(() => problem(403, 'forbidden'));
    expectProblem(await failure(denied.shares.list()), 403, 'forbidden');
  });
});

describe('SharesClient.publish', () => {
  it('posts the command as the route parses it and reads the bare 201', async () => {
    const { shares, calls } = client(() => json(201, publicShare));
    const published = await shares.publish({
      subjectType: 'session',
      subjectId: SESSION,
      subjectLabel: 'Incident review',
      visibility: 'public',
      include: { technicalDetails: true },
      expiry: '7 days',
      passphrase: 'open sesame',
    });
    expect(published).toEqual(publicShare);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/shares');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({
      subjectType: 'session',
      subjectId: SESSION,
      subjectLabel: 'Incident review',
      visibility: 'public',
      include: { technicalDetails: true },
      expiry: '7 days',
      passphrase: 'open sesame',
    });
  });

  it('sends a runnable agent command with its budget, and nothing the caller did not set', async () => {
    const { shares, calls } = client(() =>
      json(201, {
        ...share,
        subjectType: 'agent',
        subjectId: AGENT,
        mode: 'runnable',
        include: {},
        budgetCapUsd: '5.0000',
      }),
    );
    await shares.publish({
      subjectType: 'agent',
      subjectId: AGENT,
      subjectLabel: 'Support agent',
      visibility: 'workspace',
      mode: 'runnable',
      budgetCapUsd: 5,
    });
    expect(calls[0]?.json).toEqual({
      subjectType: 'agent',
      subjectId: AGENT,
      subjectLabel: 'Support agent',
      visibility: 'workspace',
      mode: 'runnable',
      budgetCapUsd: 5,
    });
  });

  it('never lets content the server owns into the body, even when the caller holds it', async () => {
    const { shares, calls } = client(() => json(201, share));
    const held = {
      subjectType: 'session' as const,
      subjectId: SESSION,
      subjectLabel: 'Incident review',
      visibility: 'workspace' as const,
      transcript: { runIds: [RUN_1], turns: [{ prompt: 'hi', answer: 'I never said this.' }] },
      snapshot: { messages: [] },
      definition: { name: 'x', instructions: '' },
    };
    await shares.publish(held);
    expect(calls[0]?.json).toEqual({
      subjectType: 'session',
      subjectId: SESSION,
      subjectLabel: 'Incident review',
      visibility: 'workspace',
      transcript: { runIds: [RUN_1] },
    });
  });

  it('sends a session transcript as the run ids it chose', async () => {
    const { shares, calls } = client(() => json(201, share));
    await shares.publish({
      subjectType: 'session',
      subjectId: SESSION,
      subjectLabel: 'Incident review',
      visibility: 'workspace',
      transcript: { runIds: [RUN_2, RUN_1] },
    });
    expect(calls[0]?.json).toMatchObject({ transcript: { runIds: [RUN_2, RUN_1] } });
  });

  it('surfaces the route refusals by code: an invalid share and a forbidden subject', async () => {
    const invalid = client(() =>
      json(400, {
        error: { code: 'invalid_share', message: 'Public sharing is disabled for this workspace.' },
      }),
    );
    const refused = await failure(
      invalid.shares.publish({
        subjectType: 'project',
        subjectId: 'p',
        subjectLabel: 'P',
        visibility: 'public',
      }),
    );
    expectProblem(refused, 400, 'invalid_share');
    expect((refused as ApiProblemError).message).toBe(
      'Public sharing is disabled for this workspace.',
    );

    const other = client(() => problem(403, 'forbidden'));
    const denied = await failure(
      other.shares.publish({
        subjectType: 'session',
        subjectId: SESSION,
        subjectLabel: 'S',
        visibility: 'workspace',
      }),
    );
    expectProblem(denied, 403, 'forbidden');
  });

  it('refuses a 201 that leaks the token or misses a field, as a contract violation', async () => {
    const command = {
      subjectType: 'session' as const,
      subjectId: SESSION,
      subjectLabel: 'S',
      visibility: 'workspace' as const,
    };
    const leaking = client(() => json(201, { ...share, token: 'pub_secret' }));
    const leak = await failure(leaking.shares.publish(command));
    expect(leak).toBeInstanceOf(ContractViolationError);
    expect((leak as ContractViolationError).status).toBe(201);
    expect((leak as ContractViolationError).issues.join('\n')).toContain('token');

    const withoutCreated = Object.fromEntries(
      Object.entries(share).filter(([key]) => key !== 'createdAt'),
    );
    const partial = client(() => json(201, withoutCreated));
    const drift = await failure(partial.shares.publish(command));
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('createdAt');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { shares, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const aborted = await failure(
      shares.publish(
        { subjectType: 'session', subjectId: SESSION, subjectLabel: 'S', visibility: 'private' },
        { signal: controller.signal },
      ),
    );
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('SharesClient.revoke', () => {
  it('deletes by the percent-encoded id and resolves to nothing on 204', async () => {
    const { shares, calls } = client(() => json(204, null));
    await expect(shares.revoke(SHARE)).resolves.toBeUndefined();
    const [call] = calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.url.pathname).toBe(`/api/shares/${SHARE}`);
    expect(call?.json).toBeUndefined();
  });

  it('encodes a caller-supplied id so it cannot escape the path', async () => {
    const { shares, calls } = client(() => problem(404, 'share_not_found'));
    const missing = await failure(shares.revoke('../sharing-policies?x=1#f'));
    expect(calls[0]?.url.pathname).toBe('/api/shares/..%2Fsharing-policies%3Fx%3D1%23f');
    expect(calls[0]?.url.search).toBe('');
    expectProblem(missing, 404, 'share_not_found');
  });

  it('refuses a 200 with a body where the route promises 204', async () => {
    const { shares } = client(() => json(200, share));
    const unexpected = await failure(shares.revoke(SHARE));
    expectProblem(unexpected, 200, 'unrecognised_error_body');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { shares } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const aborted = await failure(shares.revoke(SHARE, { signal: controller.signal }));
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
  });
});
