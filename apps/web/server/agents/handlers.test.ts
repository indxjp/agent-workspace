/**
 * The five handlers of spec §34, exercised through the store port.
 *
 * These assertions are about the *contract a client sees*: which status a case produces, which
 * machine-readable code comes with it, and — the part §25 makes non-negotiable — that a caller in
 * workspace B gets a 404 rather than another workspace's row, and never a 403 that would confirm
 * the row exists.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentPermissions, AgentResource, CreateAgentInput } from '../../contracts/agents';
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  requireAgentId,
  updateAgent,
} from './handlers';
import { type ApiProblem, type ApiResult } from '../http/result';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentStoreProvider, WorkspaceAgentStore } from './store';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const ABSENT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_A = {
  principalId: '66666666-6666-4666-8666-666666666666',
  userId: '88888888-8888-4888-8888-888888888888',
} as const;
const OWNER_B = {
  principalId: '77777777-7777-4777-8777-777777777777',
  userId: '99999999-9999-4999-8999-999999999999',
} as const;

const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

function body(overrides: Partial<CreateAgentInput> = {}): Record<string, unknown> {
  return {
    name: 'Customer Support Agent',
    instructions: 'You help employees answer questions...',
    modelConnectionId: null,
    model: null,
    permissions: { ...PERMISSIONS },
    ...overrides,
  };
}

/** Read the error code out of a failing result, or fail the test saying what shape came back. */
function codeOf(result: ApiResult): string {
  const problem = result.body as Partial<ApiProblem>;
  const code = problem.error?.code;
  if (typeof code !== 'string') {
    throw new Error(`expected an error envelope, received ${JSON.stringify(result.body)}`);
  }
  return code;
}

/** Read the agent out of a succeeding result. */
function agentOf(result: ApiResult): AgentResource {
  return result.body as AgentResource;
}

let provider: AgentStoreProvider;
let a: WorkspaceAgentStore;
let b: WorkspaceAgentStore;

beforeEach(() => {
  provider = createInMemoryAgentStoreProvider({ knownModelConnectionIds: new Set([CONNECTION]) });
  a = provider.forWorkspace(WORKSPACE_A);
  b = provider.forWorkspace(WORKSPACE_B);
});

describe('requireAgentId', () => {
  it('accepts a UUID', () => {
    const outcome = requireAgentId(ABSENT_ID);
    expect(outcome).toEqual({ ok: true, id: ABSENT_ID });
  });

  it('rejects a non-UUID with 400 rather than letting it reach the store', () => {
    for (const value of ['banana', '', undefined, null, 12, {}]) {
      const outcome = requireAgentId(value);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.result.status).toBe(400);
      expect(codeOf(outcome.result)).toBe('invalid_agent_id');
    }
  });
});

describe('POST /api/agents', () => {
  it('returns 201 and the created agent', async () => {
    const result = await createAgent(a, body(), OWNER_A);
    expect(result.status).toBe(201);
    expect(agentOf(result).name).toBe('Customer Support Agent');
    expect(agentOf(result).workspaceId).toBe(WORKSPACE_A);
  });

  it('returns 400 with every field error, not just the first', async () => {
    const result = await createAgent(a, { name: '', instructions: 1, permissions: {} }, OWNER_A);
    expect(result.status).toBe(400);
    expect(codeOf(result)).toBe('invalid_body');
    const problem = result.body as ApiProblem;
    expect(problem.error.details?.length ?? 0).toBeGreaterThan(2);
  });

  it('returns 409 for a duplicate name in the same workspace', async () => {
    await createAgent(a, body(), OWNER_A);
    const result = await createAgent(a, body(), OWNER_A);
    expect(result.status).toBe(409);
    expect(codeOf(result)).toBe('agent_name_conflict');
  });

  it('returns 400 for a modelConnectionId the workspace does not have', async () => {
    const result = await createAgent(a, body({ modelConnectionId: ABSENT_ID }), OWNER_A);
    expect(result.status).toBe(400);
    expect(codeOf(result)).toBe('unknown_model_connection');
  });

  it('returns a body that survives JSON round-tripping', async () => {
    const result = await createAgent(a, body(), OWNER_A);
    expect(JSON.parse(JSON.stringify(result.body))).toEqual(result.body);
  });
});

describe('GET /api/agents', () => {
  it('returns 200 and an empty collection for a workspace with no agents', async () => {
    const result = await listAgents(a);
    expect(result).toEqual({ status: 200, body: { agents: [] } });
  });

  it('returns only the caller’s workspace (spec §25)', async () => {
    await createAgent(a, body({ name: 'A-only' }), OWNER_A);
    await createAgent(b, body({ name: 'B-only' }), OWNER_B);
    const seenByA = listBody(await listAgents(a)).map((x) => x.name);
    const seenByB = listBody(await listAgents(b)).map((x) => x.name);
    expect(seenByA).toEqual(['A-only']);
    expect(seenByB).toEqual(['B-only']);
  });

  it('lists a built-in agent last and keeps the rest in the store order (#1848)', async () => {
    await createAgent(a, body({ name: 'builder' }), OWNER_A);
    await createAgent(a, body({ name: 'Alpha' }), OWNER_A);
    await createAgent(a, body({ name: 'Beta' }), OWNER_A);
    // The memory store keeps no built-in marker (PostgreSQL does); mark the row named `builder`.
    const marked: WorkspaceAgentStore = {
      ...a,
      list: async () =>
        (await a.list()).map((row) =>
          row.name === 'builder' ? { ...row, builtin: 'builder' as const } : row,
        ),
    };
    // Rows created in the same millisecond tie-break by random id, so read the store's own order.
    const storeOrder = (await a.list()).map((row) => row.name).filter((name) => name !== 'builder');
    const listed = listBody(await listAgents(marked));
    expect(listed.map((x) => x.name)).toEqual([...storeOrder, 'builder']);
    expect(listed[2]?.builtin).toBe('builder');
  });
});

function listBody(result: ApiResult): AgentResource[] {
  return (result.body as { agents: AgentResource[] }).agents;
}

describe('GET /api/agents/:id', () => {
  it('returns 200 for an agent in the caller’s workspace', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await getAgent(a, agentOf(createdResult).id);
    expect(result.status).toBe(200);
    expect(agentOf(result).id).toBe(agentOf(createdResult).id);
  });

  it('returns 404 for an id nothing uses', async () => {
    const result = await getAgent(a, ABSENT_ID);
    expect(result.status).toBe(404);
    expect(codeOf(result)).toBe('agent_not_found');
  });

  it('returns 404 — not 403 — for another workspace’s agent (spec §25)', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await getAgent(b, agentOf(createdResult).id);
    expect(result.status).toBe(404);
    expect(codeOf(result)).toBe('agent_not_found');
  });

  it('does not name the agent in a 404, so the message is not an existence oracle', async () => {
    const createdResult = await createAgent(a, body({ name: 'Secret Project Agent' }), OWNER_A);
    const result = await getAgent(b, agentOf(createdResult).id);
    expect(JSON.stringify(result.body)).not.toContain('Secret Project Agent');
  });
});

describe('lineage and archivedAt on read (issue #1851)', () => {
  const LINEAGE = {
    agentId: '44444444-4444-4444-8444-444444444444',
    version: 2,
    runId: 'run_abc',
  };
  const ARCHIVED_AT = new Date('2026-02-03T04:05:06.007Z');

  /** The memory store cannot write lineage (only the builder can), so mark the stored row. */
  function markedStore(id: string): WorkspaceAgentStore {
    const mark = <T extends { id: string }>(row: T) =>
      row.id === id ? { ...row, createdByAgent: LINEAGE, archivedAt: ARCHIVED_AT } : row;
    return {
      ...a,
      list: async () => (await a.list()).map(mark),
      get: async (rowId) => {
        const row = await a.get(rowId);
        return row === null ? null : mark(row);
      },
    };
  }

  it('shows lineage and archivedAt on get and on list', async () => {
    const made = agentOf(await createAgent(a, body({ name: 'Made' }), OWNER_A));
    const store = markedStore(made.id);
    const expected = { createdByAgent: LINEAGE, archivedAt: '2026-02-03T04:05:06.007Z' };
    expect(agentOf(await getAgent(store, made.id))).toMatchObject(expected);
    expect(listBody(await listAgents(store))[0]).toMatchObject(expected);
  });

  it('shows neither for a person-made agent, and an archived agent is still listed', async () => {
    const person = agentOf(await createAgent(a, body({ name: 'Person' }), OWNER_A));
    const made = agentOf(await createAgent(a, body({ name: 'Made' }), OWNER_A));
    const store = markedStore(made.id);
    const read = agentOf(await getAgent(store, person.id));
    expect(read).not.toHaveProperty('createdByAgent');
    expect(read).not.toHaveProperty('archivedAt');
    expect(listBody(await listAgents(store))).toHaveLength(2);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('returns 200 and the updated agent', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await updateAgent(a, agentOf(createdResult).id, { name: 'Renamed' });
    expect(result.status).toBe(200);
    expect(agentOf(result).name).toBe('Renamed');
  });

  it('returns 400 for a body that changes nothing', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await updateAgent(a, agentOf(createdResult).id, {});
    expect(result.status).toBe(400);
    expect(codeOf(result)).toBe('invalid_body');
  });

  it('validates the id before the body, so a bad id is not reported as a bad body', async () => {
    const result = await updateAgent(a, 'banana', { name: '' });
    expect(codeOf(result)).toBe('invalid_agent_id');
  });

  it('returns 409 when the new name is taken in the same workspace', async () => {
    await createAgent(a, body({ name: 'Taken' }), OWNER_A);
    const createdResult = await createAgent(a, body({ name: 'Free' }), OWNER_A);
    const result = await updateAgent(a, agentOf(createdResult).id, { name: 'Taken' });
    expect(result.status).toBe(409);
    expect(codeOf(result)).toBe('agent_name_conflict');
  });

  it('returns 404 for another workspace’s agent, and leaves it unchanged (spec §25)', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await updateAgent(b, agentOf(createdResult).id, { name: 'Hijacked' });
    expect(result.status).toBe(404);
    const after = await getAgent(a, agentOf(createdResult).id);
    expect(agentOf(after).name).toBe('Customer Support Agent');
  });

  it('returns 400 for a modelConnectionId the workspace does not have', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const result = await updateAgent(a, agentOf(createdResult).id, {
      modelConnectionId: ABSENT_ID,
    });
    expect(result.status).toBe(400);
    expect(codeOf(result)).toBe('unknown_model_connection');
  });
});

describe('DELETE /api/agents/:id', () => {
  it('returns 204 with no body, then 404 on a second call', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const id = agentOf(createdResult).id;
    const first = await deleteAgent(a, id);
    expect(first).toEqual({ status: 204, body: null });
    const second = await deleteAgent(a, id);
    expect(second.status).toBe(404);
  });

  it('returns 404 for another workspace’s agent, and does not delete it (spec §25)', async () => {
    const createdResult = await createAgent(a, body(), OWNER_A);
    const id = agentOf(createdResult).id;
    expect((await deleteAgent(b, id)).status).toBe(404);
    expect((await getAgent(a, id)).status).toBe(200);
  });
});
