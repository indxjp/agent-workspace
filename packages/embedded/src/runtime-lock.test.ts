import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNTIME_DIRECTORY } from './local-secrets.js';
import { createRuntimeLock, RUNTIME_PID_FILE } from './runtime-lock.js';

let projectDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'embedded-runtime-lock-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const runtimeDirectory = () => path.join(projectDir, RUNTIME_DIRECTORY);
const pidFile = () => path.join(runtimeDirectory(), RUNTIME_PID_FILE);

function record(content: string): void {
  mkdirSync(runtimeDirectory(), { recursive: true });
  writeFileSync(pidFile(), content);
}

describe('createRuntimeLock (#560)', () => {
  it('writes its own pid in a git-ignored runtime directory, and removes it again', () => {
    const lock = createRuntimeLock({ pid: 1000, isAlive: () => true });
    lock.acquire(projectDir);
    expect(readFileSync(pidFile(), 'utf8')).toBe('1000\n');
    expect(readFileSync(path.join(runtimeDirectory(), '.gitignore'), 'utf8')).toBe('*\n');
    expect(lock.liveHolder(projectDir)).toBeUndefined();
    lock.release(projectDir);
    expect(existsSync(pidFile())).toBe(false);
    expect(() => {
      lock.release(projectDir);
    }).not.toThrow();
  });

  it('leaves no temporary file behind', () => {
    createRuntimeLock({ pid: 1000 }).acquire(projectDir);
    expect(readdirSync(runtimeDirectory()).sort()).toStrictEqual(['.gitignore', RUNTIME_PID_FILE]);
  });

  it('answers a live holder other than itself', () => {
    record('4242\n');
    const checked: number[] = [];
    const lock = createRuntimeLock({
      pid: 1000,
      isAlive: (pid) => {
        checked.push(pid);
        return true;
      },
    });
    expect(lock.liveHolder(projectDir)).toBe(4242);
    expect(checked).toStrictEqual([4242]);
  });

  it('ignores a stale pid, and replaces it on acquire', () => {
    record('4242\n');
    const lock = createRuntimeLock({ pid: 1000, isAlive: () => false });
    expect(lock.liveHolder(projectDir)).toBeUndefined();
    lock.acquire(projectDir);
    expect(readFileSync(pidFile(), 'utf8')).toBe('1000\n');
  });

  it('treats a liveness check that throws as no holder', () => {
    record('4242\n');
    const lock = createRuntimeLock({
      pid: 1000,
      isAlive: () => {
        throw new Error('no such process');
      },
    });
    expect(lock.liveHolder(projectDir)).toBeUndefined();
  });

  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
    ['text', 'running\n'],
    ['a negative pid', '-4\n'],
    ['zero', '0\n'],
    ['two lines', '4242\n4243\n'],
    ['a fraction', '42.5\n'],
  ])('answers no holder for %s', (_name, content) => {
    if (content !== undefined) record(content);
    const lock = createRuntimeLock({ pid: 1000, isAlive: () => true });
    expect(lock.liveHolder(projectDir)).toBeUndefined();
  });

  it('never removes a record that names another process', () => {
    record('4242\n');
    createRuntimeLock({ pid: 1000, isAlive: () => true }).release(projectDir);
    expect(readFileSync(pidFile(), 'utf8')).toBe('4242\n');
  });

  it('never throws when the runtime directory cannot be written', () => {
    writeFileSync(runtimeDirectory(), 'a file where the directory belongs');
    const lock = createRuntimeLock({ pid: 1000 });
    expect(() => {
      lock.acquire(projectDir);
    }).not.toThrow();
    expect(lock.liveHolder(projectDir)).toBeUndefined();
    expect(() => {
      lock.release(projectDir);
    }).not.toThrow();
  });

  it('checks liveness with process.kill by default', () => {
    record(`${String(process.pid)}\n`);
    // Its own pid is never a foreign holder.
    expect(createRuntimeLock().liveHolder(projectDir)).toBeUndefined();
    // This process is alive, so a lock that belongs to another pid sees it.
    expect(createRuntimeLock({ pid: 1 }).liveHolder(projectDir)).toBe(process.pid);
  });
});
