import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadWorkspaceTestServices } from './workspace-services.test-support.js';

import { createRunningService, mocks } from './workspace-services.test-support.js';
const { runEmbeddedCommand } = await loadWorkspaceTestServices();

const stubFetch = (headers: Record<string, string>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 401, headers }))),
  );
const unsupported = {
  'x-agent-workspace-contracts': '99.1.0',
  'x-agent-workspace-contracts-minimum': '99.0.0',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('stops an embedded workspace it refuses', async () => {
  const web = createRunningService({ url: 'http://web' });
  const database = createRunningService({ url: 'postgresql://embedded' });
  mocks.detectHostCapabilities.mockReturnValue({ defaultDriver: 'docker', drivers: [] });
  mocks.startEmbeddedDatabase.mockResolvedValue(database);
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(web);
  stubFetch(unsupported);
  await expect(runEmbeddedCommand()).rejects.toThrow(/serves contracts 99\.0\.0/);
  expect(web.close).toHaveBeenCalledOnce();
});
