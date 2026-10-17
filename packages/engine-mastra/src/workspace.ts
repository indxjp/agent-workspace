/**
 * Which filesystem writes the Mastra adapter lets through, decided on the path a tool names
 * (ENG-10, #309).
 *
 * Pure. Mastra's workspace tools reach the disk through one `WorkspaceFilesystem`, so the platform's
 * grants are enforced by **wrapping that filesystem** (`./boundary.ts` subclasses Mastra's
 * `LocalFilesystem` and asks {@link mastraWriteVerdict} before every mutating call), not by
 * inspecting tool arguments; a call that removes or moves a path also asks
 * {@link mastraRemoveVerdict}, because it takes the whole subtree with it): every tool that writes — `write_file`, `edit_file`, `mkdir`,
 * `delete`, and any a later Mastra release adds — ends in one of those calls. `./guard.ts` repeats
 * the question on the path with its symbolic links resolved. The conformance kit's `writeAllowed`
 * calls {@link mastraWriteAllowed} over a compiled configuration — the same function, so the answer
 * the kit checks is the answer a run gets.
 *
 * The grant arithmetic is `@agent-workspace/engine`'s `writeGrantVerdict`, not a copy of it, and
 * `formal/AgentWorkspace/Authz/PathGrant.lean` proves the one the port ships.
 *
 * ## How Mastra spells a path, restated so the check reads the same path
 *
 * `LocalFilesystem` expands a leading `~` to the home directory, accepts an absolute path as is, and
 * resolves anything else against its base path. A leading `~` is therefore refused outright (it
 * names a file outside the workspace), an absolute path is accepted only when it is the workspace
 * root or below it, and a relative one is normalised by the port's own `normaliseGrantPath`, which
 * refuses a `..` that climbs out.
 */
import {
  relativeSubtreeVerdict,
  relativeWriteVerdict,
  workspacePathVerdict,
  type EngineWorkspace,
  type WorkspacePathVerdict,
} from '@agent-workspace/engine';

/** What the filesystem wrapper needs to know about the run's workspace. Plain data. */
export type MastraWorkspace = EngineWorkspace;

export type MastraPathVerdict = WorkspacePathVerdict;

/**
 * A path a tool named, as a workspace-relative one — or a refusal. `'.'` is the workspace root.
 */
export function mastraWorkspacePath(workspace: MastraWorkspace, input: string): MastraPathVerdict {
  if (input.startsWith('~')) {
    return {
      ok: false,
      reason: `${JSON.stringify(input)} starts with "~", which Mastra expands to the home directory outside the workspace; name the file relative to the workspace.`,
    };
  }
  const base = workspace.cwd.replace(/\/+$/u, '');
  let relative = input;
  if (input.startsWith('/')) {
    if (input.replace(/\/+$/u, '') === base) return { ok: true, relative: '.' };
    if (!input.startsWith(`${base}/`)) {
      return {
        ok: false,
        reason: `${JSON.stringify(input)} is an absolute path outside the workspace ${JSON.stringify(base)}.`,
      };
    }
    relative = input.slice(base.length + 1);
  }
  return workspacePathVerdict(workspace, relative);
}

/** {@link mastraWriteVerdict} over a path that is already workspace-relative and normalised. */
export function mastraRelativeWriteVerdict(
  workspace: MastraWorkspace,
  relative: string,
): MastraPathVerdict {
  return relativeWriteVerdict(workspace, relative);
}

/**
 * May the filesystem write `input`? Only a path inside the workspace, outside this adapter's own
 * directory and outside every read-only grant.
 */
export function mastraWriteVerdict(workspace: MastraWorkspace, input: string): MastraPathVerdict {
  const resolved = mastraWorkspacePath(workspace, input);
  return resolved.ok ? mastraRelativeWriteVerdict(workspace, resolved.relative) : resolved;
}

/**
 * Does the subtree at `relative` — the path itself or anything under it — hold a read-only grant
 * or this adapter's own directory? `relative` is workspace-relative and normalised, and has already
 * passed {@link mastraRelativeWriteVerdict}.
 *
 * The write rule asks whether the target is *inside* a protected location. Removing or moving a
 * directory also takes everything *under* it, so a recursive delete or a move of `docs` would take
 * a read-only grant on `docs/contracts` with it although `docs` itself is writable. This is the
 * second question those calls ask. Compared segment by segment, like the grants themselves:
 * `docs-private` does not contain `docs/contracts`.
 */
export function mastraRelativeSubtreeVerdict(
  workspace: MastraWorkspace,
  relative: string,
): MastraPathVerdict {
  return relativeSubtreeVerdict(workspace, relative);
}

/**
 * May the filesystem remove `input`, or move it away? Only a path it may write
 * ({@link mastraWriteVerdict}) whose subtree holds no read-only grant and not this adapter's own
 * directory ({@link mastraRelativeSubtreeVerdict}). `deleteFile`, `rmdir` and `moveFile`'s source
 * ask this.
 */
export function mastraRemoveVerdict(workspace: MastraWorkspace, input: string): MastraPathVerdict {
  const written = mastraWriteVerdict(workspace, input);
  return written.ok ? mastraRelativeSubtreeVerdict(workspace, written.relative) : written;
}

/** {@link mastraRemoveVerdict} as a boolean. */
export function mastraRemoveAllowed(workspace: MastraWorkspace, input: string): boolean {
  return mastraRemoveVerdict(workspace, input).ok;
}

/** {@link mastraWriteVerdict} as a boolean, for the conformance kit and the engine matrix. */
export function mastraWriteAllowed(workspace: MastraWorkspace, input: string): boolean {
  return mastraWriteVerdict(workspace, input).ok;
}
