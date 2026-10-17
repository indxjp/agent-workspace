/**
 * The half of the filesystem wrapper that needs a disk: symbolic links (ENG-10, #309).
 *
 * `./workspace.ts` decides on the path a tool **named**; the kernel then follows every link on it.
 * A model that may not write `contracts/signed.pdf` (a read-only grant) could otherwise write
 * `notes/link.pdf`, a link that points at it. Mastra's `LocalFilesystem` already refuses a link that
 * leaves the workspace (`contained: true`), but it knows nothing of grants, so this module resolves
 * the path the way the kernel will — the longest prefix that exists, through `realpath` — and asks
 * the write question again of what it finds.
 *
 * A final component that is a link to nothing is refused: writing it would create the link's
 * target, wherever that is, and there is no real path to check yet.
 *
 * The check and the write are two system calls, so a process racing the tool could swap a
 * component in between. The only process in the sandbox that could is the agent's own
 * `execute_command`, which is withheld whenever a read-only grant exists (`./tools.ts`).
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { resolvedWorkspacePathVerdict } from '@agent-workspace/engine';

import type { MastraPathVerdict, MastraWorkspace } from './workspace.js';

/**
 * Re-check a write the lexical rule allowed, on the file the kernel will actually open.
 * `relative` has already passed `./workspace.ts`.
 */
export function mastraResolvedWriteVerdict(
  workspace: MastraWorkspace,
  relative: string,
): Promise<MastraPathVerdict> {
  return resolvedWorkspacePathVerdict(workspace, relative, true, { realpath, lstat, path });
}
