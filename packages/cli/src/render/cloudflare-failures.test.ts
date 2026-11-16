import { describe, expect, it, vi } from 'vitest';

import { containerWorkers, fakeContainer } from './cloudflare-workers.test-support.ts';

type ContainerWorker = (typeof containerWorkers)[number];

interface Failure {
  readonly error: { readonly code: string; readonly step: string; readonly message: string };
}
const failureOf = async (response: Response): Promise<Failure> =>
  (await response.json()) as Failure;
const silenced = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
describe.each(containerWorkers)('the $service Worker', (worker) => {
  describe('when something throws', () => {
    forwardFailureCase(worker);
    startFailureCase(worker);
    missingContainerCase(worker);
    objectFailureCase(worker);
    objectRoutingCase(worker);
    failureSecretIsolationCase(worker);
  });
});

function forwardFailureCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('answers 502 JSON naming the forward step when the container rejects the forward', async () => {
    const error = silenced();
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ failForward: new Error('connection reset') });

      const response = await new Instance(fake.ctx, secrets).fetch(
        new Request('https://app.example/setup'),
      );

      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await failureOf(response)).toEqual({
        error: { code: 'worker_exception', step: 'forward', message: 'Error: connection reset' },
      });
    } finally {
      error.mockRestore();
    }
  });
}

function startFailureCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('keeps answering 503 "is starting" when start() throws', async () => {
    const error = silenced();
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer();
      fake.ctx.container.start = () => {
        throw new Error('no capacity');
      };

      const response = await new Instance(fake.ctx, secrets).fetch(
        new Request('https://app.example/'),
      );

      expect(response.status).toBe(503);
      expect(await response.text()).toBe(`The ${worker.service} is starting`);
    } finally {
      error.mockRestore();
    }
  });
}

function missingContainerCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('answers 500 JSON naming the container-binding step when containers are not enabled', async () => {
    const error = silenced();
    try {
      const { Instance } = await worker.load();
      const { ctx } = fakeContainer();

      const response = await new Instance({ ...ctx, container: undefined }, secrets).fetch(
        new Request('https://app.example/'),
      );

      expect(response.status).toBe(500);
      const { error: failure } = await failureOf(response);
      expect(failure.code).toBe('worker_exception');
      expect(failure.step).toBe('container-binding');
      expect(failure.message).toContain(`${worker.className} class`);
    } finally {
      error.mockRestore();
    }
  });
}

function objectFailureCase(worker: ContainerWorker): void {
  it('answers 500 JSON from the entry when the Durable Object binding is missing or its fetch throws', async () => {
    const error = silenced();
    try {
      const { entry } = await worker.load();
      const request = new Request('https://app.example/');
      const object = { fetch: () => Promise.reject(new Error('object reset')) };
      const throwing = {
        [worker.binding]: { idFromName: () => 'id', get: () => object },
      };

      const missing = await entry.fetch(request, {});
      const rejected = await entry.fetch(request, throwing);

      expect(missing.status).toBe(500);
      expect((await failureOf(missing)).error.step).toBe('durable-object-binding');
      expect(rejected.status).toBe(500);
      expect((await failureOf(rejected)).error).toEqual({
        code: 'worker_exception',
        step: 'durable-object',
        message: 'Error: object reset',
      });
    } finally {
      error.mockRestore();
    }
  });
}

function objectRoutingCase(worker: ContainerWorker): void {
  it('routes the entry to the one named Durable Object and returns its answer', async () => {
    const { entry } = await worker.load();
    const names: string[] = [];
    const binding = {
      idFromName: (name: string) => {
        names.push(name);
        return 'id';
      },
      get: () => ({ fetch: () => Promise.resolve(new Response('object')) }),
    };

    const response = await entry.fetch(new Request('https://app.example/'), {
      [worker.binding]: binding,
    });

    expect(await response.text()).toBe('object');
    expect(names).toEqual([worker.object]);
  });
}

function failureSecretIsolationCase(worker: ContainerWorker): void {
  const secrets: Record<string, string> = worker.secrets;
  it('never puts an environment value in a failure body', async () => {
    const error = silenced();
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ failForward: new Error('boom') });
      const distinct = Object.fromEntries(
        Object.keys(secrets).map((name) => [name, `value-of-${name}`]),
      );

      const response = await new Instance(fake.ctx, distinct).fetch(
        new Request('https://app.example/'),
      );
      const body = await response.text();

      expect(response.status).toBe(502);
      for (const value of Object.values(distinct)) {
        expect(body).not.toContain(value);
      }
    } finally {
      error.mockRestore();
    }
  });
}
