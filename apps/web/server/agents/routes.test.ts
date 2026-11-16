import { afterEach, describe, expect, it, vi } from 'vitest';
import { log as webLogger } from '../telemetry/logger';

import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '../../app/api/agents/[id]/route';
import { POST as createRoute, GET as listRoute } from '../../app/api/agents/route';
import type { AgentResource } from '../../contracts/agents';
import { applicationContext, clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createInMemoryAgentStoreProvider } from './memory-store';

import {
  bodyOf,
  CREATE_BODY,
  createIn,
  idContext,
  request,
  useMemoryRuntime,
  WORKSPACE_A,
  WORKSPACE_B,
} from './routes.fixture.test-support';
afterEach(() => {
  clearApplicationContext();
});

describe('the five agent routes serve real responses once a runtime is wired', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    // No `useMemoryRuntime()`. This is the deployed state of this branch, and it is asserted
    // rather than assumed, because every other assertion in this file depends on the wiring
    // being the thing that changes the answer.
    const response = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'agents_runtime_not_configured' },
    });
  });
});

describe('agent routes: creation', () => {
  it('creates an agent and returns it at 201', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/agents', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const agent = (await bodyOf(response)) as AgentResource;
    expect(agent.name).toBe('Support triage');
    expect(agent.workspaceId).toBe(WORKSPACE_A);
    expect(agent.model).toBe('claude-sonnet-4-5');
  });

  it('creates the agent and initial assignments through one compound request', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          agent: JSON.parse(CREATE_BODY) as unknown,
          assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
        }),
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agent: { name: 'Support triage' },
      assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
    });
  });

  it('leaves no agent row when an assignment names a skill the workspace does not have', async () => {
    // W2-3 (F-05): this answered `400 unknown-skill` after creating and then deleting the row, and
    // an agent that vanished inside its own create answered `500 not-found`. The row and the
    // assignment are now one store write, and the refusal is the caller's to correct.
    useMemoryRuntime();
    const runtime = applicationContext()?.agents ?? null;
    if (runtime === null) throw new Error('useMemoryRuntime installed no agents runtime.');
    installTestDomains({
      agents: {
        ...runtime,
        agents: createInMemoryAgentStoreProvider({ knownAssignableIds: new Set() }),
      },
    });
    const skillId = '55555555-5555-4555-8555-555555555555';
    const response = await createRoute(
      request('POST', '/api/agents', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          agent: JSON.parse(CREATE_BODY) as unknown,
          assignments: { files: [], skillIds: [skillId], connectorIds: [], storageGrants: [] },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'unknown_skill',
        message: 'An assigned skill is not in this workspace.',
        details: [skillId],
      },
    });
    const list = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
    expect(await list.json()).toEqual({ agents: [] });
  });
});

describe('agent routes: CRUD', () => {
  it('lists, reads, updates and deletes that agent through the real handlers', async () => {
    useMemoryRuntime();
    const agent = await createIn(WORKSPACE_A);

    const list = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    expect(await bodyOf(list)).toMatchObject({ agents: [{ id: agent.id }] });

    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}`, { workspace: WORKSPACE_A }),
      idContext(agent.id),
    );
    expect(read.status).toBe(200);
    expect((await bodyOf(read)) as AgentResource).toMatchObject({ id: agent.id });

    const patched = await patchRoute(
      request('PATCH', `/api/agents/${agent.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'Renamed' }),
      }),
      idContext(agent.id),
    );
    expect(patched.status).toBe(200);
    expect((await bodyOf(patched)) as AgentResource).toMatchObject({ name: 'Renamed' });

    const removed = await deleteRoute(
      request('DELETE', `/api/agents/${agent.id}`, { workspace: WORKSPACE_A }),
      idContext(agent.id),
    );
    expect(removed.status).toBe(204);
    expect(removed.headers.get('content-type')).toBeNull();

    const afterDelete = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
    expect(await bodyOf(afterDelete)).toEqual({ agents: [] });
  });
});

describe('agent routes: runtime switching and versioning', () => {
  it('answers 503 runtime_switch_audit_not_configured to a runtime switch with no audit sink', async () => {
    // W3-6: the sink is `null` (no runtimes API installed), not absent; the switch still refuses
    // before writing, and the agent keeps its runtime profile.
    useMemoryRuntime();
    expect(applicationContext()?.agents.runtimeSwitchAudit).toBeNull();
    const agent = await createIn(WORKSPACE_A);
    const response = await patchRoute(
      request('PATCH', `/api/agents/${agent.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ runtimeProfileId: '99999999-9999-4999-8999-999999999999' }),
      }),
      idContext(agent.id),
    );
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'runtime_switch_audit_not_configured' },
    });
    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}`, { workspace: WORKSPACE_A }),
      idContext(agent.id),
    );
    expect((await bodyOf(read)) as AgentResource).toMatchObject({ runtimeProfileId: null });
  });

  it('saves each PATCH as one ui version and points local at it (issue #616)', async () => {
    const versions = useMemoryRuntime();
    const agent = await createIn(WORKSPACE_A);
    const patch = (body: Record<string, unknown>): Promise<Response> =>
      patchRoute(
        request('PATCH', `/api/agents/${agent.id}`, {
          workspace: WORKSPACE_A,
          body: JSON.stringify(body),
        }),
        idContext(agent.id),
      );

    // The agent was created without a version: the first edit is version 1, built from the row.
    expect((await patch({ instructions: 'First edit.' })).status).toBe(200);
    const renamed = await patch({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect((await bodyOf(renamed)) as AgentResource).toMatchObject({
      name: 'Renamed',
      instructions: 'First edit.',
    });

    const listing = await (await versions.forWorkspace(WORKSPACE_A))?.list(agent.id);
    expect(listing?.versions.map(({ number, via, summary }) => [number, via, summary])).toEqual([
      [1, 'ui', 'Console edit: settings'],
      [2, 'ui', 'Console edit: settings'],
    ]);
    expect(listing?.pointers).toMatchObject([{ environment: 'local', number: 2 }]);
    expect(listing?.materialisedVersionId).toBe(listing?.versions[1]?.id);
    // The second edit landed on version 1's body, so it kept the first edit.
    expect(listing?.versions[1]?.body).toMatchObject({
      definition: { agent: { name: 'Renamed', instructions: 'First edit.' } },
    });
  });
});

describe('agent routes: tenant isolation', () => {
  it('does not let another workspace read, change or delete the row', async () => {
    useMemoryRuntime();
    const agent = await createIn(WORKSPACE_A);

    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}`, { workspace: WORKSPACE_B }),
      idContext(agent.id),
    );
    expect(read.status).toBe(404);
    // Not an existence oracle: the 404 must not carry A's data.
    expect(await read.text()).not.toContain('Support triage');

    const patched = await patchRoute(
      request('PATCH', `/api/agents/${agent.id}`, {
        workspace: WORKSPACE_B,
        body: JSON.stringify({ name: 'Taken over' }),
      }),
      idContext(agent.id),
    );
    expect(patched.status).toBe(404);

    const removed = await deleteRoute(
      request('DELETE', `/api/agents/${agent.id}`, { workspace: WORKSPACE_B }),
      idContext(agent.id),
    );
    expect(removed.status).toBe(404);

    expect(
      await bodyOf(await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_B }))),
    ).toEqual({ agents: [] });
    const stillThere = await getRoute(
      request('GET', `/api/agents/${agent.id}`, { workspace: WORKSPACE_A }),
      idContext(agent.id),
    );
    expect(stillThere.status).toBe(200);
    expect((await bodyOf(stillThere)) as AgentResource).toMatchObject({ name: 'Support triage' });
  });
});

describe('the workspace gate runs before the body is parsed', () => {
  it('answers 401 — not 400 — to an unauthenticated POST carrying a malformed body', async () => {
    useMemoryRuntime();
    // No workspace header, so the resolver reports `unauthenticated`; the body is nonsense. The
    // caller must learn that they are not authenticated, not that this route wanted JSON. Reading
    // the body first is what produced 400 here before, and it is the ordering W1-CP-06 inherits.
    const response = await createRoute(request('POST', '/api/agents', { body: 'not json at all' }));
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('answers 401 — not 400 — to an unauthenticated PATCH carrying a malformed body', async () => {
    useMemoryRuntime();
    const response = await patchRoute(
      request('PATCH', '/api/agents/whatever', { body: 'not json at all' }),
      idContext('whatever'),
    );
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('still reports a malformed body to a caller who did pass the gate', async () => {
    // The complement of the two above: moving the parse inside the gate must not stop it running.
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/agents', { workspace: WORKSPACE_A, body: 'not json at all' }),
    );
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'malformed_body' } });
  });
});

describe('agent routes enforce the shared role policy', () => {
  it('denies a Viewer before creating an agent', async () => {
    useMemoryRuntime('viewer');
    const response = await createRoute(
      request('POST', '/api/agents', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    expect(response.status).toBe(403);
  });

  it('a Builder may edit the agent it created, and no other Builder may (issue #117)', async () => {
    useMemoryRuntime('builder');
    const agent = await createIn(WORKSPACE_A, 'builder-a@example.test');

    // B2 did not create this row: `own` is denied, and `decide()` never sees a role wide enough
    // to substitute for it (Builder's grant on agents is `own`, not `any`).
    const deniedForOther = await patchRoute(
      request('PATCH', `/api/agents/${agent.id}`, {
        workspace: WORKSPACE_A,
        actor: 'builder-b@example.test',
        body: JSON.stringify({ name: 'Hijacked' }),
      }),
      idContext(agent.id),
    );
    expect(deniedForOther.status).toBe(403);

    // B1 did create it: the same route, the same agent, only the caller differs.
    const allowedForOwner = await patchRoute(
      request('PATCH', `/api/agents/${agent.id}`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
        body: JSON.stringify({ name: 'Renamed by its own creator' }),
      }),
      idContext(agent.id),
    );
    expect(allowedForOwner.status, await allowedForOwner.clone().text()).toBe(200);
  });
});

describe('agent routes answer a store failure with the safe Problem envelope', () => {
  const SENTINEL = 'postgresql://admin:TOP-SECRET@internal.example/workspace';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // I-02 (engineering audit): a throwing store used to reject the route function, and Next.js
  // answered a bodiless 500 with no logged context. The `server/http/route.ts` wrapper renders it.
  it('GET /api/agents maps a throwing store to 500 internal_error', async () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    useMemoryRuntime();
    const runtime = applicationContext()?.agents ?? null;
    if (runtime === null) throw new Error('useMemoryRuntime installed no agents runtime.');
    installTestDomains({
      agents: {
        ...runtime,
        agents: {
          forWorkspace: (workspaceId) => ({
            ...runtime.agents.forWorkspace(workspaceId),
            list: () => Promise.reject(new Error(SENTINEL)),
          }),
        },
      },
    });

    const response = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(SENTINEL);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal_error', message: 'The request could not be completed.' },
    });
  });
});
