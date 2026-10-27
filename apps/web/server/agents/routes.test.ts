/**
 * The five route handlers of spec §34, imported as Next.js will import them and driven with real
 * `Request` objects.
 *
 * Everything else in this directory tests a module the routes call. This file tests the routes
 * themselves — the exported `GET` / `POST` / `PATCH` / `DELETE` functions in
 * `apps/web/app/api/agents/route.ts` and `apps/web/app/api/agents/[id]/route.ts` — because the
 * wiring in those files is code too, and until this suite existed the only outcome anyone had
 * observed from them was `503 agents_runtime_not_configured`. A route that answers 503 in every
 * circumstance is indistinguishable from a route that does not work, and "it will work once
 * W1-CP-06 wires a session" is a claim, not a test.
 *
 * What a test can supply that production cannot yet is the runtime: `installTestDomains`
 * installs the in-memory reference store and a resolver. Everything downstream of that seam is the
 * real code path a deployed request takes.
 *
 * The one thing this file cannot exercise is Next.js's own routing — which file it picks for a URL
 * and how it fills `params`. That is what `tests/route-inventory.test.ts` covers, from the other
 * side.
 */
import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as listRoute, POST as createRoute } from '../../app/api/agents/route';
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '../../app/api/agents/[id]/route';
import type { AgentResource, AgentResourceAssignments } from '../../contracts/agents';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../agent-versions/memory-store';
import { applicationContext, clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentResourceStoreProvider } from './resource-store';
import { type WorkspaceResolution } from './runtime';
import { clearEnginesRegisteredForTests, registerEngineForTests } from '../engines/registry';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** The workspace a request acts in, taken from a header **only in this test**. */
const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, taken from a header only here. */
const ACTOR_HEADER = 'x-test-actor';

afterEach(() => {
  clearApplicationContext();
});

/**
 * Install a runtime whose resolver reads the workspace from a request header.
 *
 * A real resolver must never do this — `runtime.ts` says so, and W1-CP-06 will read a session
 * cookie instead. It is exactly what makes the isolation assertions below meaningful: the test
 * gives an attacker the strongest position there is, full control of the workspace identity, and
 * then asserts that workspace B still cannot reach workspace A's row.
 */
function useMemoryRuntime(role: Role = 'owner'): InMemoryAgentVersionStoreProvider {
  const assignments = new Map<string, AgentResourceAssignments>();
  const agents = createInMemoryAgentStoreProvider({ assignments });
  const agentResources: AgentResourceStoreProvider = {
    forWorkspace: (workspaceId) => ({
      get: async (agentId) => {
        if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) return null;
        return (
          assignments.get(`${workspaceId}:${agentId}`) ?? {
            files: [],
            skillIds: [],
            connectorIds: [],
            storageGrants: [],
          }
        );
      },
      replace: async (agentId, next) => {
        if ((await agents.forWorkspace(workspaceId).get(agentId)) === null) {
          return { kind: 'not-found' as const };
        }
        const stored = { ...next, storageGrants: next.storageGrants ?? [] };
        assignments.set(`${workspaceId}:${agentId}`, stored);
        return { kind: 'updated' as const, assignments: stored };
      },
    }),
  };
  installTestDomains({
    agents: {
      agents,
      agentResources,
      resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        if (workspaceId === null) {
          return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
        }
        return Promise.resolve({ kind: 'workspace', workspaceId });
      },
    },
  });
  // Issue #616: a PATCH saves a version, so the version store is part of the runtime.
  const versions = createInMemoryAgentVersionStoreProvider({ agents, resources: agentResources });
  installTestDomains({ agentVersions: { versions } });
  installTestDomains({
    rbac: {
      // Issue #117: `POST /api/agents` resolves `created_by`, falling back to the workspace's
      // oldest Owner when the caller cannot be matched by email (true here, which authenticates as
      // an API key) — so each fixture workspace needs at least one seeded member.
      directory: createMemoryDirectory({
        users: [
          {
            email: 'owner-a@example.test',
            name: 'Owner A',
            workspaceId: WORKSPACE_A,
            role: 'owner',
          },
          {
            email: 'owner-b@example.test',
            name: 'Owner B',
            workspaceId: WORKSPACE_B,
            role: 'owner',
          },
          // Two distinct Builders of workspace A, seeded by real email — issue #117's ownership
          // tests need two people the "own"/"other" comparison can actually tell apart, which the
          // single fixed test actor below could not.
          {
            email: 'builder-a@example.test',
            name: 'Builder A',
            workspaceId: WORKSPACE_A,
            role: 'builder',
          },
          {
            email: 'builder-b@example.test',
            name: 'Builder B',
            workspaceId: WORKSPACE_A,
            role: 'builder',
          },
        ],
      }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        const actor = request.headers.get(ACTOR_HEADER) ?? 'agent-route-test';
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId:
                  actor === 'builder-a@example.test'
                    ? '819aac78-a253-48ca-bb59-638a37531f1d'
                    : actor === 'builder-b@example.test'
                      ? '54450291-6b86-470a-819a-d242b67bcdba'
                      : '1353503f-91fc-4c4c-89d4-e7f1dd35386c',
                apiKeyId:
                  actor === 'builder-a@example.test'
                    ? '10a92952-c0a5-43e1-a7f0-901b32dcaedc'
                    : actor === 'builder-b@example.test'
                      ? '3d469b13-fdb5-4206-895a-37f762c28ea1'
                      : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId,
                role,
                label:
                  actor === 'builder-a@example.test'
                    ? 'Builder A automation'
                    : actor === 'builder-b@example.test'
                      ? 'Builder B automation'
                      : 'Agent route test key',
              }),
        );
      },
    },
  });
  return versions;
}

function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    /** issue #117: which seeded member this request authenticates as, for own/other tests. */
    actor?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.actor !== undefined) headers.set(ACTOR_HEADER, options.actor);
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null && options.body !== undefined) headers.set('content-type', contentType);
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

/** A `context` shaped the way Next.js shapes it for `app/api/agents/[id]/route.ts`. */
function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const CREATE_BODY = JSON.stringify({
  name: 'Support triage',
  instructions: 'Answer support mail.',
  modelConnectionId: null,
  model: 'claude-sonnet-4-5',
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
});

async function bodyOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function createIn(workspace: string, actor?: string): Promise<AgentResource> {
  const response = await createRoute(
    request('POST', '/api/agents', {
      workspace,
      body: CREATE_BODY,
      ...(actor === undefined ? {} : { actor }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await bodyOf(response)) as AgentResource;
}

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

  /**
   * ADR-0065 D3 at the one-call create (#318): an agent is never *saved* with connectors or skills
   * its engine cannot honour. A create body carries no policy, so the engine is the default arm —
   * which is why the test descriptor is a `claude-agent-sdk` descriptor with a capability removed
   * (see `apps/web/server/engines/registry.ts`) rather than a second engine.
   */
  describe('engine capability check', () => {
    afterEach(() => {
      clearEnginesRegisteredForTests();
    });

    function registerClaudeWithout(capability: 'mcp' | 'skills'): void {
      registerEngineForTests({
        id: 'claude-agent-sdk',
        displayName: `Claude Agent SDK (test: no ${capability})`,
        version: 'test',
        capabilities: {
          mcp: capability !== 'mcp',
          skills: capability !== 'skills',
          subagents: false,
          resume: true,
          fork: false,
          interrupt: true,
          streamingText: false,
          reasoning: true,
          maxTurns: 'native',
          maxBudget: 'native',
          wireProtocols: ['anthropic-messages'],
        },
      });
    }

    async function createWith(assignments: AgentResourceAssignments): Promise<Response> {
      return createRoute(
        request('POST', '/api/agents', {
          workspace: WORKSPACE_A,
          body: JSON.stringify({ agent: JSON.parse(CREATE_BODY) as unknown, assignments }),
        }),
      );
    }

    it('refuses a compound create assigning a connector the engine cannot speak to', async () => {
      useMemoryRuntime();
      registerClaudeWithout('mcp');

      const response = await createWith({
        files: [],
        skillIds: [],
        connectorIds: ['44444444-4444-4444-8444-444444444444'],
        storageGrants: [],
      });

      expect(response.status).toBe(422);
      expect(await bodyOf(response)).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['mcp'] },
      });
      // Refused before anything was written: no half-created agent is left for a retry to find.
      const list = await listRoute(request('GET', '/api/agents', { workspace: WORKSPACE_A }));
      expect(await bodyOf(list)).toMatchObject({ agents: [] });
    });

    it('refuses a compound create assigning a skill the engine cannot materialise', async () => {
      useMemoryRuntime();
      registerClaudeWithout('skills');

      const response = await createWith({
        files: [],
        skillIds: ['55555555-5555-4555-8555-555555555555'],
        connectorIds: [],
        storageGrants: [],
      });

      expect(response.status).toBe(422);
      expect(await bodyOf(response)).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['skills'] },
      });
    });

    it('accepts the same create on the engine as this deployment really registers it', () => {
      // "Nothing changes for claude-agent-sdk agents" — the assertion above is about the test
      // descriptor, not about connectors becoming unassignable.
      useMemoryRuntime();
      return createWith({
        files: [],
        skillIds: [],
        connectorIds: ['44444444-4444-4444-8444-444444444444'],
        storageGrants: [],
      }).then(async (response) => {
        expect(response.status, JSON.stringify(await bodyOf(response))).toBe(201);
      });
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
