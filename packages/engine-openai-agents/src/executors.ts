/**
 * The executors behind this adapter's tools: our Shell, our Editor and three read tools
 * (ENG-09, #308).
 *
 * The OpenAI Agents SDK runs no local tool itself — `shellTool` and `applyPatchTool` both take an
 * executor the caller supplies — so these are the platform's, and they run **inside the sandbox
 * container, under `cwd`**. Nothing here imports the SDK: the Editor is handed the SDK's
 * `applyDiff` by `./boundary.ts`, so the patch format is the SDK's and not a re-implementation.
 *
 * ## Where the path rules are enforced
 *
 * Every path goes through `./workspace.ts` before the filesystem is touched: a write is refused
 * inside a read-only grant, inside this adapter's own directory, outside the workspace, or at an
 * absolute path that is not under `cwd`. A refusal is an answer to the model
 * (`ERROR: …`), not an exception: the run continues and the file is unchanged, which is what the
 * acceptance criterion *"a write to a read-only-granted path is refused by our Editor, and the file
 * is unchanged"* asks for.
 *
 * **No symbolic link is followed.** The verdict is over the path's spelling, so it is the verdict
 * over the file only when no component of that spelling is a link: `alias -> docs` would let
 * `alias/spec.md` pass a check that `docs/spec.md` fails, and `rm` would then remove the read-only
 * file. Before any filesystem call, {@link symbolicLinkOnPath} `lstat`s every existing component
 * from `cwd` down to the target (and to a move's destination) and refuses the operation if one is a
 * link, as `packages/runtime/src/transfer.ts` does for the runner's own writes. With no link on the path, the
 * real path is the lexical one, so the grant check is a check on the file actually touched.
 *
 * The runner's read-only filesystem modes are the second, independent half of a read-only grant;
 * this is the first.
 */
import { readFile, readdir, stat } from 'node:fs/promises';

import { runShellCommand, type ShellCommandResult } from './shell-process.js';
import { capped, describe, toolError } from './tool-output.js';
import { absolute, linkRefusal } from './workspace-links.js';
import { resolveWorkspacePath, type OpenAiAgentsWorkspace } from './workspace.js';

export { applyPatch, type ApplyDiff, type PatchOperation } from './editor.js';
export { OPENAI_AGENTS_TOOL_OUTPUT_LIMIT } from './tool-output.js';
export { symbolicLinkOnPath } from './workspace-links.js';

/** What a read tool was asked: the verb it answers to, the path, and a pre-checked refusal if any. */
type ReadToolCall = {
  readonly verb: string;
  readonly input: string;
  readonly earlyRefusal?: string | null;
};

/**
 * The shape every read tool shares: resolve `input` inside the workspace, refuse a path with a
 * link on it, run `read` on the resolved path, and answer a sentence for the model if any step
 * fails. `earlyRefusal` is an answer for a bad call that is checked after the path resolves and
 * before the filesystem is touched.
 */
async function readTool(
  workspace: OpenAiAgentsWorkspace,
  call: ReadToolCall,
  read: (relative: string) => Promise<string>,
): Promise<string> {
  const { verb, input, earlyRefusal = null } = call;
  const resolved = resolveWorkspacePath(workspace, input);
  if (!resolved.ok) {
    return toolError(`refused to ${verb} ${JSON.stringify(input)}: ${resolved.reason}`);
  }
  if (earlyRefusal !== null) return earlyRefusal;
  try {
    const linked = await linkRefusal(workspace, verb, input, resolved.relative);
    if (linked !== null) return linked;
    return await read(resolved.relative);
  } catch (cause) {
    return toolError(`${verb} ${resolved.relative} failed: ${describe(cause)}`);
  }
}

/** `read_file`. */
export function readWorkspaceFile(
  workspace: OpenAiAgentsWorkspace,
  input: string,
): Promise<string> {
  return readTool(workspace, { verb: 'read', input }, async (relative) =>
    capped(await readFile(absolute(workspace, relative), 'utf8')),
  );
}

/** `list_files`: one directory, one entry per line, directories with a trailing `/`. */
export function listWorkspaceFiles(
  workspace: OpenAiAgentsWorkspace,
  input: string,
): Promise<string> {
  return readTool(workspace, { verb: 'list', input }, async (relative) => {
    const entries = await readdir(absolute(workspace, relative), { withFileTypes: true });
    return capped(
      entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
        .join('\n'),
    );
  });
}

/** Every line containing `query` under `relative`, as `path:line: text`; symbolic links are skipped. */
async function matchingLines(
  workspace: OpenAiAgentsWorkspace,
  relative: string,
  query: string,
): Promise<string[]> {
  const full = absolute(workspace, relative);
  if (!(await stat(full)).isDirectory()) {
    return (await readFile(full, 'utf8'))
      .split('\n')
      .flatMap((line, index) =>
        line.includes(query) ? [`${relative}:${String(index + 1)}: ${line}`] : [],
      );
  }
  const entries = (await readdir(full, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    matches.push(...(await matchingLines(workspace, child, query)));
  }
  return matches;
}

/** `search_files`: lines containing `query` (a plain substring) under `input`. */
export function searchWorkspaceFiles(
  workspace: OpenAiAgentsWorkspace,
  input: string,
  query: string,
): Promise<string> {
  const earlyRefusal = query.length === 0 ? toolError('the search query is empty.') : null;
  return readTool(workspace, { verb: 'search', input, earlyRefusal }, async (relative) => {
    const matches = await matchingLines(workspace, relative, query);
    return capped(matches.length === 0 ? 'no matches' : matches.join('\n'));
  });
}

/** One shell invocation's arguments, as the `shell` tool takes them. */
export type ShellRequest = {
  readonly commands: readonly string[];
  readonly timeoutMs?: number | null | undefined;
};

/** The default and the ceiling of one command's wall-clock time. */
export const OPENAI_AGENTS_SHELL_TIMEOUT_MS = 120_000;

/**
 * The Shell: `shell`'s executor. Runs each command in order in `cwd`, with the run's environment,
 * and stops at the first that fails. Never throws; a cancelled run kills the running command.
 */
export async function runShell(
  workspace: OpenAiAgentsWorkspace,
  env: Readonly<Record<string, string>>,
  request: ShellRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (request.commands.length === 0) return toolError('no command was given.');
  const timeoutMs = Math.min(
    Math.max(1, request.timeoutMs ?? OPENAI_AGENTS_SHELL_TIMEOUT_MS),
    OPENAI_AGENTS_SHELL_TIMEOUT_MS,
  );
  const reports: string[] = [];
  for (const command of request.commands) {
    const result = await runShellCommand(command, { cwd: workspace.cwd, env, timeoutMs, signal });
    reports.push(shellReport(command, result));
    if (result.timedOut || result.exit !== 0) {
      return toolError(capped(reports.join('\n')));
    }
  }
  return capped(reports.join('\n'));
}

/** One command's report: the command, its status line, its output and its stderr when it has any. */
function shellReport(command: string, result: ShellCommandResult): string {
  const outcome = result.timedOut ? 'timeout' : `exit ${String(result.exit)}`;
  // In the status line rather than after the output, so the answer's own cap cannot cut it off.
  const dropped =
    result.dropped === 0
      ? ''
      : `; truncated: ${String(result.dropped)} more characters were printed and not kept`;
  const stderr = result.stderr === '' ? '' : `\n[stderr]\n${result.stderr}`;
  return `$ ${command}\n[${outcome}${dropped}]\n${result.stdout}${stderr}`;
}
