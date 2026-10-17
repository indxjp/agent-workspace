/**
 * Which tool calls the pi adapter lets through, decided on the path the model names (ENG-08, #307).
 *
 * Pure. pi has no permission system of its own (its docs recommend a container, which the runtime
 * driver already is), so the platform's grants are enforced by the adapter, in pi-agent-core's
 * `beforeToolCall` hook: `./boundary.ts` installs a guard that asks {@link piToolCallVerdict}
 * first, and `./guard.ts` repeats the write check on the path with every symbolic link on it
 * resolved. The conformance kit's `writeAllowed` calls {@link workspaceWriteAllowed} over a
 * compiled configuration — the same function, so the answer the kit checks is the answer a run
 * gets.
 *
 * The grant arithmetic is `@agent-workspace/engine`'s `writeGrantVerdict`, not a copy of it: a
 * second implementation of `..` handling is a second chance to get it wrong, and
 * `formal/AgentWorkspace/Authz/PathGrant.lean` proves the one the port ships.
 *
 * ## The spellings pi rewrites, refused rather than re-implemented
 *
 * pi resolves a tool path against `cwd` after stripping a leading `@`, expanding a leading `~` and
 * folding Unicode spaces into ASCII ones (`resolveToCwd`). A guard that checked the string before
 * those rewrites would be checking a different path than the one written, so a path using any of
 * them is refused outright: the model can always spell the same file plainly.
 */
import type { PiToolName } from '@indx-workspace/contracts/agents';
import {
  relativeWriteVerdict,
  workspacePathVerdict,
  type EngineWorkspace,
  type WorkspacePathVerdict,
} from '@agent-workspace/engine';

export { relativeWriteVerdict, type WorkspacePathVerdict } from '@agent-workspace/engine';

/** What the guard needs to know about the run's workspace. Plain data, so it compiles. */
export type PiWorkspace = EngineWorkspace;

/** The characters pi's `normalizeUnicodeSpaces` folds into an ASCII space. */
const REWRITTEN_SPACES = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/u;

/**
 * Turn a model-supplied path into a workspace-relative one, or refuse it.
 *
 * Relative paths are relative to `cwd`; an absolute one is accepted only when it is `cwd` itself or
 * below it, so `/etc/passwd` is not "a file called etc/passwd in the workspace".
 */
export function resolveWorkspacePath(workspace: PiWorkspace, input: string): WorkspacePathVerdict {
  if (input.startsWith('~') || input.startsWith('@') || REWRITTEN_SPACES.test(input)) {
    return {
      ok: false,
      reason: `the path ${JSON.stringify(input)} uses a spelling pi rewrites (a leading "~" or "@", or a Unicode space); name the file plainly, relative to the workspace.`,
    };
  }
  return workspacePathVerdict(workspace, input);
}

/**
 * May a tool of this run write `input`? A write is allowed only when the path normalises inside
 * the workspace, outside this adapter's own directory and outside every read-only grant.
 */
export function workspaceWriteVerdict(workspace: PiWorkspace, input: string): WorkspacePathVerdict {
  const resolved = resolveWorkspacePath(workspace, input);
  if (!resolved.ok) return resolved;
  return relativeWriteVerdict(workspace, resolved.relative);
}

/** {@link workspaceWriteVerdict} as a boolean, for the conformance kit. */
export function workspaceWriteAllowed(workspace: PiWorkspace, input: string): boolean {
  return workspaceWriteVerdict(workspace, input).ok;
}

/** What {@link piToolCallVerdict} decided: let the call run, or block it with a sentence. */
export type PiToolCallVerdict =
  | { readonly allow: true; readonly path: string | null; readonly writes: boolean }
  | { readonly allow: false; readonly reason: string };

function pathArgument(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const path = (args as Readonly<Record<string, unknown>>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * The guard's decision on one tool call, before it runs.
 *
 * * A tool the compiled plan does not offer is blocked — `bash` whenever `runCommands` is false
 *   included. pi was never told about it, so a call naming it is a model inventing a tool, and
 *   the answer is the same refusal whichever tool it invented.
 * * `read` needs a path inside the workspace.
 * * `write` and `edit` need a path {@link workspaceWriteVerdict} allows.
 * * `bash` runs when offered; its effects are the reason it is withheld under a read-only grant.
 */
export function piToolCallVerdict(
  workspace: PiWorkspace,
  offered: readonly PiToolName[],
  toolName: string,
  args: unknown,
): PiToolCallVerdict {
  const tool = offered.find((name) => name === toolName);
  if (tool === undefined) {
    return {
      allow: false,
      reason: `the tool ${JSON.stringify(toolName)} is not offered to this agent; its permissions allow ${offered.length === 0 ? 'no tool' : offered.join(', ')}.`,
    };
  }
  if (tool === 'bash') return { allow: true, path: null, writes: false };
  const path = pathArgument(args);
  if (path === null) return { allow: false, reason: `${tool} needs a non-empty "path".` };
  if (tool === 'read') {
    const resolved = resolveWorkspacePath(workspace, path);
    return resolved.ok
      ? { allow: true, path: resolved.relative, writes: false }
      : { allow: false, reason: resolved.reason };
  }
  const verdict = workspaceWriteVerdict(workspace, path);
  return verdict.ok
    ? { allow: true, path: verdict.relative, writes: true }
    : { allow: false, reason: verdict.reason };
}
