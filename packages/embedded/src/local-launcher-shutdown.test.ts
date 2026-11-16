import { existsSync } from 'node:fs';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { expect, it } from 'vitest';

import {
  ADMIN_ID,
  harness,
  projectDir,
  TOKEN,
  URL_,
  WORKSPACE_ID,
} from './launcher.test-support.js';

// UX-G (#760): after SIGKILL of `aw dev` the runtime saw the channel close, began to stop, hung in
// a service that never closed, and then ignored every signal while spinning.
it('exits 1 after the grace when a service never closes, whatever signal arrives', async () => {
  const h = harness({
    stopGraceMs: 20,
    startWorkspace: () =>
      Promise.resolve({
        url: URL_,
        seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
        close: () => new Promise<void>(() => undefined),
      }),
  });
  await h.run();
  const pidFile = path.join(projectDir, '.agent-workspace', 'runtime.pid');
  expect(existsSync(pidFile)).toBe(true);
  h.disconnect();
  h.signal('SIGTERM');
  await expect(h.exitCode).resolves.toBe(1);
  expect(existsSync(pidFile)).toBe(false);
  expect(h.stderr.join('')).toContain('did not stop within the grace');
});

it('revokes, closes and exits 0 on SIGINT, once', async () => {
  const h = harness();
  await h.run();
  h.signal('SIGINT');
  h.signal('SIGTERM');
  h.disconnect();
  await expect(h.exitCode).resolves.toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.events.slice(-4)).toStrictEqual(['revoke', 'root.close', 'workspace.close', 'exit:0']);
  expect(h.events.filter((event) => event === 'exit:0')).toHaveLength(1);
});

// S1-25 (#510): a closed terminal (SIGHUP) or Ctrl+Break (SIGBREAK) ends the process without an
// `exit` event, so the detached postmaster would outlive it unless the launcher stops in order.
it.each(['SIGHUP', 'SIGBREAK'] as const)(
  'revokes, closes and exits 0 on %s, once',
  async (signal) => {
    const h = harness();
    await h.run();
    h.signal(signal);
    h.signal(signal);
    await expect(h.exitCode).resolves.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.events.slice(-4)).toStrictEqual(['revoke', 'root.close', 'workspace.close', 'exit:0']);
    expect(h.events.filter((event) => event === 'exit:0')).toHaveLength(1);
  },
);

it('stops on the channel closing, and tolerates a failed revoke', async () => {
  const h = harness({
    issueLocalCredential: () =>
      Promise.resolve({
        token: TOKEN,
        expiresAt: new Date('2026-10-03T00:00:00.000Z'),
        revoke: () => Promise.reject(new Error('database gone')),
      }),
  });
  await h.run();
  h.disconnect();
  await expect(h.exitCode).resolves.toBe(0);
  expect(h.events.slice(-3)).toStrictEqual(['root.close', 'workspace.close', 'exit:0']);
  expect(h.stderr.join('')).toContain('could not be revoked');
});

it('warns when the key to revoke no longer exists, and stays quiet when it was already revoked', async () => {
  for (const [outcome, warned] of [
    ['missing', true],
    ['already-revoked', false],
  ] as const) {
    const h = harness({
      issueLocalCredential: () =>
        Promise.resolve({
          token: TOKEN,
          expiresAt: new Date('2026-10-03T00:00:00.000Z'),
          revoke: () => Promise.resolve(outcome),
        }),
    });
    await h.run();
    h.disconnect();
    await expect(h.exitCode).resolves.toBe(0);
    expect(h.stderr.join('').includes('was not found to revoke'), outcome).toBe(warned);
    expect(h.events.slice(-3)).toStrictEqual(['root.close', 'workspace.close', 'exit:0']);
  }
});

it('sends failed and releases everything when a step after ready fails', async () => {
  const h = harness({
    issueLocalCredential: () => Promise.reject(new Error(`boom ${TOKEN}`)),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
    { type: 'failed', message: 'the local runtime failed to start (Error)' },
  ]);
  expect(h.events.slice(-2)).toStrictEqual(['root.close', 'workspace.close']);
});
