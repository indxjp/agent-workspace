import { ignoredStorageSettingsWarning } from '@indx-workspace/contracts/storage-settings';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
  createRunningService,
  installWorkspaceTestEnvironment,
  loadWorkspaceTestServices,
  mocks,
} from './workspace-services.test-support.js';
const { startWorkspace } = await loadWorkspaceTestServices();
installWorkspaceTestEnvironment();

// @story US-STO-10

const OLD_NAMES = ['AW_FILE_STORAGE_ROOT', 'OBJECT_STORAGE_BUCKET'] as const;
// The literal folder, not `EMBEDDED_STORAGE_ROOT`: moving the constant must fail this.
const STORAGE_FOLDER_URL = pathToFileURL(path.resolve('.agent-workspace/storage')).href;

/** The storage environment the server is started with, read while it runs. */
async function startedEnvironment(): Promise<Record<string, string | undefined>> {
  process.env['DATABASE_URL'] = 'postgresql://external';
  mocks.startRunner.mockResolvedValue(createRunningService({ url: 'http://runner' }));
  mocks.startGateway.mockResolvedValue(createRunningService({ port: 4000 }));
  mocks.startWeb.mockResolvedValue(createRunningService({ url: 'http://web' }));
  const running = await startWorkspace();
  const seen = Object.fromEntries(
    ['AW_STORAGE_URL', ...OLD_NAMES].map((key) => [key, process.env[key]]),
  );
  await running.close();
  return seen;
}

const warnings = (stderr: MockInstance<typeof process.stderr.write>): string[] =>
  stderr.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((chunk) => chunk.includes('storage_setting_ignored'));

it('[US-STO-10][api][cli] sets AW_STORAGE_URL to the file URL of the storage folder and no root', async () => {
  expect(await startedEnvironment()).toStrictEqual({
    AW_STORAGE_URL: STORAGE_FOLDER_URL,
    AW_FILE_STORAGE_ROOT: undefined,
    OBJECT_STORAGE_BUCKET: undefined,
  });
});

it.each(OLD_NAMES)(
  '[US-STO-10][api][cli] keeps storage off and warns once, without the value, when %s is set alone',
  async (name) => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const secret = `secret-${randomUUID()}`;
    process.env[name] = `/srv/${secret}`;

    const seen = await startedEnvironment();

    // No default location: it would move new writes away from where the old setting put them.
    expect(seen['AW_STORAGE_URL']).toBeUndefined();
    // The server never sees the old name, so it does not warn a second time.
    expect(seen[name]).toBeUndefined();
    expect(ignoredStorageSettingsWarning(seen)).toBeNull();
    const written = warnings(stderr);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`storage_setting_ignored: ignoring ${name};`);
    expect(written[0]).toContain('AW_STORAGE_URL');
    expect(written[0]).toContain('nothing is read from the old location');
    expect(written.join('')).not.toContain(secret);
    // The user's variable is back once the workspace has closed.
    expect(process.env[name]).toBe(`/srv/${secret}`);
  },
);

it('[US-STO-10][api][cli] keeps an AW_STORAGE_URL the environment already sets', async () => {
  process.env['AW_STORAGE_URL'] = 's3://elsewhere';
  expect(await startedEnvironment()).toMatchObject({
    AW_STORAGE_URL: 's3://elsewhere',
    AW_FILE_STORAGE_ROOT: undefined,
  });
});

it('[US-STO-10][api][cli] keeps an AW_STORAGE_URL beside an old setting, and warns once', async () => {
  const stderr = vi.spyOn(process.stderr, 'write');
  process.env['AW_STORAGE_URL'] = 's3://elsewhere';
  process.env['OBJECT_STORAGE_BUCKET'] = 'old-bucket';

  expect(await startedEnvironment()).toMatchObject({
    AW_STORAGE_URL: 's3://elsewhere',
    OBJECT_STORAGE_BUCKET: undefined,
  });
  expect(warnings(stderr)).toHaveLength(1);
});
