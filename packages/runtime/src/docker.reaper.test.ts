import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCKER_REAP_INTERVAL_MS } from './docker.js';
import type { DockerCommandResult } from './docker.js';
import { commandResult, runSpec, recordingDriver } from './docker.test-support.js';

const removals = (calls: readonly string[][]) => calls.filter((call) => call[0] === 'rm');

describe('docker driver deadline reaper (#783)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes a session past expiresAt without a manager shutdown', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 60 }),
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(removals(calls)).toEqual([]);

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toEqual([['rm', '--force', '--volumes', 'c-1']]);
  });

  it('never reaps a session without a deadline', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({ sessionId: 's', engine: 'claude-agent-sdk', workspacePath: '/ws/s' });

    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(removals(calls)).toEqual([]);
  });

  it('reads a reaped handle as not live and lets the manager destroy it', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(1);
    expect(await driver.isLive(handle)).toBe(false);
    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    expect(removals(calls)).toHaveLength(1);
    await expect(driver.destroy(handle)).rejects.toThrow(/no longer live/u);
  });

  it('keeps the handle when removal fails, warns once and retries on the next tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls: string[][] = [];
    let failing = true;
    const driver = recordingDriver(calls, {
      rm: () => (failing ? commandResult(1, '', 'daemon busy') : commandResult(0)),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/c-1: daemon busy/u));
    warn.mockRestore();
    failing = false;
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    expect(removals(calls)).toHaveLength(3);
    expect(await driver.isLive(handle)).toBe(false);
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS * 4);
    expect(removals(calls)).toHaveLength(3);
  });

  it('lets destroy and a reaper tick race on the same container', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const pending: ((result: DockerCommandResult) => void)[] = [];
    const driver = recordingDriver(calls, {
      rm: () =>
        new Promise<DockerCommandResult>((resolve) => {
          pending.push(resolve);
        }),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });

    // The reaper wins: its rm removes the container, destroy's rm finds it already gone.
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    const destroyed = driver.destroy(handle);
    expect(pending).toHaveLength(2);
    pending[0]?.(commandResult(0));
    await vi.advanceTimersByTimeAsync(0);
    pending[1]?.(commandResult(1, '', 'Error response from daemon: No such container: c-1'));
    await expect(destroyed).resolves.toBeUndefined();
    await expect(driver.destroy(handle)).rejects.toThrow(/no longer live/u);

    // destroy wins: the late reaper rm must not record the dropped handle as reaped.
    const second = await driver.create({
      sessionId: 's2',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s2',
      runSpec: runSpec({ timeoutSeconds: 1 }),
    });
    await vi.advanceTimersByTimeAsync(DOCKER_REAP_INTERVAL_MS);
    const destroyedSecond = driver.destroy(second);
    expect(pending).toHaveLength(4);
    pending[3]?.(commandResult(0));
    await expect(destroyedSecond).resolves.toBeUndefined();
    pending[2]?.(commandResult(1, '', 'No such container: c-2'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(driver.destroy(second)).rejects.toThrow(/no longer live/u);
  });

  it('waits out a removal another call still has in progress', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const answers = [
      commandResult(
        1,
        '',
        'Error response from daemon: removal of container c-1 is already in progress',
      ),
      commandResult(
        1,
        '',
        'Error response from daemon: removal of container c-1 is already in progress',
      ),
      commandResult(1, '', 'Error response from daemon: No such container: c-1'),
    ];
    const driver = recordingDriver(calls, { rm: () => answers.shift() ?? commandResult(0) });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec(),
    });

    const destroyed = driver.destroy(handle);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(destroyed).resolves.toBeUndefined();
    expect(removals(calls)).toHaveLength(3);
    expect(await driver.isLive(handle)).toBe(false);
  });

  it('still reports a removal that keeps failing', async () => {
    const calls: string[][] = [];
    const driver = recordingDriver(calls, {
      rm: () => commandResult(1, '', 'Error response from daemon: device or resource busy'),
    });
    const handle = await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec(),
    });

    await expect(driver.destroy(handle)).rejects.toThrow(/remove container failed: .*busy/u);
    expect(removals(calls)).toHaveLength(1);
  });

  it('stops the interval once reapAll has run', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const driver = recordingDriver(calls);
    await driver.create({
      sessionId: 's',
      engine: 'claude-agent-sdk',
      workspacePath: '/ws/s',
      runSpec: runSpec({ timeoutSeconds: 3_600 }),
    });
    await driver.reapAll();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(calls).toEqual([]);
  });
});
