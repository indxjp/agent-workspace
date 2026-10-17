/**
 * Issue #560: which process runs this project's local runtime, `.agent-workspace/runtime.pid`.
 *
 * A second `aw dev` in the same project used to fail with `port 8080 is already in use`, which does
 * not say that the project's own runtime holds the port. The launcher records its pid here before
 * starting the services and removes it on stop or failure, so a later start that collides on a
 * port can say the runtime is already running and name the process.
 *
 * It is diagnosis only, never a refusal: a start is never turned away because of this file. A pid
 * cannot prove its process is an aw runtime (a stale record's pid can be reused by an unrelated
 * process), so the failure message only says what the file records and never tells the user to
 * stop that pid, and a launcher whose services all bind despite a live record re-records itself,
 * so a stale record heals on the next successful start. Its I/O never fails a start; every error is
 * swallowed.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ensureRuntimeDirectory, RUNTIME_DIRECTORY } from './local-secrets.js';

/** The pid file, inside {@link RUNTIME_DIRECTORY}. */
export const RUNTIME_PID_FILE = 'runtime.pid';

/** A pid file holds one positive decimal integer and an optional trailing line feed. */
const PID_FILE_CONTENT = /^([1-9][0-9]{0,9})\r?\n?$/u;

/** This project's runtime pid file, as the launcher keeps it. */
export interface RuntimeLock {
  /** The live process recorded for `projectDir` other than this one, if any. */
  liveHolder(projectDir: string): number | undefined;
  /** Record this process for `projectDir`, atomically. Never throws. */
  acquire(projectDir: string): void;
  /** Remove the record for `projectDir` when it still names this process. Never throws. */
  release(projectDir: string): void;
}

export interface RuntimeLockOptions {
  /** This process's pid; `process.pid` by default. */
  readonly pid?: number;
  /** Whether `pid` is a live process; `process.kill(pid, 0)` by default. */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Whether `pid` names a live process, by sending it signal 0. `ESRCH` (no such process), `EPERM`
 * (a process another user owns, so not a runtime this user launched) and any other refusal all
 * answer no: the answer only ever words a diagnosis.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFile(projectDir: string): string {
  return path.join(projectDir, RUNTIME_DIRECTORY, RUNTIME_PID_FILE);
}

/** The pid recorded for `projectDir`; a missing, unreadable or malformed file records none. */
function readRecordedPid(projectDir: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(pidFile(projectDir), 'utf8');
  } catch {
    return undefined;
  }
  const match = PID_FILE_CONTENT.exec(content);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const pid = Number.parseInt(digits, 10);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** The pid file of the launcher, over the project's runtime directory. */
export function createRuntimeLock(options: RuntimeLockOptions = {}): RuntimeLock {
  const ownPid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  return {
    liveHolder: (projectDir) => {
      const recorded = readRecordedPid(projectDir);
      if (recorded === undefined || recorded === ownPid) return undefined;
      try {
        return isAlive(recorded) ? recorded : undefined;
      } catch {
        return undefined;
      }
    },
    acquire: (projectDir) => {
      const file = pidFile(projectDir);
      const temporary = `${file}.${String(ownPid)}.tmp`;
      try {
        ensureRuntimeDirectory(projectDir);
        writeFileSync(temporary, `${String(ownPid)}\n`);
        renameSync(temporary, file);
      } catch {
        try {
          unlinkSync(temporary);
        } catch {
          // Nothing was left behind, or it cannot be removed; either way the start goes on.
        }
      }
    },
    release: (projectDir) => {
      if (readRecordedPid(projectDir) !== ownPid) return;
      try {
        unlinkSync(pidFile(projectDir));
      } catch {
        // Another start replaced or removed it first; the record is not ours to fix.
      }
    },
  };
}
