import { describe, expect, it } from 'vitest';

import { containerWorkers, fakeContainer, fileOf } from './cloudflare-workers.test-support.ts';

type ContainerWorker = (typeof containerWorkers)[number];

describe.each(containerWorkers)('the $service Worker', (worker) => {
  containerConfigurationCase(worker);
  containerStartEnvironmentCase(worker);
  requestForwardingCase(worker);
  credentialForwardingCase(worker);
});

function containerConfigurationCase(worker: ContainerWorker): void {
  it('runs its image pin as one Container behind one Durable Object, with no name, account or secret', () => {
    expect(JSON.parse(fileOf(worker.configFile))).toEqual({
      main: worker.main,
      compatibility_date: '2026-10-01',
      workers_dev: true,
      containers: [
        {
          class_name: worker.className,
          image: worker.image,
          max_instances: 1,
          instance_type: 'standard-1',
        },
      ],
      durable_objects: { bindings: [{ name: worker.binding, class_name: worker.className }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: [worker.className] }],
    });
  });
}

function containerStartEnvironmentCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('starts the server without migrating, hands the Worker secrets to the container, and proxies to its port', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, { ...secrets, [worker.binding]: { binding: true } });

    const response = await object.fetch(new Request('https://app.example/health'));

    expect(await response.text()).toBe('web');
    expect(fake.started).toEqual([
      {
        entrypoint: worker.entrypoint,
        env: { ...secrets, AW_CONTAINER_IDLE_STOP_SECONDS: '900' },
        // The server connects out at boot (database, object storage, providers).
        enableInternet: true,
      },
    ]);
    expect(JSON.stringify(fake.started)).not.toContain('migrate');
    expect(fake.inactivity).toEqual([900_000]);
    expect(fake.forwarded).toContain(`${String(worker.port)} http://app.example/health`);
  });
}

function requestForwardingCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('forwards the request to the container over http with its method and headers, and returns the answer', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, secrets);

    const response = await object.fetch(
      new Request('https://app.example/setup?next=1', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
        body: 'payload',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('web');
    expect(fake.forwarded).toContain(`${String(worker.port)} http://app.example/setup?next=1`);
    const [init] = fake.forwardedRequests;
    expect(init).toBeInstanceOf(Request);
    expect((init as Request).method).toBe('POST');
    expect((init as Request).headers.get('x-forwarded-proto')).toBe('https');
  });
}

function credentialForwardingCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('forwards Authorization and X-Provider-Credential unchanged', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, secrets);

    await object.fetch(
      new Request('https://app.example/verify', {
        method: 'POST',
        headers: { authorization: 'Bearer manager-token', 'x-provider-credential': 'provider-key' },
        body: '{}',
      }),
    );

    const [init] = fake.forwardedRequests;
    expect((init as Request).headers.get('authorization')).toBe('Bearer manager-token');
    expect((init as Request).headers.get('x-provider-credential')).toBe('provider-key');
  });
}
