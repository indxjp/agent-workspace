/**
 * A visitor's demo copy runs on the deployment's runtime driver, in a workspace the provisioner made
 * a moment ago, whose guest can never press Test Runtime. A run is refused unless its workspace has
 * a current Test Runtime pass (`runtime_not_verified`), and a pass recorded on one instance is seen
 * by another only through the workspace's shared record (issue #827). So the copy must leave the
 * visitor's workspace with a pass that a real Test Runtime of this deployment's driver made, or the
 * first run on any other instance is refused.
 *
 * The registry here is the production one (`installDriverRegistry`), over a fake runner manager and
 * a shared store in memory; each `installInstance` is another function instance with its own, empty
 * verification file, as a serverless host starts one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeManagerClient } from '../compose/runtime-manager-client';
import { createRuntimeRunResolver } from '../compose/runtime-profile';
import type { AgentRecord } from '../agents/contract';
import type { LaunchContext } from '../runs/environment';
import { clearWebRuntimeRegistry, currentWebRuntimeRegistry } from '../runtimes/registry';
import { log } from '../telemetry/logger';
import { createMemoryTemplatesWorld } from '../demo/provision/templates.world.test-support';
import type { DemoTemplatesWorld } from '../demo/provision/templates.contract';
import { installDriverRegistry, type SharedRuntimeVerifications } from './services';
import { demoRuntimeVerifier } from './wiring/email-link';

const NOW = new Date('2026-11-17T09:00:00.000Z');
const VALIDITY_MS = 3_600_000;

let directory = '';
let verifyCalls = 0;
let failVerify = false;
let shared = new Map<string, { configurationKey: string; expiresAt: Date }>();

const sharedVerifications: SharedRuntimeVerifications = {
  get: (workspaceId, driverId) => Promise.resolve(shared.get(`${workspaceId}/${driverId}`) ?? null),
  record: (workspaceId, driverId, verification) => {
    shared.set(`${workspaceId}/${driverId}`, verification);
    return Promise.resolve();
  },
};

const manager = createRuntimeManagerClient('http://127.0.0.1:41000', 'm'.repeat(32), () => {
  verifyCalls += 1;
  if (failVerify) return Promise.resolve(Response.json({ error: 'down' }, { status: 503 }));
  return Promise.resolve(
    Response.json({
      fingerprint: 'fp',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + VALIDITY_MS).toISOString(),
    }),
  );
});

/** Start another instance of the deployment: its own empty verification file, the shared store. */
async function installInstance(name: string): Promise<void> {
  vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, `${name}.json`));
  await installDriverRegistry(
    manager,
    'http://127.0.0.1:41000',
    'none',
    undefined,
    sharedVerifications,
  );
}

function registry() {
  const installed = currentWebRuntimeRegistry();
  if (installed === null) throw new Error('the runtime registry was not installed');
  return installed;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aw-demo-runtime-'));
  verifyCalls = 0;
  failVerify = false;
  shared = new Map();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('AW_DEPLOYMENT_POSTURE', '');
  vi.stubEnv('RUNTIME_DRIVER', 'docker');
});

afterEach(() => {
  clearWebRuntimeRegistry();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** A visitor's copy of one entry, made by the provisioner on the instance installed now. */
async function visitorCopy(world: DemoTemplatesWorld): Promise<AgentRecord> {
  const entry = world.entry('runtime');
  await world.seedTemplate(entry, {
    agent: {
      name: 'demo-agent',
      instructions: 'Sample data only.',
      maxTurns: 4,
      maxBudgetUsd: 0.2,
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
  return agent;
}

/** Start a run of `agent` as the launcher does, on the instance installed now. */
function startRun(world: DemoTemplatesWorld, agent: AgentRecord) {
  const resolver = createRuntimeRunResolver({
    agentFor: () => Promise.resolve(agent),
    networkGrantFor: () => Promise.resolve({ unrestrictedNetwork: false, connectorHosts: [] }),
    egressProxyConfigured: true,
    profiles: { forWorkspace: (workspaceId) => world.profileStore(workspaceId) },
    registry: registry(),
    targets: [
      {
        driver: 'docker',
        runnerUrl: 'http://runner:8080',
        workspaceRoot: '/work',
        fileTransfer: 'push-archive',
      },
    ],
  });
  return resolver.resolve({
    run: { id: '11111111-1111-4111-8111-111111111111' },
    agent: { id: agent.id, workspaceId: agent.workspaceId },
    session: { id: '44444444-4444-4444-8444-444444444444', agentId: agent.id },
    principal: {
      principalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
      workspaceId: agent.workspaceId,
    },
    prompt: 'hello',
  } as LaunchContext);
}

const memoryWorld = () => createMemoryTemplatesWorld({ verifyRuntime: demoRuntimeVerifier });

describe("a visitor's demo copy has a current Test Runtime pass of the deployment's driver", () => {
  it("carries this instance's pass to the visitor's workspace, so a run on another instance starts", async () => {
    await installInstance('instance-a');
    // The operator's Test Runtime, in a workspace of their own (the verification workspace).
    await registry().test('docker', 'hello', { workspaceId: 'operator-workspace' });
    const world = memoryWorld();
    const agent = await visitorCopy(world);
    expect(verifyCalls).toBe(1);

    await installInstance('instance-b');
    await expect(startRun(world, agent)).resolves.toMatchObject({
      driver: 'docker',
      networkPolicy: 'none',
    });
    // The pass was carried, not made again: the copy and the run ran no second Test Runtime.
    expect(verifyCalls).toBe(1);
    expect(shared.get(`${agent.workspaceId}/docker`)?.expiresAt.getTime()).toBe(
      shared.get('operator-workspace/docker')?.expiresAt.getTime(),
    );
  });

  it('runs a real Test Runtime for the copy where the instance holds no current pass', async () => {
    await installInstance('fresh');
    const world = memoryWorld();
    const agent = await visitorCopy(world);
    expect(verifyCalls).toBe(1);

    await installInstance('another');
    await expect(startRun(world, agent)).resolves.toMatchObject({ driver: 'docker' });
    expect(verifyCalls).toBe(1);
  });

  it('refuses the run with runtime_not_verified when the Test Runtime the copy ran failed', async () => {
    await installInstance('broken');
    failVerify = true;
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const world = memoryWorld();
    const agent = await visitorCopy(world);
    expect(shared.has(`${agent.workspaceId}/docker`)).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('verifying docker'),
      expect.anything(),
    );
    logged.mockRestore();

    await installInstance('another');
    await expect(startRun(world, agent)).rejects.toMatchObject({ code: 'runtime_not_verified' });
  });

  it('never counts a pass the copy did not get: without one, a fresh instance refuses the run', async () => {
    await installInstance('instance-a');
    await registry().test('docker', 'hello', { workspaceId: 'operator-workspace' });
    // The provisioner as it was before the copy carried a pass: nothing reaches the shared record.
    const world = createMemoryTemplatesWorld({ verifyRuntime: () => Promise.resolve() });
    const agent = await visitorCopy(world);

    await installInstance('instance-b');
    await expect(startRun(world, agent)).rejects.toMatchObject({ code: 'runtime_not_verified' });
  });
});
