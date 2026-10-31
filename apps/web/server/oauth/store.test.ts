/**
 * The repository-backed OAuth runtime reads the agents of a consent from the database root. The
 * in-process agents runtime is deliberately never configured here: that is the case under test.
 */
import {
  createInMemoryWorkspaceScopeResolver,
  type AgentRecord,
  type EndpointClientRecord,
  type ExchangedTokenAudit,
  type IssueOAuthTokenInput,
} from '@agent-workspace/core/db';
import type { EndpointClientKind } from '@indx-workspace/contracts/endpoint-clients';
import { describe, expect, it } from 'vitest';

import { Principal } from '../rbac/principal';
import type { Role } from '../rbac/roles';
import { createRepositoryOAuthRuntime } from './store';

const WORKSPACE = crypto.randomUUID();
const PRINCIPAL = crypto.randomUUID();
/** Differs from the creator so the consent label cannot come from the acts-for principal. */
const ACTS_FOR = crypto.randomUUID();
const ISSUER = 'https://idp.example';
const PERSON = crypto.randomUUID();
const OTHER_WORKSPACE = crypto.randomUUID();

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

function setup(kind: EndpointClientKind, memberWorkspace: string = WORKSPACE) {
  const memberOf = PRINCIPAL;
  const known = new Map([first, second].map((a) => [a.id, a]));
  const clientId = crypto.randomUUID();
  const bound: EndpointClientRecord = {
    id: clientId,
    workspaceId: WORKSPACE,
    name: 'client name',
    kind,
    agentIds: kind === 'builder' ? [] : [first.id],
    toolNames: null,
    redirectUris: [],
    oidcAudience: kind === 'app-backend' ? 'portal-web' : null,
    hasClientSecret: false,
    actsForPrincipalId: ACTS_FOR,
    createdByPrincipalId: PRINCIPAL,
    apiKeyIds: [],
    revokedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const unused = () => {
    throw new Error('not used by this test');
  };
  const exchanged: { input: IssueOAuthTokenInput; audit: ExchangedTokenAudit }[] = [];
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
              actsForPrincipalId: ACTS_FOR,
              clientSecretHash: null,
              redirectUris: [],
              oidcAudience: bound.oidcAudience,
            }
          : null,
      ),
    oauthTokens: {
      forScope: () => ({
        issue: unused,
        consume: unused,
        revokeFamily: unused,
        revoke: unused,
        issueExchanged: (input, audit) => {
          exchanged.push({ input, audit });
          return Promise.resolve();
        },
      }),
    },
    auditEventRepository: { forScope: unused },
    directory: {
      findIdentity: (issuer, subject) =>
        Promise.resolve(
          issuer === ISSUER && subject === 'person-sub'
            ? { userId: PERSON, email: 'p@x.test' }
            : null,
        ),
      membershipsForUser: (userId) =>
        Promise.resolve(
          userId === PERSON
            ? [
                {
                  principalId: memberOf,
                  workspaceId: memberWorkspace,
                  workspaceSlug: 'acme',
                  workspaceName: 'Acme',
                  role: 'builder' as const,
                },
              ]
            : [],
        ),
      principalById: (_workspaceId, principalId) =>
        Promise.resolve(
          principalId === PRINCIPAL
            ? {
                principalId,
                kind: 'membership',
                role: 'admin',
                label: 'Ada Lovelace',
                userId: crypto.randomUUID(),
                apiKeyId: null,
                actsForPrincipalId: null,
              }
            : null,
        ),
    },
  });
  return { clientId, runtime, exchanged };
}

describe('createRepositoryOAuthRuntime: the token exchange (ADR-0161)', () => {
  it('finds a member of the client workspace by (issuer, subject), with the label', async () => {
    const { runtime } = setup('app-backend');
    expect(await runtime.findMember(WORKSPACE, ISSUER, 'person-sub')).toEqual({
      userId: PERSON,
      principalId: PRINCIPAL,
      label: 'Ada Lovelace',
    });
  });

  it('answers null alike for an unknown pair, another issuer and a member of another workspace', async () => {
    const { runtime } = setup('app-backend');
    expect(await runtime.findMember(WORKSPACE, ISSUER, 'nobody')).toBeNull();
    expect(await runtime.findMember(WORKSPACE, 'https://evil.example', 'person-sub')).toBeNull();
    const elsewhere = setup('app-backend', OTHER_WORKSPACE);
    expect(await elsewhere.runtime.findMember(WORKSPACE, ISSUER, 'person-sub')).toBeNull();
  });

  it('carries the oidcAudience and no resource path for an app-backend client', async () => {
    const { runtime, clientId } = setup('app-backend');
    expect(await runtime.findClient(clientId)).toMatchObject({
      kind: 'app-backend',
      oidcAudience: 'portal-web',
      resourcePath: null,
    });
  });

  it('writes the token and its audit row in one call, the person acting on the client', async () => {
    const { runtime, clientId, exchanged } = setup('app-backend');
    const client = await runtime.findClient(clientId);
    if (client === null) throw new Error('fixture client missing');
    const expiresAt = new Date(1_000_000);
    await runtime.issueExchanged(
      client,
      { userId: PERSON, principalId: PRINCIPAL, label: 'Ada Lovelace' },
      { id: 'row', tokenHash: 'hash', familyId: 'family', resource: 'urn:x', expiresAt },
    );
    expect(exchanged).toEqual([
      {
        input: {
          id: 'row',
          clientId,
          kind: 'access',
          tokenHash: 'hash',
          subjectPrincipalId: PRINCIPAL,
          resource: 'urn:x',
          familyId: 'family',
          expiresAt,
        },
        audit: {
          actorPrincipalId: PRINCIPAL,
          actorUserId: PERSON,
          actorLabel: 'Ada Lovelace',
          clientId,
          clientName: 'client name',
        },
      },
    ]);
  });
});

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

describe('a builder client', () => {
  it('has the fixed /mcp/builder resource and no agent binding', async () => {
    const { runtime, clientId } = setup('builder');
    expect(await runtime.findClient(clientId)).toMatchObject({
      kind: 'builder',
      agentIds: [],
      resourcePath: '/mcp/builder',
      creatorLabel: 'Ada Lovelace',
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
      directory: { principalById: unused, findIdentity: unused, membershipsForUser: unused },
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

  it('lets a builder run an agent granted to them (ADR-0152)', async () => {
    const { runtime } = runtimeOf([first, second], [first.id]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'builder'), [first.id])).toBe(true);
  });

  it('refuses a builder who neither owns nor was granted an agent', async () => {
    const { runtime } = runtimeOf([first, second]);
    expect(await runtime.canRunAll(memberIn(WORKSPACE, 'builder'), [first.id])).toBe(false);
  });

  it('lets any member consent to a client that binds no agent (membership consent)', async () => {
    const { runtime } = runtimeOf([]);
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      expect(await runtime.canRunAll(memberIn(WORKSPACE, role), []), role).toBe(true);
    }
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
