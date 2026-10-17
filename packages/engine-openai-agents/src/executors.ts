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
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OPENAI_AGENTS_TOOL_ERROR_PREFIX } from './frames.js';
import {
  resolveWorkspacePath,
  workspaceWriteVerdict,
  type OpenAiAgentsWorkspace,
} from './workspace.js';

/** The SDK's `applyDiff`, as the Editor takes it. */
export type ApplyDiff = (input: string, diff: string, mode?: 'default' | 'create') => string;

/** One patch operation, in the shape the SDK's `ApplyPatchOperation` has. */
export type PatchOperation =
  | { readonly type: 'create_file'; readonly path: string; readonly diff: string }
  | {
      readonly type: 'update_file';
      readonly path: string;
      readonly diff: string;
      readonly moveTo?: string | null | undefined;
    }
  | { readonly type: 'delete_file'; readonly path: string };

/** The largest answer a tool hands back to the model, in characters. */
export const OPENAI_AGENTS_TOOL_OUTPUT_LIMIT = 64 * 1024;

function error(message: string): string {
  return `${OPENAI_AGENTS_TOOL_ERROR_PREFIX}${message}`;
}

function capped(text: string): string {
  return text.length <= OPENAI_AGENTS_TOOL_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OPENAI_AGENTS_TOOL_OUTPUT_LIMIT)}\n[truncated: ${String(text.length - OPENAI_AGENTS_TOOL_OUTPUT_LIMIT)} more characters]`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(workspace: OpenAiAgentsWorkspace, relative: string): string {
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
async function linkRefusal(
  workspace: OpenAiAgentsWorkspace,
  verb: string,
  input: string,
  relative: string,
): Promise<string | null> {
  const link = await symbolicLinkOnPath(workspace, relative);
  return link === null
    ? null
    : error(
        `refused to ${verb} ${JSON.stringify(input)}: ${JSON.stringify(link)} is a symbolic link, and no tool follows one.`,
      );
}

/** The Editor: `apply_patch`'s executor. Answers a sentence for the model, never throws. */
export async function applyPatch(
  workspace: OpenAiAgentsWorkspace,
  operation: PatchOperation,
  applyDiff: ApplyDiff,
): Promise<string> {
  const target = workspaceWriteVerdict(workspace, operation.path);
  if (!target.ok)
    return error(`refused to write ${JSON.stringify(operation.path)}: ${target.reason}`);
  const file = absolute(workspace, target.relative);
  try {
    const linked = await linkRefusal(workspace, 'write', operation.path, target.relative);
    if (linked !== null) return linked;
    if (operation.type === 'delete_file') {
      await rm(file);
      return `deleted ${target.relative}`;
    }
    if (operation.type === 'create_file') {
      const content = applyDiff('', operation.diff, 'create');
      await mkdir(path.posix.dirname(file), { recursive: true });
      await writeFile(file, content, { flag: 'wx' });
      return `created ${target.relative}`;
    }
    const moveTo = operation.moveTo ?? null;
    let destination: string | null = null;
    if (moveTo !== null) {
      const moved = workspaceWriteVerdict(workspace, moveTo);
      if (!moved.ok) return error(`refused to move to ${JSON.stringify(moveTo)}: ${moved.reason}`);
      const movedLink = await linkRefusal(workspace, 'move to', moveTo, moved.relative);
      if (movedLink !== null) return movedLink;
      destination = absolute(workspace, moved.relative);
    }
    const current = await readFile(file, 'utf8');
    const updated = applyDiff(current, operation.diff);
    await writeFile(file, updated);
    if (destination !== null) {
      await mkdir(path.posix.dirname(destination), { recursive: true });
      await rename(file, destination);
      return `updated ${target.relative} and moved it to ${moveTo ?? ''}`;
    }
    return `updated ${target.relative}`;
  } catch (cause) {
    return error(`${operation.type} ${target.relative} failed: ${describe(cause)}`);
  }
}

/** `read_file`. */
export async function readWorkspaceFile(
  workspace: OpenAiAgentsWorkspace,
  input: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(workspace, input);
  if (!resolved.ok) return error(`refused to read ${JSON.stringify(input)}: ${resolved.reason}`);
  try {
    const linked = await linkRefusal(workspace, 'read', input, resolved.relative);
    if (linked !== null) return linked;
    return capped(await readFile(absolute(workspace, resolved.relative), 'utf8'));
  } catch (cause) {
    return error(`read ${resolved.relative} failed: ${describe(cause)}`);
  }
}

/** `list_files`: one directory, one entry per line, directories with a trailing `/`. */
export async function listWorkspaceFiles(
  workspace: OpenAiAgentsWorkspace,
  input: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(workspace, input);
  if (!resolved.ok) return error(`refused to list ${JSON.stringify(input)}: ${resolved.reason}`);
  try {
    const linked = await linkRefusal(workspace, 'list', input, resolved.relative);
    if (linked !== null) return linked;
    const entries = await readdir(absolute(workspace, resolved.relative), { withFileTypes: true });
    return capped(
      entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
        .join('\n'),
    );
  } catch (cause) {
    return error(`list ${resolved.relative} failed: ${describe(cause)}`);
  }
}

/** `search_files`: lines containing `query` (a plain substring) under `input`. */
export async function searchWorkspaceFiles(
  workspace: OpenAiAgentsWorkspace,
  input: string,
  query: string,
): Promise<string> {
  const resolved = resolveWorkspacePath(workspace, input);
  if (!resolved.ok) return error(`refused to search ${JSON.stringify(input)}: ${resolved.reason}`);
  if (query.length === 0) return error('the search query is empty.');
  const matches: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const full = absolute(workspace, relative);
    const info = await stat(full);
    if (info.isDirectory()) {
      const entries = await readdir(full, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        await walk(relative === '.' ? entry.name : `${relative}/${entry.name}`);
      }
      return;
    }
    const lines = (await readFile(full, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (line.includes(query)) matches.push(`${relative}:${String(index + 1)}: ${line}`);
    });
  };
  try {
    const linked = await linkRefusal(workspace, 'search', input, resolved.relative);
    if (linked !== null) return linked;
    await walk(resolved.relative);
    return capped(matches.length === 0 ? 'no matches' : matches.join('\n'));
  } catch (cause) {
    return error(`search ${resolved.relative} failed: ${describe(cause)}`);
  }
}

/** One shell invocation's arguments, as the `shell` tool takes them. */
export type ShellRequest = {
  readonly commands: readonly string[];
  readonly timeoutMs?: number | null | undefined;
};

/** The default and the ceiling of one command's wall-clock time. */
export const OPENAI_AGENTS_SHELL_TIMEOUT_MS = 120_000;

function runOne(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{
  stdout: string;
  stderr: string;
  exit: number | null;
  timedOut: boolean;
  dropped: number;
}> {
  return new Promise((resolve) => {
    // Its own process group (POSIX), so a timeout or a cancel can kill the whole pipeline — `sh`
    // and everything it started — rather than `sh` alone while `sleep 9999 | cat` lives on.
    const child = spawn(command, { cwd, env: { ...env }, shell: true, detached: !WINDOWS });
    let stdout = '';
    let stderr = '';
    let dropped = 0;
    let timedOut = false;
    // Held in memory only up to the answer's own limit: a command that prints without end (`yes`)
    // must not grow the sandbox process for the whole of its time budget. What is not kept is
    // counted, so the report can say how much was dropped.
    const keep = (held: string, chunk: Buffer): string => {
      const text = chunk.toString('utf8');
      const room = Math.max(0, OPENAI_AGENTS_TOOL_OUTPUT_LIMIT - held.length);
      if (text.length <= room) return held + text;
      dropped += text.length - room;
      return held + text.slice(0, room);
    };
    const kill = (): void => {
      killProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted === true) kill();
    let exit: number | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ stdout, stderr, exit, timedOut, dropped });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keep(stderr, chunk);
    });
    child.on('error', (cause) => {
      stderr += describe(cause);
    });
    // `close` waits for every holder of the output pipes, and a background job (`server &`) holds
    // them forever. So the command is over when `sh` exits: what it left running in its group is
    // killed, and the answer goes back once the pipes drain or after a short grace.
    child.on('exit', (code) => {
      exit = code;
      kill();
      setTimeout(finish, SHELL_EXIT_GRACE_MS).unref();
    });
    child.on('close', (code) => {
      exit ??= code;
      finish();
    });
  });
}

const WINDOWS = process.platform === 'win32';

/** How long the output pipes may take to drain after the shell itself has exited. */
const SHELL_EXIT_GRACE_MS = 250;

/**
 * Kill a shell and everything it started: its process group on POSIX. Windows has no process group
 * to signal, so there only the shell is killed. A process that is already gone is not an error.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (WINDOWS) child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the group has already exited.
  }
}

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
  if (request.commands.length === 0) return error('no command was given.');
  const timeoutMs = Math.min(
    Math.max(1, request.timeoutMs ?? OPENAI_AGENTS_SHELL_TIMEOUT_MS),
    OPENAI_AGENTS_SHELL_TIMEOUT_MS,
  );
  const reports: string[] = [];
  for (const command of request.commands) {
    const result = await runOne(command, workspace.cwd, env, timeoutMs, signal);
    const outcome = result.timedOut ? 'timeout' : `exit ${String(result.exit)}`;
    // In the status line rather than after the output, so the answer's own cap cannot cut it off.
    const dropped =
      result.dropped === 0
        ? ''
        : `; truncated: ${String(result.dropped)} more characters were printed and not kept`;
    reports.push(
      `$ ${command}\n[${outcome}${dropped}]\n${result.stdout}${result.stderr === '' ? '' : `\n[stderr]\n${result.stderr}`}`,
    );
    if (result.timedOut || result.exit !== 0) {
      return error(capped(reports.join('\n')));
    }
  }
  return capped(reports.join('\n'));
}
