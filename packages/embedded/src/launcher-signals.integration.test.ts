import { localApiKeys } from './launcher-api.test-support.js';
import { DATABASE_PORT } from './launcher-ports.test-support.js';
import { RuntimeTestProject } from './launcher-project.test-support.js';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { getMe } from './launcher-api.test-support.js';
import { freePorts, holdPort } from './launcher-ports.test-support.js';
import {
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  expectCleanStop,
  isAlive,
  processGroupOf,
} from './launcher-process.test-support.js';

/**
 * S1-25 (#510): a terminal's Ctrl+C reaches only the launcher. The launcher is forked `detached`,
 * so it leads its own process group like a terminal job, and SIGINT goes to that whole group.
 */

const project = new RuntimeTestProject('embedded-launcher-group-');
beforeAll(() => project.prepare());
afterAll(() => project.close(), STOP_TIMEOUT_MS);

it(
  'stops in order on a SIGINT to its whole group, and on a SIGHUP to it on the next start',
  async () => {
    const ports = await freePorts();
    const { runtime, credential } = await project.start({ ports, detached: true });
    const pid = project.recordPostmaster();

    if (process.platform !== 'win32') {
      // The launcher leads its group; the postmaster must be in a group of its own.
      expect(processGroupOf(runtime.pid)).toBe(runtime.pid);
      expect(processGroupOf(pid)).not.toBe(runtime.pid);
    }

    const exit = await runtime.interruptGroup();
    const exitedAt = new Date();
    expect(exit, runtime.stderr).toStrictEqual({ code: 0, signal: null });
    expectCleanStop(runtime.stderr);
    if (process.platform !== 'win32') expect(isAlive(pid)).toBe(false);
    const held = await holdPort(DATABASE_PORT);
    expect(held, `port ${String(DATABASE_PORT)} is still in use`).not.toBeNull();
    if (held !== null) await new Promise<void>((resolve) => held.close(() => resolve()));

    // A normal restart on the same project: the first key was revoked by the stop.
    const nextPorts = await freePorts();
    const restarted = await project.start({ ports: nextPorts, detached: true });
    const next = restarted.runtime;
    const nextPid = project.recordPostmaster();
    expect((await getMe(restarted.ready.url, credential.token)).status).toBe(401);

    const keys = await localApiKeys(credential.workspaceId);
    const revoked = keys.filter((key) => key.revokedAt !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revokedAt?.getTime()).toBeLessThanOrEqual(exitedAt.getTime());

    // A closed terminal on a second start, which imports no embedded-postgres and so has no
    // library exit hook: SIGHUP's default action skips the `exit` backstop, so only the
    // launcher's own ordered stop ends the detached postmaster (review of #510).
    expect(await next.interruptGroup('SIGHUP'), next.stderr).toStrictEqual({
      code: 0,
      signal: null,
    });
    expectCleanStop(next.stderr);
    if (process.platform !== 'win32') expect(isAlive(nextPid)).toBe(false);
    const heldAfterHangUp = await holdPort(DATABASE_PORT);
    expect(heldAfterHangUp, `port ${String(DATABASE_PORT)} is still in use`).not.toBeNull();
    if (heldAfterHangUp !== null) {
      await new Promise<void>((resolve) => heldAfterHangUp.close(() => resolve()));
    }
  },
  2 * START_TIMEOUT_MS + 2 * STOP_TIMEOUT_MS + 30_000,
);
