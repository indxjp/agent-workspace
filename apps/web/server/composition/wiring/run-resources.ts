import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type {
  DatabaseRoot,
  SessionRecord,
  WorkspaceScope,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { ConnectionStoreError, openConnectionStore } from '@agent-workspace/core/storage';

import {
  createRunAgentReader,
  engineOfVersion,
  versionToPin,
} from '../../agent-versions/session-version';
import { storageGrantUnavailable } from '../../agent-versions/storage-grants';
import {
  createAgentRunResourceLoader,
  type RunStorageConnections,
} from '../../compose/resource-loader';
import type { Connectors } from '../../connectors/runtime';
import type { Files } from '../../files/runtime';
import type { LaunchContext, SessionRef } from '../../runs/environment';
import type { Skills } from '../../skills/runtime';
import type {
  StorageConnections,
  StorageConnectionsRuntime,
} from '../../storage-connections/runtime';
import { log } from '../../telemetry/logger';
import { sessionForLaunch } from '../session-launch';
import type { AgentsWiring } from './agents';

/**
 * The run's view of its granted connections: the row, and a read-only store opened with the
 * credential the connection store holds for that row's URL, so a rotation reaches the next run. Every
 * expected failure is `run_storage_grant_unavailable`, and no message carries credential text.
 */
// @story US-STO-12
export function createRunStorageConnections({
  storage,
  scopes,
}: {
  readonly storage: {
    readonly store: {
      forWorkspace(
        workspaceId: string,
      ): Pick<ReturnType<StorageConnectionsRuntime['store']['forWorkspace']>, 'get' | 'credential'>;
    };
    readonly fileRoots: readonly string[];
  };
  readonly scopes: Pick<WorkspaceScopeResolver, 'forWorkspaceId'>;
}): RunStorageConnections {
  const openStore = async (workspaceId: string, connectionId: string, writable: boolean) => {
    const store = storage.store.forWorkspace(workspaceId);
    const connection = await store.get(connectionId);
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (connection === null || scope === null) {
      throw storageGrantUnavailable('a granted storage connection no longer exists');
    }
    // The row read here is the one the store opens with, so its write switch is judged here too.
    if (writable && !connection.writeAllowed) {
      throw storageGrantUnavailable(
        `the connection ${JSON.stringify(connection.name)} no longer allows writes`,
      );
    }
    // Only for the URL of the row read here: the store refuses a secret bound to another target.
    const credential =
      connection.provider === 'file'
        ? ({ provider: 'file' } as const)
        : await store.credential(connectionId, connection.url);
    if (credential === null) {
      throw storageGrantUnavailable(
        `the credential of the connection ${JSON.stringify(connection.name)} is missing`,
      );
    }
    try {
      return await openConnectionStore(connection.url, credential, {
        writable,
        fileRoots: storage.fileRoots,
        egress: loadEgressPolicyFromEnv(),
        // Counts and the id only: a name or path could carry the target of a link.
        onSkipped: (counts) =>
          log.warn('[runs] a storage connection listing skipped entries', {
            connectionId,
            ...counts,
          }),
      });
    } catch (cause) {
      if (!(cause instanceof ConnectionStoreError)) throw cause;
      throw storageGrantUnavailable(
        `the connection ${JSON.stringify(connection.name)} cannot be opened (${cause.code})`,
      );
    }
  };
  return {
    get: (workspaceId, connectionId) => storage.store.forWorkspace(workspaceId).get(connectionId),
    open: (workspaceId, connectionId) => openStore(workspaceId, connectionId, false),
    openWritable: (workspaceId, connectionId) => openStore(workspaceId, connectionId, true),
  };
}

export function wireRunResources({
  root,
  scopes,
  agents,
  agentResources,
  resourceCatalog,
  principalIdentity,
  connectors,
  files,
  skills,
  storageConnections,
}: Pick<
  AgentsWiring,
  'scopes' | 'agents' | 'agentResources' | 'resourceCatalog' | 'principalIdentity'
> & {
  readonly root: DatabaseRoot;
  readonly connectors: Connectors;
  readonly files: Files;
  readonly skills: Skills;
  readonly storageConnections: StorageConnections;
}) {
  const filesRuntime = files.kind === 'serving' ? files.runtime : null;
  // issue #125: a project's `project_files`/`project_mcp_servers` associations, read the same way
  // every other provider here is — bound to a workspace id, with the `WorkspaceScope` lookup
  // hidden inside the adapter rather than pushed onto `resource-loader.ts`, which knows nothing
  // about scopes. `root.projectFiles`/`root.projectMcpServers` are the same `.forScope` providers
  // `wireProjects` already reads from.
  const projectResources = {
    async listFileIds(workspaceId: string, projectId: string): Promise<readonly string[]> {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? [] : root.projectFiles.forScope(scope).list(projectId);
    },
    async listMcpServerIds(workspaceId: string, projectId: string): Promise<readonly string[]> {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? [] : root.projectMcpServers.forScope(scope).list(projectId);
    },
  };
  // A granted connection folder is read through the connection as it is at run time: the row, and a
  // credential the connection store holds for that row's URL, so a rotation reaches the next run.
  const storage = storageConnections.kind === 'serving' ? storageConnections.runtime : null;
  const runStorageConnections =
    storage === null ? null : createRunStorageConnections({ storage, scopes });
  const loaderDependencies = {
    catalog: resourceCatalog,
    ...(filesRuntime?.storage === undefined ? {} : { storage: filesRuntime.storage }),
    ...(skills.kind === 'serving' ? { skills: skills.runtime.store } : {}),
    ...(connectors.kind === 'serving' ? { connectors: connectors.runtime.connectors } : {}),
    projectResources,
    ...(runStorageConnections === null ? {} : { storageConnections: runStorageConnections }),
  };
  const runResources = createAgentRunResourceLoader(loaderDependencies);
  // The run-start preflight's view of the same selection: catalog row sizes, never bytes.
  const runFileSizes = createAgentRunResourceLoader({ ...loaderDependencies, sizesOnly: true });
  // Issue #612: a session pins the version `local` points at when its row is inserted, and every
  // run of it composes from that version; a legacy session (no pin) runs from the row.
  const pinnedVersionFor = async (scope: WorkspaceScope, agentId: string): Promise<string | null> =>
    // ponytail: `list` reads every version body for one pointer; add a pointer-only read if agents
    // collect enough versions for session start to notice.
    versionToPin((await root.agentVersions.forScope(scope).list(agentId))?.pointers ?? [], 'local');
  const launchRef = async (scope: WorkspaceScope, row: SessionRecord): Promise<SessionRef> => {
    const ref = sessionForLaunch(row);
    if (row.agentVersionId === null) return ref;
    const version = await root.agentVersions.forScope(scope).findById(row.agentVersionId);
    return version === null
      ? ref
      : { ...ref, versionEngine: engineOfVersion(version), agentVersionNumber: version.number };
  };
  // The runtime resolver, allocation, compose and hydration all read the run's configuration, so
  // one read is shared per launch context; a failed read is dropped so a retry reads again.
  const readRunAgent = createRunAgentReader({
    agents,
    assignments: agentResources,
    versions: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? null : root.agentVersions.forScope(scope);
    },
  });
  const runAgents = new WeakMap<LaunchContext, ReturnType<typeof readRunAgent>>();
  const runAgentOf = (context: LaunchContext) => {
    const cached = runAgents.get(context);
    if (cached !== undefined) return cached;
    const read = readRunAgent(
      context.principal.workspaceId,
      context.agent.id,
      context.session.agentVersionId ?? null,
    );
    runAgents.set(context, read);
    read.catch(() => runAgents.delete(context));
    return read;
  };

  const resolveWave5Actor = async (request: Request) => {
    const result = await principalIdentity.resolveActor(request);
    if (result.kind !== 'workspace') return result;
    const identity = result.principal;
    return {
      kind: 'workspace' as const,
      workspaceId: identity.workspaceId,
      principalId: identity.principalId,
      ownerPrincipalId: identity.ownerPrincipalId,
      userId: identity.userId,
      userLabel: identity.label,
      role: identity.role,
      scope: identity.scope,
    };
  };
  const wave5Repositories = async (workspaceId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
    return {
      projects: root.projects.forScope(scope),
      files: root.projectFiles.forScope(scope),
      mcpServers: root.projectMcpServers.forScope(scope),
      shares: root.shares.forScope(scope),
      views: root.shareViews.forScope(scope),
      audit: root.auditEventRepository.forScope(scope),
      // issue #125: `POST /api/projects/:id/sessions` resolves `defaultAgentId` and persists it
      // by calling these two directly, rather than through the `apps/web/server/agents/**` and
      // `apps/web/server/runs/**` adapters — both outside this task's Owns globs this wave.
      agents: root.agents.forScope(scope),
      sessions: root.sessions.forScope(scope),
      agentVersions: root.agentVersions.forScope(scope),
    };
  };

  return {
    filesRuntime,
    runResources,
    runFileSizes,
    pinnedVersionFor,
    launchRef,
    readRunAgent,
    runStorageConnections,
    runAgentOf,
    resolveWave5Actor,
    wave5Repositories,
  };
}

export type RunResourcesWiring = ReturnType<typeof wireRunResources>;
