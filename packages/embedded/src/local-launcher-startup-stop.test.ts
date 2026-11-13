import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { expect, it } from 'vitest';

import { deferred, harness, TOKEN, until, URL_, WORKSPACE } from './launcher.test-support.js';

it('exits 0 at once on a signal before start arrives, starting nothing', async () => {
  const h = harness({ startTimeoutMs: 60_000 });
  const result = h.launch();
  await Promise.resolve();
  h.signal('SIGINT');
  await expect(result).resolves.toBe(0);
  await expect(h.exitCode).resolves.toBe(0);
  expect(h.sent).toStrictEqual([]);
  expect(h.events).toStrictEqual(['exit:0']);
});

it('abandons a start in progress on SIGTERM, closes the workspace when it arrives, and exits 0', async () => {
  const pending = deferred<{
    url: string;
    seed: { workspaceId: string; adminUserId: string };
    close: () => Promise<void>;
  }>();
  const h = harness({
    startWorkspace: () => {
      h.events.push('startWorkspace');
      return pending.promise;
    },
  });
  const result = h.run();
  await until(() => h.events.includes('startWorkspace'));
  h.signal('SIGTERM');
  pending.resolve({
    ...WORKSPACE,
    close: () => {
      h.events.push('workspace.close');
      return Promise.resolve();
    },
  });
  await expect(result).resolves.toBe(0);
  expect(h.sent).toStrictEqual([]);
  expect(h.events.slice(-2)).toStrictEqual(['workspace.close', 'exit:0']);
});

it('revokes a key that arrives after a stop during the start before closing the database', async () => {
  const pending = deferred<{
    token: string;
    expiresAt: Date;
    revoke: () => Promise<'revoked' | 'already-revoked' | 'missing'>;
  }>();
  const h = harness({
    issueLocalCredential: () => {
      h.events.push('issue');
      return pending.promise;
    },
  });
  const result = h.run();
  await until(() => h.events.includes('issue'));
  h.signal('SIGINT');
  pending.resolve({
    token: TOKEN,
    expiresAt: new Date('2026-10-03T00:00:00.000Z'),
    revoke: () => {
      h.events.push('revoke');
      return Promise.resolve('revoked' as const);
    },
  });
  await expect(result).resolves.toBe(0);
  expect(h.sent).toStrictEqual([{ type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION }]);
  expect(h.events.slice(-4)).toStrictEqual(['revoke', 'root.close', 'workspace.close', 'exit:0']);
  for (const output of [...h.stdout, ...h.stderr]) expect(output).not.toContain(TOKEN);
});

it('exits 0 after the grace period when the channel closes during a start that never settles', async () => {
  const h = harness({
    stopGraceMs: 20,
    startWorkspace: () => {
      h.events.push('startWorkspace');
      return new Promise(() => undefined);
    },
  });
  const result = h.run();
  await until(() => h.events.includes('startWorkspace'));
  h.disconnect();
  await expect(result).resolves.toBe(0);
  await expect(h.exitCode).resolves.toBe(0);
  expect(h.sent).toStrictEqual([]);
});

it('reports failed when the start outlives its deadline', async () => {
  const h = harness({
    startupTimeoutMs: 30,
    stopGraceMs: 20,
    startWorkspace: () => new Promise(() => undefined),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'failed', message: 'the local runtime did not become ready in time' },
  ]);
  expect(h.events).not.toContain('exit:0');
});
