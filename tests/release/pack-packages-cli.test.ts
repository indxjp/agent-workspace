import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CREATE_SMOKE_CASES,
  PUBLISHED_PACKAGES,
  checkCreatedManifest,
  consumerEnvironment,
  parseOptions,
  resolveProbe,
  runtimeEnvironment,
  selectPackages,
  windowsCommandLine,
} from '../../scripts/release/pack-packages.mjs';

describe('the consumer import probe', () => {
  it('imports a JSON export with its import attribute and every other subpath plainly', () => {
    expect(
      resolveProbe(
        ['@indx-workspace/embedded/launch', '@indx-workspace/embedded/package.json'],
        new Set(['@indx-workspace/embedded/package.json']),
      ),
    ).toBe(
      'await import("@indx-workspace/embedded/launch");\n' +
        'await import("@indx-workspace/embedded/package.json", { with: { type: \'json\' } });\n',
    );
  });

  it('reads a stylesheet export from the install instead of importing it, and fails when it is missing or empty', () => {
    const consumer = mkdtempSync(path.join(tmpdir(), 'css-probe-'));
    try {
      const pkg = path.join(consumer, 'node_modules', 'pkg');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'pkg', exports: { './a.css': './a.css' } }),
      );
      const probe = resolveProbe(['pkg/a.css'], new Set(), new Set(['pkg/a.css']));
      writeFileSync(path.join(consumer, 'probe.mjs'), probe);
      const run = () => spawnSync(process.execPath, ['probe.mjs'], { cwd: consumer }).status;
      expect(run()).not.toBe(0); // missing
      writeFileSync(path.join(pkg, 'a.css'), '');
      expect(run()).not.toBe(0); // empty
      writeFileSync(path.join(pkg, 'a.css'), '.a{}');
      expect(run()).toBe(0);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('publishes the react stylesheet with the types its build ships, so a strict consumer can import it (#880)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '../../packages/react/package.json'), 'utf8'),
    ) as { scripts: { build: string }; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.publishConfig.exports['./styles.css']).toEqual({
      types: './dist/styles.d.css.ts',
      default: './dist/styles.css',
    });
    expect(manifest.scripts.build).toContain("'styles.d.css.ts'");
  });
});

describe('the command line and package selection', () => {
  it('selects a subset of the packages in publish order, and refuses a bad list', () => {
    expect(selectPackages(undefined)).toEqual([...PUBLISHED_PACKAGES]);
    expect(selectPackages('create,cli,platforms,contracts,aw,sdk')).toEqual([
      'contracts',
      'platforms',
      'sdk',
      'aw',
      'cli',
      'create',
    ]);
    expect(() => selectPackages('contracts,web')).toThrow(/names web, not one of/u);
    expect(() => selectPackages('sdk,sdk')).toThrow(/names sdk twice/u);
    expect(() => selectPackages('')).toThrow(/empty package/u);
    expect(() => selectPackages('sdk,')).toThrow(/empty package/u);
  });

  it('parses the command line strictly and packs all nine for a release or the smoke', () => {
    expect(parseOptions(['--out', 'o', '--smoke', '--expect-tag', 'packages-v0.1.0'])).toEqual({
      out: 'o',
      smoke: true,
      expectTag: 'packages-v0.1.0',
      packages: [...PUBLISHED_PACKAGES],
    });
    expect(parseOptions(['--packages', 'contracts,cli']).packages).toEqual(['contracts', 'cli']);
    expect(() => parseOptions(['--smok'])).toThrow(/Unknown option '--smok'/u);
    expect(() => parseOptions(['extra'])).toThrow(/Unexpected argument 'extra'/u);
    expect(() => parseOptions(['--packages', 'cli', '--smoke'])).toThrow(/cannot be combined/u);
    expect(() => parseOptions(['--packages', 'cli', '--expect-tag', 'packages-v0.1.0'])).toThrow(
      /cannot be combined/u,
    );
  });

  it('refuses a repeated option and an empty --out (regression, S1-12)', () => {
    expect(() => parseOptions(['--packages', 'cli', '--packages', 'sdk'])).toThrow(
      /--packages is given more than once/u,
    );
    expect(() => parseOptions(['--smoke', '--smoke'])).toThrow(/--smoke is given more than once/u);
    expect(() => parseOptions(['--out', ''])).toThrow(/--out names no directory/u);
  });
});

describe('the environment of smoke commands', () => {
  it('forks the embedded runtime without the variables its launcher manages', () => {
    const environment = runtimeEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        DATABASE_URL: 'postgres://elsewhere/db',
        NODE_ENV: 'test',
        HOST: '0.0.0.0',
        PORT: '3000',
        MIGRATIONS_DIR: '/m',
        AW_DEPLOYMENT_POSTURE: 'production',
        BOOTSTRAP_ADMIN_PASSWORD: 'inherited-secret',
        VITEST_WORKER_ID: '1',
        GATEWAY_PORT: '1',
        UNSET: undefined,
      },
      { gateway: 41001, runner: 41002 },
    );
    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      GATEWAY_PORT: '41001',
      RUNNER_PORT: '41002',
    });
  });

  it('keeps CI credentials out of every smoke command and the forked runtime (regression, S1-12)', () => {
    const parent = {
      Path: String.raw`C:\Windows`,
      HOME: '/home/u',
      TEMP: '/tmp',
      LC_ALL: 'C.UTF-8',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/x',
      NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'cache-write-token',
      TEST_S3_SECRET_ACCESS_KEY: 's3-secret',
      GITHUB_TOKEN: 'gh-token',
      NPM_CONFIG_USERCONFIG: '/home/u/.npmrc-with-token',
      SOMETHING_ELSE: 'x',
    };
    const expected = {
      Path: String.raw`C:\Windows`,
      HOME: '/home/u',
      TEMP: '/tmp',
      LC_ALL: 'C.UTF-8',
    };
    expect(consumerEnvironment(parent)).toEqual(expected);
    expect(runtimeEnvironment(parent, { gateway: 1, runner: 2 })).toEqual({
      ...expected,
      GATEWAY_PORT: '1',
      RUNNER_PORT: '2',
    });
  });

  it('quotes a cmd.exe argument with a space and refuses one cmd.exe would expand (regression, S1-12)', () => {
    expect(
      windowsCommandLine('pnpm', [
        'pack',
        '--pack-destination',
        String.raw`C:\Temp\out with space`,
      ]),
    ).toBe(String.raw`pnpm pack --pack-destination "C:\Temp\out with space"`);
    expect(windowsCommandLine('npm', ['x', String.raw`C:\a b\ `.trimEnd()])).toBe(
      String.raw`npm x "C:\a b\\"`,
    );
    expect(windowsCommandLine('node', [String.raw`C:\plain\path.js`])).toBe(
      String.raw`node C:\plain\path.js`,
    );
    expect(windowsCommandLine('npx', ['--no-install', 'aw', '--version'])).toBe(
      'npx --no-install aw --version',
    );
    expect(() => windowsCommandLine('npm', ['%PATH%'])).toThrow(/through cmd\.exe/u);
    expect(() => windowsCommandLine('npm', ['a"b'])).toThrow(/through cmd\.exe/u);
  });
});

describe('the create smoke cases (S1-16)', () => {
  it('runs npm create twice: -- --cloud local for v1 and -- --yes for the default v2 project (S1-16)', () => {
    expect(CREATE_SMOKE_CASES.map(({ directory, args }) => ({ directory, args }))).toEqual([
      { directory: 'generated', args: ['--offline', '--', '--cloud', 'local'] },
      { directory: 'v2', args: ['--offline', '--', '--yes', '--no-install'] },
    ]);
    for (const { args } of CREATE_SMOKE_CASES) {
      // npm keeps what precedes `--` and would swallow its own `--yes`; the bin gets the rest.
      const separator = args.indexOf('--');
      expect(args.indexOf('--offline')).toBeLessThan(separator);
      expect(args.slice(separator + 1).some((arg) => arg === '--cloud' || arg === '--yes')).toBe(
        true,
      );
    }
    expect(Object.isFrozen(CREATE_SMOKE_CASES)).toBe(true);
    expect(
      CREATE_SMOKE_CASES.map(({ dependencies }) =>
        dependencies('1.2.3', { 'engine-sdk': '4.5.6' }),
      ),
    ).toEqual([
      { '@indx-workspace/cli': '1.2.3' },
      {
        '@indx-workspace/aw': '1.2.3',
        '@indx-workspace/embedded': '1.2.3',
        '@indx-workspace/sdk': '1.2.3',
        'engine-sdk': '4.5.6',
      },
    ]);
  });

  it('accepts a created package.json with exactly the expected dependencies and refuses any other (S1-16)', () => {
    const [v1, v2] = CREATE_SMOKE_CASES;
    if (v1 === undefined || v2 === undefined) throw new Error('two create smoke cases expected');
    const v2Dependencies = v2.dependencies('1.2.3', { 'engine-sdk': '4.5.6' });
    const manifest = (dependencies: Record<string, string>) =>
      `${JSON.stringify({ name: 'v2', private: true, dependencies }, null, 2)}
`;

    expect(
      checkCreatedManifest(manifest(v1.dependencies('1.2.3', {})), v1.dependencies('1.2.3', {})),
    ).toEqual([]);
    expect(checkCreatedManifest(manifest(v2Dependencies), v2Dependencies)).toEqual([]);
    const reversed = Object.fromEntries(Object.entries(v2Dependencies).reverse());
    expect(checkCreatedManifest(manifest(reversed), v2Dependencies)).toEqual([]);

    const extra = { ...v2Dependencies, '@indx-workspace/cli': '1.2.3' };
    expect(checkCreatedManifest(manifest(extra), v2Dependencies)).toEqual([
      expect.stringContaining('not exactly'),
    ]);
    const missing = Object.fromEntries(
      Object.entries(v2Dependencies).filter(([name]) => name !== '@indx-workspace/embedded'),
    );
    expect(checkCreatedManifest(manifest(missing), v2Dependencies)).toEqual([
      expect.stringContaining('not exactly'),
    ]);
    expect(
      checkCreatedManifest(
        manifest({ ...v2Dependencies, '@indx-workspace/sdk': '1.2.4' }),
        v2Dependencies,
      ),
    ).toEqual([expect.stringContaining('not exactly')]);
    expect(
      checkCreatedManifest(
        manifest({ ...v2Dependencies, '@indx-workspace/sdk': 'workspace:*' }),
        v2Dependencies,
      ),
    ).toContain('keeps a workspace: specifier');
    expect(
      checkCreatedManifest(
        manifest({ ...v2Dependencies, '@agent-workspace/sdk': '1.2.3' }),
        v2Dependencies,
      ),
    ).toContain('names @agent-workspace/');
    expect(checkCreatedManifest('{"dependencies":', v2Dependencies)).toEqual(['is not JSON']);
    expect(checkCreatedManifest('[]', v2Dependencies)).toEqual(['is not a JSON object']);
    expect(checkCreatedManifest('{"name":"v2"}', v2Dependencies)).toEqual([
      expect.stringContaining('not exactly'),
    ]);
  });
});
