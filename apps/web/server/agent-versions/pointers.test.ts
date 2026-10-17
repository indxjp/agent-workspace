import { describe, expect, it, vi } from 'vitest';

import type { ApplyAndPointOutcome } from '@agent-workspace/core/db';
import { SetAgentPointerResponseSchema } from '@indx-workspace/contracts/agent-versions';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import type { AgentRecord } from '../agents/contract';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { WorkspaceAgentStore } from '../agents/store';
import { FIXTURE_PERMISSIONS, fixtureSurface, versionRequest, type FixtureEdits } from './fixtures';
import { toAgentVersionResource } from './contract';
import { createAgentVersion } from './handlers';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from './memory-store';
import { promoteAgent, rollbackAgent, setAgentPointer, type PointerActor } from './pointers';
import type { WorkspaceAgentVersionStore } from './store';
import type { RequestCeiling } from '../policy-ceiling/ceiling';

/**
 * `setAgentPointer` (S1-06, issue #444) on the memory stores: the pointer move materialises the
 * version onto the row, answers each refusal with nothing written, and hands the store the
 * move's `agent-changed` audit row, which the store records only when the move applied (#478: the
 * row is written inside the pointer transaction, not after it).
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';
const ACTOR: PointerActor = { principalId: OWNER, userId: null, actor: 'builder key' };

interface Harness {
  readonly agents: WorkspaceAgentStore;
  readonly provider: InMemoryAgentVersionStoreProvider;
  readonly store: WorkspaceAgentVersionStore;
  createAgent(name: string): Promise<AgentRecord>;
  save(agent: AgentRecord, edits?: FixtureEdits): Promise<void>;
  current(agentId: string): Promise<AgentRecord>;
}

/** A bundle lookup that holds every digest: it reports none missing. */
const everyBundleStored = (): Promise<readonly string[]> => Promise.resolve([]);

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** The connector and the full bundle entry a code-tool version pins (ADR-0118 TS1, TS4). */
function codeToolEdits(digest: string, instructions: string): FixtureEdits {
  return {
    instructions,
    resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
    toolBundles: [
      { tool: 'lookup', digest, description: 'Look a ticket up.', inputSchema: { type: 'object' } },
    ],
  };
}

/** A ceiling that sets only the promotion bar (issue #619). */
function barOf(minEvalScore: number): RequestCeiling {
  return {
    policy: { promotion: { minEvalScore } },
    deploymentDefaultModel: () => Promise.resolve(null),
    connectorNames: () => Promise.resolve([]),
    recordRefusal: () => Promise.resolve(),
  };
}

async function harness(): Promise<Harness> {
  const agentProvider = createInMemoryAgentStoreProvider();
  const agents = agentProvider.forWorkspace(WORKSPACE);
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: agentProvider,
    references: {
      [WORKSPACE]: {
        connector: [
          { id: 'c1', name: 'tickets' },
          { id: 'c2', name: AW_DEV_TOOLS_CONNECTOR },
          { id: 'c3', name: 'filesystem', stdio: true },
          { id: 'c4', name: 'git', stdio: true },
        ],
      },
    },
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const current = async (agentId: string): Promise<AgentRecord> => {
    const row = await agents.get(agentId);
    if (row === null) throw new Error(`agent ${agentId} exists`);
    return row;
  };
  return {
    agents,
    provider,
    store,
    async createAgent(name) {
      const created = await agents.create(
        {
          name,
          instructions: 'Before any version.',
          modelConnectionId: null,
          model: null,
          permissions: FIXTURE_PERMISSIONS,
        },
        { principalId: OWNER, userId: null },
      );
      if (created.kind !== 'created') throw new Error('the memory store creates the agent');
      return created.agent;
    },
    async save(agent, edits = {}) {
      const saved = await createAgentVersion(
        versionRequest({ name: agent.name, ...edits }),
        await current(agent.id),
        OWNER,
        { store, toolBundles: everyBundleStored },
      );
      if (saved.status !== 201) throw new Error(`the version saves: ${JSON.stringify(saved)}`);
    },
    current,
  };
}

describe('setAgentPointer', () => {
  it('materialises the version, points local at it and records one agent-changed row', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { instructions: 'Version one.', resources: { connectors: ['tickets'] } });
    await h.save(agent, { instructions: 'Version two.' });

    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
    });

    expect(result.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(result.body);
    expect(body.agent.instructions).toBe('Version one.');
    expect(body.pointer).toMatchObject({ environment: 'local', number: 1 });
    expect((await h.current(agent.id)).instructions).toBe('Version one.');
    expect(h.provider.assignmentsOf(agent.id)).toEqual({
      skillIds: [],
      connectorIds: ['c1'],
      files: [],
    });
    expect((await h.store.list(agent.id))?.pointers.map((pointer) => pointer.number)).toEqual([1]);
    expect(h.provider.audits()).toEqual([
      {
        workspaceId: WORKSPACE,
        action: 'agent-changed',
        subjectId: agent.id,
        subjectLabel: 'Support triage: local -> version 1',
        actorPrincipalId: OWNER,
        actorUserId: null,
        actorLabel: 'builder key',
      },
    ]);
  });

  it('moves an existing pointer: pointing at version 2 replaces local -> 1', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { instructions: 'Version one.' });
    await h.save(agent, { instructions: 'Version two.' });
    const deps = { store: h.store };
    await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps);
    const moved = await setAgentPointer(
      { environment: 'local', version: 2 },
      await h.current(agent.id),
      ACTOR,
      deps,
    );
    expect(moved.status).toBe(200);
    expect(h.provider.pointerCount()).toBe(1);
    expect((await h.current(agent.id)).instructions).toBe('Version two.');
    expect(h.provider.audits()).toHaveLength(2);
  });

  it('refuses a version with code tools for any environment but local (ADR-0115)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] } });
    const deps = { store: h.store };
    const refused = (result: { status: number; body: unknown }) => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'code_tool_needs_host',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`, 'environment:production'],
        },
      });
    };

    expect(
      (await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps)).status,
    ).toBe(200);
    refused(await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, deps));
    refused(await promoteAgent({}, await h.current(agent.id), ACTOR, deps));
    refused(await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, deps));
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('refuses a version with code tools before the promotion bar judges it (ADR-0115)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] } });
    const deps = { store: h.store, ceiling: barOf(0.9) };
    await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps);

    for (const result of [
      await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, deps),
      await promoteAgent({}, await h.current(agent.id), ACTOR, deps),
    ]) {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({ error: { code: 'code_tool_needs_host' } });
    }
  });

  it('refuses a version with stdio connectors for any environment but local, naming them (#793)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: ['tickets', 'git', 'filesystem'] } });
    const deps = { store: h.store };
    const refused = (result: { status: number; body: unknown }) => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'stdio_connector_needs_tool_sandbox',
          details: ['connector:filesystem', 'connector:git', 'environment:production'],
        },
      });
    };

    expect(
      (await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps)).status,
    ).toBe(200);
    refused(await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, deps));
    refused(await promoteAgent({}, await h.current(agent.id), ACTOR, deps));
    refused(await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, deps));
    refused(
      await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, {
        ...deps,
        ceiling: barOf(0.9),
      }),
    );
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('promotes a version whose connectors are not stdio (#793)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: ['tickets'] } });
    const deps = { store: h.store };
    await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps);

    const promoted = await promoteAgent({}, await h.current(agent.id), ACTOR, deps);

    expect(promoted).toMatchObject({ status: 200, body: { environment: 'production', to: 1 } });
  });

  it('rolls local back to a code-tool version: only other environments are refused', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] } });
    await h.save(agent, { instructions: 'Version two.' });
    const deps = { store: h.store };
    await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, deps);
    await setAgentPointer({ environment: 'local', version: 2 }, agent, ACTOR, deps);

    const rolled = await rollbackAgent(
      { environment: 'local' },
      await h.current(agent.id),
      ACTOR,
      deps,
    );

    expect(rolled).toMatchObject({ status: 200, body: { environment: 'local', to: 1 } });
  });

  describe('on a deployment with a tool host (ADR-0118 TS8)', () => {
    const needsHost = (result: { status: number; body: unknown }, environment = 'production') => {
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: {
          code: 'code_tool_needs_host',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`, `environment:${environment}`],
        },
      });
    };

    async function codeToolAgent(): Promise<{ h: Harness; agent: AgentRecord }> {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      await h.save(agent, codeToolEdits(DIGEST_A, 'Version one.'));
      await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store: h.store,
        toolBundles: everyBundleStored,
      });
      return { h, agent };
    }

    it('promotes and points production at a bundled code-tool version, and refuses without one', async () => {
      const { h, agent } = await codeToolAgent();
      const withHost = { store: h.store, toolBundles: everyBundleStored, toolHost: true };
      const withoutHost = { store: h.store, toolBundles: everyBundleStored };

      needsHost(await promoteAgent({}, await h.current(agent.id), ACTOR, withoutHost));
      needsHost(
        await promoteAgent({}, await h.current(agent.id), ACTOR, {
          ...withoutHost,
          toolHost: false,
        }),
      );
      needsHost(
        await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, withoutHost),
      );
      expect(h.provider.pointerCount()).toBe(1);

      expect(
        (await promoteAgent({ dryRun: true }, await h.current(agent.id), ACTOR, withHost)).status,
      ).toBe(200);
      expect(h.provider.pointerCount()).toBe(1);
      expect((await promoteAgent({}, await h.current(agent.id), ACTOR, withHost)).status).toBe(200);
      expect(h.provider.pointerCount()).toBe(2);
    });

    it('hands a bundled code-tool version to the promotion bar once a host exists', async () => {
      const { h, agent } = await codeToolAgent();
      const bar = { store: h.store, toolBundles: everyBundleStored, ceiling: barOf(0.9) };

      needsHost(
        await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, bar),
      );
      // With a host the bar judges the version: unevaluated it is refused for that, not the host.
      const withHost = { ...bar, toolHost: true };
      const judged = await setAgentPointer(
        { environment: 'production', version: 1 },
        agent,
        ACTOR,
        withHost,
      );
      expect(judged.status).toBe(409);
      expect(judged.body).toMatchObject({ error: { code: 'promotion_not_evaluated' } });

      const id = (await h.store.list(agent.id))?.versions.find((row) => row.number === 1)?.id;
      if (id === undefined) throw new Error('version 1 is saved');
      h.provider.recordEvaluation(id, { score: 1, passed: 1, total: 1, failing: [] });
      expect(
        (await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, withHost))
          .status,
      ).toBe(200);
    });

    it('still refuses a code-tool version with no hostable bundle, by name', async () => {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      await h.save(agent, { resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] } });
      await h.save(agent, {
        resources: { connectors: [AW_DEV_TOOLS_CONNECTOR] },
        toolBundles: [{ tool: 'lookup', digest: DIGEST_A }],
      });
      const deps = { store: h.store, toolBundles: everyBundleStored, toolHost: true };

      for (const version of [1, 2]) {
        needsHost(
          await setAgentPointer({ environment: 'production', version }, agent, ACTOR, deps),
        );
      }
      expect(h.provider.pointerCount()).toBe(0);
    });

    it('refuses a pointer move to a domain-declaring tool where the sandbox cannot enforce them, by name (#1018)', async () => {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      const edits = codeToolEdits(DIGEST_A, 'Version one.');
      await h.save(agent, {
        ...edits,
        toolBundles: [
          {
            tool: 'lookup',
            digest: DIGEST_A,
            description: 'Look a ticket up.',
            inputSchema: {},
            allowedDomains: ['api.example.com'],
          },
        ],
      });
      const deps = { store: h.store, toolBundles: everyBundleStored, toolHost: true };
      const e2b = { ...deps, toolDomainsRefusal: 'cannot enforce restricted yet' };

      for (const environment of ['local', 'production'] as const) {
        const refused = await setAgentPointer({ environment, version: 1 }, agent, ACTOR, e2b);
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({
          error: { code: 'network_policy_unsupported', details: ['tool:lookup'] },
        });
      }
      expect(h.provider.pointerCount()).toBe(0);

      const enforced = { ...deps, toolDomainsRefusal: null };
      expect(
        (await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, enforced))
          .status,
      ).toBe(200);
    });

    it('rolls production back to the previous version and its bundle digest', async () => {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      await h.save(agent, codeToolEdits(DIGEST_A, 'Version one.'));
      await h.save(agent, codeToolEdits(DIGEST_B, 'Version two.'));
      const deps = { store: h.store, toolBundles: everyBundleStored, toolHost: true };
      for (const version of [1, 2]) {
        const moved = await setAgentPointer(
          { environment: 'production', version },
          agent,
          ACTOR,
          deps,
        );
        expect(moved.status).toBe(200);
      }

      const rolled = await rollbackAgent(
        { environment: 'production' },
        await h.current(agent.id),
        ACTOR,
        deps,
      );

      expect(rolled).toMatchObject({ status: 200, body: { environment: 'production', to: 1 } });
      const pointer = (await h.store.list(agent.id))?.pointers.find(
        (candidate) => candidate.environment === 'production',
      );
      expect(pointer?.number).toBe(1);
      const restored = await h.store.find(agent.id, 1);
      if (restored === null) throw new Error('version 1 is saved');
      expect(toAgentVersionResource(restored).body.toolBundles?.[0]?.digest).toBe(DIGEST_A);
    });

    it('refuses a rollback onto a code-tool version without a tool host', async () => {
      const h = await harness();
      const agent = await h.createAgent('Support triage');
      await h.save(agent, codeToolEdits(DIGEST_A, 'Version one.'));
      await h.save(agent, { instructions: 'Version two.' });
      const withHost = { store: h.store, toolBundles: everyBundleStored, toolHost: true };
      await setAgentPointer({ environment: 'production', version: 1 }, agent, ACTOR, withHost);
      await setAgentPointer({ environment: 'production', version: 2 }, agent, ACTOR, withHost);

      const rolled = await rollbackAgent({ environment: 'production' }, agent, ACTOR, {
        store: h.store,
        toolBundles: everyBundleStored,
      });

      needsHost(rolled);
      const pointer = (await h.store.list(agent.id))?.pointers.find(
        (candidate) => candidate.environment === 'production',
      );
      expect(pointer?.number).toBe(2);
    });
  });

  it('points production without touching the row or the assignments, and audits it (#612)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { instructions: 'Version one.', resources: { connectors: ['tickets'] } });
    await h.save(agent, { instructions: 'Version two.' });
    const deps = { store: h.store };
    await setAgentPointer({ environment: 'local', version: 2 }, agent, ACTOR, deps);
    const before = await h.current(agent.id);
    const assignments = h.provider.assignmentsOf(agent.id);

    const result = await setAgentPointer(
      { environment: 'production', version: 1 },
      before,
      ACTOR,
      deps,
    );

    expect(result.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(result.body);
    expect(body.agent.instructions).toBe('Version two.');
    expect(body.pointer).toMatchObject({ environment: 'production', number: 1 });
    expect(await h.current(agent.id)).toEqual(before);
    expect(h.provider.assignmentsOf(agent.id)).toEqual(assignments);
    expect(
      (await h.store.list(agent.id))?.pointers.map((pointer) => [
        pointer.environment,
        pointer.number,
      ]),
    ).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    expect(h.provider.audits().at(-1)?.subjectLabel).toBe(
      'Support triage: production -> version 1',
    );
  });

  it('checks C9 per environment: a surface served in local may still be served in production', async () => {
    const h = await harness();
    const deps = { store: h.store };
    const first = await h.createAgent('Support triage');
    await h.save(first, { surfaces: [fixtureSurface('main')] });
    await setAgentPointer({ environment: 'production', version: 1 }, first, ACTOR, deps);
    const second = await h.createAgent('Billing');
    await h.save(second, { surfaces: [fixtureSurface('main', 'Billing')] });

    const local = await setAgentPointer({ environment: 'local', version: 1 }, second, ACTOR, deps);
    const production = await setAgentPointer(
      { environment: 'production', version: 1 },
      await h.current(second.id),
      ACTOR,
      deps,
    );

    expect(local.status).toBe(200);
    expect(production).toMatchObject({
      status: 409,
      body: { error: { code: 'surface_name_taken', details: ['surface:main'] } },
    });
  });

  it.each([
    ['an environment that does not exist', { environment: 'preview', version: 1 }],
    ['version 0', { environment: 'local', version: 0 }],
    ['an unknown key', { environment: 'local', version: 1, force: true }],
    ['a missing version', { environment: 'local' }],
  ])('answers 400 invalid_agent_version for %s', async (_name, body) => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    const result = await setAgentPointer(body, agent, ACTOR, {
      store: h.store,
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
    expect(h.provider.audits()).toEqual([]);
  });

  it('answers 404 agent_version_not_found naming the number, and writes nothing', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent);
    const result = await setAgentPointer({ environment: 'local', version: 9 }, agent, ACTOR, {
      store: h.store,
    });
    expect(result).toEqual({
      status: 404,
      body: {
        error: {
          code: 'agent_version_not_found',
          message: 'The agent has no version with that number.',
          details: ['version:9'],
        },
      },
    });
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('answers 409 surface_name_taken (C9) and leaves the row, assignments and pointer unchanged', async () => {
    const h = await harness();
    const first = await h.createAgent('Support triage');
    await h.save(first, { surfaces: [fixtureSurface('main')] });
    const deps = { store: h.store };
    expect(
      (await setAgentPointer({ environment: 'local', version: 1 }, first, ACTOR, deps)).status,
    ).toBe(200);

    const second = await h.createAgent('Billing');
    await h.save(second, {
      instructions: 'Would serve main too.',
      surfaces: [fixtureSurface('main', 'Billing')],
    });
    const before = await h.current(second.id);
    const result = await setAgentPointer({ environment: 'local', version: 1 }, before, ACTOR, deps);

    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'surface_name_taken', details: ['surface:main'] } },
    });
    expect(await h.current(second.id)).toEqual(before);
    expect(h.provider.assignmentsOf(second.id)).toBeUndefined();
    expect((await h.store.list(second.id))?.pointers).toEqual([]);
    expect(h.provider.audits()).toHaveLength(1);
  });

  it('answers 422 agent_subagent_unusable when the store finds the nesting a concurrent save built', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent);
    // The pipeline saw no nesting; the store, inside the transaction that materialises, does.
    const store = {
      ...h.store,
      applyAndPoint: () =>
        Promise.resolve({
          kind: 'subagent-nesting' as const,
          unusable: ['ghost'],
          parents: ['boss'],
        }),
    };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_subagent_unusable', details: ['subagent:ghost', 'parent:boss'] },
      },
    });
    expect(h.provider.audits()).toEqual([]);
  });

  it("answers 409 agent_name_conflict when the version's agent name is another agent's", async () => {
    const h = await harness();
    await h.createAgent('Billing');
    const agent = await h.createAgent('Support triage');
    // A version may rename its agent; this one takes a name the workspace already uses.
    await h.save(agent, { name: 'Billing' });
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
    });
    expect(result).toEqual({
      status: 409,
      body: {
        error: {
          code: 'agent_name_conflict',
          message: 'This workspace already has an agent named "Billing".',
        },
      },
    });
    expect((await h.current(agent.id)).name).toBe('Support triage');
    expect(h.provider.audits()).toEqual([]);
  });

  it("skips the name check on a production move: it never writes the row's name (#612)", async () => {
    const h = await harness();
    const deps = { store: h.store };
    const agent = await h.createAgent('Billing');
    await h.save(agent);
    await h.save(agent, { name: 'Billing v2' });
    await setAgentPointer({ environment: 'local', version: 2 }, agent, ACTOR, deps);
    // The name version 1 gives the agent is now another agent's.
    await h.createAgent('Billing');

    const result = await setAgentPointer(
      { environment: 'production', version: 1 },
      await h.current(agent.id),
      ACTOR,
      deps,
    );

    expect(result.status).toBe(200);
    expect((await h.current(agent.id)).name).toBe('Billing v2');
  });

  it('re-validates the stored version: an engine no longer registered refuses the move', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent);
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
      registered: ['pi'],
    });
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'unsupported_engine' } } });
    expect(h.provider.pointerCount()).toBe(0);
  });

  it('re-resolves once on reference-gone and retries the write with the new ids', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: ['tickets'] } });
    const gone: ApplyAndPointOutcome = { kind: 'reference-gone', referenceKind: 'connector' };
    const applyAndPoint = vi
      .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
      .mockResolvedValueOnce(gone)
      .mockImplementation((id, input) => h.store.applyAndPoint(id, input));
    const resolveDefinition = vi.fn<WorkspaceAgentVersionStore['resolveDefinition']>((references) =>
      h.store.resolveDefinition(references),
    );
    const store = { ...h.store, applyAndPoint, resolveDefinition };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result.status).toBe(200);
    expect(applyAndPoint).toHaveBeenCalledTimes(2);
    // Once by the pipeline, once by the retry.
    expect(resolveDefinition).toHaveBeenCalledTimes(2);
    expect(h.provider.audits()).toHaveLength(1);
  });

  it('answers the resolution refusal when the reference is gone on re-resolve', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { resources: { connectors: ['tickets'] } });
    const store = {
      ...h.store,
      applyAndPoint: vi
        .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
        .mockResolvedValue({ kind: 'reference-gone', referenceKind: 'connector' }),
      resolveDefinition: vi
        .fn<WorkspaceAgentVersionStore['resolveDefinition']>()
        .mockImplementationOnce((references) => h.store.resolveDefinition(references))
        .mockResolvedValue({
          kind: 'unresolved',
          missing: [{ kind: 'connector', name: 'tickets' }],
          ambiguous: [],
        }),
    };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_definition_references_missing', details: ['connector:tickets'] },
      },
    });
    expect(store.applyAndPoint).toHaveBeenCalledTimes(1);
    expect(h.provider.audits()).toEqual([]);
  });

  it('throws on a second reference-gone rather than chasing the race', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent);
    const store = {
      ...h.store,
      applyAndPoint: vi
        .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
        .mockResolvedValue({ kind: 'reference-gone', referenceKind: 'skill' }),
    };
    await expect(
      setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store,
      }),
    ).rejects.toThrow(/deleted twice/u);
    expect(h.provider.audits()).toEqual([]);
  });

  it('hands the store the audit row and propagates a refused in-transaction audit write (#478)', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent);
    // The repository rejects when `audit_events` refuses the row, and its transaction rolls back.
    const applyAndPoint = vi
      .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
      .mockRejectedValue(new Error('audit insert failed'));
    await expect(
      setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store: { ...h.store, applyAndPoint },
      }),
    ).rejects.toThrow(/audit insert failed/u);
    expect(applyAndPoint).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        audit: {
          subjectLabel: 'Support triage: local -> version 1',
          actorPrincipalId: OWNER,
          actorUserId: null,
          actorLabel: 'builder key',
        },
      }),
    );
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
    expect((await h.current(agent.id)).instructions).toBe('Before any version.');
  });

  it('labels the audit row with the name the version gives the agent, not the old one', async () => {
    const h = await harness();
    const agent = await h.createAgent('Billing');
    await h.save(agent, { name: 'Billing v2' });
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
    });
    expect(result.status).toBe(200);
    expect((await h.current(agent.id)).name).toBe('Billing v2');
    expect(h.provider.audits().map((event) => event.subjectLabel)).toEqual([
      'Billing v2: local -> version 1',
    ]);
  });

  it('refuses 400 a stored version whose agent name is blank, and writes nothing', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    // Saved before the pipeline refused blank names: written to the store directly.
    const stored = await h.store.create(agent.id, {
      summary: 'Blank name',
      via: 'api',
      body: versionRequest({ name: '   ' }).body,
      createdByPrincipalId: OWNER,
    });
    expect(stored.kind).toBe('created');
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
    });
    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_agent_version',
          message: 'The body is not a version request.',
          details: ['body.definition.agent.name: must not be blank'],
        },
      },
    });
    expect((await h.current(agent.id)).name).toBe('Support triage');
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('throws on a corrupt stored body: the pipeline is its only writer', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.store.create(agent.id, {
      summary: 'Corrupt',
      via: 'api',
      body: { definition: 'no' },
      createdByPrincipalId: OWNER,
    });
    await expect(
      setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, { store: h.store }),
    ).rejects.toThrow(/broken invariant/u);
  });
});

describe('setAgentPointer: the promotion gate on production (issue #619)', () => {
  async function gated() {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.save(agent, { instructions: 'Version one.' });
    const listing = await h.store.list(agent.id);
    const versionId = listing?.versions[0]?.id;
    if (versionId === undefined) throw new Error('version 1 is saved');
    const deps = { store: h.store, ceiling: barOf(0.9) };
    const point = (environment: 'local' | 'production') =>
      setAgentPointer({ environment, version: 1 }, agent, ACTOR, deps);
    return { h, versionId, point };
  }

  it('refuses 409 promotion_not_evaluated for an unevaluated version, and moves nothing', async () => {
    const { h, point } = await gated();
    expect(await point('production')).toMatchObject({
      status: 409,
      body: { error: { code: 'promotion_not_evaluated', details: ['version:1', 'bar:0.9'] } },
    });
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('refuses 409 promotion_gate_failed below the bar, then moves once a newer evaluation passes', async () => {
    const { h, versionId, point } = await gated();
    h.provider.recordEvaluation(versionId, {
      score: 0.7,
      passed: 7,
      total: 10,
      failing: ['no refund promises', 'tone'],
    });
    const refused = await point('production');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: {
        code: 'promotion_gate_failed',
        details: ['version:1', 'score:0.7', 'bar:0.9', 'case:no refund promises', 'case:tone'],
      },
    });
    h.provider.recordEvaluation(versionId, { score: 0.9, passed: 9, total: 10, failing: ['tone'] });
    expect((await point('production')).status).toBe(200);
  });

  it('never gates local', async () => {
    const { point } = await gated();
    expect((await point('local')).status).toBe(200);
  });
});
