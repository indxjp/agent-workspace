import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { harness, projectDir, WORKSPACE } from './launcher.test-support.js';
import { RUNTIME_DIRECTORY } from './local-secrets.js';
import { createRuntimeLock, RUNTIME_PID_FILE } from './runtime-lock.js';

const OWN_PID = 1000;
const HOLDER_PID = 4242;
const runnerInUse = () =>
  Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8080'), {
    code: 'EADDRINUSE',
    port: 8080,
  });
const pidFile = () => path.join(projectDir, RUNTIME_DIRECTORY, RUNTIME_PID_FILE);
const recordHolder = (pid: number) => {
  mkdirSync(path.join(projectDir, RUNTIME_DIRECTORY), { recursive: true });
  writeFileSync(pidFile(), `${String(pid)}\n`);
};
const lock = (alive: readonly number[]) =>
  createRuntimeLock({ pid: OWN_PID, isAlive: (pid) => alive.includes(pid) });

it('reports already_running, with the port and the recorded pid, when the runner port collides', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({
    runtimeLock: lock([HOLDER_PID]),
    startWorkspace: () => Promise.reject(runnerInUse()),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    {
      type: 'failed',
      message:
        "port 8080 is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process 4242); if aw dev is running in this project, stop that aw dev before running it again",
    },
  ]);
  // The holder's record is not ours to remove.
  expect(readFileSync(pidFile(), 'utf8')).toBe('4242\n');
});

it('reports already_running when the port check finds the ports taken', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({
    runtimeLock: lock([HOLDER_PID]),
    portState: (port) => Promise.resolve(port === 3100 || port === 8080 ? 'listening' : 'free'),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    {
      type: 'failed',
      message:
        "port 3100 is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process 4242); if aw dev is running in this project, stop that aw dev before running it again",
    },
  ]);
  expect(h.events.some((event) => event.startsWith('startWorkspace'))).toBe(false);
});

it('finds the collision inside an AggregateError too', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({
    runtimeLock: lock([HOLDER_PID]),
    startWorkspace: () => Promise.reject(new AggregateError([runnerInUse()], 'start failed')),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(JSON.stringify(h.sent[0])).toContain('runtime.pid records process 4242');
});

it('keeps "port 8080 is already in use" when no live process holds the project', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({
    runtimeLock: lock([]),
    startWorkspace: () => Promise.reject(runnerInUse()),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([{ type: 'failed', message: 'port 8080 is already in use' }]);
});

it('never refuses a start up front because of a live holder', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({ runtimeLock: lock([HOLDER_PID]) });
  await expect(h.run()).resolves.toBe(0);
  expect(h.sent[1]).toMatchObject({ type: 'credential' });
});

it('re-records itself over a stale record whose pid an unrelated live process reuses', async () => {
  // A hard-killed runtime left its pid behind, and an unrelated live process now has that pid.
  recordHolder(HOLDER_PID);
  let recordedDuringStart = '';
  const h = harness({
    runtimeLock: lock([HOLDER_PID]),
    startWorkspace: () => {
      recordedDuringStart = readFileSync(pidFile(), 'utf8');
      return Promise.resolve({ ...WORKSPACE, close: () => Promise.resolve() });
    },
  });
  await expect(h.run()).resolves.toBe(0);
  // The record is only read while the services start...
  expect(recordedDuringStart).toBe(`${String(HOLDER_PID)}
`);
  // ...and once every service is bound, the record names this runtime, not the unrelated process.
  expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(OWN_PID)}
`);
  h.signal('SIGINT');
  await expect(h.exitCode).resolves.toBe(0);
  expect(existsSync(pidFile())).toBe(false);
});

it('reports a failure that is not a collision as itself, even with a live holder', async () => {
  recordHolder(HOLDER_PID);
  const h = harness({
    runtimeLock: lock([HOLDER_PID]),
    startWorkspace: () => Promise.reject(new Error('boom')),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'failed', message: 'the local runtime failed to start (Error)' },
  ]);
});

it('records its pid while running and removes it on stop', async () => {
  const h = harness({ runtimeLock: lock([]) });
  await expect(h.run()).resolves.toBe(0);
  expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(OWN_PID)}\n`);
  h.signal('SIGINT');
  await expect(h.exitCode).resolves.toBe(0);
  expect(existsSync(pidFile())).toBe(false);
});

it('replaces a stale record and removes its own after a failed start', async () => {
  recordHolder(HOLDER_PID);
  let recordedDuringStart = '';
  const h = harness({
    runtimeLock: lock([]),
    startWorkspace: () => {
      recordedDuringStart = readFileSync(pidFile(), 'utf8');
      return Promise.reject(runnerInUse());
    },
  });
  await expect(h.run()).resolves.toBe(1);
  expect(recordedDuringStart).toBe(`${String(OWN_PID)}\n`);
  expect(existsSync(pidFile())).toBe(false);
});

it('records the real process by default', async () => {
  const h = harness();
  await expect(h.run()).resolves.toBe(0);
  expect(readFileSync(pidFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
  h.disconnect();
  await expect(h.exitCode).resolves.toBe(0);
  expect(existsSync(pidFile())).toBe(false);
});
