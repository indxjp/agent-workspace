/**
 * The half of the tool guard that needs a filesystem: symbolic links (ENG-08, #307).
 *
 * `./workspace.ts` decides on the path the model **named**; pi's tools then open that path and the
 * kernel follows every link on it. So a model that cannot name `contracts/signed.pdf` (a read-only
 * grant) could name `notes/link.pdf`, a link it planted with `bash` or found in the workspace, and
 * write the protected file through it. The resolution — the deepest component that exists, through
 * `realpath`, then the same questions of the result — is `@agent-workspace/engine`'s
 * `resolvedWorkspacePathVerdict`; this module hands it node's filesystem, the one thing the port
 * cannot import.
 *
 * A final component that is a dangling link is refused for a write: `write` would create the
 * link's target, wherever it points, and there is no real path yet to check.
 *
 * The check and the write are two system calls, so a process racing the tool could swap a
 * component between them. Nothing in the sandbox runs concurrently with a tool call except the
 * agent's own `bash`, which is withheld whenever a read-only grant exists (`./tools.ts`).
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { resolvedWorkspacePathVerdict } from '@agent-workspace/engine';

import type { PiWorkspace, WorkspacePathVerdict } from './workspace.js';

/**
 * Resolve a workspace-relative path through the filesystem and re-check it.
 *
 * `relative` has already passed `./workspace.ts`; this answers whether the file the kernel will
 * actually open still passes.
 */
export function resolvedPathVerdict(
  workspace: PiWorkspace,
  relative: string,
  writes: boolean,
): Promise<WorkspacePathVerdict> {
  return resolvedWorkspacePathVerdict(workspace, relative, writes, { realpath, lstat, path });
}
