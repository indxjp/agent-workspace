import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { expect, it } from 'vitest';

import { ADMIN_ID, harness, URL_, WORKSPACE_ID } from './launcher.test-support.js';
import {
  runtimeProfileConflictWarning,
  runtimeProfileUnenforceableWarning,
} from './local-launcher.js';

it('refuses a seeded workspace the bootstrap admin is not a member of', async () => {
  const h = harness({
    openDatabaseRoot: () =>
      Promise.resolve({
        directory: { marker: 'directory' },
        resolveMembership: () => Promise.resolve(null),
        close: () => Promise.resolve(),
      }),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).toMatchObject({ type: 'failed' });
  expect(JSON.stringify(h.sent[1])).toContain('WORKSPACE_SLUG');
});

it('refuses a membership that is not the seeded bootstrap admin, issuing nothing', async () => {
  const h = harness({
    openDatabaseRoot: () =>
      Promise.resolve({
        directory: { marker: 'directory' },
        resolveMembership: () =>
          Promise.resolve({
            workspaceId: WORKSPACE_ID,
            userId: '2c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
            role: 'admin',
          }),
        close: () => Promise.resolve(),
      }),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent[1]).toMatchObject({ type: 'failed' });
  expect(JSON.stringify(h.sent[1])).toContain('WORKSPACE_SLUG');
  expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
});

it.each(['kept', 'adopted', 'created'] as const)(
  'continues to the credential, silently, when the local runtime profile is %s',
  async (kind) => {
    const h = harness({
      prepareLocalRuntimeProfile: () => Promise.resolve({ kind, profile: { driver: 'local' } }),
    });
    await expect(h.run()).resolves.toBe(0);
    expect(h.sent[1]).toMatchObject({ type: 'credential' });
    expect(h.stderr).toStrictEqual([]);
  },
);

it('warns once on a name-conflict and still starts: agents stay strictly refused', async () => {
  const h = harness({
    prepareLocalRuntimeProfile: () => Promise.resolve({ kind: 'name-conflict', name: 'local' }),
  });
  await expect(h.run()).resolves.toBe(0);
  expect(h.sent[1]).toMatchObject({ type: 'credential' });
  expect(h.stderr).toStrictEqual([runtimeProfileConflictWarning('local')]);
  expect(h.stderr[0]).toContain('cannot run until one is chosen');
  expect(h.stderr[0]?.endsWith('\n')).toBe(true);
});

it('warns once, naming the settings, when the local profile is unenforceable, and still starts', async () => {
  const settings = ['networkPolicy=restricted', 'allowedDomains', 'filesystem=read-only'];
  const h = harness({
    prepareLocalRuntimeProfile: () =>
      Promise.resolve({ kind: 'unenforceable', name: 'local', settings }),
  });
  await expect(h.run()).resolves.toBe(0);
  expect(h.sent[1]).toMatchObject({ type: 'credential' });
  expect(h.stderr).toStrictEqual([runtimeProfileUnenforceableWarning('local', settings)]);
  expect(h.stderr[0]).toContain('networkPolicy=restricted, allowedDomains, filesystem=read-only');
  expect(h.stderr[0]).toContain('cannot run until one is chosen');
  expect(h.stderr[0]?.endsWith('\n')).toBe(true);
});

it('prepares the docker profile under the docker sandbox and starts on a docker default (#786)', async () => {
  const drivers: string[] = [];
  const h = harness({
    prepareLocalRuntimeProfile: (_workspaceId, _root, driver) => {
      drivers.push(driver);
      return Promise.resolve({ kind: 'created', profile: { driver: 'docker' } });
    },
  });
  h.env['RUNTIME_DRIVER'] = 'docker';
  await expect(h.run()).resolves.toBe(0);
  expect(drivers).toStrictEqual(['docker']);
  expect(h.sent[1]).toMatchObject({ type: 'credential' });
});

it('keeps the local profile when no driver was asked for, though the host default is docker', async () => {
  const drivers: string[] = [];
  const seen: (string | undefined)[] = [];
  const h = harness({
    // The driver startWorkspace reports (banner, startup line) is the one runs use (BH061-050).
    startWorkspace: () => {
      seen.push(h.env['RUNTIME_DRIVER']);
      return Promise.resolve({
        url: URL_,
        seed: { workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID },
        close: () => Promise.resolve(),
      });
    },
    prepareLocalRuntimeProfile: (_workspaceId, _root, driver) => {
      drivers.push(driver);
      return Promise.resolve({ kind: 'kept', profile: { driver: 'local' } });
    },
  });
  await expect(h.run()).resolves.toBe(0);
  expect(drivers).toStrictEqual(['local']);
  expect(seen).toStrictEqual(['local']);
});

it.each([
  { kind: 'kept', profile: { driver: 'local' } },
  { kind: 'name-conflict', name: 'docker' },
  { kind: 'unenforceable', name: 'docker', settings: ['networkPolicy=restricted'] },
] as const)(
  'refuses a docker session, issuing nothing, when the default is not a docker profile ($kind)',
  async (outcome) => {
    const h = harness({ prepareLocalRuntimeProfile: () => Promise.resolve(outcome) });
    h.env['RUNTIME_DRIVER'] = 'docker';
    await expect(h.run()).resolves.toBe(1);
    expect(h.sent[1]).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(h.sent[1])).toContain('the docker sandbox needs a runtime profile');
    expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
  },
);

it('answers runtime_profile_not_prepared, issuing nothing, when the preparation throws', async () => {
  const h = harness({
    prepareLocalRuntimeProfile: () =>
      Promise.reject(new Error('postgres://user:secret@127.0.0.1/db is unreachable')),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.sent).toStrictEqual([
    { type: 'ready', url: URL_, contractsVersion: CONTRACTS_VERSION },
    {
      type: 'failed',
      message:
        'the local runtime could not prepare the workspace default runtime profile named local',
    },
  ]);
  expect(h.events.some((event) => event.startsWith('issue:'))).toBe(false);
  expect(h.events.slice(-2)).toStrictEqual(['root.close', 'workspace.close']);
});

it('never prepares the runtime profile of a workspace the admin is not a member of', async () => {
  const h = harness({
    openDatabaseRoot: () =>
      Promise.resolve({
        directory: { marker: 'directory' },
        resolveMembership: () => Promise.resolve(null),
        close: () => Promise.resolve(),
      }),
  });
  await expect(h.run()).resolves.toBe(1);
  expect(h.events.some((event) => event.startsWith('prepareProfile:'))).toBe(false);
});
