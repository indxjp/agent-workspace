/**
 * A deployment with an empty database, for route tests that drive every handler: RBAC is the
 * harness's, each subsystem with an absent state is in it, and the domains production always builds
 * from the database read empty in-memory rows. Install the RBAC harness first.
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';

import { createInMemoryAgentVersionStoreProvider } from './agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import { applicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { createManualLinkInvitationSender } from './invitations/send-invitation';
import { TEST_WORKSPACE_ID } from './rbac/testing';
import { InMemoryTranscriptStore } from './sessions/memory-store';
import { createMemoryWorkspaceRepository } from './workspaces/testing';

/** A write the probes never reach: every write probe is refused (401, 403 or 400) before it. */
function unreachableWrite(): Promise<never> {
  return Promise.reject(new Error('this sweep sends no write that reaches a store'));
}

/**
 * The rest of the application context, as a deployment with an empty database has it. RBAC is
 * the harness's; every subsystem that has an absent state (`unavailable` or `disabled`) is in it,
 * so its routes answer their own `503`; the domains production always builds from the database
 * read an empty one, so a probe meets the `401`, `403`, `404` or `400` a real deployment answers.
 */
export function installEmptyDeployment(): void {
  const rbac = applicationContext()?.rbac;
  if (rbac === undefined) throw new Error('install the RBAC harness first');
  const identify = (request: Request) => rbac.identify(request);
  const actorOf = async (request: Request) => {
    const principal = await identify(request);
    if (principal === null) {
      return { kind: 'unauthenticated' as const, reason: 'no verified identity' };
    }
    return {
      kind: 'workspace' as const,
      workspaceId: principal.workspaceId,
      principalId: principal.principalId,
      ownerPrincipalId: principal.ownerPrincipalId,
      userId: principal.userId,
      userLabel: principal.label,
      role: principal.role,
    };
  };
  const agents = createInMemoryAgentStoreProvider();
  installTestDomains({
    a2a: { kind: 'disabled' },
    connectors: { kind: 'unavailable' },
    files: { kind: 'unavailable' },
    models: { kind: 'unavailable' },
    runtimes: { kind: 'unavailable' },
    secrets: { kind: 'unavailable' },
    setup: { kind: 'unavailable' },
    skills: { kind: 'unavailable' },
    surfaces: { kind: 'disabled' },
    tokens: { kind: 'disabled' },
    toolEndpoint: { kind: 'disabled' },
    triggers: { kind: 'disabled' },
    agents: {
      agents,
      resolveWorkspace: async (request) => {
        const actor = await actorOf(request);
        return actor.kind === 'workspace'
          ? { kind: 'workspace', workspaceId: actor.workspaceId }
          : actor;
      },
    },
    agentVersions: { versions: createInMemoryAgentVersionStoreProvider({ agents }) },
    audit: {
      scopes: createInMemoryWorkspaceScopeResolver([{ id: TEST_WORKSPACE_ID, slug: 'envelope' }]),
      repositories: {
        forScope: () => ({
          write: () => Promise.resolve(),
          count: () => Promise.resolve(0),
          list: () => Promise.resolve({ items: [], nextCursor: null }),
        }),
      },
    },
    cliAuth: {
      secret: 'a-session-secret-that-is-long-enough-for-tests',
      sessions: {
        recordApproval: unreachableWrite,
        exchange: unreachableWrite,
        findActiveByHash: () => Promise.resolve(null),
        revokeByHash: () => Promise.resolve(false),
        moveToWorkspace: () => Promise.resolve(false),
      },
    },
    endpointClients: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      create: unreachableWrite,
      update: () => Promise.resolve({ kind: 'not-found' }),
      revoke: () => Promise.resolve(null),
      rotateSecret: () => Promise.resolve({ kind: 'not-found' }),
      mintKey: unreachableWrite,
      agentOwnership: () => Promise.resolve('unknown'),
      audit: () => Promise.resolve(),
    },
    invitations: {
      recordAuditEvent: () => Promise.resolve(),
      sendInvitation: createManualLinkInvitationSender(),
    },
    oauth: {
      findClient: () => Promise.resolve(null),
      canRunAll: () => Promise.resolve(false),
      agentNames: () => Promise.resolve(null),
      tokens: unreachableWrite,
      audit: () => Promise.resolve(),
    },
    projects: {
      resolveActor: actorOf,
      forWorkspace: () =>
        Promise.resolve({
          projects: {
            get: () => Promise.resolve(null),
            list: () => Promise.resolve([]),
            createWithAssociations: unreachableWrite,
            updateWithAssociations: unreachableWrite,
            archive: () => Promise.resolve(null),
            restore: () => Promise.resolve(null),
            moveSession: unreachableWrite,
          },
          files: { list: () => Promise.resolve([]) },
          mcpServers: { list: () => Promise.resolve([]) },
          audit: { write: () => Promise.resolve() },
          agents: { get: () => Promise.resolve(null) },
          sessions: { get: () => Promise.resolve(null), ensure: unreachableWrite },
          agentVersions: { list: () => Promise.resolve(null) },
        }),
    },
    sessions: {
      authenticate: async (request) => {
        const principal = await identify(request);
        if (principal === null || principal.scope !== null || principal.via === 'user-token') {
          return null;
        }
        return {
          kind: 'user',
          principalId: principal.principalId,
          ownerPrincipalId: principal.ownerPrincipalId,
          userId: principal.userId,
          workspaceId: principal.workspaceId,
          role: principal.role,
        };
      },
      canAccessSession: () => Promise.resolve(false),
      store: new InMemoryTranscriptStore(),
    },
    shares: {
      resolveActor: actorOf,
      forWorkspace: () =>
        Promise.resolve({
          shares: {
            create: unreachableWrite,
            findByToken: () => Promise.resolve(null),
            get: () => Promise.resolve(null),
            list: () => Promise.resolve([]),
            revoke: () => Promise.resolve(false),
            stop: () => Promise.resolve(false),
            reserveVisitorMessage: unreachableWrite,
            getPublicSharingEnabled: () => Promise.resolve(false),
            setPublicSharingEnabled: unreachableWrite,
          },
          views: { record: () => Promise.resolve(), count: () => Promise.resolve(0) },
          audit: { write: () => Promise.resolve() },
        }),
      resolvePublic: () => Promise.resolve(null),
      sharingMaterials: () => Promise.resolve({ values: [], referenceIds: [] }),
      sessionRuns: (_workspaceId, runIds) => Promise.resolve(runIds.map(() => null)),
      subjectOwnership: () => Promise.resolve('unknown'),
      runPublic: unreachableWrite,
    },
    workspaces: {
      repository: createMemoryWorkspaceRepository({
        workspaces: [{ id: TEST_WORKSPACE_ID, slug: 'envelope', name: 'Envelope', members: [] }],
      }),
    },
  });
}
