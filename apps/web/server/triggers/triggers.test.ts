/**
 * `/api/triggers` (issue #1293, ADR-0144): the management matrix, the secret shown once, and the
 * public fire route: the uniform 404, the owner re-check, the handshakes, the idempotency key, the
 * body cap and the two limits. The repository is in memory; its SQL is covered in core's
 * `triggers.test.ts`.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { TriggerRecord, TriggerRepository } from '@agent-workspace/core/db';
import { TRIGGER_MAX_BODY_BYTES, type TriggerResource } from '@indx-workspace/contracts/triggers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/triggers/[id]/route';
import { POST as FIRE } from '../../app/api/triggers/[id]/fire/[secret]/route';
import { POST as ROTATE } from '../../app/api/triggers/[id]/secret/route';
import { GET as LIST, POST as CREATE } from '../../app/api/triggers/route';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
} from '../engines/images';
import { clearApplicationContext } from '../application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../application-context-fixtures';
import { conferredBy } from '../rbac/conferral';
import { Principal } from '../rbac/principal';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { AgentRef, LaunchContext, RunApiEnvironment } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { MAX_PROMPT_CHARS } from '../runs/service';
import type { TriggersRuntime } from './runtime';

const ownerCaller = { email: 'owner@example.com' };
const adminCaller = { email: 'admin@example.com' };
const builderCaller = { email: 'builder@example.com' };
const otherBuilderCaller = { email: 'other-builder@example.com' };
const viewerCaller = { email: 'viewer@example.com' };

interface State {
  readonly rows: Map<string, TriggerRecord>;
  readonly hashes: Map<string, string>;
  readonly deliveries: Map<string, string | null>;
  readonly zoomTokens: Map<string, string>;
  readonly agentOwners: Map<string, string>;
  readonly revoked: Set<string>;
  readonly store: InMemoryRunStore;
  readonly launches: LaunchContext[];
  recentDeliveries: number | null;
  unfinishedRuns: number;
  refuseStart: boolean;
  agentGone: boolean;
  agentEngine: string;
  failRecordRun: boolean;
}

let harness: RbacHarness;
let state: State;
let principalIds: Record<string, string>;

function repository(): TriggerRepository {
  const named = (name: string, except: string | null) =>
    [...state.rows.values()].some((row) => row.name === name && row.id !== except);
  return {
    list: () => Promise.resolve([...state.rows.values()].map((row) => row)),
    get: (id) => {
      const row = state.rows.get(id);
      return Promise.resolve(row === undefined ? null : row);
    },
    create: (input) => {
      if (!state.agentOwners.has(input.agentId))
        return Promise.resolve({ kind: 'agent-not-found' });
      if (named(input.name, null)) return Promise.resolve({ kind: 'name-taken' });
      const now = new Date();
      const row = {
        id: randomUUID(),
        workspaceId: TEST_WORKSPACE_ID,
        agentId: input.agentId,
        name: input.name,
        kind: input.kind,
        promptTemplate: input.promptTemplate,
        cron: input.kind === 'schedule' ? input.cron : null,
        timezone: input.kind === 'schedule' ? input.timezone : null,
        enabled: input.enabled ?? true,
        outputSchema: input.outputSchema ?? null,
        subject: input.subject ?? null,
        ownerPrincipalId: input.ownerPrincipalId,
        hasSecret: input.kind === 'webhook',
        lastFiredAt: null,
        scheduleFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      state.rows.set(row.id, row);
      if (input.kind === 'webhook') state.hashes.set(row.id, input.secretHash);
      return Promise.resolve({ kind: 'created', trigger: row });
    },
    update: (id, patch) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve({ kind: 'not-found' });
      if (patch.name !== undefined && named(patch.name, id)) {
        return Promise.resolve({ kind: 'name-taken' });
      }
      const next = {
        ...row,
        name: patch.name ?? row.name,
        promptTemplate: patch.promptTemplate ?? row.promptTemplate,
        enabled: patch.enabled ?? row.enabled,
        outputSchema: patch.outputSchema === undefined ? row.outputSchema : patch.outputSchema,
        subject: patch.subject === undefined ? row.subject : patch.subject,
      };
      state.rows.set(id, next);
      return Promise.resolve({ kind: 'updated', trigger: next });
    },
    setSecretHash: (id, secretHash) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve({ kind: 'not-found' });
      state.hashes.set(id, secretHash);
      return Promise.resolve({ kind: 'set', trigger: row });
    },
    countDeliveriesSince: () => Promise.resolve(state.recentDeliveries ?? state.deliveries.size),
    countUnfinishedRuns: () => Promise.resolve(state.unfinishedRuns),
    markFired: (id, at) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve(false);
      state.rows.set(id, { ...row, lastFiredAt: at });
      return Promise.resolve(true);
    },
    remove: (id) => Promise.resolve(state.rows.delete(id)),
    claimDelivery: (_triggerId, key) => {
      if (state.deliveries.has(key)) {
        return Promise.resolve({ kind: 'duplicate', runId: state.deliveries.get(key) ?? null });
      }
      state.deliveries.set(key, null);
      return Promise.resolve({ kind: 'claimed' });
    },
    recordDeliveryRun: (_triggerId, key, runId) => {
      if (state.failRecordRun) return Promise.reject(new Error('database unavailable'));
      state.deliveries.set(key, runId);
      return Promise.resolve(true);
    },
    releaseDelivery: (_triggerId, key) => Promise.resolve(state.deliveries.delete(key)),
    pruneDeliveries: () => Promise.resolve(0),
  };
}

function installFakes(): State {
  state = {
    rows: new Map(),
    hashes: new Map(),
    deliveries: new Map(),
    zoomTokens: new Map(),
    agentOwners: new Map(),
    revoked: new Set(),
    store: new InMemoryRunStore(),
    launches: [],
    recentDeliveries: null,
    unfinishedRuns: 0,
    refuseStart: false,
    agentGone: false,
    agentEngine: 'claude-agent-sdk',
    failRecordRun: false,
  };
  const repo = repository();
  const runtime: TriggersRuntime = {
    repository: () => Promise.resolve(repo),
    findForIngress: (id) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      return Promise.resolve({ trigger: row, secretHash: state.hashes.get(id) ?? null });
    },
    owner: async (workspaceId, principalId) => {
      if (state.revoked.has(principalId)) return null;
      const member = (await harness.directory.forWorkspace(workspaceId).listMemberships()).find(
        (m) => m.principalId === principalId,
      );
      if (member === undefined) return null;
      return Principal.fromDirectoryRecord({
        principalId,
        kind: 'membership',
        workspaceId,
        role: member.role,
        label: member.name,
        userId: member.userId,
        apiKeyId: null,
        actsForPrincipalId: null,
      });
    },
    agentOwnership: (principal, agentId) => {
      const owner = state.agentOwners.get(agentId);
      if (owner === undefined) return Promise.resolve('unknown');
      return Promise.resolve(owner === principal.ownerPrincipalId ? 'own' : 'other');
    },
    zoomTokens: {
      configured: (_ws, ids) =>
        Promise.resolve(new Set(ids.filter((id) => state.zoomTokens.has(id)))),
      set: (_ws, id, token) => {
        state.zoomTokens.set(id, token);
        return Promise.resolve();
      },
      clear: (_ws, id) => {
        state.zoomTokens.delete(id);
        return Promise.resolve();
      },
      read: (_ws, id) => Promise.resolve(state.zoomTokens.get(id) ?? null),
    },
    now: () => new Date(),
  };
  installTestDomains({ triggers: { kind: 'serving', runtime } });
  const env: RunApiEnvironment = {
    authenticate: () => Promise.reject(new Error('the fire route does not authenticate')),
    findAgent: (_principal, agentId): Promise<AgentRef | null> =>
      Promise.resolve(
        state.agentOwners.has(agentId) && !state.agentGone
          ? { id: agentId, workspaceId: TEST_WORKSPACE_ID, engine: state.agentEngine }
          : null,
      ),
    openSession: (_principal, agent) =>
      Promise.resolve({ id: randomUUID(), agentId: agent.id, engine: null }),
    discardSession: () => Promise.resolve(),
    ownsRun: () => Promise.resolve(true),
    preflight: () =>
      Promise.resolve(
        state.refuseStart
          ? { code: 'agent_runtime_profile_missing', message: 'the agent has no runtime profile.' }
          : null,
      ),
    store: state.store,
    launch: (context) => {
      state.launches.push(context);
    },
  };
  installTestRunApi(env);
  return state;
}

beforeEach(async () => {
  harness = installRbacHarness([
    { email: ownerCaller.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    { email: adminCaller.email, name: 'Admin', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
    {
      email: builderCaller.email,
      name: 'Builder',
      workspaceId: TEST_WORKSPACE_ID,
      role: 'builder',
    },
    {
      email: otherBuilderCaller.email,
      name: 'Other',
      workspaceId: TEST_WORKSPACE_ID,
      role: 'builder',
    },
    { email: viewerCaller.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  const memberships = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).listMemberships();
  principalIds = Object.fromEntries(memberships.map((m) => [m.email, m.principalId]));
  installFakes();
});

afterEach(() => {
  clearEngineImagesConfiguredForTests();
  resetTestRunApi();
  clearApplicationContext();
  harness.teardown();
});

function agentOf(caller: { email: string }): string {
  const id = randomUUID();
  state.agentOwners.set(id, principalIds[caller.email] ?? 'missing');
  return id;
}

const createBody = (agentId: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'webhook',
  name: 'inbox',
  agentId,
  prompt: 'Handle this: {{body}}',
  ...overrides,
});

const createAs = (caller: { email: string }, body: unknown) =>
  harness.call(CREATE, { method: 'POST', path: '/api/triggers', as: caller, body });

interface Created {
  readonly trigger: TriggerResource;
  readonly secret: string;
  readonly firePath: string;
}

async function seed(
  caller: { email: string } = builderCaller,
  overrides: Record<string, unknown> = {},
): Promise<Created> {
  const response = await createAs(caller, createBody(agentOf(caller), overrides));
  expect(response.status).toBe(201);
  return response.body as Created;
}

async function fireRaw(
  id: string,
  secret: string,
  init: { body?: string; headers?: Record<string, string>; query?: string } = {},
) {
  const response = await FIRE(
    new Request(`https://control-plane.test/api/triggers/${id}/fire/${secret}${init.query ?? ''}`, {
      method: 'POST',
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    { params: Promise.resolve({ id, secret }) },
  );
  const text = await response.text();
  return { status: response.status, text, headers: response.headers, response };
}

const jsonOf = (text: string): unknown => JSON.parse(text) as unknown;

describe('not configured', () => {
  it('answers the named 503 on management and fire while triggers are disabled (no run runtime yet)', async () => {
    const created = await seed(builderCaller);
    installTestDomains({ triggers: { kind: 'disabled' } });
    const list = await harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: ownerCaller,
    });
    expect(list.status).toBe(503);
    expect(list.body).toMatchObject({ error: { code: 'triggers_runtime_not_configured' } });
    const fired = await fireRaw(created.trigger.id, created.secret);
    expect(fired.status).toBe(503);
    expect(jsonOf(fired.text)).toMatchObject({ error: { code: 'triggers_not_configured' } });
    expect(state.launches).toHaveLength(0);
  });
});

describe('management: the role matrix', () => {
  it('refuses a viewer', async () => {
    const response = await createAs(viewerCaller, createBody(agentOf(ownerCaller)));
    expect(response.status).toBe(403);
    expect(state.rows.size).toBe(0);
  });

  it('refuses a viewer on list and a builder on a trigger that is not theirs', async () => {
    const created = await seed(ownerCaller);
    const list = await harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: viewerCaller,
    });
    expect(list.status).toBe(403);
    const patch = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { enabled: false },
    });
    expect(patch.status).toBe(403);
  });

  it('creates a trigger for a builder, owned by them, and shows the secret once', async () => {
    const created = await seed(builderCaller);
    expect(created.trigger.ownerPrincipalId).toBe(principalIds[builderCaller.email]);
    expect(created.trigger).toMatchObject({ hasSecret: true, hasZoomSecretToken: false });
    expect(created.secret).toMatch(/^awcs_live_/u);
    expect(created.firePath).toBe(`/api/triggers/${created.trigger.id}/fire/${created.secret}`);

    const got = await harness.call(GET_ONE, {
      method: 'GET',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(got.status).toBe(200);
    expect(got.text).not.toContain(created.secret);
    const list = await harness.call(LIST, {
      method: 'GET',
      path: '/api/triggers',
      as: builderCaller,
    });
    expect(list.text).not.toContain(created.secret);
  });

  it('refuses an agent the caller may not run, and one that does not exist', async () => {
    const foreign = await createAs(builderCaller, createBody(agentOf(otherBuilderCaller)));
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: { code: 'trigger_agent_not_runnable' } });
    const absent = await createAs(builderCaller, createBody(randomUUID()));
    expect(absent.status).toBe(403);
  });

  it('answers 409 to a duplicate name', async () => {
    const created = await seed(builderCaller);
    const again = await createAs(builderCaller, createBody(agentOf(builderCaller)));
    expect(again.status).toBe(409);
    expect(state.rows.size).toBe(1);
    expect(created.trigger.name).toBe('inbox');
  });

  const scheduleBody = (overrides: Record<string, unknown> = {}) => ({
    kind: 'schedule',
    name: 'nightly',
    agentId: agentOf(builderCaller),
    prompt: 'go',
    cron: '0 3 * * *',
    timezone: 'Asia/Tokyo',
    ...overrides,
  });

  it('creates a schedule trigger with no secret', async () => {
    const created = await createAs(builderCaller, scheduleBody());
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      trigger: expect.objectContaining({
        kind: 'schedule',
        cron: '0 3 * * *',
        timezone: 'Asia/Tokyo',
        hasSecret: false,
        enabled: true,
      }) as unknown,
    });
    expect(state.hashes.size).toBe(0);
  });

  it.each([
    ['six fields', { cron: '0 0 3 * * *' }],
    ['an out-of-range minute', { cron: '61 * * * *' }],
    ['a date that never exists', { cron: '0 0 31 2 *' }],
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
    ['a {{body}} prompt', { prompt: 'summarise {{body}}' }],
  ])('answers 400 to a schedule with %s and stores nothing', async (_name, overrides) => {
    const response = await createAs(builderCaller, scheduleBody(overrides));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(state.rows.size).toBe(0);
  });

  it('answers 400 to a {{body}} prompt patched onto a schedule and keeps the old prompt', async () => {
    const created = (await createAs(builderCaller, scheduleBody())).body as {
      trigger: { id: string };
    };
    const response = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { prompt: 'summarise {{body}}' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
    expect(state.rows.get(created.trigger.id)?.promptTemplate).toBe('go');
  });

  it('refuses a schedule for an agent the member may not run', async () => {
    const response = await createAs(
      builderCaller,
      scheduleBody({ agentId: agentOf(otherBuilderCaller) }),
    );
    expect(response.status).toBe(403);
    expect(state.rows.size).toBe(0);
  });

  describe('output schema (ADR-0154)', () => {
    const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
    const patchAs = (id: string, body: unknown) =>
      harness.call(PATCH, {
        method: 'PATCH',
        path: `/api/triggers/${id}`,
        as: builderCaller,
        id,
        body,
      });

    it('stores the schema on create and shows it on create, get and list', async () => {
      const created = await seed(builderCaller, { outputSchema: sheet });
      expect(created.trigger.outputSchema).toEqual(sheet);
      const one = await harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/triggers/${created.trigger.id}`,
        as: builderCaller,
        id: created.trigger.id,
      });
      expect(one.body).toMatchObject({ trigger: { outputSchema: sheet } });
      const list = await harness.call(LIST, {
        method: 'GET',
        path: '/api/triggers',
        as: builderCaller,
      });
      expect(list.body).toMatchObject({ triggers: [{ outputSchema: sheet }] });
      expect((await seed(builderCaller, { name: 'plain' })).trigger.outputSchema).toBeNull();
    });

    it.each([
      ['root_type', { type: 'array' }],
      ['ref', { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }],
    ])(
      'answers 400 invalid_field naming the %s limit on create and patch',
      async (limit, schema) => {
        const created = await createAs(
          builderCaller,
          createBody(agentOf(builderCaller), { outputSchema: schema }),
        );
        expect(created.status).toBe(400);
        expect(created.body).toMatchObject({ error: { code: 'invalid_field' } });
        expect(JSON.stringify(created.body)).toContain(limit);
        expect(state.rows.size).toBe(0);

        const seeded = await seed(builderCaller, { outputSchema: sheet });
        const patched = await patchAs(seeded.trigger.id, { outputSchema: schema });
        expect(patched.status).toBe(400);
        expect(patched.body).toMatchObject({ error: { code: 'invalid_field' } });
        expect(state.rows.get(seeded.trigger.id)?.outputSchema).toEqual(sheet);
      },
    );

    it('replaces the schema on patch, keeps it when omitted and clears it with null', async () => {
      const { trigger } = await seed(builderCaller, { outputSchema: sheet });
      const next = { type: 'object', properties: { score: { type: 'number' } } };
      expect((await patchAs(trigger.id, { outputSchema: next })).body).toMatchObject({
        trigger: { outputSchema: next },
      });
      expect((await patchAs(trigger.id, { enabled: true })).body).toMatchObject({
        trigger: { outputSchema: next },
      });
      expect((await patchAs(trigger.id, { outputSchema: null })).body).toMatchObject({
        trigger: { outputSchema: null },
      });
    });
  });

  describe('run subject (ADR-0156)', () => {
    const patchAs = (caller: { email: string }, id: string, body: unknown) =>
      harness.call(PATCH, { method: 'PATCH', path: `/api/triggers/${id}`, as: caller, id, body });

    /** A Builder's own trigger that an Admin gave a subject. */
    async function builderTriggerWithSubject(): Promise<TriggerResource> {
      const { trigger } = await seed(builderCaller, { name: 'planned' });
      expect((await patchAs(adminCaller, trigger.id, { subject: 'planner' })).status).toBe(200);
      return trigger;
    }

    const refusedForSubject = (response: { status: number; body: unknown }) => {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'trigger_subject_not_allowed' } });
    };

    it('stores the subject on create and shows it on create, get and list', async () => {
      const created = await seed(adminCaller, { subject: 'planner' });
      expect(created.trigger.subject).toBe('planner');
      const one = await harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/triggers/${created.trigger.id}`,
        as: adminCaller,
        id: created.trigger.id,
      });
      expect(one.body).toMatchObject({ trigger: { subject: 'planner' } });
      const list = await harness.call(LIST, {
        method: 'GET',
        path: '/api/triggers',
        as: adminCaller,
      });
      expect(list.body).toMatchObject({ triggers: [{ subject: 'planner' }] });
      expect((await seed(adminCaller, { name: 'plain' })).trigger.subject).toBeNull();
    });

    it('lets an admin and an owner replace the subject, keep it when omitted, and clear it with null', async () => {
      const { trigger } = await seed(adminCaller, { subject: 'planner' });
      expect((await patchAs(adminCaller, trigger.id, { subject: 'organiser' })).body).toMatchObject(
        {
          trigger: { subject: 'organiser' },
        },
      );
      expect((await patchAs(ownerCaller, trigger.id, { enabled: true })).body).toMatchObject({
        trigger: { subject: 'organiser' },
      });
      expect((await patchAs(adminCaller, trigger.id, { subject: null })).body).toMatchObject({
        trigger: { subject: null },
      });
    });

    it('refuses a builder creating a trigger with a subject, storing nothing', async () => {
      refusedForSubject(
        await createAs(builderCaller, createBody(agentOf(builderCaller), { subject: 'admin' })),
      );
      expect(state.rows.size).toBe(0);
    });

    it('refuses a builder setting or changing the subject of their own trigger', async () => {
      const plain = await seed(builderCaller);
      refusedForSubject(await patchAs(builderCaller, plain.trigger.id, { subject: 'admin' }));
      expect(state.rows.get(plain.trigger.id)?.subject).toBeNull();

      const trigger = await builderTriggerWithSubject();
      refusedForSubject(await patchAs(builderCaller, trigger.id, { subject: 'colleague' }));
      expect(state.rows.get(trigger.id)?.subject).toBe('planner');
    });

    it('refuses a builder any other change to their trigger while it has a subject', async () => {
      const trigger = await builderTriggerWithSubject();
      for (const body of [
        { prompt: 'Do something else: {{body}}' },
        { name: 'renamed' },
        { enabled: false },
        { outputSchema: { type: 'object' } },
      ]) {
        refusedForSubject(await patchAs(builderCaller, trigger.id, body));
      }
      expect(state.rows.get(trigger.id)).toMatchObject({
        name: trigger.name,
        promptTemplate: 'Handle this: {{body}}',
        enabled: true,
        subject: 'planner',
      });
    });

    it('lets a builder clear the subject, and then edit the trigger as before', async () => {
      const trigger = await builderTriggerWithSubject();
      expect(
        (await patchAs(builderCaller, trigger.id, { subject: null, prompt: 'Next: {{body}}' }))
          .body,
      ).toMatchObject({ trigger: { subject: null, prompt: 'Next: {{body}}' } });
      expect((await patchAs(builderCaller, trigger.id, { enabled: false })).status).toBe(200);
    });

    it('answers 400 to an empty or oversized subject on create and patch, changing nothing', async () => {
      for (const subject of ['', 'a'.repeat(257)]) {
        const created = await createAs(adminCaller, createBody(agentOf(adminCaller), { subject }));
        expect(created.status).toBe(400);
      }
      expect(state.rows.size).toBe(0);
      const seeded = await seed(adminCaller, { subject: 'planner' });
      expect((await patchAs(adminCaller, seeded.trigger.id, { subject: '' })).status).toBe(400);
      expect(state.rows.get(seeded.trigger.id)?.subject).toBe('planner');
    });

    it('refuses a viewer setting a subject on a trigger they cannot manage', async () => {
      const created = await createAs(
        viewerCaller,
        createBody(agentOf(builderCaller), { subject: 'planner' }),
      );
      expect(created.status).toBe(403);
      expect(state.rows.size).toBe(0);
    });
  });

  it('rejects a malformed body with 400', async () => {
    const response = await createAs(builderCaller, { kind: 'webhook', name: '' });
    expect(response.status).toBe(400);
  });

  it.each(['owner', 'admin', 'builder'] as const)(
    'refuses a %s API key on create',
    async (role) => {
      const key = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
        name: `${role}-key`,
        role: conferredBy('owner', role, 'test'),
        expiresAt: null,
      });
      if (key.kind !== 'created') throw new Error(key.kind);
      const response = await harness.call(CREATE, {
        method: 'POST',
        path: '/api/triggers',
        as: null,
        bearer: key.presented,
        body: createBody(agentOf(ownerCaller)),
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'api_key_not_permitted' } });
      expect(state.rows.size).toBe(0);
    },
  );

  it('stores a Zoom secret token write-only and clears it with null', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    expect(created.trigger.hasZoomSecretToken).toBe(true);
    expect(JSON.stringify(created)).not.toContain('zoom-app-secret');
    const cleared = await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { zoomSecretToken: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ trigger: { hasZoomSecretToken: false } });
    expect(state.zoomTokens.size).toBe(0);
  });

  it('answers the same 404 for an id that is absent and one that is not an id', async () => {
    for (const id of [randomUUID(), 'not-an-id']) {
      const response = await harness.call(GET_ONE, {
        method: 'GET',
        path: `/api/triggers/${id}`,
        as: ownerCaller,
        id,
      });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'trigger_not_found' } });
    }
  });

  it('removes a trigger, its Zoom token, and answers 404 afterwards', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    const removed = await harness.call(DELETE, {
      method: 'DELETE',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(removed.status).toBe(200);
    expect(state.rows.size).toBe(0);
    expect(state.zoomTokens.size).toBe(0);
    expect((await fireRaw(created.trigger.id, created.secret)).status).toBe(404);
  });

  it('rotates the secret: the old one stops working at once', async () => {
    const created = await seed(builderCaller);
    const rotated = await harness.call(ROTATE, {
      method: 'POST',
      path: `/api/triggers/${created.trigger.id}/secret`,
      as: builderCaller,
      id: created.trigger.id,
    });
    expect(rotated.status).toBe(201);
    const next = rotated.body as Created;
    expect(next.secret).not.toBe(created.secret);
    expect((await fireRaw(created.trigger.id, created.secret)).status).toBe(404);
    expect((await fireRaw(created.trigger.id, next.secret, { body: 'x' })).status).toBe(202);
  });
});

describe('fire', () => {
  it('starts a run as the owner in a new session and answers 202 { run }', async () => {
    const created = await seed(builderCaller);
    const fired = await fireRaw(created.trigger.id, created.secret, { body: '{"a":1}' });
    expect(fired.status).toBe(202);
    const { run } = jsonOf(fired.text) as { run: { id: string } };
    expect(state.launches).toHaveLength(1);
    expect(state.launches[0]?.run.id).toBe(run.id);
    expect(state.launches[0]?.prompt).toBe('Handle this: {"a":1}');
    expect(state.launches[0]?.principal.ownerPrincipalId).toBe(principalIds[builderCaller.email]);
    expect(state.rows.get(created.trigger.id)?.lastFiredAt).not.toBeNull();
  });

  it('starts the run with the trigger output schema, and with none when the trigger has none (ADR-0154)', async () => {
    const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
    const typed = await seed(builderCaller, { outputSchema: sheet });
    expect((await fireRaw(typed.trigger.id, typed.secret)).status).toBe(202);
    expect(state.launches[0]?.outputSchema).toEqual(sheet);

    const plain = await seed(builderCaller, { name: 'plain' });
    expect((await fireRaw(plain.trigger.id, plain.secret)).status).toBe(202);
    expect(state.launches[1]).not.toHaveProperty('outputSchema');
  });

  it('starts the run with the trigger subject, and none when it has none; a body never overrides it (ADR-0156)', async () => {
    const subject = await seed(adminCaller, { subject: 'planner' });
    expect(
      (await fireRaw(subject.trigger.id, subject.secret, { body: '{"subject":"mallory"}' })).status,
    ).toBe(202);
    expect(state.launches[0]?.subject).toBe('planner');

    const plain = await seed(builderCaller, { name: 'plain' });
    expect(
      (await fireRaw(plain.trigger.id, plain.secret, { body: '{"subject":"eve"}' })).status,
    ).toBe(202);
    expect(state.launches[1]).not.toHaveProperty('subject');
  });

  it('answers 422 engine_capability_unsupported when the engine cannot honour the schema, and frees the key', async () => {
    const typed = await seed(builderCaller, {
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
    });
    const headers = { 'idempotency-key': 'needs-schema' };
    const image = (engine: string): string =>
      `registry.example/private-project/runtime-${engine}@sha256:${'c'.repeat(64)}`;
    configureEngineImagesForTests(
      new Map([
        ['claude-agent-sdk', image('claude-agent-sdk')],
        ['pi', image('pi')],
      ]),
    );
    state.agentEngine = 'pi';
    const refused = await fireRaw(typed.trigger.id, typed.secret, { headers });
    expect(refused.status).toBe(422);
    expect(jsonOf(refused.text)).toMatchObject({
      error: { code: 'engine_capability_unsupported' },
    });
    expect(state.launches).toHaveLength(0);
    expect(state.deliveries.has('needs-schema')).toBe(false);

    state.agentEngine = 'claude-agent-sdk';
    expect((await fireRaw(typed.trigger.id, typed.secret, { headers })).status).toBe(202);
    expect(state.launches).toHaveLength(1);
  });

  it('answers the one 404 for a wrong secret, an unknown id, a malformed secret and a disabled trigger', async () => {
    const created = await seed(builderCaller);
    const wrong = await fireRaw(created.trigger.id, 'awcs_live_wrong');
    const unknown = await fireRaw(randomUUID(), created.secret);
    const malformed = await fireRaw(created.trigger.id, 'x');
    await harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { enabled: false },
    });
    const disabled = await fireRaw(created.trigger.id, created.secret);
    for (const miss of [wrong, unknown, malformed, disabled]) {
      expect(miss.status).toBe(404);
      expect(jsonOf(miss.text)).toMatchObject({ error: { code: 'trigger_not_found' } });
    }
    expect(wrong.text.replaceAll(created.trigger.id, '')).toBe(
      unknown.text.replaceAll(created.trigger.id, ''),
    );
    expect(state.deliveries.size).toBe(0);
  });

  it('answers 403 once the owner is revoked, and when the role no longer runs the agent', async () => {
    const created = await seed(builderCaller);
    state.revoked.add(principalIds[builderCaller.email] ?? '');
    const revoked = await fireRaw(created.trigger.id, created.secret);
    expect(revoked.status).toBe(403);
    expect(jsonOf(revoked.text)).toMatchObject({ error: { code: 'trigger_owner_not_allowed' } });
    expect(state.deliveries.size).toBe(0);

    state.revoked.clear();
    state.agentOwners.set(created.trigger.agentId, principalIds[otherBuilderCaller.email] ?? '');
    const lostAgent = await fireRaw(created.trigger.id, created.secret);
    expect(lostAgent.status).toBe(403);
  });

  it('returns the same run for a repeated Idempotency-Key and starts one run', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'delivery-1' };
    const first = await fireRaw(created.trigger.id, created.secret, { body: 'a', headers });
    const again = await fireRaw(created.trigger.id, created.secret, { body: 'a', headers });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(jsonOf(again.text)).toEqual(jsonOf(first.text));
    expect(state.deliveries.size).toBe(1);
    expect(state.launches).toHaveLength(1);
  });

  it('dedupes a redelivered body without an Idempotency-Key, as Graph and Zoom retry', async () => {
    const created = await seed(builderCaller);
    const body = '{"value":[{"subscriptionId":"s-1","changeType":"created"}]}';
    const first = await fireRaw(created.trigger.id, created.secret, { body });
    const retry = await fireRaw(created.trigger.id, created.secret, { body });
    expect(retry.status).toBe(202);
    expect(jsonOf(retry.text)).toEqual(jsonOf(first.text));
    expect(state.launches).toHaveLength(1);
    expect([...state.deliveries.keys()]).toEqual([
      `body:${createHash('sha256').update(body).digest('hex')}`,
    ]);

    const other = await fireRaw(created.trigger.id, created.secret, { body: '{"value":[]}' });
    expect(jsonOf(other.text)).not.toEqual(jsonOf(first.text));
    const explicit = await fireRaw(created.trigger.id, created.secret, {
      body,
      headers: { 'idempotency-key': 'explicit' },
    });
    expect(jsonOf(explicit.text)).not.toEqual(jsonOf(first.text));
    expect(state.launches).toHaveLength(3);
  });

  it('answers 409 with Retry-After while the first delivery is still starting', async () => {
    const created = await seed(builderCaller);
    state.deliveries.set('delivery-2', null);
    const pending = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'delivery-2' },
    });
    expect(pending.status).toBe(409);
    expect(pending.headers.get('retry-after')).toBe('1');
  });

  it('rejects an Idempotency-Key longer than 255 characters', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'k'.repeat(256) },
    });
    expect(response.status).toBe(400);
  });

  it('echoes a Graph validationToken as 200 text/plain without starting a run', async () => {
    const created = await seed(builderCaller);
    const echoed = await fireRaw(created.trigger.id, created.secret, {
      query: '?validationToken=abc%20123',
    });
    expect(echoed.status).toBe(200);
    expect(echoed.text).toBe('abc 123');
    expect(echoed.headers.get('content-type')).toContain('text/plain');
    expect(state.deliveries.size).toBe(0);
    const wrongSecret = await fireRaw(created.trigger.id, 'awcs_live_wrong', {
      query: '?validationToken=abc',
    });
    expect(wrongSecret.status).toBe(404);
  });

  it('answers a Zoom endpoint.url_validation with the HMAC of the plain token', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    const answered = await fireRaw(created.trigger.id, created.secret, {
      body: JSON.stringify({
        event: 'endpoint.url_validation',
        payload: { plainToken: 'plain-1' },
      }),
    });
    expect(answered.status).toBe(200);
    expect(jsonOf(answered.text)).toEqual({
      plainToken: 'plain-1',
      encryptedToken: createHmac('sha256', 'zoom-app-secret').update('plain-1').digest('hex'),
    });
    expect(state.deliveries.size).toBe(0);
  });

  it('answers 422 to a Zoom validation when no Zoom token is stored', async () => {
    const created = await seed(builderCaller);
    const answered = await fireRaw(created.trigger.id, created.secret, {
      body: JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'p' } }),
    });
    expect(answered.status).toBe(422);
    expect(jsonOf(answered.text)).toMatchObject({ error: { code: 'trigger_zoom_not_configured' } });
  });

  it('refuses a body over 256 KiB with 413', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      body: 'x'.repeat(TRIGGER_MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(state.deliveries.size).toBe(0);
  });

  it('answers 429 over 30 firings a minute and frees the claim so the key can retry', async () => {
    const created = await seed(builderCaller);
    state.recentDeliveries = 31;
    const limited = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'burst' },
    });
    expect(limited.status).toBe(429);
    expect(jsonOf(limited.text)).toMatchObject({ error: { code: 'trigger_rate_limited' } });
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(state.deliveries.has('burst')).toBe(false);
  });

  it('answers 429 with three runs unfinished', async () => {
    const created = await seed(builderCaller);
    state.unfinishedRuns = 3;
    const limited = await fireRaw(created.trigger.id, created.secret);
    expect(limited.status).toBe(429);
    expect(jsonOf(limited.text)).toMatchObject({ error: { code: 'trigger_concurrency_limited' } });
    expect(state.deliveries.size).toBe(0);
  });

  it('answers 413 when the prompt with the body exceeds the run prompt limit, starting no run', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      body: 'x'.repeat(MAX_PROMPT_CHARS),
    });
    expect(response.status).toBe(413);
    expect(jsonOf(response.text)).toMatchObject({ error: { code: 'trigger_prompt_too_long' } });
    expect(state.deliveries.size).toBe(0);
    expect(state.launches).toHaveLength(0);
  });

  it('frees the claim when the run start is refused or the agent is gone, so the key can fire again', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'refused' };
    state.refuseStart = true;
    const refused = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(refused.status).toBe(422);
    expect(jsonOf(refused.text)).toMatchObject({
      error: { code: 'agent_runtime_profile_missing' },
    });
    expect(state.deliveries.has('refused')).toBe(false);

    state.refuseStart = false;
    state.agentGone = true;
    const gone = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(gone.status).toBe(403);
    expect(jsonOf(gone.text)).toMatchObject({ error: { code: 'trigger_owner_not_allowed' } });
    expect(state.deliveries.has('refused')).toBe(false);

    state.agentGone = false;
    expect((await fireRaw(created.trigger.id, created.secret, { headers })).status).toBe(202);
    expect(state.launches).toHaveLength(1);
  });

  it('keeps the claim when recording a started run fails, so a retry starts no second run', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'recorded' };
    state.failRecordRun = true;
    await expect(fireRaw(created.trigger.id, created.secret, { headers })).rejects.toThrow(
      'database unavailable',
    );
    expect(state.launches).toHaveLength(1);
    expect(state.deliveries.has('recorded')).toBe(true);

    state.failRecordRun = false;
    const retry = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(retry.status).toBe(409);
    expect(state.launches).toHaveLength(1);
  });
});
