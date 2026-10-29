/** An archived agent is hidden from the list and its pointers and versions are frozen (#1851). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as getAgent } from '../../app/api/agents/[id]/route';
import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { POST as postPromote } from '../../app/api/agents/[id]/promote/route';
import { POST as postRollback } from '../../app/api/agents/[id]/rollback/route';
import { GET as getVersions, POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import { GET as getAgents } from '../../app/api/agents/route';
import { FIXTURE_PERMISSIONS, versionRequest } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentStoreProvider } from './store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = 'a0000000-0000-4000-8000-000000000001';
const ARCHIVED_AT = new Date('2026-10-01T00:00:00.000Z');

let agents: AgentStoreProvider;
let archived: Set<string>;
let active: string;
let frozen: string;

/** The memory store cannot write `archived_at`, so the rows of `archived` are marked as they are read. */
function marking(store: AgentStoreProvider, ids: ReadonlySet<string>): AgentStoreProvider {
  return {
    forWorkspace: (workspaceId) => {
      const inner = store.forWorkspace(workspaceId);
      const mark = <T extends { id: string }>(row: T) =>
        ids.has(row.id) ? { ...row, archivedAt: ARCHIVED_AT } : row;
      return {
        ...inner,
        list: async () => (await inner.list()).map(mark),
        get: async (id) => {
          const row = await inner.get(id);
          return row === null ? null : mark(row);
        },
      };
    },
  };
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

async function problemCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { code?: unknown } }).error?.code;
}

async function createAgent(name: string): Promise<string> {
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name,
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture');
  return created.agent.id;
}

async function saveVersionAndPointLocal(id: string, name: string): Promise<void> {
  const saved = await postVersion(
    request('POST', `/api/agents/${id}/versions`, versionRequest({ name })),
    context(id),
  );
  expect(saved.status).toBe(201);
  const pointed = await putPointer(
    request('PUT', `/api/agents/${id}/pointers`, { environment: 'local', version: 1 }),
    context(id),
  );
  expect(pointed.status).toBe(200);
}

beforeEach(async () => {
  archived = new Set();
  const store = marking(createInMemoryAgentStoreProvider(), archived);
  agents = store;
  active = await createAgent('active');
  frozen = await createAgent('frozen');
  installTestDomains({
    agents: {
      agents: store,
      agentResources: {
        forWorkspace: () => ({
          get: () =>
            Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
          replace: () => Promise.resolve({ kind: 'not-found' as const }),
        }),
      },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      ceiling: { kind: 'disabled' },
    },
    agentVersions: {
      versions: createInMemoryAgentVersionStoreProvider({ agents: store }),
      ceiling: { kind: 'disabled' },
    },
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: PRINCIPAL,
            apiKeyId: 'b0000000-0000-4000-8000-000000000001',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'owner key',
          }),
        ),
    },
  });
  await saveVersionAndPointLocal(active, 'active');
  await saveVersionAndPointLocal(frozen, 'frozen');
});

afterEach(clearApplicationContext);

async function listedNames(query = ''): Promise<string[]> {
  const response = await getAgents(request('GET', `/api/agents${query}`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { agents: { name: string }[] };
  return body.agents.map((agent) => agent.name).sort();
}

describe('archived agents (issue #1851 slice 4)', () => {
  it('an archived agent is hidden from the agent list, shown with ?archived=include, and its pointers cannot move', async () => {
    archived.add(frozen);

    expect(await listedNames()).toEqual(['active']);
    expect(await listedNames('?archived=include')).toEqual(['active', 'frozen']);
    const listed = (await (
      await getAgents(request('GET', '/api/agents?archived=include'))
    ).json()) as {
      agents: { id: string; archivedAt?: string }[];
    };
    expect(listed.agents.find((agent) => agent.id === frozen)?.archivedAt).toBe(
      ARCHIVED_AT.toISOString(),
    );

    const read = await getAgent(request('GET', `/api/agents/${frozen}`), context(frozen));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { archivedAt?: string }).archivedAt).toBe(
      ARCHIVED_AT.toISOString(),
    );

    const moves = [
      putPointer(
        request('PUT', `/api/agents/${frozen}/pointers`, { environment: 'local', version: 1 }),
        context(frozen),
      ),
      postPromote(request('POST', `/api/agents/${frozen}/promote`, {}), context(frozen)),
      postRollback(request('POST', `/api/agents/${frozen}/rollback`, {}), context(frozen)),
      postVersion(
        request('POST', `/api/agents/${frozen}/versions`, versionRequest({ name: 'frozen' })),
        context(frozen),
      ),
    ];
    for (const response of await Promise.all(moves)) {
      expect(response.status).toBe(409);
      expect(await problemCode(response)).toBe('agent_archived');
    }

    const listing = (await (
      await getVersions(request('GET', `/api/agents/${frozen}/versions`), context(frozen))
    ).json()) as { items: unknown[]; pointers: { environment: string; number: number }[] };
    expect(listing.items).toHaveLength(1);
    expect(listing.pointers).toEqual([
      expect.objectContaining({ environment: 'local', number: 1 }),
    ]);
  });

  it('refuses a repeated or unknown ?archived= with 400 invalid_agent_list_query', async () => {
    for (const query of ['?archived=include&archived=x', '?archived=all']) {
      const response = await getAgents(request('GET', `/api/agents${query}`));
      expect(response.status).toBe(400);
      expect(await problemCode(response)).toBe('invalid_agent_list_query');
    }
  });

  it('does not refuse the same moves on an active agent as archived', async () => {
    archived.add(frozen);

    const responses = [
      await putPointer(
        request('PUT', `/api/agents/${active}/pointers`, { environment: 'local', version: 1 }),
        context(active),
      ),
      await postPromote(request('POST', `/api/agents/${active}/promote`, {}), context(active)),
      await postRollback(request('POST', `/api/agents/${active}/rollback`, {}), context(active)),
      await postVersion(
        request('POST', `/api/agents/${active}/versions`, versionRequest({ name: 'active' })),
        context(active),
      ),
    ];
    for (const response of responses)
      expect(await problemCode(response)).not.toBe('agent_archived');
  });
});
