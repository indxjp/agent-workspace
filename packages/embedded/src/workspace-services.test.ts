import {
  installWorkspaceTestEnvironment,
  loadWorkspaceTestServices,
} from './workspace-services.test-support.js';

import { expect, it, vi } from 'vitest';

import { createRunningService, mocks } from './workspace-services.test-support.js';
const { startWorkspace } = await loadWorkspaceTestServices();

installWorkspaceTestEnvironment();

it('runs the web server as asked: the published build, or the contributor default', async () => {
  const web = createRunningService({ url: 'http://web' });
  mocks.startEmbeddedDatabase.mockResolvedValue(
    createRunningService({ url: 'postgresql://embedded' }),
  );
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(web);

  await (await startWorkspace({ web: { dir: '/runtime/dist/web', dev: false } })).close();
  expect(mocks.startWeb).toHaveBeenLastCalledWith(expect.any(Object), {
    dir: '/runtime/dist/web',
    dev: false,
  });

  await (await startWorkspace()).close();
  expect(mocks.startWeb).toHaveBeenLastCalledWith(expect.any(Object), undefined);
});

it('waits for network services before stopping the embedded database', async () => {
  let finishWebShutdown: (() => void) | undefined;
  const database = createRunningService({ url: 'postgresql://embedded' });
  const runner = createRunningService({ url: 'http://runner' });
  const gateway = createRunningService({ port: 4000 });
  const web = createRunningService({ url: 'http://web' });
  web.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishWebShutdown = resolve;
      }),
  );
  mocks.startEmbeddedDatabase.mockResolvedValue(database);
  mocks.startRunner.mockResolvedValue(runner);
  mocks.startGateway.mockResolvedValue(gateway);
  mocks.startWeb.mockResolvedValue(web);

  const running = await startWorkspace();
  const closing = running.close();
  await vi.waitFor(() => expect(web.close).toHaveBeenCalledOnce());
  expect(database.close).not.toHaveBeenCalled();

  finishWebShutdown?.();
  await closing;
  expect(database.close).toHaveBeenCalledOnce();
});
