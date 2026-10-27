/**
 * The policy use cases called directly, without the route (W2-4): the results they return before
 * the route wrapper turns them into responses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FIXTURE_POLICY } from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import type { ApiResult } from '../http/result';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { createInMemoryAgentStoreProvider } from './memory-store';
import { getAgentPolicy, updateAgentPolicy } from './policy-update';
import type { AgentStoreProvider } from './store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const MISSING = 'f0000000-0000-4000-8000-0000000000f1';

let agents: AgentStoreProvider;
let agentId: string;

function install(options: { readonly policyConfigured: boolean }): void {
  installTestDomains({
    agents: {
      agents,
      ...(options.policyConfigured
        ? {
            agentResources: {
              forWorkspace: () => ({
                get: () =>
                  Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
                replace: () => Promise.resolve({ kind: 'not-found' as const }),
              }),
            },
            skillCatalog: {
              forWorkspace: () =>
                Promise.resolve({ listSkills: () => Promise.resolve([]) } as unknown as Awaited<
                  ReturnType<ResourceCatalogStoreProvider['forWorkspace']>
                >),
            },
          }
        : {}),
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
  installTestDomains({
    agentVersions: { versions: createInMemoryAgentVersionStoreProvider({ agents }) },
  });
}

beforeEach(async () => {
  agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: 'claude-sonnet-4-5',
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentId = created.agent.id;
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: OWNER,
            apiKeyId: 'b0000000-0000-4000-8000-000000000001',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'owner key',
          }),
        ),
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) =>
  new Request('http://localhost/api/agents/x/policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = () => new Request('http://localhost/api/agents/x/policy');

function result(value: ApiResult | Response): ApiResult {
  if (value instanceof Response) throw new Error(`expected a result, got ${value.status}`);
  return value;
}
function code(value: ApiResult | Response): unknown {
  return (result(value).body as { error?: { code?: string } }).error?.code;
}

describe('getAgentPolicy', () => {
  it('reads the effective policy of an agent in the caller workspace', async () => {
    install({ policyConfigured: true });
    const read = result(await getAgentPolicy(get(), params(agentId)));
    expect(read.status).toBe(200);
    expect(read.body).toHaveProperty('policy');
    expect(read.body).toHaveProperty('source');
  });

  it('answers 404 for an unknown agent', async () => {
    install({ policyConfigured: true });
    const read = await getAgentPolicy(get(), params(MISSING));
    expect(read.status).toBe(404);
  });

  it('answers 503 when the deployment has no policy wiring', async () => {
    install({ policyConfigured: false });
    const read = await getAgentPolicy(get(), params(agentId));
    expect(read.status).toBe(503);
    expect(code(read)).toBe('agent_policy_not_configured');
  });
});

describe('updateAgentPolicy', () => {
  it('saves the policy and answers it as stored', async () => {
    install({ policyConfigured: true });
    const saved = result(await updateAgentPolicy(put(FIXTURE_POLICY), params(agentId)));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ policy: FIXTURE_POLICY, source: 'stored' });
  });

  it('refuses an allowlisted skill the agent has no assignment for', async () => {
    install({ policyConfigured: true });
    const refused = await updateAgentPolicy(
      put({ ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: ['pdf'] } }),
      params(agentId),
    );
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('skill_not_assigned');
  });

  it('answers 404 for an unknown agent before reading the body', async () => {
    install({ policyConfigured: true });
    const refused = await updateAgentPolicy(put('not a policy'), params(MISSING));
    expect(refused.status).toBe(404);
  });
});
