import type {
  AgentRunResourceLoader,
  AgentRunResourceSelection,
  DeliveredStorageFolder,
} from '../../compose/resource-loader';
import type { LaunchContext } from '../../runs/environment';
import { isUnderMemoryDirectory } from '../../compose/agent-memory';
import { grantRoots } from '../../files/search-terms';

export function createLaunchResourceTracking(loader: AgentRunResourceLoader) {
  // Keep the delivered grant stable if its connection is renamed during the run.
  const deliveredFolders = new WeakMap<LaunchContext, Map<string, DeliveredStorageFolder>>();
  // Write-back compares archive and compose grants to refuse mismatched loads.
  const hydratedFolders = new WeakMap<LaunchContext, Map<string, DeliveredStorageFolder>>();
  // Archive and compose reuse identical loads. Attachments have distinct arguments, and a
  // failed load is evicted so a retry reads the bucket again.
  const launchLoads = new WeakMap<
    LaunchContext,
    Map<string, ReturnType<AgentRunResourceLoader['load']>>
  >();
  const sharedLoader = (context: LaunchContext): AgentRunResourceLoader => ({
    load: (...args) => {
      let loads = launchLoads.get(context);
      if (loads === undefined) {
        loads = new Map();
        launchLoads.set(context, loads);
      }
      const key = JSON.stringify(args);
      const held = loads.get(key);
      if (held !== undefined) return held;
      const loading = loader.load(...args);
      loads.set(key, loading);
      loading.catch(() => loads.delete(key));
      return loading;
    },
  });
  const recordingFolders = (context: LaunchContext): AgentRunResourceLoader => {
    const folders = new Map<string, DeliveredStorageFolder>();
    deliveredFolders.set(context, folders);
    const shared = sharedLoader(context);
    return {
      load: async (...args) => {
        const selection = await shared.load(...args);
        for (const [path, grant] of selection.storageFolders ?? []) folders.set(path, grant);
        return selection;
      },
    };
  };
  return {
    sharedLoader,
    recordingFolders,
    rememberHydrated(context: LaunchContext, selection: AgentRunResourceSelection) {
      hydratedFolders.set(context, new Map(selection.storageFolders ?? []));
    },
    deliveredFor: (context: LaunchContext) => deliveredFolders.get(context) ?? new Map(),
    hydratedFor: (context: LaunchContext) => hydratedFolders.get(context) ?? new Map(),
  };
}

/**
 * ADR-0147: run-scoped file search answers only from the paths this very request carries, so a
 * launch whose grants cannot be recorded fails rather than running with an empty snapshot. The
 * memory folder is left out (ADR-0163): its run path `memory/` is not a workspace path (the folder
 * is `memory/<agentId>/`), so recording it would let a search reach every agent's memory, and
 * search does not read memory.
 */
export async function recordRunFileGrants(
  runs: {
    snapshotFileGrants?(runId: string, paths: readonly string[]): Promise<boolean>;
  } | null,
  runId: string,
  files: Parameters<typeof grantRoots>[0],
): Promise<void> {
  const recorded = await runs?.snapshotFileGrants?.(
    runId,
    grantRoots(files.filter((file) => !isUnderMemoryDirectory(file.path))),
  );
  if (recorded !== true) throw new Error('the run file grants were not recorded');
}
