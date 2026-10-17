/**
 * The half of the tool guard that needs a filesystem: symbolic links (#951).
 *
 * `./path-grant.ts` decides on the path the model **named**; an engine's tools then open that path
 * and the kernel follows every link on it. So a model that cannot name `contracts/signed.pdf` (a
 * read-only grant) could name `notes/link.pdf`, a link it planted or found, and write the protected
 * file through it. This module resolves the path the way the kernel will — the deepest component
 * that exists, through `realpath` — and asks the same questions of the result: still inside the
 * workspace, and, for a write, outside every read-only grant and the adapter's own directory.
 *
 * A final component that is a dangling link is refused for a write: `write` would create the link's
 * target, wherever it points, and there is no real path yet to check.
 *
 * The check and the write are two system calls, so a process racing the tool could swap a component
 * between them. The adapter withholds its shell whenever a read-only grant exists, which is what
 * keeps anything in the sandbox from running concurrently with a tool call.
 *
 * The filesystem is injected ({@link ResolvedPathHost}): this package has no `@types/node`.
 */
import {
  relativeWriteVerdict,
  type EngineWorkspace,
  type WorkspacePathVerdict,
} from './path-grant.js';

/** The `node:fs/promises` + `node:path` members the guard uses, structurally. */
export type ResolvedPathHost = {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readonly path: {
    join(...parts: string[]): string;
    dirname(p: string): string;
    basename(p: string): string;
    relative(from: string, to: string): string;
    isAbsolute(p: string): boolean;
    readonly sep: string;
  };
};

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function existsAsLink(host: ResolvedPathHost, target: string): Promise<boolean | null> {
  try {
    return (await host.lstat(target)).isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** `target` with every existing component's links resolved; the missing tail kept as written. */
async function resolveExisting(host: ResolvedPathHost, target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await host.realpath(current);
      return missing.length === 0 ? real : host.path.join(real, ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = host.path.dirname(current);
      if (parent === current) return target;
      missing.push(host.path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a workspace-relative path through the filesystem and re-check it.
 *
 * `relative` has already passed {@link import('./path-grant.js').workspacePathVerdict}; this answers
 * whether the file the kernel will actually open still passes. ENOENT and ENOTDIR mean "absent".
 */
export async function resolvedWorkspacePathVerdict(
  workspace: EngineWorkspace,
  relative: string,
  writes: boolean,
  host: ResolvedPathHost,
): Promise<WorkspacePathVerdict> {
  const { path } = host;
  const root = await host.realpath(workspace.cwd);
  const target = path.join(workspace.cwd, relative);
  if (writes && (await existsAsLink(host, target)) === true) {
    try {
      await host.realpath(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        ok: false,
        reason: `${JSON.stringify(relative)} is a symbolic link to nothing; writing it would create a file wherever it points.`,
      };
    }
  }
  const real = await resolveExisting(host, target);
  const inside = path.relative(root, real);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return {
      ok: false,
      reason: `${JSON.stringify(relative)} resolves outside the workspace through a symbolic link.`,
    };
  }
  const normalised = inside === '' ? '.' : inside.split(path.sep).join('/');
  if (!writes) return { ok: true, relative: normalised };
  return relativeWriteVerdict(workspace, normalised);
}
