import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runCreateCommand: vi.fn() }));

vi.mock('@indx-workspace/cli/create', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@indx-workspace/cli/create')>()),
  runCreateCommand: mocks.runCreateCommand,
}));

import { runCreate } from './run.js';

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('npm create @indx-workspace', () => {
  it('is @scope/create, so npm create @indx-workspace resolves to it, with exactly one bin', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string; bin: Record<string, string> };
    const cli = JSON.parse(
      await readFile(new URL('../../cli/package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(manifest.name).toBe('@indx-workspace/create');
    expect(Object.keys(manifest.bin)).toHaveLength(1);
    expect(manifest.version).toBe(cli.version);
  });

  it('passes every argument to the CLI generator and exits 0 when it succeeds', async () => {
    mocks.runCreateCommand.mockResolvedValue(undefined);

    await expect(runCreate(['acme-ai', '--cloud', 'gcp'])).resolves.toBe(0);
    expect(mocks.runCreateCommand).toHaveBeenCalledWith(['acme-ai', '--cloud', 'gcp']);
  });

  it('passes --yes and --cloud local through unchanged, as npm hands them over after its -- (S1-16)', async () => {
    mocks.runCreateCommand.mockResolvedValue(undefined);

    await expect(runCreate(['acme-ai', '--yes'])).resolves.toBe(0);
    expect(mocks.runCreateCommand).toHaveBeenLastCalledWith(['acme-ai', '--yes']);
    await expect(runCreate(['acme-ai', '--cloud', 'local'])).resolves.toBe(0);
    expect(mocks.runCreateCommand).toHaveBeenLastCalledWith(['acme-ai', '--cloud', 'local']);
  });

  it('turns a refusal into its one message and exit 1, as create-agent-workspace does', async () => {
    mocks.runCreateCommand.mockRejectedValue(
      new Error('Unsupported --cloud "mars".', { cause: new Error('secret driver text') }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(runCreate(['acme-ai', '--cloud', 'mars'])).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith('Unsupported --cloud "mars".\n');
  });
});
