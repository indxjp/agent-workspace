/**
 * `enforcement.json` (ENG-02b, #318): the save-time capability check against
 * `engineCapabilityRefusal`, and session engine pinning against the **real** `startRun` — the run
 * route, with a run store installed, so that "and creates no run row" is checked on the rows and
 * not on a verdict. Part of the `engines` family; see `engines.test.ts`.
 */
import { EngineCapabilityKeySchema } from '@indx-workspace/contracts/engines';
import { afterEach, describe, expect, it } from 'vitest';

import { installTestRunApi, resetTestRunApi } from '../server/application-context-fixtures';
import { engineCapabilityRefusal } from '../server/agents/policy';
import { sessionForLaunch } from '../server/composition/session-launch';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
} from '../server/engines/registry';
import { startRun } from '../server/runs/api';
import { InMemoryRunStore } from '../server/runs/memory-store';
import { asRecord, asString, loadVectors, type FormalVector } from '../../../tests/formal/vectors';
import { asBoolean, asNullableString, asNumber, asStringArray } from './engines.test-support';

const enforcementVectors = loadVectors('engines', 'enforcement.json');

const ENFORCEMENT_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ENFORCEMENT_AGENT = '33333333-3333-4333-8333-333333333333';
const ENFORCEMENT_SESSION = '44444444-4444-4444-8444-444444444444';
const ENFORCEMENT_PRINCIPAL = '77777777-7777-4777-8777-777777777777';
const ENFORCEMENT_USER = '66666666-6666-4666-8666-666666666666';

/** The vectors whose id starts with `prefix`, as `it.each` rows. */
function vectorsWithPrefix(prefix: string): (readonly [string, FormalVector])[] {
  return enforcementVectors.filter((v) => v.id.startsWith(prefix)).map((v) => [v.id, v] as const);
}

/**
 * A `claude-agent-sdk` descriptor whose three demandable capabilities are the vector's.
 *
 * It replaces the built-in descriptor rather than sitting beside it, which is the only way the
 * refusal is reachable: `AgentPolicy` has one arm, so no engine other than `claude-agent-sdk` can be
 * named by a body that parses at all. Every other field is the real descriptor's.
 */
function registerCapabilities(capabilities: {
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
}): void {
  const claude = registeredEngine('claude-agent-sdk');
  if (claude === null) throw new Error('claude-agent-sdk is not registered');
  // `installed` is dropped rather than carried over: since ENG-07 it is the deployment's configured
  // image map, not a field a descriptor may state (`../server/engines/registry.ts`).
  registerEngineForTests({
    id: claude.id,
    displayName: claude.displayName,
    version: claude.version,
    capabilities: { ...claude.capabilities, ...capabilities },
  });
}

/** Registers the vector's capabilities and returns the refusal its demand draws. */
function refusalForCapabilityVector(vector: FormalVector) {
  const input = asRecord(vector.input, vector.id);
  const capabilities = asRecord(input['capabilities'], `${vector.id} capabilities`);
  const demand = asRecord(input['demand'], `${vector.id} demand`);

  registerCapabilities({
    mcp: asBoolean(capabilities['mcp'], `${vector.id} mcp`),
    skills: asBoolean(capabilities['skills'], `${vector.id} skills`),
    subagents: asBoolean(capabilities['subagents'], `${vector.id} subagents`),
  });
  return engineCapabilityRefusal('claude-agent-sdk', {
    connectors: asBoolean(demand['connectors'], `${vector.id} connectors`),
    skills: asBoolean(demand['skills'], `${vector.id} demanded skills`),
    subagents: asBoolean(demand['subagents'], `${vector.id} demanded subagents`),
  });
}

/** Installs a run API whose agent and session carry the vector's engines; returns its probes. */
function installPinningRunApi(vector: FormalVector) {
  const input = asRecord(vector.input, vector.id);
  const sessionEngine = asNullableString(input['sessionEngine'], `${vector.id} sessionEngine`);
  const agentEngine = asString(input['agentEngine'], `${vector.id} agentEngine`);

  const store = new InMemoryRunStore();
  const launched: unknown[] = [];
  installTestRunApi({
    authenticate: () =>
      Promise.resolve({
        principalId: ENFORCEMENT_PRINCIPAL,
        ownerPrincipalId: ENFORCEMENT_PRINCIPAL,
        userId: ENFORCEMENT_USER,
        workspaceId: ENFORCEMENT_WORKSPACE,
        role: 'owner' as const,
        scope: null,
      }),
    findAgent: (principal, agentId) =>
      Promise.resolve(
        agentId === ENFORCEMENT_AGENT
          ? { id: ENFORCEMENT_AGENT, workspaceId: principal.workspaceId, engine: agentEngine }
          : null,
      ),
    openSession: () =>
      Promise.resolve({
        id: ENFORCEMENT_SESSION,
        agentId: ENFORCEMENT_AGENT,
        engine: sessionEngine,
      }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context) => {
      launched.push(context);
    },
  });
  return { store, launched };
}

function startReplayRun(): Promise<Response> {
  return startRun(
    new Request(`http://web/api/agents/${ENFORCEMENT_AGENT}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'replay', sessionId: ENFORCEMENT_SESSION }),
    }),
    ENFORCEMENT_AGENT,
  );
}

describe('engine enforcement', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
    resetTestRunApi();
  });

  it.each(vectorsWithPrefix('capability/'))('%s', (_id, vector) => {
    const expected = asRecord(vector.expected, vector.id);
    const refusal = refusalForCapabilityVector(vector);

    if (asString(expected['verdict'], vector.id) === 'saved') {
      expect(refusal, `${vector.id} should be saved`).toBeNull();
      expect(expected['details']).toEqual([]);
      return;
    }
    expect(refusal, `${vector.id} should be refused`).not.toBeNull();
    if (refusal === null) return;
    const body = asRecord(refusal.body, `${vector.id} problem body`);
    const error = asRecord(body['error'], `${vector.id} problem error`);
    expect(error['code']).toBe('engine_capability_unsupported');
    expect(refusal.status).toBe(expected['status']);
    // The capability travels as the single `details` entry, and it is one the contract publishes.
    expect(error['details']).toEqual(expected['details']);
    for (const detail of asStringArray(error['details'], `${vector.id} details`)) {
      expect(EngineCapabilityKeySchema.safeParse(detail).success).toBe(true);
    }
  });

  it.each(vectorsWithPrefix('pinning/'))('%s', async (_id, vector) => {
    const expected = asRecord(vector.expected, vector.id);
    const { store, launched } = installPinningRunApi(vector);

    const response = await startReplayRun();

    expect(response.status).toBe(expected['status']);
    const persisted = await store.listRuns(ENFORCEMENT_WORKSPACE, { limit: 10 });
    // The half a verdict cannot state: the rows themselves.
    expect(persisted.items).toHaveLength(asNumber(expected['runsAfter'], `${vector.id} runsAfter`));

    if (asString(expected['verdict'], vector.id) === 'session_engine_mismatch') {
      const body = asRecord(await response.json(), `${vector.id} problem body`);
      const error = asRecord(body['error'], `${vector.id} problem error`);
      expect(error['code']).toBe('session_engine_mismatch');
      expect(launched).toHaveLength(0);
      return;
    }
    const body = asRecord(await response.json(), `${vector.id} run body`);
    const run = asRecord(body['run'], `${vector.id} run`);
    expect(run['engine']).toBe(expected['runEngine']);
    expect(launched).toHaveLength(1);
  });

  it.each(vectorsWithPrefix('pinning/'))(
    '%s carries the session pin into the launch reference',
    (_id, vector) => {
      // The other side of "a run never re-pins the session": the launch reference the route compares
      // against is the session row's own engine, carried across unchanged by `session-launch.ts`.
      const input = asRecord(vector.input, vector.id);
      const expected = asRecord(vector.expected, vector.id);
      const sessionEngine = asNullableString(input['sessionEngine'], `${vector.id} sessionEngine`);
      const ref = sessionForLaunch({
        id: ENFORCEMENT_SESSION,
        workspaceId: ENFORCEMENT_WORKSPACE,
        agentId: ENFORCEMENT_AGENT,
        userId: null,
        ownerPrincipalId: 'principal-1',
        projectId: null,
        engineSessionId: null,
        engine: sessionEngine === null ? null : 'claude-agent-sdk',
        agentVersionId: null,
        title: null,
        status: 'active',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      // A session row can only carry a published engine, so the reference is `null` exactly when the
      // vector's session is unpinned — which is what the expected `sessionEngine` records.
      expect(ref.engine === null).toBe(expected['sessionEngine'] === null);
    },
  );
});
