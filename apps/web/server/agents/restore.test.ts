/** `POST /api/agents/:id/restore` brings back an archived agent and records it (issue #1851 slice 4). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import { POST as postRestore } from '../../app/api/agents/[id]/restore/route';
import { versionRequest } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { createInMemoryAgentStoreProvider } from './memory-store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER_PRINCIPAL = 'a0000000-0000-4000-8000-000000000001';
const OTHER_PRINCIPAL = 'a0000000-0000-4000-8000-000000000002';
const ARCHIVED_AT = new Date('2026-10-01T00:00:00.000Z');
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

let agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
let caller: { role: Role; principalId: string };
let agentId: string;

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function restoreRequest(body?: string): Request {
  return new Request('http://localhost/api/agents/x/restore', {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const store = () => agents.forWorkspace(WORKSPACE);

async function problemCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { code?: unknown } }).error?.code;
}

beforeEach(async () => {
  agents = createInMemoryAgentStoreProvider();
  caller = { role: 'owner', principalId: OWNER_PRINCIPAL };
  const created = await store().create(
    {
      name: 'archived-agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: PERMISSIONS,
    },
    { principalId: OWNER_PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture');
  agentId = created.agent.id;
  agents.archive(WORKSPACE, agentId, ARCHIVED_AT);
  installTestDomains({
    agents: {
      agents,
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
      versions: createInMemoryAgentVersionStoreProvider({ agents }),
      ceiling: { kind: 'disabled' },
    },
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: caller.principalId,
            apiKeyId: 'b0000000-0000-4000-8000-000000000001',
            workspaceId: WORKSPACE,
            role: caller.role,
            label: 'test key',
          }),
        ),
    },
  });
});

afterEach(clearApplicationContext);

describe('POST /api/agents/:id/restore (issue #1851 slice 4)', () => {
  it('restoring an archived agent through the API clears archived_at and writes an agent-changed audit row', async () => {
    const response = await postRestore(restoreRequest(), context(agentId));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; archivedAt?: unknown };
    expect(body.id).toBe(agentId);
    expect(body.archivedAt).toBeUndefined();
    expect((await store().get(agentId))?.archivedAt).toBeUndefined();
    expect(agents.audits()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        action: 'agent-changed',
        subjectId: agentId,
        subjectLabel: 'archived-agent',
        actorPrincipalId: OWNER_PRINCIPAL,
        details: { archived: false },
      }),
    ]);
  });

  it.each([
    ['an Admin', 'admin', OTHER_PRINCIPAL],
    ['the Owner role', 'owner', OTHER_PRINCIPAL],
    ['the agent’s owner, a Builder', 'builder', OWNER_PRINCIPAL],
  ] as const)('lets %s restore', async (_who, role, principalId) => {
    caller = { role, principalId };

    expect((await postRestore(restoreRequest(), context(agentId))).status).toBe(200);
    expect((await store().get(agentId))?.archivedAt).toBeUndefined();
  });

  it.each([
    ['a Builder who does not own the agent', 'builder'],
    ['a Viewer', 'viewer'],
  ] as const)('refuses %s with 403 and changes nothing', async (_who, role) => {
    caller = { role, principalId: OTHER_PRINCIPAL };

    const response = await postRestore(restoreRequest(), context(agentId));

    expect(response.status).toBe(403);
    expect((await store().get(agentId))?.archivedAt).toEqual(ARCHIVED_AT);
    expect(agents.audits()).toEqual([]);
  });

  it('answers 404 for an unknown or malformed id', async () => {
    const unknown = await postRestore(restoreRequest(), context(crypto.randomUUID()));
    const malformed = await postRestore(restoreRequest(), context('not-a-uuid'));

    expect(unknown.status).toBe(404);
    expect(await problemCode(unknown)).toBe('agent_not_found');
    expect(malformed.status).toBe(404);
  });

  it('is a 200 no-op for an agent that is not archived, and writes no audit row', async () => {
    expect((await postRestore(restoreRequest(), context(agentId))).status).toBe(200);

    const again = await postRestore(restoreRequest(), context(agentId));

    expect(again.status).toBe(200);
    expect(agents.audits()).toHaveLength(1);
  });

  it('refuses a request that carries a body', async () => {
    const response = await postRestore(restoreRequest('{}'), context(agentId));

    expect(response.status).toBe(400);
    expect(await problemCode(response)).toBe('malformed_body');
    expect((await store().get(agentId))?.archivedAt).toEqual(ARCHIVED_AT);
  });

  it('unfreezes the agent: a pointer move is refused while archived and succeeds after the restore', async () => {
    const pointer = () =>
      putPointer(
        jsonRequest('PUT', `/api/agents/${agentId}/pointers`, { environment: 'local', version: 1 }),
        context(agentId),
      );
    const frozen = await pointer();
    expect(frozen.status).toBe(409);
    expect(await problemCode(frozen)).toBe('agent_archived');

    expect((await postRestore(restoreRequest(), context(agentId))).status).toBe(200);

    const saved = await postVersion(
      jsonRequest('POST', `/api/agents/${agentId}/versions`, versionRequest({ name: 'archived' })),
      context(agentId),
    );
    expect(saved.status).toBe(201);
    expect((await pointer()).status).toBe(200);
  });
});
