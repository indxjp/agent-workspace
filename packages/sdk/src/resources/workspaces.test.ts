import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { WorkspacesClient } from './workspaces.js';

const problem = (status: number, code: string) => json(status, { error: { code, message: code } });

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly workspaces: WorkspacesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/control',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { workspaces: new WorkspacesClient(http), calls: api.calls };
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

describe('WorkspacesClient.sharingPolicy.get', () => {
  it('reads the policy from the id-less route under the base path prefix', async () => {
    const { workspaces, calls } = client(() => json(200, { publicSharing: false }));
    const policy = await workspaces.sharingPolicy.get();
    expect(policy).toEqual({ publicSharing: false });
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/control/api/sharing-policies');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.json).toBeUndefined();
  });

  it('refuses a body that is not the one-field policy', async () => {
    const renamed = client(() => json(200, { publicSharingEnabled: true }));
    const drift = await failure(renamed.workspaces.sharingPolicy.get());
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('publicSharing');

    const widened = client(() => json(200, { publicSharing: true, runnableLinks: true }));
    expect(await failure(widened.workspaces.sharingPolicy.get())).toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('surfaces the unwired-runtime and unauthenticated problems by code', async () => {
    const unwired = client(() => problem(503, 'shares_runtime_not_configured'));
    expectProblem(
      await failure(unwired.workspaces.sharingPolicy.get()),
      503,
      'shares_runtime_not_configured',
    );
    const anonymous = client(() => problem(401, 'unauthenticated'));
    expectProblem(await failure(anonymous.workspaces.sharingPolicy.get()), 401, 'unauthenticated');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { workspaces } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const aborted = await failure(workspaces.sharingPolicy.get({ signal: controller.signal }));
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
  });
});

describe('WorkspacesClient.sharingPolicy.set', () => {
  it('patches exactly { publicSharing } and reads the echoed policy', async () => {
    const { workspaces, calls } = client(() => json(200, { publicSharing: true }));
    const policy = await workspaces.sharingPolicy.set({ publicSharing: true });
    expect(policy).toEqual({ publicSharing: true });
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.pathname).toBe('/control/api/sharing-policies');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ publicSharing: true });
  });

  it('sends only the one field the route accepts, even when the caller passes more', async () => {
    const { workspaces, calls } = client(() => json(200, { publicSharing: false }));
    const input = { publicSharing: false, reason: 'audit' };
    await workspaces.sharingPolicy.set(input);
    expect(calls[0]?.json).toEqual({ publicSharing: false });
  });

  it('surfaces the Owner-only refusal and the invalid-policy problem by code', async () => {
    const admin = client(() => problem(403, 'forbidden'));
    expectProblem(
      await failure(admin.workspaces.sharingPolicy.set({ publicSharing: true })),
      403,
      'forbidden',
    );
    const invalid = client(() => problem(400, 'invalid_policy'));
    expectProblem(
      await failure(invalid.workspaces.sharingPolicy.set({ publicSharing: true })),
      400,
      'invalid_policy',
    );
  });

  it('refuses a 200 whose body drifted from the policy', async () => {
    const { workspaces } = client(() => json(200, { publicSharing: 'on' }));
    const drift = await failure(workspaces.sharingPolicy.set({ publicSharing: true }));
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).status).toBe(200);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { workspaces, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const aborted = await failure(
      workspaces.sharingPolicy.set({ publicSharing: true }, { signal: controller.signal }),
    );
    expect(aborted).toBeInstanceOf(TransportError);
    expect((aborted as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

const WORKSPACE_VIEW = {
  id: 'ws-a',
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  role: 'owner',
};

describe('WorkspacesClient.select (issue #236, SDK-04, S-2)', () => {
  it('POSTs the JSON switch and returns the membership view', async () => {
    const { workspaces, calls } = client(() => json(200, { workspace: WORKSPACE_VIEW }));
    const selected = await workspaces.select('acme');
    expect(selected).toEqual(WORKSPACE_VIEW);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/control/api/auth/workspace');
    expect(call?.json).toEqual({ workspace: 'acme' });
  });

  it('surfaces the not-available problem by code, whether by id, by slug or unknown', async () => {
    const { workspaces } = client(() => problem(404, 'workspace_not_available'));
    expectProblem(
      await failure(workspaces.select('no-such-workspace')),
      404,
      'workspace_not_available',
    );
  });

  it('refuses a 200 whose body drifted from WorkspaceSwitchResponseSchema', async () => {
    const { workspaces } = client(() =>
      json(200, { workspace: { ...WORKSPACE_VIEW, role: undefined } }),
    );
    const drift = await failure(workspaces.select('acme'));
    expect(drift).toBeInstanceOf(ContractViolationError);
  });
});
