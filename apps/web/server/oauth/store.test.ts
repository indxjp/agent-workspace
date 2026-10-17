/**
 * The repository-backed OAuth runtime reads the agents of a consent from the database root. The
 * in-process agents runtime is deliberately never configured here: that is the case under test.
 */
import {
  createInMemoryWorkspaceScopeResolver,
  type AgentRecord,
  type EndpointClientRecord,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { createRepositoryOAuthRuntime } from './store';

const WORKSPACE = crypto.randomUUID();
const PRINCIPAL = crypto.randomUUID();

const agent = (name: string): AgentRecord => ({
  id: crypto.randomUUID(),
  workspaceId: WORKSPACE,
  name,
  instructions: '',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  policy: null,
  createdBy: null,
  ownerPrincipalId: PRINCIPAL,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const first = agent('first <b>');
const second = agent('second');

function setup(kind: 'mcp-project' | 'a2a-agent') {
  const known = new Map([first, second].map((a) => [a.id, a]));
  const clientId = crypto.randomUUID();
  const bound: EndpointClientRecord = {
    id: clientId,
    workspaceId: WORKSPACE,
    name: 'client name',
    kind,
    agentIds: [first.id],
    toolNames: null,
    redirectUris: [],
    hasClientSecret: false,
    actsForPrincipalId: PRINCIPAL,
    createdByPrincipalId: PRINCIPAL,
    apiKeyIds: [],
    revokedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const unused = () => {
    throw new Error('not used by this test');
  };
  const runtime = createRepositoryOAuthRuntime({
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    agents: { forScope: () => ({ get: (id) => Promise.resolve(known.get(id) ?? null) }) },
    agentGrants: { forScope: unused },
    endpointClients: { forScope: () => ({ get: () => Promise.resolve(bound) }) },
    findOAuthClient: (id) =>
      Promise.resolve(
        id === clientId
          ? {
              id,
              workspaceId: WORKSPACE,
              name: bound.name,
              kind,
              actsForPrincipalId: PRINCIPAL,
              clientSecretHash: null,
              redirectUris: [],
            }
          : null,
      ),
    oauthTokens: { forScope: unused },
    auditEventRepository: { forScope: unused },
    directory: { principalById: unused },
  });
  return { clientId, runtime };
}

describe('createRepositoryOAuthRuntime', () => {
  it('names the agents in the order asked, without the agents runtime', async () => {
    const { runtime } = setup('mcp-project');
    expect(await runtime.agentNames(WORKSPACE, [second.id, first.id])).toEqual([
      'second',
      'first <b>',
    ]);
  });

  it('answers null, not a shorter list, when an agent no longer exists', async () => {
    const { runtime } = setup('mcp-project');
    expect(await runtime.agentNames(WORKSPACE, [first.id, crypto.randomUUID()])).toBeNull();
  });

  it('addresses an a2a client by its agent name without the agents runtime', async () => {
    const { runtime, clientId } = setup('a2a-agent');
    expect(await runtime.findClient(clientId)).toMatchObject({
      agentIds: [first.id],
      resourcePath: `/api/a2a/agents/${encodeURIComponent(first.name)}`,
    });
  });

  it('gives an mcp-project client its project path', async () => {
    const { runtime, clientId } = setup('mcp-project');
    expect(await runtime.findClient(clientId)).toMatchObject({
      resourcePath: '/mcp/projects/client%20name',
    });
  });
});

describe('canRunAll without the agents runtime', () => {
  const OTHER_WORKSPACE = crypto.randomUUID();
  const MEMBER_PRINCIPAL = crypto.randomUUID();
  const MEMBER_USER = crypto.randomUUID();

  const memberIn = (workspaceId: string, role: Role) =>
    Principal.fromDirectoryRecord({
      principalId: MEMBER_PRINCIPAL,
      kind: 'membership',
      workspaceId,
      role,
      label: 'member',
      userId: MEMBER_USER,
      apiKeyId: null,
      actsForPrincipalId: null,
    });

  /** Agents are keyed by workspace so that a read through the wrong scope finds nothing. */
  function runtimeOf(agents: readonly AgentRecord[], grantedAgentIds: readonly string[] = []) {
    const scopesRead: string[] = [];
    const unused = () => {
      throw new Error('not used by this test');
    };
    const runtime = createRepositoryOAuthRuntime({
      scopes: createInMemoryWorkspaceScopeResolver([
        { id: WORKSPACE, slug: 'acme' },
        { id: OTHER_WORKSPACE, slug: 'other' },
      ]),
      agents: {
        forScope: (scope) => {
          scopesRead.push(scope.workspaceId);
          return {
            get: (id) =>
              Promise.resolve(
                agents.find((a) => a.id === id && a.workspaceId === scope.workspaceId) ?? null,
              ),
          };
        },
      },
      agentGrants: {
        forScope: (scope) => {
          scopesRead.push(scope.workspaceId);
          return {
            hasGrant: (agentId, userId) =>
              Promise.resolve(
                scope.workspaceId === WORKSPACE &&
                  userId === MEMBER_USER &&
                  grantedAgentIds.includes(agentId),
              ),
          };
        },
      },
      endpointClients: { forScope: unused },
      findOAuthClient: unused,
      oauthTokens: { forScope: unused },
      auditEventRepository: { forScope: unused },
      directory: { principalById: unused },
    });
    return { runtime, scopesRead };
  }

  const ownedBy = (a: AgentRecord, ownerPrincipalId: string): AgentRecord => ({
    ...a,
    ownerPrincipalId,
  });

  it('lets a builder run agents they own', async () => {
    const { runtime } = runtimeOf([
      ownedBy(first, MEMBER_PRINCIPAL),
      ownedBy(second, MEMBER_PRINCIPAL),
    ]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'builder'), [first.id, second.id])).toBe(
      true,
    );
  });

  it('lets a viewer run agents granted to them', async () => {
    const { runtime } = runtimeOf([first, second], [first.id, second.id]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'viewer'), [first.id, second.id])).toBe(
      true,
    );
  });

  it('refuses when one agent of the client is not granted', async () => {
    const { runtime } = runtimeOf([first, second], [first.id]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'viewer'), [first.id, second.id])).toBe(
      false,
    );
  });

  it('refuses a builder who neither owns nor was granted an agent', async () => {
    const { runtime } = runtimeOf([first, second]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'builder'), [first.id])).toBe(false);
  });

  it('refuses an agent that does not exist', async () => {
    const { runtime } = runtimeOf([ownedBy(first, MEMBER_PRINCIPAL)]);
    expect(
      await runtime.canRunAll(memberIn(WORKSPACE, 'owner'), [first.id, crypto.randomUUID()]),
    ).toBe(false);
  });

  it("reads agents and grants only through the principal's own workspace", async () => {
    const foreign = { ...ownedBy(first, MEMBER_PRINCIPAL), workspaceId: OTHER_WORKSPACE };
    const { runtime, scopesRead } = runtimeOf([foreign], [foreign.id]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'owner'), [foreign.id])).toBe(false);
    expect(scopesRead.length).toBeGreaterThan(0);
    expect(new Set(scopesRead)).toEqual(new Set([WORKSPACE]));
  });
});
