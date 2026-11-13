/**
 * Workspace paths as the filesystem sees them: the absolute form of a relative path, and the
 * refusal for a path that has a symbolic link on it.
 *
 * Split out of `./executors.ts`; `./editor.ts` and the read tools both begin every operation here.
 * The rule itself (no tool follows a link) is stated in `./executors.ts`.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { toolError } from './tool-output.js';
import type { OpenAiAgentsWorkspace } from './workspace.js';

/** The absolute form of a workspace-relative path (`.` is `cwd` itself). */
export function absolute(workspace: OpenAiAgentsWorkspace, relative: string): string {
  return relative === '.' ? workspace.cwd : path.posix.join(workspace.cwd, relative);
}

function isMissing(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The first component of `relative`, from `cwd` down, that is a symbolic link, or `null` when none
 * is. `cwd` itself is the sandbox root the runner chose and is not inspected. A component that does
 * not exist ends the walk: nothing below it exists either, so nothing below it can be a link.
 */
export async function symbolicLinkOnPath(
  workspace: OpenAiAgentsWorkspace,
  relative: string,
): Promise<string | null> {
  if (relative === '.') return null;
  let current = '';
  for (const segment of relative.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    try {
      if ((await lstat(absolute(workspace, current))).isSymbolicLink()) return current;
    } catch (cause) {
      if (isMissing(cause)) return null;
      throw cause;
    }
  }
  return null;
}

/** The refusal sentence for a path with a link on it, or `null` when the path has none. */
export async function linkRefusal(
  workspace: OpenAiAgentsWorkspace,
  verb: string,
  input: string,
  relative: string,
): Promise<string | null> {
  const link = await symbolicLinkOnPath(workspace, relative);
  return link === null
    ? null
    : toolError(
        `refused to ${verb} ${JSON.stringify(input)}: ${JSON.stringify(link)} is a symbolic link, and no tool follows one.`,
      );
}
