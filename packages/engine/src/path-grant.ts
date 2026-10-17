/**
 * Path normalisation and file grants, for every engine adapter (ENG-04, #303).
 *
 * A file grant is the platform saying *"this agent may read this path, and may not write it"*.
 * Two separate mechanisms enforce it and neither is allowed to be the only one: the runner
 * materialises a read-only grant with read-only filesystem modes, and the adapter compiles the
 * grant into whatever its engine's tool-permission grammar is. This module is the part **both**
 * have to agree about — what a grant's path actually names — because a rule written against
 * `docs/spec.md` and a `chmod` applied to `docs/../docs/spec.md` protect different files.
 *
 * ## Why this is not `node:path`
 *
 * Three reasons, in increasing order of importance.
 *
 *   * `packages/engine` depends on `@indx-workspace/contracts` and nothing else, so it
 *     has no `@types/node` (see `./port.ts`'s header for why the port's dependency list is the
 *     design rather than an inconvenience).
 *   * `path.normalize` is platform-dependent: on Windows it treats `\` as a separator and `C:` as
 *     a root, and a grant compiled on one platform and enforced on another would not be the same
 *     grant. A sandbox path is a POSIX path wherever the control plane happens to run.
 *   * **`path.normalize` is not a security decision and does not claim to be.** It collapses
 *     `a/../b` to `b` and `../b` to `../b`, answering "what does this path mean" — not "may this
 *     path be used". This module answers the second question, which needs an explicit refusal for
 *     every input that escapes, and `normalize` has no way to express one.
 *
 * ## What a symlink is, here
 *
 * A symlink is not resolved by this module and must not be: resolving one needs a filesystem, and
 * a filesystem answer is only true at the instant it is read (a TOCTOU the runner's own
 * `refuseSymlinkPath` closes at materialisation time by refusing the path outright). What this
 * module handles is the *other* half — a symlink's recorded **target**, which arrives as an
 * ordinary string and is exactly the shape an escape is written in. {@link normaliseGrantPath}
 * refuses `../../etc/passwd` whether it came from a tenant's grant list or out of a link this
 * runner read, and that is the property `formal/AgentWorkspace/Authz/PathGrant.lean` proves.
 */

/** Why a path may not be used as a grant. Each arm names one class of input, never a catch-all. */
export const PATH_GRANT_REFUSALS = [
  /** The path is empty, or is only separators. */
  'empty',
  /** The path is absolute — POSIX (`/etc`) or Windows (`C:\`, `\\server`). */
  'absolute',
  /** Normalising the path leaves the workspace root: `..` climbs above it. */
  'escapes_root',
  /** A byte no sandbox path may carry: NUL, or a backslash that would be a separator elsewhere. */
  'illegal_character',
  /** The workspace's own engine-configuration directory. Declared by the adapter, not guessed. */
  'protected_directory',
] as const;
export type PathGrantRefusal = (typeof PATH_GRANT_REFUSALS)[number];

export type PathGrantVerdict =
  | {
      readonly ok: true;
      /** The path with `.`, empty and redundant segments removed, joined with `/`. */
      readonly path: string;
      /** The same value as segments, so a caller comparing prefixes cannot do it by substring. */
      readonly segments: readonly string[];
    }
  | { readonly ok: false; readonly refusal: PathGrantRefusal; readonly reason: string };

function refuse(refusal: PathGrantRefusal, reason: string): PathGrantVerdict {
  return { ok: false, refusal, reason };
}

/**
 * Is this string an absolute path under **any** platform this repository's paths travel through?
 *
 * Deliberately wider than POSIX. A grant composed on a Windows control plane and enforced inside
 * a Linux container would have `C:\secrets` read as a *relative* path named `C:\secrets` there —
 * a single file with a strange name, created inside the sandbox — and the author's intent, which
 * was to name a location outside it, would be silently granted as something else. Refusing the
 * shape everywhere is the answer that means the same thing on both.
 */
function isAbsolute(input: string): boolean {
  if (input.startsWith('/') || input.startsWith('\\')) return true;
  return /^[A-Za-z]:[\\/]/u.test(input);
}

/**
 * Normalise one workspace-relative path, or say why it cannot be one.
 *
 * A **positive** assertion (ADR-0015): the returned path is usable because every segment was
 * classified, never because no rule objected. `..` is resolved against the accumulated segments
 * and refused the moment it would pop past the root — not matched as a substring, which is the
 * check `a/..%2f..` and `....//` are written to get past.
 *
 * `protectedDirectory` is the adapter's own configuration directory
 * ({@link import('./port.js').AgentEngine.protectedConfigDirectory}). It is compared against the
 * **normalised** first segment, so `./.claude/settings.json` is refused for the same reason
 * `.claude/settings.json` is; comparing the raw input would have looked at a leading `.` segment
 * and let the second spelling through.
 */
export function normaliseGrantPath(
  input: string,
  protectedDirectory: string | null = null,
): PathGrantVerdict {
  if (input.includes('\0')) {
    return refuse('illegal_character', 'a sandbox path may not contain a NUL byte.');
  }
  if (input.includes('\\')) {
    return refuse(
      'illegal_character',
      `${JSON.stringify(input)} contains a backslash. It is a path separator on Windows and an ordinary filename byte on Linux, so the same grant would name two different files; write the path with "/".`,
    );
  }
  if (isAbsolute(input)) {
    return refuse(
      'absolute',
      `${JSON.stringify(input)} is an absolute path. A grant names a location inside the run's workspace, and an absolute path names one outside it.`,
    );
  }

  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        return refuse(
          'escapes_root',
          `${JSON.stringify(input)} climbs above the workspace root with "..".`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return refuse('empty', `${JSON.stringify(input)} names no path inside the workspace.`);
  }
  if (protectedDirectory !== null && segments[0] === protectedDirectory) {
    return refuse(
      'protected_directory',
      `${JSON.stringify(input)} normalises into ${JSON.stringify(protectedDirectory)}, which is the engine's own configuration directory. A tenant file there would change how the engine runs, not what it runs on.`,
    );
  }
  return { ok: true, path: segments.join('/'), segments };
}

/** One grant, after normalisation. The shape the write decision below is taken against. */
export type NormalisedGrant = {
  readonly kind: 'file' | 'directory';
  readonly path: string;
  readonly segments: readonly string[];
  readonly access: 'read' | 'read-write';
};

/**
 * Does `candidate` name a location **inside** `grant` — the grant itself, or a descendant?
 *
 * Compared segment by segment, never as a string prefix. `docs-private/secret` starts with
 * `docs` as text and is not inside it as a path, and a prefix comparison that got that wrong
 * would deny a path nobody granted (annoying) *or*, with the arguments the other way round,
 * allow a write the grant did not cover (not annoying).
 */
function isWithin(candidate: readonly string[], grant: readonly string[]): boolean {
  if (candidate.length < grant.length) return false;
  return grant.every((segment, index) => candidate[index] === segment);
}

/**
 * May the engine be allowed to **write** this path?
 *
 * The rule the T3 adversarial theorem states: a write is allowed only when the normalised path
 * lands outside every read-only grant. A file grant protects exactly itself; a directory grant
 * protects itself and everything under it. A path that does not normalise is refused rather than
 * compared — an input this module could not read is not an input it may vouch for.
 *
 * Note the direction. This function does not say a write is *possible*; the filesystem modes the
 * runner applies say that. It says whether the adapter may compile a rule that permits one, which
 * is the second of the two independent checks a read-only grant gets.
 */
export function writeGrantVerdict(
  candidate: string,
  grants: readonly NormalisedGrant[],
  protectedDirectory: string | null = null,
): PathGrantVerdict {
  const normalised = normaliseGrantPath(candidate, protectedDirectory);
  if (!normalised.ok) return normalised;
  for (const grant of grants) {
    if (grant.access !== 'read') continue;
    const covers =
      grant.kind === 'directory'
        ? isWithin(normalised.segments, grant.segments)
        : normalised.path === grant.path;
    if (covers) {
      return refuse(
        'escapes_root',
        `${JSON.stringify(candidate)} normalises to ${JSON.stringify(normalised.path)}, which is covered by the read-only grant ${JSON.stringify(grant.path)}.`,
      );
    }
  }
  return normalised;
}

/**
 * Normalise a whole grant list, refusing the list rather than dropping an entry.
 *
 * Dropping the entry that could not be read would compile a *narrower* set of protections than
 * the one the control plane sent, and the run would start looking exactly as though it had been
 * granted correctly. ADR-0015's explicit `else`: a grant this module cannot read is a refusal
 * with the offending path named.
 */
export function normaliseGrants(
  grants: readonly { kind: 'file' | 'directory'; path: string; access: 'read' | 'read-write' }[],
  protectedDirectory: string | null = null,
):
  | { readonly ok: true; readonly grants: readonly NormalisedGrant[] }
  | { readonly ok: false; readonly refusal: PathGrantRefusal; readonly reason: string } {
  const normalised: NormalisedGrant[] = [];
  for (const grant of grants) {
    const verdict = normaliseGrantPath(grant.path, protectedDirectory);
    if (!verdict.ok) return verdict;
    normalised.push({
      kind: grant.kind,
      path: verdict.path,
      segments: verdict.segments,
      access: grant.access,
    });
  }
  return { ok: true, grants: normalised };
}

/** What a tool guard knows about the run's workspace. Plain data, so it compiles. */
export type EngineWorkspace = {
  /** The sandbox root, without a trailing slash. */
  readonly cwd: string;
  /** Every grant, normalised. Only the `read` ones constrain a write. */
  readonly grants: readonly NormalisedGrant[];
  /** This adapter's own configuration directory. Never written by a tool. */
  readonly protectedDirectory: string;
};

export type WorkspacePathVerdict =
  | { readonly ok: true; readonly relative: string }
  | { readonly ok: false; readonly reason: string };

/**
 * A model-supplied path as workspace-relative (`'.'` is the root), or a refusal.
 *
 * Relative paths are relative to `cwd`; an absolute one is accepted only when it is `cwd` itself or
 * below it, so `/etc/passwd` is not "a file called etc/passwd in the workspace".
 */
export function workspacePathVerdict(
  workspace: EngineWorkspace,
  input: string,
): WorkspacePathVerdict {
  const root = workspace.cwd.replace(/\/+$/u, '');
  let relative = input;
  if (input === root || input === `${root}/`) relative = '.';
  else if (input.startsWith(`${root}/`)) relative = input.slice(root.length + 1);
  if (relative === '.' || relative === './' || relative === '') return { ok: true, relative: '.' };
  const verdict = normaliseGrantPath(relative);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, relative: verdict.path };
}

/** May a tool write this already-relative, normalised path? */
export function relativeWriteVerdict(
  workspace: EngineWorkspace,
  relative: string,
): WorkspacePathVerdict {
  if (relative === '.') {
    return { ok: false, reason: 'the workspace root itself is not a file that can be written.' };
  }
  const verdict = writeGrantVerdict(relative, workspace.grants, workspace.protectedDirectory);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, relative: verdict.path };
}

/** {@link workspacePathVerdict} then {@link relativeWriteVerdict}. */
export function workspaceWriteVerdict(
  workspace: EngineWorkspace,
  input: string,
): WorkspacePathVerdict {
  const resolved = workspacePathVerdict(workspace, input);
  return resolved.ok ? relativeWriteVerdict(workspace, resolved.relative) : resolved;
}

/**
 * Does the subtree at `relative` — the path itself or anything under it — hold a read-only grant
 * or this adapter's own directory? `relative` is workspace-relative and normalised, and has already
 * passed {@link relativeWriteVerdict}.
 *
 * The write rule asks whether the target is *inside* a protected location. Removing or moving a
 * directory also takes everything *under* it, so a recursive delete of `docs` would take a read-only
 * grant on `docs/contracts` with it although `docs` itself is writable. Compared segment by
 * segment, like the grants themselves: `docs-private` does not contain `docs/contracts`.
 */
export function relativeSubtreeVerdict(
  workspace: EngineWorkspace,
  relative: string,
): WorkspacePathVerdict {
  const segments = relative === '.' ? [] : relative.split('/');
  const contains = (protectedSegments: readonly string[]): boolean =>
    protectedSegments.length >= segments.length &&
    segments.every((segment, index) => protectedSegments[index] === segment);
  if (contains([workspace.protectedDirectory])) {
    return {
      ok: false,
      reason: `${JSON.stringify(relative)} holds ${JSON.stringify(workspace.protectedDirectory)}, the engine's own configuration directory, so it cannot be removed or moved.`,
    };
  }
  for (const grant of workspace.grants) {
    if (grant.access !== 'read') continue;
    if (contains(grant.segments)) {
      return {
        ok: false,
        reason: `${JSON.stringify(relative)} holds the read-only grant ${JSON.stringify(grant.path)}, so it cannot be removed or moved.`,
      };
    }
  }
  return { ok: true, relative };
}
