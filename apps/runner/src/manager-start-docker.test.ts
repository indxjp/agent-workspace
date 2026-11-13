import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import { expect, it } from 'vitest';
import { dockerDriverOptions, dockerRuntimeOrigin, startRunnerManager } from './manager-start.js';
import { TOKEN } from './manager-start.fixture.test-support.js';

it('Docker runner manager addressing > uses the driver-assigned DNS name instead of the non-routable full container ID', () => {
  const handle: RuntimeHandle = {
    id: 'c9fc61d1-6597-454b-9200-06179e4a1d6e',
    driver: 'docker',
    externalId: 'a'.repeat(64),
    workspacePath: '/workspace',
    createdAt: new Date('2026-09-15T00:00:00Z'),
  };

  expect(dockerRuntimeOrigin(handle)).toBe(
    'http://agent-workspace-c9fc61d1-6597-454b-9200-06179e4a1d6e:8080',
  );
  expect(dockerRuntimeOrigin(handle)).not.toContain(handle.externalId);
});

it('Docker runner manager addressing > addresses a sandbox at its published loopback port under RUNTIME_PUBLISH=loopback (#786)', async () => {
  const calls: (readonly string[])[] = [];
  const options = dockerDriverOptions(
    { RUNTIME_IMAGE: 'agent-workspace/runtime:dev', RUNTIME_PUBLISH: 'loopback' },
    (args) => {
      calls.push(args);
      if (args[0] === 'run') return Promise.resolve({ exitCode: 0, stdout: 'c1\n', stderr: '' });
      if (args[0] === 'port') {
        return Promise.resolve({ exitCode: 0, stdout: '127.0.0.1:41234\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
  );
  const handle = await options.driver.create({
    sessionId: 's',
    engine: 'claude-agent-sdk',
    workspacePath: '/unused',
    runSpec: {
      runtimeProfileId: 'rp',
      driver: 'docker',
      networkPolicy: 'open',
      filesystem: 'read-write',
    },
  });
  expect(calls[0]).toContain('--publish');
  expect(options.runtimeOrigin?.(handle)).toBe('http://127.0.0.1:41234');
});

it('Docker runner manager addressing > listens on a port the OS picks for PORT=0, as the embedded local runtime asks', async () => {
  const manager = await startRunnerManager({
    RUNNER_MANAGER_TOKEN: TOKEN,
    RUNTIME_IMAGE: 'agent-workspace/runtime:dev',
    HOST: '127.0.0.1',
    PORT: '0',
  });
  try {
    expect(manager.address.port).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${String(manager.address.port)}/healthz`);
    expect(health.status).toBe(200);
  } finally {
    await expect(manager.shutdown()).resolves.toBe('clean');
  }
});

it('Docker runner manager addressing > refuses a RUNTIME_PUBLISH it does not know', () => {
  expect(() =>
    dockerDriverOptions({ RUNTIME_IMAGE: 'agent-workspace/runtime:dev', RUNTIME_PUBLISH: 'lan' }),
  ).toThrow(/RUNTIME_PUBLISH must be loopback/u);
});
