import {
  installWorkspaceTestEnvironment,
  loadWorkspaceTestServices,
} from './workspace-services.test-support.js';

import { expect, it, vi } from 'vitest';

import { createRunningService, mocks } from './workspace-services.test-support.js';
const { startWorkspace } = await loadWorkspaceTestServices();

installWorkspaceTestEnvironment();

const dockerAndLocal = [
  { id: 'docker', available: true, reason: 'Docker daemon is reachable' },
  {
    id: 'local',
    available: true,
    reason: 'No tenant isolation: commands run as the host user',
  },
];
const isolationWarning = 'WARNING: local runtime has no tenant isolation';

function resolveServices(): void {
  mocks.startEmbeddedDatabase.mockResolvedValue(
    createRunningService({ url: 'postgresql://embedded' }),
  );
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));
}

function written(stream: NodeJS.WriteStream): string {
  return vi
    .mocked(stream)
    .write.mock.calls.map(([chunk]) => String(chunk))
    .join('');
}

it('reports the requested local driver and warns although the host prefers docker (#476)', async () => {
  process.env['RUNTIME_DRIVER'] = 'local';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  const stdout = written(process.stdout);
  expect(stdout).toContain(
    'Runtime: local — requested by RUNTIME_DRIVER; No tenant isolation: commands run as the host user\n',
  );
  expect(stdout).toContain('Host default: docker\n');
  expect(stdout).not.toContain('Runtime: docker');
  expect(written(process.stderr)).toContain(isolationWarning);
  expect(mocks.startRunner).toHaveBeenCalledWith(
    expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
  );
});

it('runs a requested sandbox-runtime on local, says so once and warns (#818)', async () => {
  process.env['RUNTIME_DRIVER'] = 'sandbox-runtime';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  const notice =
    'sandbox-runtime is not implemented; this session runs on local with no isolation.\n';
  const stderr = written(process.stderr);
  expect(stderr.split(notice)).toHaveLength(2);
  expect(stderr).toContain(isolationWarning);
  expect(written(process.stdout)).toBe(
    'Runtime: local — No tenant isolation: commands run as the host user\n',
  );
  expect(mocks.startRunner).toHaveBeenCalledWith(
    expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
  );
});

it('keeps the default line unchanged when RUNTIME_DRIVER is not set', async () => {
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  expect(written(process.stdout)).toBe('Runtime: docker — Docker daemon is reachable\n');
  expect(written(process.stderr)).not.toContain(isolationWarning);
});

it('warns when the host default is local and RUNTIME_DRIVER is not set', async () => {
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'local',
    drivers: dockerAndLocal.slice(1),
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  expect(written(process.stdout)).toBe(
    'Runtime: local — No tenant isolation: commands run as the host user\n',
  );
  expect(written(process.stderr)).toContain(isolationWarning);
});

it('trims a padded RUNTIME_DRIVER, reports local and warns (#476)', async () => {
  process.env['RUNTIME_DRIVER'] = ' local\r';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  expect(written(process.stdout)).toBe(
    'Runtime: local — requested by RUNTIME_DRIVER; No tenant isolation: commands run as the host user\nHost default: docker\n',
  );
  expect(written(process.stderr)).toContain(isolationWarning);
  expect(mocks.startRunner).toHaveBeenCalledWith(
    expect.objectContaining({ RUNTIME_DRIVER: 'local' }),
  );
});

it('treats a blank RUNTIME_DRIVER as unset and reports the host default (#476)', async () => {
  process.env['RUNTIME_DRIVER'] = '  ';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  expect(written(process.stdout)).toBe('Runtime: docker — Docker daemon is reachable\n');
  expect(written(process.stderr)).not.toContain(isolationWarning);
  expect(mocks.startRunner).toHaveBeenCalledWith(
    expect.objectContaining({ RUNTIME_DRIVER: 'docker' }),
  );
});

it('treats an empty RUNTIME_DRIVER as unset and warns when the host default is local', async () => {
  process.env['RUNTIME_DRIVER'] = '';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'local',
    drivers: dockerAndLocal.slice(1),
  });
  resolveServices();

  const running = await startWorkspace();
  await running.close();

  expect(written(process.stdout)).toBe(
    'Runtime: local — No tenant isolation: commands run as the host user\n',
  );
  expect(written(process.stderr)).toContain(isolationWarning);
});

it('reports a requested docker driver without a warning when the host prefers local', async () => {
  process.env['RUNTIME_DRIVER'] = 'docker';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'local',
    drivers: dockerAndLocal,
  });
  resolveServices();
  const sandbox = createRunningService({
    url: 'http://127.0.0.1:41000',
    token: 't'.repeat(64),
  });
  mocks.startDockerSandbox.mockResolvedValue(sandbox);
  mocks.dockerGatewayHost.mockResolvedValue('172.17.0.1');

  const running = await startWorkspace();
  expect(written(process.stdout)).toBe(
    'Runtime: docker — requested by RUNTIME_DRIVER; Docker daemon is reachable\nHost default: local\n',
  );
  expect(written(process.stderr)).not.toContain(isolationWarning);
  // #786: runs go to the docker runner manager, and a sandbox reaches the gateway via the host.
  // #1846: the gateway still forwards aw-control calls to the web process on loopback.
  expect(mocks.startGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      HOST: '172.17.0.1',
      GATEWAY_CONTROL_PLANE_ORIGIN: 'http://127.0.0.1:3000',
    }),
  );
  expect(mocks.startWeb).toHaveBeenCalledWith(
    expect.objectContaining({
      RUNTIME_DRIVER: 'docker',
      RUNNER_MANAGER_URL: 'http://127.0.0.1:41000',
      RUNNER_MANAGER_TOKEN: 't'.repeat(64),
      RUNTIME_VERIFICATION_NETWORK_POLICY: 'open',
      MODEL_GATEWAY_URL: 'http://host.docker.internal:4000',
    }),
    undefined,
  );
  await running.close();
  expect(sandbox.close).toHaveBeenCalledOnce();
  expect(process.env['RUNNER_MANAGER_URL']).toBeUndefined();
});

it('fails the start, never falling back to local, when the docker sandbox cannot start (#786)', async () => {
  process.env['RUNTIME_DRIVER'] = 'docker';
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  resolveServices();
  mocks.dockerGatewayHost.mockResolvedValue('127.0.0.1');
  const refused = new Error('the docker sandbox could not start and verify a container');
  mocks.startDockerSandbox.mockRejectedValue(refused);

  await expect(startWorkspace()).rejects.toBe(refused);
  expect(mocks.startRunner).not.toHaveBeenCalled();
  expect(mocks.startWeb).not.toHaveBeenCalled();
  expect(process.env['RUNTIME_DRIVER']).toBe('docker');
});

it('starts no docker sandbox for the local driver, nor for a docker host default nobody asked for', async () => {
  mocks.detectHostCapabilities.mockReturnValue({
    defaultDriver: 'docker',
    drivers: dockerAndLocal,
  });
  for (const requested of ['local', undefined]) {
    if (requested === undefined) delete process.env['RUNTIME_DRIVER'];
    else process.env['RUNTIME_DRIVER'] = requested;
    resolveServices();
    const running = await startWorkspace();
    await running.close();
    expect(mocks.startDockerSandbox).not.toHaveBeenCalled();
    expect(mocks.startGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ HOST: '127.0.0.1' }),
    );
    expect(mocks.startWeb.mock.lastCall?.[0]).not.toHaveProperty('RUNNER_MANAGER_URL');
  }
});
