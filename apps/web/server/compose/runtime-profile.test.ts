import { describe, expect, it } from 'vitest';

import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';

import type { AgentRecord } from '../agents/contract';
import type { RuntimeProfileRecord, RuntimeProfileStoreProvider } from '../runtimes/store';
import type { LaunchContext } from '../runs/environment';
import {
  createRuntimeRunResolver,
  localRuntimeRunSpecRejection,
  runtimeSettingsFor,
  type RuntimeDriverTarget,
} from './runtime-profile';

type NetworkGrantFor = Parameters<typeof createRuntimeRunResolver>[0]['networkGrantFor'];

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const PROFILE = '55555555-5555-4555-8555-555555555555';

const context = {
  run: { id: '11111111-1111-4111-8111-111111111111' },
  agent: { id: AGENT, workspaceId: WORKSPACE },
  session: { id: '44444444-4444-4444-8444-444444444444', agentId: AGENT },
  principal: {
    principalId: '77777777-7777-4777-8777-777777777777',
    userId: '66666666-6666-4666-8666-666666666666',
    workspaceId: WORKSPACE,
  },
  prompt: 'hello',
} as LaunchContext;

function agent(runtimeProfileId: string | null): AgentRecord {
  return {
    id: AGENT,
    workspaceId: WORKSPACE,
    name: 'Agent',
    instructions: '',
    modelConnectionId: null,
    model: 'claude-sonnet-4-5',
    runtimeProfileId,
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    },
    policy: null,
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    createdBy: '66666666-6666-4666-8666-666666666666',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function profile(driver = 'local'): RuntimeProfileRecord {
  return {
    id: PROFILE,
    workspaceId: WORKSPACE,
    name: 'Constrained',
    driver,
    runtimeConnectionId: '77777777-7777-4777-8777-777777777777',
    cpu: 2,
    memoryMb: 768,
    diskMb: 2048,
    networkPolicy: 'restricted',
    allowedDomains: ['api.example.com'],
    filesystem: 'read-only',
    persistPaths: ['/workspace/output'],
    timeoutSeconds: 47,
    idleTimeoutSeconds: 11,
    driverConfig: { runtimeClassName: 'gvisor' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function dependencies(
  selectedAgent: AgentRecord | null,
  selectedProfile: RuntimeProfileRecord | null,
  testPassed = true,
  configuredTargets?: readonly RuntimeDriverTarget[],
  grant: Awaited<ReturnType<NetworkGrantFor>> = { unrestrictedNetwork: true, connectorHosts: [] },
) {
  const profiles = {
    forWorkspace: () => ({ get: () => Promise.resolve(selectedProfile) }),
  } as unknown as RuntimeProfileStoreProvider;
  return {
    agentFor: () => Promise.resolve(selectedAgent),
    networkGrantFor: () => Promise.resolve(grant),
    egressProxyConfigured: true,
    profiles,
    registry: {
      list: () =>
        Promise.resolve([
          {
            id: selectedProfile?.driver ?? 'local',
            label: 'Runtime',
            connectionExists: true,
            imageReachable: true,
            testPassed,
            state: 'enabled' as const,
            reason: null,
            networkPolicies: null,
          },
        ]),
      test: () => Promise.reject(new Error('not used')),
    },
    targets: configuredTargets ?? [
      {
        driver: (selectedProfile?.driver ?? 'local') as RuntimeDriverTarget['driver'],
        runnerUrl: 'http://runner:8080',
        workspaceRoot: '/work',
        fileTransfer: 'push-archive',
      },
    ],
  };
}

describe('a lapsed Test Runtime pass (BH061-002)', () => {
  const scoped = (renew: (driverId: string, scope: object) => Promise<boolean>) => {
    const base = dependencies(agent(PROFILE), profile('kubernetes'), false);
    return { ...base, registry: { ...base.registry, renew } };
  };

  it('is re-verified once by the run, which then launches', async () => {
    const calls: unknown[] = [];
    const target = await createRuntimeRunResolver(
      scoped((driverId, scope) => {
        calls.push([driverId, scope]);
        return Promise.resolve(true);
      }),
    ).resolve(context);
    expect(target.driver).toBe('kubernetes');
    expect(calls).toEqual([
      [
        'kubernetes',
        { workspaceId: WORKSPACE, runtimeConnectionId: '77777777-7777-4777-8777-777777777777' },
      ],
    ]);
  });

  it('refuses the run with runtime_not_verified and the fix when re-verifying fails', async () => {
    await expect(
      createRuntimeRunResolver(scoped(() => Promise.resolve(false))).resolve(context),
    ).rejects.toThrow(/^runtime_not_verified: .*run Test Runtime on the Runtimes page/u);
  });
});

describe('runtime profile launch composition', () => {
  it('resolves every selected profile constraint into one immutable run spec', async () => {
    const resolver = createRuntimeRunResolver(dependencies(agent(PROFILE), profile('kubernetes')));
    const target = await resolver.resolve(context);
    expect(target).toEqual({
      runtimeProfileId: PROFILE,
      driver: 'kubernetes',
      runtimeConnectionId: '77777777-7777-4777-8777-777777777777',
      cpu: 2,
      memoryMb: 768,
      diskMb: 2048,
      networkPolicy: 'restricted',
      allowedDomains: ['api.example.com'],
      filesystem: 'read-only',
      persistPaths: ['/workspace/output'],
      timeoutSeconds: 47,
      idleTimeoutSeconds: 11,
      driverConfig: { runtimeClassName: 'gvisor' },
      runnerUrl: 'http://runner:8080',
      workspaceRoot: '/work',
      fileTransfer: 'push-archive',
    });
    expect(runtimeSettingsFor(target)).toEqual({
      runnerUrl: 'http://runner:8080',
      workspaceRoot: '/work',
    });
  });

  it('marks the run as served by a tool sandbox only when the allocation returned one', async () => {
    const target = await createRuntimeRunResolver(
      dependencies(agent(PROFILE), profile('kubernetes')),
    ).resolve(context);
    expect(runtimeSettingsFor(target)).not.toHaveProperty('toolSandbox');
    expect(runtimeSettingsFor({ ...target, toolSandboxOrigin: 'http://tool-host:9' })).toEqual({
      runnerUrl: 'http://runner:8080',
      workspaceRoot: '/work',
      toolSandbox: true,
    });
  });

  it('refuses to substitute a default when the agent has no profile', async () => {
    const resolver = createRuntimeRunResolver(dependencies(agent(null), null));
    await expect(resolver.resolve(context)).rejects.toThrow('agent_runtime_profile_missing: ');
  });

  it('fails closed for a missing, unverified, or unconfigured profile driver', async () => {
    await expect(
      createRuntimeRunResolver(dependencies(agent(PROFILE), null)).resolve(context),
    ).rejects.toThrow('which no longer exists');
    await expect(
      createRuntimeRunResolver(dependencies(agent(PROFILE), profile(), false)).resolve(context),
    ).rejects.toThrow('runtime_not_verified: Test Runtime has no current pass');
    await expect(
      createRuntimeRunResolver(
        dependencies(agent(PROFILE), profile('kubernetes'), true, []),
      ).resolve(context),
    ).rejects.toThrow('no launch target is configured');
  });

  it("asks the registry about the run's own workspace, so its Test Runtime pass counts", async () => {
    const base = dependencies(agent(PROFILE), profile('kubernetes'));
    const seen: Array<string | undefined> = [];
    const resolver = createRuntimeRunResolver({
      ...base,
      registry: {
        ...base.registry,
        list: (workspaceId) => {
          seen.push(workspaceId);
          return base.registry.list();
        },
      },
    });
    await resolver.resolve(context);
    expect(seen).toEqual([WORKSPACE]);
  });

  it('refuses local profiles whose controls the local runner cannot enforce', async () => {
    const resolver = createRuntimeRunResolver(
      dependencies(agent(PROFILE), profile(), true, [
        {
          driver: 'local',
          runnerUrl: 'http://runner:8080',
          workspaceRoot: '/work',
          fileTransfer: 'local-disk',
          validate: localRuntimeRunSpecRejection,
        },
      ]),
    );
    await expect(resolver.resolve(context)).rejects.toThrow(
      'the local runner cannot enforce cpu, memoryMb, diskMb, networkPolicy=restricted',
    );
  });

  describe('network floor (ADR-0117 decision 9)', () => {
    const open = (driver: string): RuntimeProfileRecord => ({
      ...profile(driver),
      networkPolicy: 'open',
      allowedDomains: null,
    });
    const hosts = ['b.example.com', 'a.example.com'];

    async function resolveWith(
      selected: RuntimeProfileRecord,
      grant: Awaited<ReturnType<NetworkGrantFor>>,
      egressProxyConfigured = true,
    ) {
      const allocated: RuntimeRunSpec[] = [];
      const lowered: unknown[] = [];
      let grantCalls = 0;
      const base = dependencies(agent(PROFILE), selected, true, undefined, grant);
      const target = await createRuntimeRunResolver({
        ...base,
        egressProxyConfigured,
        networkGrantFor: () => {
          grantCalls += 1;
          return Promise.resolve(grant);
        },
        targets: [
          {
            driver: selected.driver as RuntimeDriverTarget['driver'],
            runnerUrl: 'http://runner:8080',
            workspaceRoot: '/work',
            fileTransfer: 'push-archive',
            allocate: (_context, spec) => {
              allocated.push(spec);
              return Promise.resolve({ runnerUrl: 'http://allocated:8080' });
            },
          },
        ],
        onNetworkLowered: (_context, change) => lowered.push(change),
      }).resolve(context);
      return { target, allocated, lowered, grantCalls };
    }

    it('keeps open when the permission is granted', async () => {
      const { target, lowered } = await resolveWith(open('kubernetes'), {
        unrestrictedNetwork: true,
        connectorHosts: hosts,
      });
      expect(target.networkPolicy).toBe('open');
      expect(target.allowedDomains).toBeUndefined();
      expect(lowered).toEqual([]);
    });

    it('lowers open to restricted with the connector hosts, and allocates that spec', async () => {
      const { target, allocated, lowered, grantCalls } = await resolveWith(open('kubernetes'), {
        unrestrictedNetwork: false,
        connectorHosts: hosts,
      });
      expect(grantCalls).toBe(1);
      expect(target.networkPolicy).toBe('restricted');
      expect(target.allowedDomains).toEqual(['a.example.com', 'b.example.com']);
      expect(allocated).toHaveLength(1);
      expect(allocated[0]?.networkPolicy).toBe('restricted');
      expect(lowered).toEqual([
        { applied: 'restricted', allowedDomains: ['a.example.com', 'b.example.com'] },
      ]);
    });

    it('lowers open to none when there is no connector host', async () => {
      const { target, allocated, lowered } = await resolveWith(open('docker'), {
        unrestrictedNetwork: false,
        connectorHosts: [],
      });
      expect(target.networkPolicy).toBe('none');
      expect(target.allowedDomains).toBeUndefined();
      expect(allocated[0]?.networkPolicy).toBe('none');
      expect(lowered).toEqual([{ applied: 'none', allowedDomains: [] }]);
    });

    it('drops a stale allowedDomains list stored on an open profile', async () => {
      const { target } = await resolveWith(
        { ...open('docker'), allowedDomains: ['old.example.com'] },
        { unrestrictedNetwork: false, connectorHosts: [] },
      );
      expect(target.allowedDomains).toBeUndefined();
    });

    it.each(['none', 'restricted'] as const)('leaves %s unchanged', async (networkPolicy) => {
      const selected = { ...profile('kubernetes'), networkPolicy };
      const { target, lowered, grantCalls } = await resolveWith(selected, {
        unrestrictedNetwork: false,
        connectorHosts: hosts,
      });
      expect(target.networkPolicy).toBe(networkPolicy);
      expect(target.allowedDomains).toEqual(selected.allowedDomains ?? undefined);
      expect(lowered).toEqual([]);
      expect(grantCalls).toBe(0);
    });

    it.each(['docker', 'kubernetes'])(
      'allows a lowered restricted on %s when the egress proxy is configured',
      async (driver) => {
        const { target } = await resolveWith(open(driver), {
          unrestrictedNetwork: false,
          connectorHosts: hosts,
        });
        expect(target.networkPolicy).toBe('restricted');
        expect(target.allowedDomains).toEqual(['a.example.com', 'b.example.com']);
      },
    );

    it.each(['docker', 'kubernetes'])(
      'refuses a lowered restricted on %s when no egress proxy is configured, never open',
      async (driver) => {
        const resolved = resolveWith(
          open(driver),
          { unrestrictedNetwork: false, connectorHosts: hosts },
          false,
        );
        await expect(resolved).rejects.toMatchObject({ code: 'network_policy_unenforceable' });
        await expect(resolved).rejects.toThrow(
          'network_policy_unenforceable: open lowered to restricted (a.example.com, ' +
            `b.example.com) because the agent lacks unrestrictedNetwork; ${driver} cannot ` +
            'enforce restricted without an egress proxy (AGENT_WORKSPACE_EGRESS_PROXY_IMAGE); ' +
            'grant unrestrictedNetwork or remove remote connectors',
        );
      },
    );

    it.each([
      ['cloud-run-service', true],
      ['cloud-run-service', false],
      ['aca-sessions', true],
      ['aca-sessions', false],
    ] as const)(
      'refuses a lowered restricted on %s (egress proxy configured: %s), never open',
      async (driver, egressProxyConfigured) => {
        const resolved = resolveWith(
          open(driver),
          { unrestrictedNetwork: false, connectorHosts: hosts },
          egressProxyConfigured,
        );
        await expect(resolved).rejects.toMatchObject({ code: 'network_policy_unenforceable' });
        await expect(resolved).rejects.toThrow(
          'network_policy_unenforceable: open lowered to restricted (a.example.com, ' +
            `b.example.com) because the agent lacks unrestrictedNetwork; ${driver} cannot ` +
            'enforce restricted yet; grant unrestrictedNetwork or remove remote connectors',
        );
      },
    );

    it.each(
      ['docker', 'kubernetes', 'cloud-run-service', 'aca-sessions'].flatMap((driver) => [
        [driver, true] as const,
        [driver, false] as const,
      ]),
    )(
      'allows none and a granted open on %s (egress proxy configured: %s)',
      async (driver, egressProxyConfigured) => {
        const lowered = await resolveWith(
          open(driver),
          { unrestrictedNetwork: false, connectorHosts: [] },
          egressProxyConfigured,
        );
        expect(lowered.target.networkPolicy).toBe('none');
        const granted = await resolveWith(
          open(driver),
          { unrestrictedNetwork: true, connectorHosts: hosts },
          egressProxyConfigured,
        );
        expect(granted.target.networkPolicy).toBe('open');
      },
    );

    it('exempts the local driver, which can enforce no network policy', async () => {
      const { target, lowered, grantCalls } = await resolveWith(open('local'), {
        unrestrictedNetwork: false,
        connectorHosts: hosts,
      });
      expect(target.networkPolicy).toBe('open');
      expect(lowered).toEqual([]);
      expect(grantCalls).toBe(0);
    });
  });
});
