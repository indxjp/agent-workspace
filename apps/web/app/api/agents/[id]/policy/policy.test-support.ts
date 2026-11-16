import { createInMemoryCatalog } from '@agent-workspace/core/db';
import { afterEach, expect } from 'vitest';
import type {
  AgentPolicy,
  AgentResource,
  AgentResourceAssignments,
} from '../../../../../contracts/agents';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../../../server/agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import type { AgentResourceStoreProvider } from '../../../../../server/agents/resource-store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { registerEngineForTests } from '../../../../../server/engines/registry';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import type { ResourceCatalogStoreProvider } from '../../../../../server/storage/store';
import { POST as createAgentRoute } from '../../route';
import { GET as getRoute, PUT as putRoute } from './route';

/**
 * `GET`/`PUT /api/agents/:id/policy` (S-13), driven with real `Request` objects. Mirrors
 * `resources.test.ts`'s shape in this same directory — the sibling sub-resource route this one was
 * copied from — including the header-driven test resolver `apps/web/server/agents/routes.test.ts`
 * explains at length: it hands an attacker full control of the workspace identity and then proves
 * workspace B still cannot reach workspace A's row.
 *
 * The role matrix itself (Owner/Admin/Builder-own/Builder-other/Viewer, crossed with `decide()`'s
 * four ownership answers) is `apps/web/server/rbac/authorisation-matrix.test.ts`'s job — it derives
 * the whole closed-world matrix from `tests/route-declarations/SDK-02-AGENT-POLICY-234.ts` and
 * `apps/web/server/rbac/core/declarations/SDK-02-AGENT-POLICY-234.ts` and asserts no cell is undecided.
 * This file proves the two routes actually reach the store, the catalog and the 409/400/503
 * refusals `decide()` cannot express.
 */
export const WORKSPACE_A = '66666666-6666-4666-8666-666666666666';

const WORKSPACE_HEADER = 'x-test-workspace';

const ACTOR_HEADER = 'x-test-actor';

/** The shared in-memory catalog with one skill, `triage`, that every workspace's lookup sees. */
const skillCatalogRows = createInMemoryCatalog().forWorkspace(WORKSPACE_A);

export const SKILL_ID = (
  await skillCatalogRows.putSkill({
    name: 'triage',
    skillMd: '# Triage',
    enabled: true,
    ownerPrincipalId: 'owner',
  })
).id;

export const CONNECTOR_ID = '88888888-8888-4888-8888-888888888888';

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

export function validPolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['triage'] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
    ...overrides,
  };
}

function skillCatalog(): ResourceCatalogStoreProvider {
  return { forWorkspace: () => Promise.resolve(skillCatalogRows) };
}

/** `skillsConfigured: false` leaves `skillCatalog` unwired, for the 503 test. */
export function useMemoryRuntime(
  options: { readonly skillsConfigured?: boolean } = {},
): InMemoryAgentVersionStoreProvider {
  const skillsConfigured = options.skillsConfigured ?? true;
  const assignments = new Map<string, AgentResourceAssignments>();
  const agents = createInMemoryAgentStoreProvider({ assignments });
  const agentResources = policyResourceStore(agents, assignments);
  installTestDomains({
    agents: {
      agents,
      agentResources,
      ...(skillsConfigured ? { skillCatalog: skillCatalog() } : {}),
      resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? { kind: 'unauthenticated', reason: 'no test workspace header' }
            : { kind: 'workspace', workspaceId },
        );
      },
    },
  });
  // Issue #616: a policy PUT saves a version, so the version store is part of the runtime.
  const versions = createInMemoryAgentVersionStoreProvider({
    agents,
    resources: agentResources,
    references: {
      [WORKSPACE_A]: {
        skill: [{ id: SKILL_ID, name: 'triage' }],
        connector: [{ id: CONNECTOR_ID, name: 'github' }],
      },
    },
  });
  installTestDomains({ agentVersions: { versions } });
  installPolicyRbac();
  return versions;
}

export function request(
  method: string,
  url: string,
  options: { workspace?: string; body?: string; actor?: string } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.actor !== undefined) headers.set(ACTOR_HEADER, options.actor);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

export async function createAsBuilderA(): Promise<AgentResource> {
  const response = await createAgentRoute(
    request('POST', '/api/agents', {
      workspace: WORKSPACE_A,
      body: CREATE_BODY,
      actor: 'builder-a@example.test',
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as AgentResource;
}

export function registerClaudeWithout(capability: 'mcp' | 'skills'): void {
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

export async function createWithAssignments(
  assignments: AgentResourceAssignments,
): Promise<AgentResource> {
  const response = await createAgentRoute(
    request('POST', '/api/agents', {
      workspace: WORKSPACE_A,
      actor: 'builder-a@example.test',
      body: JSON.stringify({ agent: JSON.parse(CREATE_BODY) as unknown, assignments }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const { agent } = (await response.json()) as { agent: AgentResource };
  return agent;
}

export async function putPolicy(agentId: string, policy: unknown): Promise<Response> {
  return putRoute(
    request('PUT', `/api/agents/${agentId}/policy`, {
      workspace: WORKSPACE_A,
      actor: 'builder-a@example.test',
      body: JSON.stringify(policy),
    }),
    idContext(agentId),
  );
}

export async function readPolicy(agentId: string): Promise<AgentPolicy> {
  const response = await getRoute(
    request('GET', `/api/agents/${agentId}/policy`, {
      workspace: WORKSPACE_A,
      actor: 'builder-a@example.test',
    }),
    idContext(agentId),
  );
  return ((await response.json()) as { policy: AgentPolicy }).policy;
}

export async function readPolicyBody(agentId: string): Promise<Record<string, unknown>> {
  const response = await getRoute(
    request('GET', `/api/agents/${agentId}/policy`, {
      workspace: WORKSPACE_A,
      actor: 'builder-a@example.test',
    }),
    idContext(agentId),
  );
  return (await response.json()) as Record<string, unknown>;
}
afterEach(() => {
  clearApplicationContext();
});

function policyResourceStore(
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
function installPolicyRbac() {
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
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
        const actor = request.headers.get(ACTOR_HEADER);
        return Promise.resolve(
          workspaceId === null || actor === null
            ? null
            : Principal.fromApiKey({
                principalId:
                  actor === 'builder-a@example.test'
                    ? '36377a6a-7a0b-4610-8efc-d31547dcc38a'
                    : 'c1353585-43d3-45dd-8276-edf59109fdfa',
                apiKeyId:
                  actor === 'builder-a@example.test'
                    ? '04aa9a6d-4862-41ce-b910-b43ba3f4d12f'
                    : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                workspaceId,
                role: 'builder',
                label:
                  actor === 'builder-a@example.test'
                    ? 'Builder A policy key'
                    : 'Builder B policy key',
              }),
        );
      },
    },
  });
}
