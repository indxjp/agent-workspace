import { expect } from 'vitest';

import { POST as createRoute } from '../../app/api/agents/route';
import type { AgentResource, AgentResourceAssignments } from '../../contracts/agents';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../agent-versions/memory-store';
import { installTestDomains } from '../application-context-fixtures';
import type { Role } from '../rbac/core/roles';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentResourceStoreProvider } from './resource-store';
import { type WorkspaceResolution } from './runtime';

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

/** The workspace a request acts in, taken from a header **only in this test**. */
export const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, taken from a header only here. */
export const ACTOR_HEADER = 'x-test-actor';

const DEFAULT_ACTOR = {
  principalId: '1353503f-91fc-4c4c-89d4-e7f1dd35386c',
  apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  label: 'Agent route test key',
};
const BUILDERS: Readonly<Record<string, typeof DEFAULT_ACTOR>> = {
  'builder-a@example.test': {
    principalId: '819aac78-a253-48ca-bb59-638a37531f1d',
    apiKeyId: '10a92952-c0a5-43e1-a7f0-901b32dcaedc',
    label: 'Builder A automation',
  },
  'builder-b@example.test': {
    principalId: '54450291-6b86-470a-819a-d242b67bcdba',
    apiKeyId: '3d469b13-fdb5-4206-895a-37f762c28ea1',
    label: 'Builder B automation',
  },
};

function identifyRequest(request: Request, role: Role): Principal | null {
  const workspaceId = request.headers.get(WORKSPACE_HEADER);
  if (workspaceId === null) return null;
  const actor = request.headers.get(ACTOR_HEADER) ?? 'agent-route-test';
  return Principal.fromApiKey({ ...(BUILDERS[actor] ?? DEFAULT_ACTOR), workspaceId, role });
}

function createAssignmentStore(
  agents: ReturnType<typeof createInMemoryAgentStoreProvider>,
  assignments: Map<string, AgentResourceAssignments>,
): AgentResourceStoreProvider {
  return {
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
}

function createFixtureDirectory() {
  return createMemoryDirectory({
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
      // Ownership tests need two distinct members of the same workspace.
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
  });
}

/**
 * Install a runtime whose resolver reads the workspace from a request header.
 *
 * Production resolves the authenticated workspace. The isolation tests deliberately
 * give an attacker control of the workspace header: the test
 * gives an attacker the strongest position there is, full control of the workspace identity, and
 * then asserts that workspace B still cannot reach workspace A's row.
 */
export function useMemoryRuntime(role: Role = 'owner'): InMemoryAgentVersionStoreProvider {
  const assignments = new Map<string, AgentResourceAssignments>();
  const agents = createInMemoryAgentStoreProvider({ assignments });
  const agentResources = createAssignmentStore(agents, assignments);
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
      directory: createFixtureDirectory(),
      identify: (request) => Promise.resolve(identifyRequest(request, role)),
    },
  });
  return versions;
}

export function request(
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
export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

export const CREATE_BODY = JSON.stringify({
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

export async function bodyOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

export async function createIn(workspace: string, actor?: string): Promise<AgentResource> {
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
