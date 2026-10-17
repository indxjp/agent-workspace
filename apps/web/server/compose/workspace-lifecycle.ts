import { decodeUstar, encodeUstar, type TarEntry } from '@agent-workspace/runtime';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import type { WorkspaceObjectStoreProvider } from '../files/store';
import type { LaunchContext } from '../runs/environment';
import type { RuntimeWorkspaceLifecycle } from '../runs/launcher';
import type { RuntimeLaunchTarget } from './runtime-profile';
import type { AgentRunResourceLoader } from './resource-loader';

export interface RuntimeWorkspaceLifecycleDependencies {
  readonly resources: AgentRunResourceLoader;
  /** What the run's agent is assigned: its session's pinned version's, or the row's (issue #612). */
  readonly assignments: (context: LaunchContext) => Promise<AgentResourceAssignments>;
  readonly objects: WorkspaceObjectStoreProvider;
}

function archiveEntry(
  resource: Awaited<ReturnType<AgentRunResourceLoader['load']>>['files'][number],
): TarEntry {
  return resource.kind === 'directory'
    ? { path: resource.path, type: 'directory', mode: 0o755 }
    : {
        path: resource.path,
        type: 'file',
        mode: resource.access === 'read-write' ? 0o644 : 0o444,
        data: Buffer.from(resource.contentBase64, 'base64'),
      };
}

/**
 * Bridges the tenant-scoped control-plane object store to an isolated runtime workspace.
 *
 * Inputs are rebuilt for every run from the assignments the run's agent configuration has. Outputs are
 * parsed and path-validated in full before any durable object is touched. The original archive is
 * staged first so a partial object-store failure is recoverable, then removed only after all files
 * have been promoted.
 */
export function createRuntimeWorkspaceLifecycle(
  dependencies: RuntimeWorkspaceLifecycleDependencies,
): RuntimeWorkspaceLifecycle {
  return {
    async inputArchive(context: LaunchContext) {
      const selected = await dependencies.resources.load(
        context.principal.workspaceId,
        await dependencies.assignments(context),
      );
      if (selected.files.length === 0) return null;
      return encodeUstar(selected.files.map(archiveEntry));
    },

    async promoteOutputs(
      context: LaunchContext,
      _runtime: RuntimeLaunchTarget,
      archive: Uint8Array,
    ) {
      // Decode first: checksum, member type and traversal failures must leave durable state untouched.
      const entries = decodeUstar(archive);
      const files = entries.filter((entry) => entry.type === 'file');
      const store = dependencies.objects.forWorkspace(context.principal.workspaceId);
      const stagingKey = `.runtime-staging/${context.run.id}.tar`;
      await store.put(stagingKey, { body: archive, contentType: 'application/x-tar' });
      for (const entry of files) {
        await store.put(entry.path, {
          body: entry.data ?? new Uint8Array(),
          contentType: 'application/octet-stream',
        });
      }
      await store.delete(stagingKey);
    },
  };
}
