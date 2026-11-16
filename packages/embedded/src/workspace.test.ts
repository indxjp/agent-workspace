import { expect, it } from 'vitest';
import { loadWorkspaceTestServices } from './workspace-services.test-support.js';

import {
  createRunningService,
  environmentKeys,
  installWorkspaceTestEnvironment,
  mocks,
} from './workspace-services.test-support.js';
const { startWorkspace } = await loadWorkspaceTestServices();

installWorkspaceTestEnvironment();

it('stops the embedded database when database preparation fails', async () => {
  const startupFailure = new Error('migration failed');
  const cleanupFailure = new Error('cleanup failed');
  const database = createRunningService({ url: 'postgresql://embedded' });
  database.close.mockRejectedValue(cleanupFailure);
  mocks.startEmbeddedDatabase.mockResolvedValue(database);
  mocks.prepareDatabase.mockRejectedValue(startupFailure);

  const failure = await startWorkspace().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([startupFailure, cleanupFailure]);

  expect(database.close).toHaveBeenCalledOnce();
  expect(mocks.startRunner).not.toHaveBeenCalled();
  for (const key of environmentKeys) expect(process.env[key]).toBeUndefined();
});

// #556: the embedded PostgreSQL's port can be moved off one the operating system reserves.
it('starts the embedded database on the default port, or on AW_DATABASE_PORT', async () => {
  const startupFailure = new Error('migration failed');
  mocks.startEmbeddedDatabase.mockResolvedValue(
    createRunningService({ url: 'postgresql://embedded' }),
  );
  mocks.prepareDatabase.mockRejectedValue(startupFailure);

  await expect(startWorkspace()).rejects.toBe(startupFailure);
  expect(mocks.startEmbeddedDatabase).toHaveBeenLastCalledWith(undefined, 25_432);

  process.env['AW_DATABASE_PORT'] = '26000';
  await expect(startWorkspace()).rejects.toBe(startupFailure);
  expect(mocks.startEmbeddedDatabase).toHaveBeenLastCalledWith(undefined, 26_000);
});

it('refuses an invalid AW_DATABASE_PORT before anything starts', async () => {
  process.env['AW_DATABASE_PORT'] = '80';

  await expect(startWorkspace()).rejects.toMatchObject({
    name: 'EmbeddedDatabasePortError',
    code: 'invalid_port',
    message: 'AW_DATABASE_PORT must be a whole number from 1024 to 65535',
  });
  expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
  expect(mocks.prepareDatabase).not.toHaveBeenCalled();
  expect(mocks.startRunner).not.toHaveBeenCalled();
});

// Review of #556: a database port equal to the web port started PostgreSQL there, and the web
// server failed about a minute later with a bare "port <n> is already in use".
it('refuses an AW_DATABASE_PORT equal to the web port before anything starts', async () => {
  process.env['AW_DATABASE_PORT'] = '24100';
  process.env['PORT'] = '24100';

  await expect(startWorkspace()).rejects.toMatchObject({
    name: 'EmbeddedDatabasePortError',
    code: 'port_conflict',
    port: 24_100,
    message:
      "port 24100 is both the embedded PostgreSQL's port and PORT: set AW_DATABASE_PORT (or " +
      'PORT) in .env so the two differ',
  });
  expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
  expect(mocks.prepareDatabase).not.toHaveBeenCalled();
  expect(mocks.startRunner).not.toHaveBeenCalled();
});

it('ignores AW_DATABASE_PORT when DATABASE_URL names an external database', async () => {
  process.env['DATABASE_URL'] = 'postgresql://external';
  process.env['AW_DATABASE_PORT'] = 'not-a-port';
  const startupFailure = new Error('migration failed');
  mocks.prepareDatabase.mockRejectedValue(startupFailure);

  await expect(startWorkspace()).rejects.toBe(startupFailure);
  expect(mocks.startEmbeddedDatabase).not.toHaveBeenCalled();
});
