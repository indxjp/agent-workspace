import { describe, expect, it } from 'vitest';
import { createKubernetesDriver, type KubernetesResource } from './kubernetes.js';

function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('session'),
    interrupt: () => Promise.resolve(),
  };
}

describe('kubernetes resource lifecycle', () => {
  it('creates one pod and destroys every owned resource', async () => {
    const created: KubernetesResource[] = [];
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () =>
        Promise.resolve({
          events: {
            [Symbol.asyncIterator]: () => {
              let yielded = false;
              return {
                next: () => {
                  if (yielded) return Promise.resolve({ done: true, value: undefined });
                  yielded = true;
                  return Promise.resolve({ done: false, value: 'ok' });
                },
              };
            },
          },
          sessionId: Promise.resolve('session'),
          interrupt: () => Promise.resolve(),
        }),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/a',
    });
    expect(handle.driver).toBe('kubernetes');
    expect(created.filter((item) => item.kind === 'Pod')).toHaveLength(1);
    await driver.destroy(handle);
    expect(deleted).toHaveLength(created.length);
  });

  it('does not delete a pre-existing resource when the first create fails', async () => {
    const createError = Object.assign(new Error('namespace already exists'), { code: 409 });
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: () => Promise.reject(createError),
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });

    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session',
        workspacePath: '/workspace/pre-existing',
      }),
    ).rejects.toBe(createError);
    expect(deleted).toEqual([]);
  });

  it('rolls back only successfully created resources in reverse order', async () => {
    const createError = new Error('later create failed');
    const attempted: KubernetesResource[] = [];
    const created: KubernetesResource[] = [];
    const deleted: KubernetesResource[] = [];
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          attempted.push(item);
          if (attempted.length === 4) return Promise.reject(createError);
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          deleted.push(item);
          return Promise.resolve();
        },
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });

    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session',
        workspacePath: '/workspace/partial-create',
      }),
    ).rejects.toBe(createError);
    expect(attempted).toHaveLength(4);
    expect(deleted).toEqual([...created].reverse());
    expect(deleted).not.toContain(attempted[3]);
  });

  it('retains failed deletions for a retry while forgetting deleted and absent resources', async () => {
    const created: KubernetesResource[] = [];
    const deletionAttempts: string[] = [];
    const attemptCounts = new Map<string, number>();
    const podFailure = new Error('pod deletion unavailable');
    const policyFailure = new Error('policy deletion unavailable');
    const notFound = Object.assign(new Error('Not Found'), { code: 404 });
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => {
          created.push(item);
          return Promise.resolve(item);
        },
        delete: (item) => {
          const name = item.metadata.name;
          deletionAttempts.push(name);
          const count = (attemptCounts.get(name) ?? 0) + 1;
          attemptCounts.set(name, count);
          if (count === 1 && item.kind === 'Pod') return Promise.reject(podFailure);
          if (count === 1 && name === 'default-deny-egress') return Promise.reject(policyFailure);
          if (count === 1 && name === 'allow-gateway-egress') return Promise.reject(notFound);
          return Promise.resolve();
        },
      },
      startAgent: (_runtime, request) => Promise.resolve(echoConnection(request)),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/retry',
    });

    let firstError: unknown;
    try {
      await driver.destroy(handle);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(AggregateError);
    expect((firstError as AggregateError).errors).toEqual([podFailure, policyFailure]);
    expect(deletionAttempts).toEqual(created.map((item) => item.metadata.name).reverse());

    deletionAttempts.length = 0;
    await expect(driver.startAgent(handle, 'still live')).resolves.toBeDefined();
    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    expect(deletionAttempts).toEqual([
      created.find((item) => item.kind === 'Pod')?.metadata.name,
      'default-deny-egress',
    ]);
    await expect(driver.startAgent(handle, 'gone')).rejects.toThrow('handle is not live');
  });

  it('treats NotFound as an idempotent successful deletion', async () => {
    const notFound = Object.assign(new Error('Not Found'), { code: 404 });
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.reject(notFound),
      },
      startAgent: (_runtime, request) => Promise.resolve(echoConnection(request)),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session',
      workspacePath: '/workspace/gone',
    });

    await expect(driver.destroy(handle)).resolves.toBeUndefined();
    await expect(driver.startAgent(handle, 'gone')).rejects.toThrow('handle is not live');
  });

  it('refuses a selected profile when its resolved constraints are absent or for another driver', async () => {
    const driver = createKubernetesDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      client: {
        create: (item) => Promise.resolve(item),
        delete: () => Promise.resolve(),
      },
      startAgent: () => {
        throw new Error('not reached');
      },
    });
    await expect(
      driver.create({
        sessionId: 'session',
        engine: 'claude-agent-sdk',
        workspacePath: '/workspace/a',
        runtimeProfileId: 'profile-k8s',
      }),
    ).rejects.toThrow('selected without resolved run constraints');
    await expect(
      driver.create({
        sessionId: 'session',
        engine: 'claude-agent-sdk',
        workspacePath: '/workspace/a',
        runtimeProfileId: 'profile-local',
        runSpec: {
          runtimeProfileId: 'profile-local',
          driver: 'local',
          networkPolicy: 'open',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow('selects local, not kubernetes');
  });
});
