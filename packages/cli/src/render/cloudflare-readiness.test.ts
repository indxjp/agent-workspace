import { describe, expect, it, vi } from 'vitest';

import { containerWorkers, fakeContainer } from './cloudflare-workers.test-support.ts';

type ContainerWorker = (typeof containerWorkers)[number];

describe.each(containerWorkers)('the $service Worker', (worker) => {
  initialReadinessCase(worker);
  missingSecretCase(worker);
  secretRotationCase(worker);
  unchangedEnvironmentCase(worker);
  readinessDeadlineCase(worker);
  hungProbeCase(worker);
  containerExitCase(worker);
  singleObjectCase(worker);
});

function initialReadinessCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('starts once, waits until the server listens, and renews the inactivity timeout per request', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer({ failProbes: 2 });
    const object = new Instance(fake.ctx, secrets);

    await object.fetch(new Request('https://app.example/a'));
    await object.fetch(new Request('https://app.example/b'));

    expect(fake.started).toHaveLength(1);
    expect(fake.destroyed()).toBe(0);
    expect(
      fake.forwarded.filter((entry) => entry === `${String(worker.port)} http://container/`),
    ).toHaveLength(3);
    expect(fake.inactivity).toEqual([900_000, 900_000]);
  });
}

function missingSecretCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it.each(Object.keys(secrets))(
    'answers 503 and starts no container while %s is missing or blank',
    async (name) => {
      const { Instance } = await worker.load();
      for (const value of [undefined, '', '  ']) {
        const fake = fakeContainer();
        const object = new Instance(fake.ctx, { ...secrets, [name]: value });

        const response = await object.fetch(new Request('https://app.example/'));

        expect(response.status).toBe(503);
        expect(await response.text()).toBe(`The ${worker.service} is not configured yet`);
        expect(fake.started).toEqual([]);
        expect(fake.forwarded).toEqual([]);
      }
    },
  );
}

function secretRotationCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('stops the running container and starts it with the new environment when a secret rotates', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const [name = ''] = Object.keys(secrets);
    await new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/a'));
    const first = [...fake.stored.values()];

    // A new Worker version after `wrangler secret bulk`: the same Durable Object, new bindings.
    const rotated = { ...secrets, [name]: 'rotated' };
    await new Instance(fake.ctx, rotated).fetch(new Request('https://app.example/b'));

    expect(fake.destroyed()).toBe(1);
    expect(fake.started.map(({ env }) => env[name])).toEqual([secrets[name], 'rotated']);
    expect([...fake.stored.values()]).not.toEqual(first);
    expect(JSON.stringify([...fake.stored.values()])).not.toContain('rotated');
  });
}

function unchangedEnvironmentCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('keeps the running container when the environment is unchanged', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    await new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/a'));
    await new Instance(fake.ctx, { ...secrets }).fetch(new Request('https://app.example/b'));

    expect(fake.destroyed()).toBe(0);
    expect(fake.started).toHaveLength(1);
  });
}

function readinessDeadlineCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('answers 503 with retry-after, and does not start a second container, when it cannot become ready', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ failProbes: Number.POSITIVE_INFINITY });
      const object = new Instance(fake.ctx, secrets);

      const pending = object.fetch(new Request('https://app.example/'));
      // The environment hash settles outside the fake clock; the probes start after it.
      await vi.waitFor(() => {
        expect(fake.started).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(120 * 500);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).toBe(
        `The ${worker.service} did not answer on port ${String(worker.port)} within 60 s`,
      );
      expect(fake.started).toHaveLength(1);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });
}

function hungProbeCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('answers 503 within the deadline when the server accepts the connection and never replies', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ hangProbes: true });
      const pending = new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/'));
      await vi.waitFor(() => {
        expect(fake.started).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(70_000);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(await response.text()).toContain('did not answer on port');
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });
}

function containerExitCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('says the container exited, with the reason the runtime gives, instead of waiting out the deadline', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({
        failProbes: Number.POSITIVE_INFINITY,
        monitor: () => Promise.reject(new Error('Container exited with unexpected exit code: 1')),
      });

      const response = await new Instance(fake.ctx, secrets).fetch(
        new Request('https://app.example/'),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).toBe(
        `The ${worker.service} container exited (Container exited with unexpected exit code: 1)`,
      );
    } finally {
      error.mockRestore();
    }
  });
}

function singleObjectCase(worker: ContainerWorker): void {
  it('routes every request to one Durable Object', async () => {
    const { entry } = await worker.load();
    const names: string[] = [];
    const env = {
      [worker.binding]: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({ fetch: () => Promise.resolve(new Response('proxied')) }),
      },
    };

    await entry.fetch(new Request('https://app.example/a'), env);
    await entry.fetch(new Request('https://app.example/b'), env);

    expect(names).toEqual([worker.object, worker.object]);
  });
}
