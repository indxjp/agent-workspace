import {
  createInMemoryWorkspaceScopeResolver,
  type CreateRuntimeProfileInput,
  type EnsureWorkspaceDefaultOptions,
  type EnsureWorkspaceDefaultRuntimeProfileOutcome,
  type RuntimeProfileRecord,
  type RuntimeProfileRepository,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import {
  DOCKER_RUNTIME_PROFILE,
  dockerRunnerUnenforceable,
  LOCAL_RUNTIME_PROFILE,
  localRunnerUnenforceable,
  LocalRuntimeProfileWorkspaceMissingError,
  prepareLocalRuntimeProfile,
} from './local-runtime-profile.js';

const WORKSPACE_ID = '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const OTHER_WORKSPACE_ID = '2c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';

function unused(): Promise<never> {
  return Promise.reject(new Error('prepareLocalRuntimeProfile calls ensureWorkspaceDefault only'));
}

function profileOf(input: CreateRuntimeProfileInput): RuntimeProfileRecord {
  const at = new Date('2026-10-02T00:00:00.000Z');
  return { ...input, id: 'rp-local', workspaceId: WORKSPACE_ID, createdAt: at, updatedAt: at };
}

/** A root over one known workspace whose `ensureWorkspaceDefault` records what it was handed. */
function rootFor(
  answer: (
    input: CreateRuntimeProfileInput,
    options: EnsureWorkspaceDefaultOptions,
  ) => EnsureWorkspaceDefaultRuntimeProfileOutcome,
) {
  const calls: { readonly workspaceId: string; readonly input: CreateRuntimeProfileInput }[] = [];
  const repository = (scope: WorkspaceScope): RuntimeProfileRepository => ({
    list: unused,
    get: unused,
    create: unused,
    update: unused,
    delete: unused,
    findWorkspaceDefault: unused,
    ensureWorkspaceDefault: (input, options) => {
      calls.push({ workspaceId: scope.workspaceId, input });
      return Promise.resolve(answer(input, options));
    },
  });
  return {
    calls,
    root: {
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'default' }]),
      runtimeProfiles: { forScope: repository },
    },
  };
}

describe('LOCAL_RUNTIME_PROFILE', () => {
  it('asks the in-process runner for nothing it cannot enforce (localRuntimeRunSpecRejection)', () => {
    expect(LOCAL_RUNTIME_PROFILE).toStrictEqual({
      name: 'local',
      driver: 'local',
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'open',
      allowedDomains: null,
      filesystem: 'read-write',
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    });
  });
});

describe('prepareLocalRuntimeProfile', () => {
  it.each(['kept', 'adopted', 'created'] as const)(
    'ensures the local profile in the seeded workspace and answers %s as core does',
    async (kind) => {
      const { calls, root } = rootFor((input) => ({ kind, profile: profileOf(input) }));
      const outcome = await prepareLocalRuntimeProfile(WORKSPACE_ID, root);
      expect(outcome).toMatchObject({ kind, profile: { name: 'local', driver: 'local' } });
      expect(calls).toStrictEqual([{ workspaceId: WORKSPACE_ID, input: LOCAL_RUNTIME_PROFILE }]);
    },
  );

  it('answers a name-conflict as it is, for the launcher to warn about', async () => {
    const { root } = rootFor((input) => ({ kind: 'name-conflict', name: input.name }));
    await expect(prepareLocalRuntimeProfile(WORKSPACE_ID, root)).resolves.toStrictEqual({
      kind: 'name-conflict',
      name: 'local',
    });
  });

  it('lets core adopt only a local profile the in-process runner can enforce', async () => {
    const seen: boolean[] = [];
    const { root } = rootFor((input, options) => {
      seen.push(options.adoptable(profileOf(input)));
      seen.push(
        options.adoptable(profileOf({ ...input, timeoutSeconds: 60, persistPaths: ['/w'] })),
      );
      seen.push(options.adoptable(profileOf({ ...input, networkPolicy: 'restricted' })));
      seen.push(options.adoptable(profileOf({ ...input, cpu: 1 })));
      return { kind: 'created', profile: profileOf(input) };
    });
    await prepareLocalRuntimeProfile(WORKSPACE_ID, root);
    expect(seen).toStrictEqual([true, true, false, false]);
  });

  it('answers a not-adoptable local profile as unenforceable, naming what the runner cannot enforce', async () => {
    const restricted = profileOf({
      ...LOCAL_RUNTIME_PROFILE,
      networkPolicy: 'restricted',
      allowedDomains: ['example.com'],
      filesystem: 'read-only',
    });
    const { root } = rootFor(() => ({ kind: 'not-adoptable', profile: restricted }));
    await expect(prepareLocalRuntimeProfile(WORKSPACE_ID, root)).resolves.toStrictEqual({
      kind: 'unenforceable',
      name: 'local',
      settings: ['networkPolicy=restricted', 'allowedDomains', 'filesystem=read-only'],
    });
  });

  it('replaces only the launcher profile of the other driver as the default', async () => {
    const replaceable: Record<string, boolean[]> = { local: [], docker: [] };
    for (const driver of ['local', 'docker'] as const) {
      const { root } = rootFor((input, options) => {
        for (const current of [LOCAL_RUNTIME_PROFILE, DOCKER_RUNTIME_PROFILE]) {
          replaceable[driver]?.push(options.replaceable?.(profileOf(current)) === true);
        }
        replaceable[driver]?.push(
          options.replaceable?.(profileOf({ ...DOCKER_RUNTIME_PROFILE, name: 'chosen' })) === true,
        );
        return { kind: 'created', profile: profileOf(input) };
      });
      await prepareLocalRuntimeProfile(WORKSPACE_ID, root, driver);
    }
    expect(replaceable).toStrictEqual({
      local: [false, true, false],
      docker: [true, false, false],
    });
  });

  it('ensures the docker profile under the docker sandbox, adopting one the driver can run', async () => {
    const seen: boolean[] = [];
    const { calls, root } = rootFor((input, options) => {
      seen.push(options.adoptable(profileOf({ ...input, cpu: 2, memoryMb: 2048 })));
      seen.push(options.adoptable(profileOf({ ...input, networkPolicy: 'restricted' })));
      return { kind: 'adopted', profile: profileOf(input) };
    });
    await expect(prepareLocalRuntimeProfile(WORKSPACE_ID, root, 'docker')).resolves.toMatchObject({
      kind: 'adopted',
      profile: { name: 'docker', driver: 'docker', diskMb: 1024, networkPolicy: 'open' },
    });
    expect(calls).toStrictEqual([{ workspaceId: WORKSPACE_ID, input: DOCKER_RUNTIME_PROFILE }]);
    expect(seen).toStrictEqual([true, false]);
  });

  it('refuses a workspace that does not exist, writing nothing', async () => {
    const { calls, root } = rootFor((input) => ({ kind: 'created', profile: profileOf(input) }));
    await expect(prepareLocalRuntimeProfile(OTHER_WORKSPACE_ID, root)).rejects.toBeInstanceOf(
      LocalRuntimeProfileWorkspaceMissingError,
    );
    expect(calls).toStrictEqual([]);
  });
});

describe('localRunnerUnenforceable', () => {
  it('accepts the local runtime profile itself', () => {
    expect(localRunnerUnenforceable(LOCAL_RUNTIME_PROFILE)).toStrictEqual([]);
  });

  it('accepts an empty domain list and an empty driver config', () => {
    expect(
      localRunnerUnenforceable({
        ...LOCAL_RUNTIME_PROFILE,
        allowedDomains: [],
        driverConfig: {},
      }),
    ).toStrictEqual([]);
  });

  it('names every setting localRuntimeRunSpecRejection refuses, in its order', () => {
    expect(
      localRunnerUnenforceable({
        cpu: 1,
        memoryMb: 512,
        diskMb: 1024,
        networkPolicy: 'none',
        allowedDomains: ['example.com'],
        filesystem: 'read-only',
        driverConfig: { image: 'x' },
      }),
    ).toStrictEqual([
      'cpu',
      'memoryMb',
      'diskMb',
      'networkPolicy=none',
      'allowedDomains',
      'filesystem=read-only',
      'driverConfig',
    ]);
  });
});

describe('dockerRunnerUnenforceable', () => {
  it('accepts the docker runtime profile and names what the docker driver refuses', () => {
    expect(dockerRunnerUnenforceable(DOCKER_RUNTIME_PROFILE)).toStrictEqual([]);
    expect(
      dockerRunnerUnenforceable({
        ...DOCKER_RUNTIME_PROFILE,
        networkPolicy: 'restricted',
        allowedDomains: ['example.com'],
      }),
    ).toStrictEqual(['networkPolicy=restricted', 'allowedDomains']);
  });
});
