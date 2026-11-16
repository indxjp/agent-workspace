/**
 * What the store proves about "demo sandboxes have no internet", link by link, from the
 * provisioner's copy to the network policy a run resolves to (spec, 04 "Safe to use" row and
 * /platform; phase P6):
 *
 * 1. the copy never has unrestricted network, whatever its template was built with;
 * 2. the copy has a runtime profile, the visitor workspace's own demo profile, and it is `none`
 *    with no allowed domain (so a run of it is launched, in a sandbox with the gateway and nothing
 *    else);
 * 3. the run's resolver turns that profile into the network policy `none` with no allowed domain;
 *    a profile somebody opened is lowered to `none` for an agent without unrestricted network, and
 *    the provisioner closes it again on the next copy (`templates.contract.ts`);
 * 4. the run's preflight does not refuse the copy for a missing runtime profile, and does refuse,
 *    with a typed reason, a copy of a deployment that has no runtime driver or no demo key, so a
 *    run never starts in a sandbox this deployment did not make.
 */
import { describe, expect, it } from 'vitest';

import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';

import type { AgentRecord } from '../../agents/contract';
import { createRunPreflight } from '../../compose/run-preflight';
import { createRuntimeRunResolver, type RuntimeDriverTarget } from '../../compose/runtime-profile';
import type { LaunchContext } from '../../runs/environment';
import type { RuntimeProfileStoreProvider } from '../../runtimes/store';
import type { DemoSandbox } from '../provision/ports';
import type { DemoTemplatesWorld } from '../provision/templates.contract';
import { createMemoryTemplatesWorld } from '../provision/templates.world.test-support';

const NOW = new Date('2026-11-16T09:00:00.000Z');

/** A demo copy of an entry whose template agent was built to have the internet: the worst case. */
async function copiedWorld(sandbox: Partial<DemoSandbox> = {}) {
  const world = createMemoryTemplatesWorld(sandbox);
  const entry: DemoEntrySlug = world.entry('net');
  await world.seedTemplate(entry, {
    agent: {
      name: 'open-agent',
      instructions: 'Sample data only.',
      unrestrictedNetwork: true,
      maxTurns: 8,
      maxBudgetUsd: 0.5,
    },
    files: [{ path: 'deals/q1.csv', text: 'id,amount\n1,100\n' }],
    assign: [{ path: 'deals', access: 'read' }],
  });
  const guest = await world.newGuest();
  await world.templates.copyInto({
    entry,
    workspaceId: guest.workspaceId,
    guestUserId: guest.userId,
    limits: { maxTurns: null, maxBudgetUsd: null },
    now: NOW,
  });
  const [agent] = await world.agents(guest.workspaceId);
  if (agent === undefined) throw new Error('the copy made no agent');
  return { world, agent };
}

function launchOf(agent: AgentRecord): LaunchContext {
  return {
    run: { id: '11111111-1111-4111-8111-111111111111' },
    agent: { id: agent.id, workspaceId: agent.workspaceId },
    session: { id: '44444444-4444-4444-8444-444444444444', agentId: agent.id },
    principal: {
      principalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
      workspaceId: agent.workspaceId,
    },
    prompt: 'hello',
  } as LaunchContext;
}

/** The profiles of the world's workspaces, as the run's resolver and preflight read them. */
const profilesOf = (world: DemoTemplatesWorld): RuntimeProfileStoreProvider => ({
  forWorkspace: (workspaceId) => world.profileStore(workspaceId),
});

/** Resolve a run of `agent` the way the launcher does: the grant is the agent's own permission. */
function resolveRun(world: DemoTemplatesWorld, agent: AgentRecord) {
  const target: RuntimeDriverTarget = {
    driver: 'docker',
    runnerUrl: 'http://runner:8080',
    workspaceRoot: '/work',
    fileTransfer: 'push-archive',
  };
  const resolver = createRuntimeRunResolver({
    agentFor: () => Promise.resolve(agent),
    networkGrantFor: () =>
      Promise.resolve({
        unrestrictedNetwork: agent.permissions.unrestrictedNetwork,
        connectorHosts: [],
      }),
    egressProxyConfigured: true,
    profiles: profilesOf(world),
    registry: {
      list: () =>
        Promise.resolve([
          {
            id: 'docker',
            label: 'Docker',
            connectionExists: true,
            imageReachable: true,
            testPassed: true,
            state: 'enabled' as const,
            reason: null,
            networkPolicies: null,
          },
        ]),
      test: () => Promise.reject(new Error('not used')),
    },
    targets: [target],
  });
  return resolver.resolve(launchOf(agent)) as Promise<RuntimeRunSpec>;
}

/** The preflight a run start of `agent` goes through, over the world's stores. */
function preflightOf(world: DemoTemplatesWorld, agent: AgentRecord) {
  return createRunPreflight({
    agents: { forWorkspace: () => ({ get: () => Promise.resolve(agent) }) } as never,
    profiles: profilesOf(world),
    models: {
      models: { forWorkspace: (workspaceId) => world.models(workspaceId) },
      // The provider's model list is not read here: an unreadable list is not a refusal.
      discover: () =>
        Promise.resolve({
          ok: false as const,
          reason: 'not read in this test',
          failure: { kind: 'unreachable' as const },
        }),
    },
    workspaceDefault: () => Promise.resolve(null),
    projectDefault: () => Promise.resolve(null),
    projectDefaults: () => Promise.resolve(new Map()),
    deploymentDefaultModels: { anthropic: 'test-model-id' },
    policyCeiling: null,
    warn: () => undefined,
  }).check({
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    sessionId: null,
    modelOverride: null,
    agent,
  });
}

describe('the links from a demo copy to a sandbox with no internet', () => {
  it('the copy never has unrestricted network, whatever its template was built with', async () => {
    const { agent } = await copiedWorld();
    expect(agent.permissions.unrestrictedNetwork).toBe(false);
  });

  it('the copy has a runtime profile of its own workspace, and it is none with no allowed domain', async () => {
    const { world, agent } = await copiedWorld();
    expect(agent.runtimeProfileId).not.toBeNull();
    const profiles = await world.profiles(agent.workspaceId);
    expect(profiles.map((profile) => profile.id)).toEqual([agent.runtimeProfileId]);
    expect(profiles[0]).toMatchObject({ networkPolicy: 'none', allowedDomains: null });
  });

  it("a run of the copy resolves, on the copy's own profile, to the network policy none: the gateway and nothing else", async () => {
    const { world, agent } = await copiedWorld();
    const spec = await resolveRun(world, agent);
    expect(spec.networkPolicy).toBe('none');
    expect(spec.allowedDomains ?? []).toEqual([]);
  });

  it('a profile somebody opened is lowered to none for the copy, which has no unrestricted network', async () => {
    const { world, agent } = await copiedWorld();
    await world.profileStore(agent.workspaceId).update(agent.runtimeProfileId ?? '', {
      networkPolicy: 'open',
    });
    const spec = await resolveRun(world, agent);
    expect(spec.networkPolicy).toBe('none');
    expect(spec.allowedDomains ?? []).toEqual([]);
  });

  it('the run preflight does not refuse the copy for a missing runtime profile, nor for its model', async () => {
    const { world, agent } = await copiedWorld();
    expect(await preflightOf(world, agent)).toBeNull();
  });

  it('refuses a copy made where the deployment names no runtime driver, with the missing-profile reason', async () => {
    const { world, agent } = await copiedWorld({ runtimeDriver: null });
    expect(agent.runtimeProfileId).toBeNull();
    expect(await preflightOf(world, agent)).toMatchObject({
      code: 'agent_runtime_profile_missing',
    });
  });

  it('refuses a copy made on a driver that cannot enforce no network, with the missing-profile reason', async () => {
    const { world, agent } = await copiedWorld({ enforcesNoNetwork: () => Promise.resolve(false) });
    expect(agent.runtimeProfileId).toBeNull();
    expect(await preflightOf(world, agent)).toMatchObject({
      code: 'agent_runtime_profile_missing',
    });
  });

  it('refuses a copy made where the deployment has no demo key, with the unresolved-model reason', async () => {
    const { world, agent } = await copiedWorld({ anthropicApiKey: null });
    expect(await preflightOf(world, agent)).toMatchObject({ code: 'model_connection_unresolved' });
  });
});
