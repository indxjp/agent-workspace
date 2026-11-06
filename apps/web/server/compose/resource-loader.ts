import {
  type AgentRunResourceLoader,
  type RunFileSource,
  type AgentRunResourceLoaderDependencies,
  type DeliveredStorageFolder,
} from './resource-loader-contract';
import { loadFiles, loadMemoryFolder } from './resource-loader-files';
import { loadStorageGrants } from './resource-loader-storage';
import { loadSkills } from './resource-loader-skills';
import { loadConnectors } from './resource-loader-connectors';
import { loadProjectFileGrants, loadProjectConnectorIds } from './resource-loader-projects';

function createAgentRunResourceLoader(
  dependencies: AgentRunResourceLoaderDependencies,
): AgentRunResourceLoader {
  return {
    async load(
      workspaceId,
      assignments,
      projectId = null,
      agentPermissions = undefined,
      ceilingCaps = [],
      memoryAgentId = null,
    ) {
      const [projectFileGrants, projectConnectorIds] =
        projectId === null || projectId === undefined
          ? [[], []]
          : await Promise.all([
              loadProjectFileGrants(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
              loadProjectConnectorIds(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
            ]);
      // A connector the agent is assigned is the agent's own, even when the project names it too.
      const agentConnectorIds = new Set(assignments.connectorIds);
      const sources = new Map<string, RunFileSource>();
      // A storage reference wins over a workspace file at the same path, so its source must too:
      // the loaders run concurrently, and a shared map would keep whichever wrote last.
      const storedSources = new Map<string, RunFileSource>();
      const storageFolders = new Map<string, DeliveredStorageFolder>();
      // The memory folder owns `memory/` (ADR-0163), so its sources win over any other grant there.
      const memorySources = new Map<string, RunFileSource>();
      // A run lists a granted folder twice: the preflight before it is queued (sizes only), and its
      // launch, whose input archive and compose share one load (`composition/wiring/run-launcher.ts`).
      const [files, stored, skills, connectors, memoryFiles] = await Promise.all([
        loadFiles(workspaceId, [...projectFileGrants, ...assignments.files], dependencies, sources),
        loadStorageGrants({
          workspaceId: workspaceId,
          grants: assignments.storageGrants ?? [],
          dependencies: dependencies,
          sources: storedSources,
          mayWrite: agentPermissions?.writeFiles === true,
          folders: storageFolders,
        }),
        loadSkills({
          workspaceId: workspaceId,
          skillIds: assignments.skillIds,
          skillRevisions: assignments.skillRevisions ?? {},
          dependencies: dependencies,
          sources: sources,
        }),
        dependencies.sizesOnly === true
          ? { mcpServers: {} }
          : loadConnectors(
              workspaceId,
              [...new Set([...projectConnectorIds, ...assignments.connectorIds])],
              new Set(projectConnectorIds.filter((id) => !agentConnectorIds.has(id))),
              dependencies,
            ),
        memoryAgentId === null || memoryAgentId === undefined
          ? undefined
          : loadMemoryFolder(workspaceId, memoryAgentId, dependencies, memorySources),
      ]);
      return {
        files: [...new Map([...files, ...stored].map((file) => [file.path, file])).values()],
        ...(memoryFiles === undefined ? {} : { memoryFiles }),
        skills,
        sources: new Map([...sources, ...storedSources, ...memorySources]),
        ...(storageFolders.size === 0 ? {} : { storageFolders }),
        ...connectors,
      };
    },
  };
}
export { createAgentRunResourceLoader };
export {
  type RunDirectoryGrant,
  type RunFileGrant,
  type RunFileSource,
  type RunConnectionStore,
  type RunWritableConnectionStore,
  type DeliveredStorageFolder,
  type RunStorageConnections,
  type PendingToolConnector,
  type ConnectorIdentityKey,
  type AgentRunResourceSelection,
  type ProjectResourceReader,
  type AgentRunResourceLoader,
  type AgentRunResourceLoaderDependencies,
} from './resource-loader-contract';
export {
  runFilesTooLargeMessage,
  runFilesTooLarge,
  runFilesTotal,
  assertRunFilesFit,
  runInputFiles,
  loadAttachedFiles,
  withAttachedFiles,
} from './resource-loader-files';
export { skillInboxPath } from './resource-loader-skills';
