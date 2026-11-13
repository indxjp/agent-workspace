/**
 * Where a run is launched: the runtime target the launcher hydrates, posts to and releases, and
 * the port that resolves it (refactoring plan part 09, step 2).
 *
 * These types are built only from the runtime package and execution's own `LaunchContext`, so
 * they belong to the execution context. `compose/runtime-profile.ts` implements the resolver and
 * re-exports these names; the launcher imports them from here and no longer reaches downstream.
 */
import type { RuntimeCapabilities, RuntimeRunSpec } from '@agent-workspace/runtime/driver';

import type { LaunchContext } from './environment';

/** How the run's files reach the target: the driver's `RuntimeCapabilities.fileTransfer`. */
export type FileTransfer = RuntimeCapabilities['fileTransfer'];

export type RuntimeLaunchTarget = RuntimeRunSpec &
  Readonly<{
    runnerUrl: string;
    workspaceRoot: string;
    toolSandboxOrigin?: string;
    fileTransfer: FileTransfer;
  }>;

export interface RuntimeRunResolver {
  resolve(context: LaunchContext): Promise<RuntimeLaunchTarget>;
}
