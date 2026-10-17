import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  CREATE_SMOKE_CASES,
  EXTRA_DIRECTORIES,
  PACK_DIRECTORIES,
  PUBLISHED_PACKAGES,
  checkCreatedManifest,
  checkDistContents,
  checkPackedManifest,
  checkTarballEntries,
  consumerEnvironment,
  importedSpecifiers,
  parseOptions,
  readTar,
  resolveProbe,
  runtimeEnvironment,
  selectPackages,
  tarballName,
  verifyTarball,
  windowsCommandLine,
} from '../../scripts/release/pack-packages.mjs';

const MANIFESTS = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/CHANGELOG.md',
];

function packed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@indx-workspace/sdk',
    version: '0.1.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/indxjp/agent-workspace.git',
      directory: 'packages/sdk',
    },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' },
    },
    dependencies: { '@indx-workspace/contracts': '0.1.0', zod: '4.6.5' },
    ...overrides,
  };
}

/** One ustar header and body, the shape `npm pack` writes. */
function tarEntry(name: string, body: string, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write(type, 156, 'utf8');
  const padded = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  padded.write(body, 0, 'utf8');
  return Buffer.concat([header, padded]);
}

/** One pax extended-header record: its length counts every byte of the record, itself included. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(rest) + 1;
  while (String(length).length + Buffer.byteLength(rest) !== length) length += 1;
  return `${String(length)}${rest}`;
}

/** The embedded package's packed manifest, as its build stages it (ADR-0109). */
function packedEmbedded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@indx-workspace/embedded',
    version: '0.1.0',
    description: 'The Agent Workspace local runtime.',
    license: 'Apache-2.0',
    homepage: 'https://github.com/indxjp/agent-workspace/tree/main/packages/embedded#readme',
    repository: {
      type: 'git',
      url: 'git+https://github.com/indxjp/agent-workspace.git',
      directory: 'packages/embedded',
    },
    bugs: { url: 'https://github.com/indxjp/agent-workspace/issues' },
    engines: { node: '>=24' },
    type: 'module',
    exports: { './launch': './dist/bin.js', './package.json': './package.json' },
    bin: { 'agent-workspace-embedded': './dist/bin.js' },
    dependencies: { 'embedded-postgres': '18.1.0-beta.16', next: '16.0.10', zod: '4.6.5' },
    publishConfig: { access: 'public' },
    ...overrides,
  };
}

describe('the published package tarballs (issue #246, ADR-0082)', () => {
  it('publishes contracts, platforms, the SDK, react, aw, the CLI, embedded, then create, each after what it depends on', () => {
    expect(PUBLISHED_PACKAGES).toEqual([
      'contracts',
      'platforms',
      'sdk',
      'react',
      'aw',
      'cli',
      'embedded',
      'create',
    ]);
    expect(EXTRA_DIRECTORIES).toEqual({ cli: ['templates/', 'schema/', 'modules/'] });
  });

  it('packs embedded from its generated staging directory and every other package in place', () => {
    expect(PACK_DIRECTORIES).toEqual({ embedded: 'packages/embedded/publish' });
  });

  it("accepts the embedded runtime's dist/web, dist/migrations and launcher entries (S1-12)", () => {
    const entries = [
      ...MANIFESTS,
      'package/dist/bin.js',
      'package/dist/launch.js',
      'package/dist/migrations/0001_initial.sql',
      'package/dist/web/.next-embedded/server/app/page.js',
      'package/dist/web/.next-embedded/server/app/(workspace)/w/[workspaceSlug]/agents/[agentId]/runs/[runId]/page.js',
      'package/dist/web/.next-embedded/static/chunks/app/(workspace)/layout-0123456789abcdef.js',
    ];
    expect(checkTarballEntries(entries)).toEqual([]);
    expect(checkTarballEntries([...entries, 'package/dist/web/server.js.map'])).toEqual([
      'dist/web/server.js.map: source maps point at unshipped src/',
    ]);
  });

  it('refuses the third-party scope in a dist/web file of the embedded runtime', () => {
    const contents = new Map([
      ['package/dist/bin.js', Buffer.from('#!/usr/bin/env node\n')],
      [
        'package/dist/web/.next-embedded/server/chunks/ssr/a.js',
        Buffer.from('require("@agent-workspace/core")'),
      ],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/dist/web/.next-embedded/server/chunks/ssr/a.js names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });

  it('accepts the realistic packed embedded manifest the staging build writes', () => {
    expect(checkPackedManifest(packedEmbedded(), '0.1.0')).toEqual([]);
  });

  it('refuses a staging manifest that kept a workspace devDependency in the third-party scope', () => {
    expect(
      checkPackedManifest(
        packedEmbedded({ devDependencies: { '@agent-workspace/core': 'workspace:*' } }),
        '0.1.0',
      ),
    ).toEqual([
      '@indx-workspace/embedded names @agent-workspace/*, a scope a third party owns on npm',
    ]);
    expect(checkPackedManifest(packedEmbedded({ private: true }), '0.1.0')).toEqual([
      '@indx-workspace/embedded is private',
    ]);
  });

  it('accepts the CLI generator templates only where the package declares them', () => {
    const cli = [...MANIFESTS, 'package/dist/index.js', 'package/templates/compose.yaml'];
    expect(checkTarballEntries(cli, ['templates/'])).toEqual([]);
    expect(checkTarballEntries(cli)).toHaveLength(1);
  });

  it('accepts the profile JSON Schema the CLI ships for its $schema URL (#424, ADR-0091)', () => {
    const cli = [
      ...MANIFESTS,
      'package/dist/index.js',
      'package/schema/agent-workspace.schema.json',
    ];
    expect(checkTarballEntries(cli, EXTRA_DIRECTORIES['cli'])).toEqual([]);
    expect(checkTarballEntries(cli, ['templates/'])).toHaveLength(1);
  });

  it('accepts the gcp-cloudrun Terraform module the CLI ships under modules/ (#794)', () => {
    const cli = [
      ...MANIFESTS,
      'package/dist/index.js',
      'package/modules/gcp-cloudrun/main.tf',
      'package/modules/gcp-cloudrun/.terraform.lock.hcl',
    ];
    expect(checkTarballEntries(cli, EXTRA_DIRECTORIES['cli'])).toEqual([]);
    expect(checkTarballEntries(cli, ['templates/', 'schema/'])).toHaveLength(2);
  });

  it('accepts dist/ and the manifests, and nothing else', () => {
    expect(checkTarballEntries([...MANIFESTS, 'package/dist/index.js'])).toEqual([]);
    expect(
      checkTarballEntries([
        ...MANIFESTS,
        'package/dist/index.js',
        'package/src/index.ts',
        'package/dist/index.js.map',
        'package/dist/index.test.js',
      ]),
    ).toHaveLength(3);
  });

  it('requires every manifest and a built dist/', () => {
    expect(checkTarballEntries(['package/package.json'])).toHaveLength(4);
  });

  it('accepts a lock-step manifest in the owned scope', () => {
    expect(checkPackedManifest(packed(), '0.1.0')).toEqual([]);
  });

  it('refuses the third-party scope anywhere in the manifest', () => {
    expect(checkPackedManifest(packed({ name: '@agent-workspace/sdk' }), '0.1.0')).toHaveLength(2);
    expect(
      checkPackedManifest(
        packed({ dependencies: { '@agent-workspace/contracts': '0.1.0' } }),
        '0.1.0',
      ),
    ).toHaveLength(1);
  });

  it('refuses the third-party scope in any compiled dist/ file', () => {
    const contents = new Map([
      ['package/package.json', Buffer.from('{"name":"@indx-workspace/sdk"}')],
      ['package/dist/index.js', Buffer.from("export * from '@indx-workspace/contracts';")],
      ['package/dist/lazy.d.ts', Buffer.from("import type { X } from '@agent-workspace/sdk';")],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/dist/lazy.d.ts names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });

  it('refuses the third-party scope in a template the generator copies into a project', () => {
    const contents = new Map([
      [
        'package/templates/package.json',
        Buffer.from('{"dependencies":{"@agent-workspace/cli":"0.1.0"}}'),
      ],
      ['package/templates/compose.yaml', Buffer.from('services: {}')],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/templates/package.json names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });

  it('names the tarball pnpm pack writes, so a re-run into the same directory replaces it', () => {
    expect(tarballName({ name: '@indx-workspace/sdk', version: '0.1.0' })).toBe(
      'indx-workspace-sdk-0.1.0.tgz',
    );
  });

  it('refuses a workspace specifier, a sibling off lock-step, and a version off the contracts', () => {
    const failures = [
      ...checkPackedManifest(packed({ dependencies: { zod: 'workspace:*' } }), '0.1.0'),
      ...checkPackedManifest(
        packed({ dependencies: { '@indx-workspace/contracts': '^0.1.0' } }),
        '0.1.0',
      ),
      ...checkPackedManifest(packed({ version: '0.2.0' }), '0.1.0'),
    ];
    expect(failures).toHaveLength(3);
  });

  it('refuses a private manifest, a missing repository, and an entry outside dist/', () => {
    expect(checkPackedManifest(packed({ private: true }), '0.1.0')).toHaveLength(1);
    expect(checkPackedManifest(packed({ repository: undefined }), '0.1.0')).toHaveLength(1);
    expect(
      checkPackedManifest(packed({ exports: { '.': { types: './src/index.ts' } } }), '0.1.0'),
    ).toHaveLength(1);
    expect(checkPackedManifest(packed({ bin: { aw: './bin/aw.js' } }), '0.1.0')).toHaveLength(1);
  });

  it("accepts exactly embedded's package.json self-export outside dist/ (ADR-0109)", () => {
    const embedded = (exports: unknown) =>
      packed({
        name: '@indx-workspace/embedded',
        main: undefined,
        types: undefined,
        exports,
      });
    expect(
      checkPackedManifest(
        embedded({ './launch': './dist/bin.js', './package.json': './package.json' }),
        '0.1.0',
      ),
    ).toEqual([]);
    expect(checkPackedManifest(embedded({ './x': './package.json' }), '0.1.0')).toEqual([
      '@indx-workspace/embedded entry ./package.json is outside dist/',
    ]);
    expect(
      checkPackedManifest(embedded({ './package.json': './src/package.json' }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./src/package.json is outside dist/']);
    expect(
      checkPackedManifest(embedded({ './package.json': { default: './package.json' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./package.json is outside dist/']);
  });

  it('keeps the dist-only rule for the self-export of every other package', () => {
    expect(
      checkPackedManifest(packed({ exports: { './package.json': './package.json' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/sdk entry ./package.json is outside dist/']);
  });

  it('collects the package imports the developer site shows', () => {
    const documents = [
      'import { createClient } from \'@indx-workspace/sdk\';\nimport { x } from "@indx-workspace/contracts/runs";',
      "import { fixtures } from '@indx-workspace/sdk/testing'; // npm install @indx-workspace/aw",
      "await import('@indx-workspace/sdk/events'); import '@indx-workspace/contracts/agents';",
    ];
    expect(importedSpecifiers(documents)).toEqual([
      '@indx-workspace/contracts/agents',
      '@indx-workspace/contracts/runs',
      '@indx-workspace/sdk',
      '@indx-workspace/sdk/events',
      '@indx-workspace/sdk/testing',
    ]);
  });

  it('reads the entries of a tar archive and keeps only the selected contents', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', '{"name":"x"}'),
      tarEntry('package/dist/index.js', '#!/usr/bin/env node\n'),
      Buffer.alloc(1024),
    ]);
    const { names, contents } = readTar(archive, (name) => name.endsWith('.json'));
    expect(names).toEqual(['package/package.json', 'package/dist/index.js']);
    expect(contents.get('package/package.json')?.toString('utf8')).toBe('{"name":"x"}');
    expect(contents.has('package/dist/index.js')).toBe(false);
  });

  it('names an entry by its pax path record, not its truncated ustar name (regression, S1-12)', () => {
    const real = `package/dist/web/.next-embedded/server/app/${'nested/'.repeat(20)}page.js`;
    const archive = Buffer.concat([
      tarEntry('PaxHeader/page.js', paxRecord('path', real) + paxRecord('mtime', '0'), 'x'),
      tarEntry(real.slice(0, 100), 'export default "@agent-workspace/web";'),
      tarEntry('pax_global_header', paxRecord('comment', 'ignored'), 'g'),
      tarEntry('package/package.json', '{}'),
      Buffer.alloc(1024),
    ]);
    const { names, contents } = readTar(archive, (name) => name.startsWith('package/dist/'));
    expect(names).toEqual([real, 'package/package.json']);
    expect(checkDistContents(contents)).toEqual([
      `${real} names @agent-workspace/*, a scope a third party owns on npm`,
    ]);
  });

  it('names an entry by its GNU long name, and only the entry that follows it', () => {
    const real = `package/dist/web/${'very-long-directory-name/'.repeat(6)}chunk.js`;
    const archive = Buffer.concat([
      tarEntry('././@LongLink', `${real}\0`, 'L'),
      tarEntry(real.slice(0, 100), 'x'),
      tarEntry('package/dist/bin.js', '#!/usr/bin/env node\n'),
      Buffer.alloc(1024),
    ]);
    expect(readTar(archive, () => false).names).toEqual([real, 'package/dist/bin.js']);
  });

  it('refuses a malformed pax record rather than misnaming the next entry', () => {
    const archive = Buffer.concat([
      tarEntry('PaxHeader/x', '99 path=package/dist/x.js\n', 'x'),
      tarEntry('package/dist/x.js', 'x'),
    ]);
    expect(() => readTar(archive, () => true)).toThrow(/malformed record/u);
  });

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

  it('parses the command line strictly and packs all eight for a release or the smoke', () => {
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

  it('refuses an entry target that leaves dist/ through .. (regression, S1-12)', () => {
    expect(
      checkPackedManifest(
        packedEmbedded({
          exports: { './launch': './dist/../src/x.js', './package.json': './package.json' },
        }),
        '0.1.0',
      ),
    ).toEqual(['@indx-workspace/embedded entry ./dist/../src/x.js is outside dist/']);
    expect(
      checkPackedManifest(packedEmbedded({ bin: { x: './dist/../../etc' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./dist/../../etc is outside dist/']);
  });

  it('reports a dependency specifier that is not a string instead of crashing (regression, S1-12)', () => {
    expect(checkPackedManifest(packedEmbedded({ dependencies: { a: 1 } }), '0.1.0')).toEqual([
      '@indx-workspace/embedded dependencies.a is not a string specifier',
    ]);
  });

  it('names link, directory and contiguous entries, and refuses every one that is not a regular file (regression, S1-12)', () => {
    const archive = Buffer.concat([
      tarEntry('package/src/secret.ts', 'x', '7'),
      tarEntry('package/.env', '', '2'),
      tarEntry('package/x', '', '1'),
      tarEntry('package/dist/', '', '5'),
      Buffer.alloc(1024),
    ]);
    const { names, contents, special } = readTar(archive, () => true);
    expect(names).toEqual(['package/src/secret.ts', 'package/.env', 'package/x', 'package/dist/']);
    expect(special).toEqual(['package/.env', 'package/x', 'package/dist/']);
    expect(contents.get('package/src/secret.ts')?.toString('utf8')).toBe('x');
  });

  it('verifies a whole tarball: a link entry and an unshipped file fail it (regression, S1-12)', () => {
    const fields = packed();
    const manifest = JSON.stringify(fields);
    const good = [
      tarEntry('package/package.json', manifest),
      tarEntry('package/README.md', '#'),
      tarEntry('package/LICENSE', 'L'),
      tarEntry('package/CHANGELOG.md', '#'),
      tarEntry('package/dist/index.js', 'export {};'),
    ];
    const end = Buffer.alloc(1024);
    expect(verifyTarball(gzipSync(Buffer.concat([...good, end])), '0.1.0')).toEqual({
      manifest: fields,
      failures: [],
    });
    const bad = verifyTarball(
      gzipSync(
        Buffer.concat([
          ...good,
          tarEntry('package/dist/.env', '', '2'),
          tarEntry('package/src/secret.ts', 'x', '7'),
          end,
        ]),
      ),
      '0.1.0',
    );
    expect(bad.failures).toEqual([
      'package/dist/.env: only regular files ship, not a link or a directory',
      'src/secret.ts: only dist/, the manifests and nothing else ship',
    ]);
    expect(verifyTarball(gzipSync(Buffer.concat([...good, end])), '0.2.0').failures).toEqual([
      '@indx-workspace/sdk is 0.1.0, not the contracts version 0.2.0',
      '@indx-workspace/sdk dependencies.@indx-workspace/contracts is 0.1.0, not lock-step 0.2.0',
    ]);
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

  it('refuses a repeated option and an empty --out (regression, S1-12)', () => {
    expect(() => parseOptions(['--packages', 'cli', '--packages', 'sdk'])).toThrow(
      /--packages is given more than once/u,
    );
    expect(() => parseOptions(['--smoke', '--smoke'])).toThrow(/--smoke is given more than once/u);
    expect(() => parseOptions(['--out', ''])).toThrow(/--out names no directory/u);
  });

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

describe('workflows that pack the published set', () => {
  const WORKFLOWS = path.join(__dirname, '../../.github/workflows');
  const PACKS_ALL =
    /tests\/journey\/run\.mjs|build-deploy-journey\/journey\.e2e\.mjs|tests\/docs-claims\/run\.mjs|release:pack|publish-packages\.mjs/u;

  it('builds every PUBLISHED_PACKAGES member in each full-pack job that names its projects', () => {
    let checked = 0;
    let restored = 0;
    for (const file of ['ci.yml', 'journey-live.yml', 'publish-packages.yml']) {
      const jobs = readFileSync(path.join(WORKFLOWS, file), 'utf8').split(/^ {2}(?=[\w-]+:$)/mu);
      for (const job of jobs.filter(
        (text) => PACKS_ALL.test(text) && !text.includes('node tests/generated-project/run.mjs'),
      )) {
        // ci.yml's packing jobs restore the `build` job's artifact, which builds every project.
        if (job.includes('uses: ./.github/actions/workspace-build')) {
          restored += 1;
          continue;
        }
        for (const line of job.split('\n')) {
          const list = /run-many -t build (?:--projects=|-p )(\S+(?: @\S+)*)/u.exec(line)?.[1];
          if (list === undefined) continue;
          const built = list.split(/[, ]/u);
          const missing = PUBLISHED_PACKAGES.filter(
            (name) => !built.includes(`@indx-workspace/${name}`),
          );
          expect(missing, `${file} job ${job.slice(0, job.indexOf(':'))}`).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(restored).toBeGreaterThanOrEqual(3);
    const ci = readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
    // `build` builds every project but embedded, and `build-embedded` builds embedded.
    expect(ci).toMatch(
      /^ {8}run: scripts\/ci\/nx\.sh run-many -t build --exclude=@indx-workspace\/embedded --parallel=/mu,
    );
    expect(ci).toMatch(/^ {8}run: scripts\/ci\/nx\.sh run @indx-workspace\/embedded:build /mu);
  });
});
