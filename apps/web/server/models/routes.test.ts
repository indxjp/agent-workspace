import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/model-connections/[id]/route';
import { POST as ROTATE } from '../../app/api/model-connections/[id]/credential/route';
import { POST as TEST } from '../../app/api/model-connections/[id]/test/route';
import { GET as LIST_CONNECTIONS, POST as CREATE } from '../../app/api/model-connections/route';
import { GET as LIST } from '../../app/api/models/route';
import { installModelsApi } from '../composition/services';
import { createInMemoryModelsStoreProvider } from './memory-store';
import { clearModelsRuntime, configureModelsRuntime, type ModelsAuditEvent } from './runtime';
import type { Role } from '../rbac/roles';
import { Principal } from '../rbac/principal';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const API_KEY = 'Provider-Key-Must-Never-Escape';
const ROTATED_KEY = 'Provider-Key-Must-Never-Escape-Rotated';
type RouteContext = { params: Promise<{ id: string }> };

function request(url: string, method = 'GET', body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function text(response: Response): Promise<string> {
  return response.status === 204 ? '' : response.text();
}

describe('model connections HTTP surface', () => {
  const audits: ModelsAuditEvent[] = [];
  const logs: string[] = [];

  beforeEach(() => {
    audits.length = 0;
    logs.length = 0;
    configureModelsRuntime({
      resolveActor: () =>
        Promise.resolve({
          kind: 'workspace',
          workspaceId: WORKSPACE_ID,
          principalId: '99999999-9999-4999-8999-999999999999',
          userId: '22222222-2222-4222-8222-222222222222',
          userLabel: 'Operator',
          role: 'owner',
          scope: null,
        }),
      models: createInMemoryModelsStoreProvider([WORKSPACE_ID]),
      probe: (resolved) => {
        expect([API_KEY, ROTATED_KEY]).toContain(resolved.credential);
        return Promise.resolve({
          ok: true,
          status: 200,
          latencyMs: 1,
          message: 'Connection succeeded.',
        });
      },
      // This suite is about the connection CRUD surface, not discovery — `discovery.test.ts` owns
      // that. A fixed, empty answer keeps `GET /api/models` from making a real network call.
      discover: (resolved) => {
        expect([API_KEY, ROTATED_KEY]).toContain(resolved.credential);
        return Promise.resolve({ ok: true, models: [], stale: false });
      },
      audit: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
      log: (message) => logs.push(message),
    });
  });

  afterEach(clearModelsRuntime);

  it('never returns or records a provider key across create/list/get/update/test/rotate/delete', async () => {
    const responses: string[] = [];
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Claude',
        provider: 'anthropic',
        apiKey: API_KEY,
        config: {},
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      hasCredential: boolean;
      ready: boolean;
    };
    expect(createdBody.hasCredential).toBe(true);
    expect(createdBody.ready).toBe(true);
    responses.push(JSON.stringify(createdBody));
    const context: RouteContext = { params: Promise.resolve({ id: createdBody.id }) };

    const listed = await LIST(request('http://web/api/models'));
    expect(listed.status).toBe(200);
    responses.push(await text(listed));

    const fetched = await GET_ONE(
      request(`http://web/api/model-connections/${createdBody.id}`),
      context,
    );
    expect(fetched.status).toBe(200);
    responses.push(await text(fetched));

    const refusedProviderChange = await PATCH(
      request(`http://web/api/model-connections/${createdBody.id}`, 'PATCH', {
        provider: 'openai',
      }),
      context,
    );
    expect(refusedProviderChange.status).toBe(400);
    responses.push(await text(refusedProviderChange));

    const updated = await PATCH(
      request(`http://web/api/model-connections/${createdBody.id}`, 'PATCH', {
        name: 'Claude primary',
      }),
      context,
    );
    expect(updated.status).toBe(200);
    responses.push(await text(updated));

    const tested = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(tested.status).toBe(200);
    responses.push(await text(tested));

    const rotated = await ROTATE(
      request(`http://web/api/model-connections/${createdBody.id}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
      }),
      context,
    );
    expect(rotated.status).toBe(204);
    responses.push(await text(rotated));

    const testedAfterRotation = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(testedAfterRotation.status).toBe(200);
    responses.push(await text(testedAfterRotation));

    const deleted = await DELETE(
      request(`http://web/api/model-connections/${createdBody.id}`, 'DELETE'),
      context,
    );
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      deleted: boolean;
      referencedBy: readonly unknown[];
    };
    expect(deletedBody).toEqual({ deleted: true, referencedBy: [] });
    responses.push(JSON.stringify(deletedBody));

    for (const key of [API_KEY, ROTATED_KEY]) {
      const sensitive = key.toLowerCase();
      for (const body of responses) expect(body.toLowerCase()).not.toContain(sensitive);
      expect(JSON.stringify(audits).toLowerCase()).not.toContain(sensitive);
      expect(JSON.stringify(logs).toLowerCase()).not.toContain(sensitive);
    }
    // create, update, test, rotate, test-again, delete.
    expect(audits).toHaveLength(6);
  });

  it('rejects an unknown field on the rotation route without touching the stored credential', async () => {
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Rotation guard',
        provider: 'openai',
        apiKey: API_KEY,
        config: {},
      }),
    );
    const createdBody = (await created.json()) as { id: string };
    const context: RouteContext = { params: Promise.resolve({ id: createdBody.id }) };

    const rejected = await ROTATE(
      request(`http://web/api/model-connections/${createdBody.id}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
        extra: 'nope',
      }),
      context,
    );
    expect(rejected.status).toBe(400);

    const tested = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(tested.status).toBe(200);
  });

  it('reports 404 for a rotation targeting a connection that does not exist', async () => {
    const missingId = '99999999-9999-4999-8999-999999999999';
    const context: RouteContext = { params: Promise.resolve({ id: missingId }) };
    const response = await ROTATE(
      request(`http://web/api/model-connections/${missingId}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
      }),
      context,
    );
    expect(response.status).toBe(404);
  });

  it('lists connections (names, provider, readiness) at GET /api/model-connections — issue #130', async () => {
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Claude for the selector',
        provider: 'anthropic',
        apiKey: API_KEY,
        config: {},
      }),
    );
    const createdBody = (await created.json()) as { id: string };

    const listed = await LIST_CONNECTIONS(request('http://web/api/model-connections'));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      models: readonly { id: string; name: string; provider: string; ready: boolean }[];
    };
    const row = listedBody.models.find((entry) => entry.id === createdBody.id);
    expect(row).toMatchObject({
      name: 'Claude for the selector',
      provider: 'anthropic',
      ready: true,
    });
    expect(JSON.stringify(listedBody).toLowerCase()).not.toContain(API_KEY.toLowerCase());
  });

  it('leaves the surface positively unavailable until the encrypted store is configured', async () => {
    clearModelsRuntime();
    const response = await LIST(request('http://web/api/models'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'models_runtime_not_configured' },
    });
  });

  it('the production encrypted service refuses startup without MASTER_ENCRYPTION_KEY', async () => {
    const { createSecretsService } = await import('@agent-workspace/core/secrets');
    await expect(
      createSecretsService({ DATABASE_URL: 'postgres://never-contacted.invalid/db' }),
    ).rejects.toThrow(/MASTER_ENCRYPTION_KEY/);
  });
});

/**
 * Issue #149: `/api/model-connections*` authorised by membership alone, so a Viewer or Builder
 * could edit, delete and rotate provider credentials. Every write route now reaches `decide()`
 * (`server/rbac/decide.ts`, read-only import — this task edits nothing under `server/rbac/**`,
 * which is W9-WS-119's this wave) with the acting membership's role, on the four-role matrix the
 * agents and files route suites already use for the same reason.
 *
 * The fixture below reads role and workspace id from headers **only in this test file** — a real
 * `resolveActor` (`server/composition/services.ts`) never does, and never has: it reads a verified
 * session cookie. What this buys the assertions below is the same thing it buys the agents suite's
 * equivalent fixture: full attacker control of the one input `decide()` acts on, so a test that
 * finds Builder and Viewer refused here is not an accident of which role happened to be wired up.
 */
describe('model connections write authorisation — issue #149', () => {
  const ROLE_HEADER = 'x-test-role';
  const WORKSPACE_HEADER = 'x-test-workspace';
  const WORKSPACE_A = WORKSPACE_ID;
  const WORKSPACE_B = '33333333-3333-4333-8333-333333333333';
  const ROLES = ['owner', 'admin', 'builder', 'viewer'] as const satisfies readonly Role[];
  const ALLOWED: ReadonlySet<Role> = new Set(['owner', 'admin']);

  function roleRequest(
    url: string,
    method: string,
    role: Role,
    options: { body?: unknown; workspace?: string } = {},
  ): Request {
    const headers = new Headers({
      [ROLE_HEADER]: role,
      [WORKSPACE_HEADER]: options.workspace ?? WORKSPACE_A,
    });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  let connectionId = '';

  beforeEach(async () => {
    configureModelsRuntime({
      // Deliberately not a `resolveWorkspace` + `identifyActor` pair, unlike the composition
      // root's real one: this suite is about what `withModelsRuntime` does with the role once it
      // has one, not about how a role is discovered, and `agents/routes.test.ts`'s own fixture
      // makes the same simplification for the same reason.
      resolveActor: (request) => {
        const role = request.headers.get(ROLE_HEADER);
        if (role === null) {
          return Promise.resolve({ kind: 'unauthenticated', reason: 'no test role header' });
        }
        return Promise.resolve({
          kind: 'workspace',
          workspaceId: request.headers.get(WORKSPACE_HEADER) ?? WORKSPACE_A,
          principalId: '99999999-9999-4999-8999-999999999999',
          userId: '44444444-4444-4444-8444-444444444444',
          userLabel: 'Matrix operator',
          role: role as Role,
          scope: null,
        });
      },
      models: createInMemoryModelsStoreProvider([WORKSPACE_A, WORKSPACE_B]),
      probe: () =>
        Promise.resolve({ ok: true, status: 200, latencyMs: 1, message: 'Connection succeeded.' }),
      discover: () => Promise.resolve({ ok: true, models: [], stale: false }),
      audit: () => Promise.resolve(),
      log: () => undefined,
    });
    const created = await CREATE(
      roleRequest('http://web/api/model-connections', 'POST', 'owner', {
        body: { name: 'Matrix fixture', provider: 'anthropic', apiKey: API_KEY, config: {} },
      }),
    );
    connectionId = ((await created.json()) as { id: string }).id;
  });

  afterEach(clearModelsRuntime);

  it.each(ROLES)(
    'POST /api/model-connections refuses %s unless the role manages the resource',
    async (role) => {
      const response = await CREATE(
        roleRequest('http://web/api/model-connections', 'POST', role, {
          body: { name: `Created by ${role}`, provider: 'anthropic', apiKey: API_KEY, config: {} },
        }),
      );
      expect(response.status).toBe(ALLOWED.has(role) ? 201 : 403);
    },
  );

  it.each(ROLES)(
    'PATCH /api/model-connections/:id refuses %s unless the role manages the resource',
    async (role) => {
      const context: RouteContext = { params: Promise.resolve({ id: connectionId }) };
      const response = await PATCH(
        roleRequest(`http://web/api/model-connections/${connectionId}`, 'PATCH', role, {
          body: { name: `Renamed by ${role}` },
        }),
        context,
      );
      expect(response.status).toBe(ALLOWED.has(role) ? 200 : 403);
    },
  );

  it.each(ROLES)(
    'POST /api/model-connections/:id/credential refuses %s unless the role manages the resource',
    async (role) => {
      const context: RouteContext = { params: Promise.resolve({ id: connectionId }) };
      const response = await ROTATE(
        roleRequest(`http://web/api/model-connections/${connectionId}/credential`, 'POST', role, {
          body: { apiKey: `rotated-by-${role}` },
        }),
        context,
      );
      expect(response.status).toBe(ALLOWED.has(role) ? 204 : 403);
    },
  );

  it.each(ROLES)(
    'POST /api/model-connections/:id/test refuses %s unless the role manages the resource',
    async (role) => {
      const context: RouteContext = { params: Promise.resolve({ id: connectionId }) };
      const response = await TEST(
        roleRequest(`http://web/api/model-connections/${connectionId}/test`, 'POST', role),
        context,
      );
      expect(response.status).toBe(ALLOWED.has(role) ? 200 : 403);
    },
  );

  it.each(ROLES)(
    'DELETE /api/model-connections/:id refuses %s unless the role manages the resource',
    async (role) => {
      // Its own connection per role, never the shared fixture: an allowed role actually deletes the
      // row, and reusing one row across this matrix would make a later iteration's 404 look like a
      // second refusal instead of what it is — the row already being gone.
      const created = await CREATE(
        roleRequest('http://web/api/model-connections', 'POST', 'owner', {
          body: {
            name: `To delete as ${role}`,
            provider: 'anthropic',
            apiKey: API_KEY,
            config: {},
          },
        }),
      );
      const { id } = (await created.json()) as { id: string };
      const context: RouteContext = { params: Promise.resolve({ id }) };
      const response = await DELETE(
        roleRequest(`http://web/api/model-connections/${id}`, 'DELETE', role),
        context,
      );
      expect(response.status).toBe(ALLOWED.has(role) ? 200 : 403);
    },
  );

  it('answers 500 authorisation_undecidable, never a silent allow, for a role decide() cannot classify', async () => {
    // The `refuse` branch (`server/models/http.ts`): `decide()` returns it for a role
    // `parseRole` does not accept — unreachable in production through these routes (a
    // `WorkspaceMembership.role` is always one of the four), but round 1 verification (finding 4)
    // found no test exercised it, so a mutation collapsing `refuse` into `run` survived every
    // suite. This asserts the mapping directly.
    const response = await CREATE(
      roleRequest('http://web/api/model-connections', 'POST', 'superuser' as Role, {
        body: { name: 'Unclassified role', provider: 'anthropic', apiKey: API_KEY, config: {} },
      }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authorisation_undecidable');
  });

  it('conceals workspace A’s connection from workspace B’s Owner exactly like a nonexistent id, and refuses a Viewer of A identically for both', async () => {
    const randomId = '99999999-9999-4999-8999-999999999999';

    const asForeignOwner = (id: string): Promise<Response> =>
      PATCH(
        roleRequest(`http://web/api/model-connections/${id}`, 'PATCH', 'owner', {
          body: { name: 'renamed from workspace B' },
          workspace: WORKSPACE_B,
        }),
        { params: Promise.resolve({ id }) },
      );
    const foreignReal = await asForeignOwner(connectionId);
    const foreignRandom = await asForeignOwner(randomId);
    expect(foreignReal.status).toBe(foreignRandom.status);
    expect(await foreignReal.text()).toBe(await foreignRandom.text());

    const asViewerOfA = (id: string): Promise<Response> =>
      PATCH(
        roleRequest(`http://web/api/model-connections/${id}`, 'PATCH', 'viewer', {
          body: { name: 'renamed by a viewer' },
        }),
        { params: Promise.resolve({ id }) },
      );
    const viewerReal = await asViewerOfA(connectionId);
    const viewerRandom = await asViewerOfA(randomId);
    expect(viewerReal.status).toBe(viewerRandom.status);
    expect(await viewerReal.text()).toBe(await viewerRandom.text());
  });
});

/**
 * Round 1 verification (finding 3): every test above drives the write gate through
 * `configureModelsRuntime` with its own `resolveActor` fixture, so a mutation hard-coding
 * `installModelsApi`'s `role: actor.role` (`server/composition/services.ts`) to `'owner'` — the
 * one line the composition root contributes to issue #149's fix — survived every suite in the
 * repository. This drives the real `installModelsApi`, with only `resolveWorkspace` and
 * `identifyActor` stubbed (the session-cookie and PostgreSQL membership lookup it normally wires
 * at `apps/web/server/composition/register.ts`), through the real `withModelsRuntime` write gate.
 */
describe('installModelsApi composition root — issue #149', () => {
  afterEach(clearModelsRuntime);

  it.each(['viewer', 'builder'] as const satisfies readonly Role[])(
    "carries a %s membership's role into the write gate rather than a hard-coded one",
    async (role) => {
      const principal = Principal.fromApiKey({
        principalId: '99999999-9999-4999-8999-999999999999',
        apiKeyId: '77777777-7777-4777-8777-777777777777',
        label: 'Composition-root probe',
        workspaceId: '88888888-8888-4888-8888-888888888888',
        role,
      });
      const installed = await installModelsApi(
        () => Promise.resolve({ kind: 'workspace', workspaceId: principal.workspaceId }),
        () => Promise.resolve(principal),
        {} as unknown as DatabaseRoot,
        {} as unknown as SecretsService,
      );
      expect(installed).not.toBeNull();

      const response = await CREATE(
        request('http://web/api/model-connections', 'POST', {
          name: 'Composition-root probe',
          provider: 'anthropic',
          apiKey: API_KEY,
          config: {},
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    },
  );
});
