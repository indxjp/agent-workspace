/**
 * One shell command run to completion, with its output bounded, its time limited and its whole
 * process group killed on a timeout, a cancel or the shell's own exit.
 *
 * Split out of `./executors.ts`, whose `runShell` calls it once per command.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { OPENAI_AGENTS_TOOL_OUTPUT_LIMIT, describe, head } from './tool-output.js';

/** What one command left behind. */
export type ShellCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number | null;
  readonly timedOut: boolean;
  /** How many characters were printed beyond what was kept. */
  readonly dropped: number;
};

const WINDOWS = process.platform === 'win32';

/** How long the output pipes may take to drain after the shell itself has exited. */
const SHELL_EXIT_GRACE_MS = 250;

/**
 * One output pipe, held in memory only up to the answer's own limit: a command that prints without
 * end (`yes`) must not grow the sandbox process for the whole of its time budget. What is not kept
 * is counted, so the report can say how much was dropped.
 *
 * It owns its decoder: a multi-byte character split across two chunks is carried over to the next
 * instead of becoming U+FFFD at both ends of the split.
 */
class BoundedPipe {
  text = '';
  dropped = 0;
  private readonly decoder = new StringDecoder('utf8');

  write(chunk: Buffer): void {
    this.append(this.decoder.write(chunk));
  }

  /** Flushes what the decoder still holds. */
  end(): void {
    this.append(this.decoder.end());
  }

  append(text: string): void {
    const room = Math.max(0, OPENAI_AGENTS_TOOL_OUTPUT_LIMIT - this.text.length);
    if (text.length <= room) {
      this.text += text;
      return;
    }
    const kept = head(text, room);
    this.dropped += text.length - kept.length;
    this.text += kept;
  }
}

/** Whether a signal failed because the process (group) has already exited. */
function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

/**
 * Kill a shell and everything it started: its process group on POSIX. Windows has no process group
 * to signal, so there only the shell is killed (`ChildProcess.kill` reports failure by returning
 * false, never by throwing). A group that is already gone is not an error; any other refusal to
 * signal the group (EPERM) falls back to killing the shell itself, so the command still ends.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (WINDOWS) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (cause) {
    if (!isNoSuchProcess(cause)) child.kill('SIGKILL');
  }
}

/** What bounds one command: where it runs, what it sees, how long it may take, who can cancel it. */
export type ShellCommandOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
};

/**
 * Kills the process group when the deadline passes or the signal aborts. Returns what releases
 * both, to be called once the command is over.
 */
function killOnDeadline(
  child: ChildProcess,
  options: ShellCommandOptions,
  onTimeout: () => void,
): () => void {
  const { timeoutMs, signal } = options;
  const kill = (): void => {
    killProcessTree(child);
  };
  const timer = setTimeout(() => {
    onTimeout();
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted === true) kill();
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  };
}

/** Runs `command` in a shell to completion; never rejects, whatever the command does. */
export function runShellCommand(
  command: string,
  options: ShellCommandOptions,
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    // Its own process group (POSIX), so a timeout or a cancel can kill the whole pipeline — `sh`
    // and everything it started — rather than `sh` alone while `sleep 9999 | cat` lives on.
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...options.env },
      shell: true,
      detached: !WINDOWS,
    });
    const stdout = new BoundedPipe();
    const stderr = new BoundedPipe();
    let timedOut = false;
    let exit: number | null = null;
    let settled = false;
    const release = killOnDeadline(child, options, () => {
      timedOut = true;
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdout.end();
      stderr.end();
      release();
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exit,
        timedOut,
        dropped: stdout.dropped + stderr.dropped,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.write(chunk);
    });
    child.on('error', (cause) => {
      stderr.text += describe(cause);
    });
    // `close` waits for every holder of the output pipes, and a background job (`server &`) holds
    // them forever. So the command is over when `sh` exits: what it left running in its group is
    // killed, and the answer goes back once the pipes drain or after a short grace.
    child.on('exit', (code) => {
      exit = code;
      killProcessTree(child);
      setTimeout(finish, SHELL_EXIT_GRACE_MS).unref();
    });
    child.on('close', (code) => {
      exit ??= code;
      finish();
    });
  });
}
