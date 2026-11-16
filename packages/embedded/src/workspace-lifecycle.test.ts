import path from 'node:path';
import {
  installWorkspaceTestEnvironment,
  loadWorkspaceTestServices,
} from './workspace-services.test-support.js';

import { expect, it } from 'vitest';

import { createRunningService, environmentKeys, mocks } from './workspace-services.test-support.js';
const { LOCAL_RUN_WORKSPACE_ROOT, startWorkspace } = await loadWorkspaceTestServices();

installWorkspaceTestEnvironment();

it('restores generated environment before retrying a failed startup', async () => {
  const startupFailure = new Error('gateway unavailable');
  const firstDatabase = createRunningService({ url: 'postgresql://first' });
  const secondDatabase = createRunningService({ url: 'postgresql://second' });
  const firstRunner = createRunningService({ url: 'http://first-runner' });
  const secondRunner = createRunningService({ url: 'http://second-runner' });
  const gateway = createRunningService({ port: 4000 });
  const web = createRunningService({ url: 'http://web' });
  mocks.startEmbeddedDatabase
    .mockResolvedValueOnce(firstDatabase)
    .mockResolvedValueOnce(secondDatabase);
  mocks.startRunner.mockResolvedValueOnce(firstRunner).mockResolvedValueOnce(secondRunner);
  mocks.startGateway.mockRejectedValueOnce(startupFailure).mockResolvedValueOnce(gateway);
  mocks.startWeb.mockResolvedValue(web);

  await expect(startWorkspace()).rejects.toBe(startupFailure);
  expect(process.env['DATABASE_URL']).toBeUndefined();
  expect(process.env['RUNNER_URL']).toBeUndefined();
  expect(process.env['SESSION_SECRET']).toBeUndefined();

  const running = await startWorkspace();
  expect(mocks.startEmbeddedDatabase).toHaveBeenCalledTimes(2);
  expect(mocks.prepareDatabase).toHaveBeenLastCalledWith(
    expect.objectContaining({ DATABASE_URL: 'postgresql://second' }),
    { general: false },
  );
  await running.close();

  for (const key of environmentKeys) expect(process.env[key]).toBeUndefined();
});

it('releases every acquired resource when a later service fails to start', async () => {
  const startupFailure = new Error('gateway unavailable');
  const database = createRunningService({ url: 'postgresql://embedded' });
  const runner = createRunningService({ url: 'http://runner' });
  mocks.startEmbeddedDatabase.mockResolvedValue(database);
  mocks.startRunner.mockResolvedValue(runner);
  mocks.startGateway.mockRejectedValue(startupFailure);

  await expect(startWorkspace()).rejects.toBe(startupFailure);

  expect(runner.close).toHaveBeenCalledOnce();
  expect(database.close).toHaveBeenCalledOnce();
});

it('attempts to stop every service even when one shutdown fails', async () => {
  const shutdownFailure = new Error('web shutdown failed');
  const database = createRunningService({ url: 'postgresql://embedded' });
  const runner = createRunningService({ url: 'http://runner' });
  const gateway = createRunningService({ port: 4000 });
  const web = createRunningService({ url: 'http://web' });
  web.close.mockRejectedValue(shutdownFailure);
  mocks.startEmbeddedDatabase.mockResolvedValue(database);
  mocks.startRunner.mockResolvedValue(runner);
  mocks.startGateway.mockResolvedValue(gateway);
  mocks.startWeb.mockResolvedValue(web);

  const running = await startWorkspace();
  await expect(running.close()).rejects.toBe(shutdownFailure);

  expect(web.close).toHaveBeenCalledOnce();
  expect(gateway.close).toHaveBeenCalledOnce();
  expect(runner.close).toHaveBeenCalledOnce();
  expect(database.close).toHaveBeenCalledOnce();
});

it('restores the prior environment after a successful workspace closes', async () => {
  for (const key of environmentKeys) process.env[key] = `prior-${key}`;
  const priorEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const runner = createRunningService({ url: 'http://runner' });
  const gateway = createRunningService({ port: 4000 });
  const web = createRunningService({ url: 'http://web' });
  mocks.startRunner.mockResolvedValue(runner);
  mocks.startGateway.mockResolvedValue(gateway);
  mocks.startWeb.mockResolvedValue(web);

  const running = await startWorkspace();
  expect(process.env['RUNNER_URL']).toBe('http://runner');
  expect(process.env['MODEL_GATEWAY_URL']).toBe('http://127.0.0.1:4000');
  await running.close();

  expect(Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))).toEqual(
    priorEnvironment,
  );
});

it('returns the seed prepareDatabase settled on, for the launcher to sign its admin in', async () => {
  const seed = {
    workspaceId: '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
    adminUserId: '1c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
    generalAgentId: '2d9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
  };
  process.env['DATABASE_URL'] = 'postgresql://external';
  mocks.prepareDatabase.mockResolvedValue(seed);
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

  const running = await startWorkspace();
  expect(running.seed).toStrictEqual(seed);
  await running.close();
});

it('roots run workspaces under the project, not the container path /workspace (S1-19)', async () => {
  process.env['DATABASE_URL'] = 'postgresql://external';
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

  const running = await startWorkspace();
  const expected = path.resolve(LOCAL_RUN_WORKSPACE_ROOT);
  expect(path.isAbsolute(expected)).toBe(true);
  expect(process.env['RUNNER_WORKSPACE_ROOT']).toBe(expected);
  expect(mocks.startWeb).toHaveBeenCalledWith(
    expect.objectContaining({ RUNNER_WORKSPACE_ROOT: expected }),
    undefined,
  );
  await running.close();
  expect(process.env['RUNNER_WORKSPACE_ROOT']).toBeUndefined();
});

it('keeps a RUNNER_WORKSPACE_ROOT the environment already sets', async () => {
  process.env['DATABASE_URL'] = 'postgresql://external';
  process.env['RUNNER_WORKSPACE_ROOT'] = '/srv/runs';
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));

  const running = await startWorkspace();
  expect(mocks.startWeb).toHaveBeenCalledWith(
    expect.objectContaining({ RUNNER_WORKSPACE_ROOT: '/srv/runs' }),
    undefined,
  );
  await running.close();
  expect(process.env['RUNNER_WORKSPACE_ROOT']).toBe('/srv/runs');
});
