/**
 * ADR-0087 D1: the runner and runtime images serve `npx` with `pnpm dlx` through
 * `infra/images/npx.mjs`. These are the argument mappings a `stdio` connector relies on, and the
 * refusals that keep an unsupported npx flag from being silently reinterpreted.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PATH,
  DEFAULT_PNPM_CLI,
  dlxPackageSpec,
  npxToPnpmDlx,
  pnpmInvocation,
  RUN_BIN,
  UnsupportedNpxUsage,
} from '../../infra/images/npx.mjs';

const SHIM = path.resolve(import.meta.dirname, '../../infra/images/npx.mjs');
const FAKE_PNPM = path.resolve(import.meta.dirname, 'fixtures/fake-pnpm.mjs');

interface FakeOutput {
  readonly argv: string[];
  readonly env: Partial<Record<string, string | null>>;
}

describe('npx served by pnpm dlx', () => {
  // The command runs through the bin runner with Node (see infra/images/npx-run-bin.mjs).
  const RUN = ['NODE', 'RUN_BIN'];
  it.each([
    [['cowsay'], ['dlx', '--package', 'cowsay', ...RUN, '--package', 'cowsay', '--']],
    [
      ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      [
        'dlx',
        '--package',
        '@modelcontextprotocol/server-filesystem',
        ...RUN,
        '--package',
        '@modelcontextprotocol/server-filesystem',
        '--',
        '/workspace',
      ],
    ],
    [
      ['--yes', 'pkg@1.2.3', 'a', 'b'],
      ['dlx', '--package', 'pkg@1.2.3', ...RUN, '--package', 'pkg@1.2.3', '--', 'a', 'b'],
    ],
    [
      ['@scope/pkg@latest'],
      ['dlx', '--package', '@scope/pkg@latest', ...RUN, '--package', '@scope/pkg@latest', '--'],
    ],
    // Arguments after the command belong to the command, flags included.
    [
      ['-y', 'pkg', '--port', '3000', '-y', '--', 'x'],
      [
        'dlx',
        '--package',
        'pkg',
        ...RUN,
        '--package',
        'pkg',
        '--',
        '--port',
        '3000',
        '-y',
        '--',
        'x',
      ],
    ],
    [
      ['-p', 'typescript', 'tsc', '--version'],
      ['dlx', '--package', 'typescript', ...RUN, '--command', 'tsc', '--', '--version'],
    ],
    [
      ['--package', 'a', '--package=b@2', 'cmd'],
      ['dlx', '--package', 'a', '--package', 'b@2', ...RUN, '--command', 'cmd', '--'],
    ],
    [
      ['-y', '--', 'pkg', '--flag'],
      ['dlx', '--package', 'pkg', ...RUN, '--package', 'pkg', '--', '--flag'],
    ],
  ])('maps npx %j to pnpm %j', (argv, expected) => {
    expect(npxToPnpmDlx(argv, { node: 'NODE', runBin: 'RUN_BIN' })).toEqual(expected);
  });

  it.each([
    // Non-registry specs pass through for pnpm to install as they are.
    ['alias@npm:@scope/pkg@1', 'alias@npm:@scope/pkg@1'],
    ['github:org/repo', 'github:org/repo'],
    ['https://host/pkg-1.0.0.tgz', 'https://host/pkg-1.0.0.tgz'],
    ['/srv/pkg', '/srv/pkg'],
    ['file:/srv/pkg', 'file:/srv/pkg'],
    ['.hidden-name', '.hidden-name'],
    // A relative directory is made absolute: pnpm dlx installs from its own cache directory.
    ['./dir', '/work/dir'],
    ['../dir', '/dir'],
    ['.', '/work'],
    ['..', '/'],
    ['file:./dir', 'file:/work/dir'],
    ['file:../up/dir', 'file:/up/dir'],
    // After `file:`, any location that is not absolute is a relative path.
    ['file:dir', 'file:/work/dir'],
    ['file:dir/sub', 'file:/work/dir/sub'],
    ['file:.', 'file:/work'],
  ])('gives pnpm the spec %s as %s', (spec, expected) => {
    expect(dlxPackageSpec(spec, '/work')).toBe(expected);
  });

  it('resolves a relative directory package against the working directory, in either form', () => {
    const runner = { node: 'NODE', runBin: 'RUN_BIN' };
    expect(npxToPnpmDlx(['-y', './server', '--flag'], runner, '/work')).toEqual([
      'dlx',
      '--package',
      '/work/server',
      ...RUN,
      '--package',
      '/work/server',
      '--',
      '--flag',
    ]);
    // With -p, only the packages are specs; the command is a command.
    expect(
      npxToPnpmDlx(['-p', './a', '--package=file:../b', './run'], runner, '/work/sub'),
    ).toEqual([
      'dlx',
      '--package',
      '/work/sub/a',
      '--package',
      'file:/work/b',
      ...RUN,
      '--command',
      './run',
      '--',
    ]);
  });

  it.each([
    [[], /name a package or command/u],
    [['-y'], /name a package or command/u],
    [['--'], /name a package or command/u],
    [['-p'], /-p needs a package name/u],
    [['--package', '--yes', 'x'], /--package needs a package name/u],
    [['--package=', 'x'], /--package= needs a package name/u],
    [['--package=-x', 'y'], /--package= needs a package name/u],
    [['-c', 'echo hi'], /-c is not supported/u],
    [['--call', 'echo'], /--call is not supported/u],
    [['--no-install', 'pkg'], /--no-install is not supported/u],
    [['-q', 'pkg'], /-q is not supported/u],
    [['--', '-dash-named'], /named -dash-named is not supported/u],
  ])('refuses npx %j', (argv, message) => {
    expect(() => npxToPnpmDlx(argv)).toThrow(UnsupportedNpxUsage);
    expect(() => npxToPnpmDlx(argv)).toThrow(message);
  });

  it('exits 2 with the reason on stderr, and never starts pnpm, for an unsupported flag', () => {
    const result = spawnSync(process.execPath, [SHIM, '--call', 'echo hi'], {
      encoding: 'utf8',
      env: { ...process.env, PNPM_CLI: '/nonexistent/pnpm.cjs' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--call is not supported in this image.*pnpm dlx/u);
  });

  it('passes the translated arguments and the exit code through pnpm', () => {
    // A stand-in pnpm that echoes its argv and exits 7, to prove the wiring end to end.
    const result = spawnSync(process.execPath, [SHIM, '-y', 'pkg@1', '--flag'], {
      encoding: 'utf8',
      env: { ...process.env, PNPM_CLI: FAKE_PNPM },
    });
    expect(result.status).toBe(7);
    expect((JSON.parse(result.stdout) as FakeOutput).argv).toEqual([
      'dlx',
      '--package',
      'pkg@1',
      process.execPath,
      RUN_BIN,
      '--package',
      'pkg@1',
      '--',
      '--flag',
    ]);
    // The runner is the file next to the shim, which the Dockerfiles copy with it.
    expect(path.basename(RUN_BIN)).toBe('npx-run-bin.mjs');
  });

  it('needs nothing from its environment: an engine launches connectors with a replaced one', () => {
    // No PNPM_CLI, no PATH, no HOME, no XDG_*: the shim falls back to the image's pnpm and gives
    // pnpm a PATH and writable directories under /tmp.
    const invocation = pnpmInvocation(['-y', 'pkg'], {});
    expect(invocation.cli).toBe(DEFAULT_PNPM_CLI);
    expect(DEFAULT_PNPM_CLI).toBe('/opt/pnpm/bin/pnpm.cjs');
    expect(invocation.env).toEqual({
      PATH: DEFAULT_PATH,
      XDG_CACHE_HOME: '/tmp/pnpm/cache',
      XDG_DATA_HOME: '/tmp/pnpm/data',
      XDG_STATE_HOME: '/tmp/pnpm/state',
      XDG_CONFIG_HOME: '/tmp/pnpm/config',
    });
    expect(DEFAULT_PATH.split(':')).toContain('/usr/local/bin');

    // Spawned for real with an empty environment, it runs the fixed entry point (absent on this
    // host, so node reports that path) instead of refusing for want of PNPM_CLI.
    const result = spawnSync(process.execPath, [SHIM, '-y', 'pkg'], {
      encoding: 'utf8',
      env: process.platform === 'win32' ? { SYSTEMROOT: process.env['SYSTEMROOT'] ?? '' } : {},
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/opt[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs/u);
  });

  it('keeps every directory and PATH the caller did set', () => {
    const environment = {
      PATH: '/custom/bin',
      XDG_CACHE_HOME: '/workspace/.cache',
      XDG_DATA_HOME: '/workspace/.data',
      XDG_STATE_HOME: '/workspace/.state',
      XDG_CONFIG_HOME: '/workspace/.config',
      PNPM_CLI: '/elsewhere/pnpm.cjs',
      KEEP: 'me',
    };
    const invocation = pnpmInvocation(['pkg'], environment);
    expect(invocation.cli).toBe('/elsewhere/pnpm.cjs');
    expect(invocation.env).toEqual(environment);

    const result = spawnSync(process.execPath, [SHIM, 'pkg'], {
      encoding: 'utf8',
      env: { ...process.env, PNPM_CLI: FAKE_PNPM, XDG_CACHE_HOME: '/workspace/.cache' },
    });
    expect(result.status).toBe(7);
    const { env } = JSON.parse(result.stdout) as FakeOutput;
    expect(env['XDG_CACHE_HOME']).toBe('/workspace/.cache');
    // Unset ones still default under /tmp, never the (read-only) home directory.
    for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME'] as const) {
      expect(env[name] ?? process.env[name]).toBeTruthy();
      if (process.env[name] === undefined) expect(env[name]).toMatch(/^\/tmp\/pnpm\//u);
    }
  });

  it('passes pnpm no package-manager setting: dlx already skips the packageManager check', () => {
    // pnpm 11 has no `manage-package-manager-versions`; `dlx` is exempt from the check (ADR-0087).
    const { args } = pnpmInvocation(['pkg'], {});
    expect(args[0]).toBe('dlx');
    expect(args.some((argument) => argument.startsWith('--config.'))).toBe(false);
  });
});
