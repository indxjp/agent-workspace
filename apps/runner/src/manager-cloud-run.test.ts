import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCloudRunDriver,
  type CloudRunResourceClient,
  type CloudRunServiceSpec,
} from '@agent-workspace/runtime/driver/cloud-run';

import { createRunnerManagerServer } from './manager.js';
import { createShutdownGate } from './shutdown-gate.js';

const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** An in-memory Cloud Run Admin API: every service is ready on its first poll. */
function fakeClient(): { client: CloudRunResourceClient; created: string[]; deleted: string[] } {
  const created: string[] = [];
  const deleted: string[] = [];
  const specs = new Map<string, CloudRunServiceSpec>();
  const status = (name: string, spec: CloudRunServiceSpec) => ({
    name,
    url: `https://${spec.serviceId}.a.run.app`,
    ready: true,
    labels: spec.labels,
  });
  const client: CloudRunResourceClient = {
    createService: (spec) => {
      const name = `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`;
      created.push(name);
      specs.set(name, spec);
      return Promise.resolve({ name, url: '', ready: false });
    },
    getService: (name) => {
      const spec = specs.get(name);
      return Promise.resolve(spec === undefined ? null : status(name, spec));
    },
    deleteService: (name) => {
      deleted.push(name);
      specs.delete(name);
      return Promise.resolve();
    },
    listServices: () =>
      Promise.resolve([...specs.entries()].map(([name, spec]) => status(name, spec))),
  };
  return { client, created, deleted };
}

async function managerFor(client: CloudRunResourceClient): Promise<string> {
  // Built as `startRunnerManager` builds the cloud-run-service agent driver: no `fileIntake`.
  const driver = createCloudRunDriver<never, never>({
    images: new Map([['claude-agent-sdk', 'registry.example.com/agent-runtime@sha256:abc']]),
    project: 'proj',
    region: 'asia-northeast1',
    serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
    network: 'projects/proj/global/networks/net',
    subnetwork: 'projects/proj/regions/asia-northeast1/subnetworks/sub',
    client,
    pollIntervalMs: 0,
    startAgent: () => {
      throw new Error('not used');
    },
  });
  const server = createRunnerManagerServer({
    token: TOKEN,
    workspacesRoot: '/srv/runtimes',
    driver: createShutdownGate(driver).driver,
    expectedDriver: 'cloud-run-service',
    runtimeOrigin: (handle) => handle.externalId,
    readinessPath: '/ping',
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    toolSandboxRefusal: 'no tool sandbox in this test',
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const allocate = (base: string) =>
  fetch(`${base}/runtimes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'workspace-one',
      sessionId: 'session-one',
      engine: 'claude-agent-sdk',
      runSpec: {
        runtimeProfileId: 'profile-one',
        driver: 'cloud-run-service',
        networkPolicy: 'none',
        filesystem: 'read-write',
      },
    }),
  });

describe('runner manager serving the cloud-run-service agent driver', () => {
  it('reuses the live service for a follow-up run of the session instead of starting another', async () => {
    const { client, created, deleted } = fakeClient();
    const base = await managerFor(client);

    const first = await allocate(base);
    expect(first.status).toBe(201);
    const { runnerUrl } = (await first.json()) as { runnerUrl: string };

    const second = await allocate(base);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { runnerUrl: string }).runnerUrl).toBe(runnerUrl);
    expect(created).toHaveLength(1);
    expect(deleted).toEqual([]);
  });
});
