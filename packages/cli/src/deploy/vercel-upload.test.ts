import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertStageable,
  isExcluded,
  removeStaged,
  stageDirectory,
  stagePlatform,
  writeFunctionEntry,
} from './vercel-upload.js';
import { defaultProfile } from '../profile-defaults.js';
import {
  renderVercelPartSettings,
  renderVercelProject,
  VERCEL_FUNCTION_ENTRY,
} from '../render/vercel.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-upload-test-'));
  created.push(directory);
  return directory;
}

async function put(root: string, file: string, contents = ''): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), contents);
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    );
}

const manifest = (name: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies });

/** A workspace where every package has thousands of dependency files, build output and tests. */
async function workspace(): Promise<string> {
  const root = await temporaryDirectory();
  await put(root, 'package.json', manifest('root'));
  await put(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await put(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  await put(root, '.npmrc', 'save-exact=true\n');
  await put(root, 'tsconfig.json', '{}');
  await put(root, 'README.md', 'not needed to build');
  await put(root, 'docs/guide.md', 'not needed to build');
  await put(root, '.git/HEAD', 'ref: refs/heads/main\n');
  await put(root, '.nx/workspace-data/graph.json', '{}');
  const packages: [string, string, Record<string, string>][] = [
    ['apps/web', 'web', { '@t/gateway': 'workspace:*' }],
    ['apps/runner', 'runner', { '@t/core': 'workspace:^' }],
    ['packages/core', '@t/core', {}],
    ['packages/gateway', '@t/gateway', { '@t/core': 'workspace:*', zod: '4.0.0' }],
    ['packages/unrelated', '@t/unrelated', {}],
  ];
  for (const [directory, name, dependencies] of packages) {
    await put(root, `${directory}/package.json`, manifest(name, dependencies));
    await put(root, `${directory}/src/index.ts`, 'export {};');
    await put(root, `${directory}/src/index.test.ts`, 'test');
    await put(root, `${directory}/dist/index.js`, '');
    await put(root, `${directory}/.env.local`, 'SECRET=1');
    await put(root, `${directory}/tsconfig.build.tsbuildinfo`, '{}');
    await Promise.all(
      Array.from({ length: 1200 }, (_, index) =>
        put(root, `${directory}/node_modules/dep-${String(index)}/index.js`),
      ),
    );
  }
  return root;
}

describe('the upload `aw deploy` makes to Vercel', () => {
  it('holds the gateway, what it depends on and the root files, and nothing the build does not read', async () => {
    const source = await workspace();
    const staged = await stagePlatform(source, 'packages/gateway');
    created.push(staged);

    expect((await files(staged)).sort()).toEqual(
      [
        '.npmrc',
        'apps/runner/package.json',
        'apps/web/package.json',
        'package.json',
        'packages/core/package.json',
        'packages/core/src/index.ts',
        'packages/gateway/package.json',
        'packages/gateway/src/index.ts',
        'packages/unrelated/package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.json',
      ].sort(),
    );
    await removeStaged(staged);
    expect(await readdir(os.tmpdir())).not.toContain(path.basename(staged));
  });

  it('follows the dependencies of the control plane and leaves the manager out of it', async () => {
    const source = await workspace();
    const staged = await stagePlatform(source, 'apps/web');
    created.push(staged);

    const uploaded = await files(staged);
    expect(uploaded).toContain('apps/web/src/index.ts');
    expect(uploaded).toContain('packages/gateway/src/index.ts');
    expect(uploaded).toContain('packages/core/src/index.ts');
    expect(uploaded).not.toContain('apps/runner/src/index.ts');
    expect(uploaded).not.toContain('packages/unrelated/src/index.ts');
  });

  it('stays far below the 5000 files a free Vercel team may upload, whatever is in node_modules', async () => {
    const source = await workspace();
    expect((await files(source)).length).toBeGreaterThan(6000);

    const staged = await stagePlatform(source, 'apps/web');
    created.push(staged);

    expect((await files(staged)).length).toBeLessThan(100);
    // Writing and walking 6000+ files: seconds on a shared CI runner's disk.
  }, 30_000);

  it('refuses a source that is not a platform checkout, by name', async () => {
    const source = await temporaryDirectory();
    await put(source, 'apps/web/package.json', '{ not json');

    await expect(stagePlatform(source, 'apps/web')).rejects.toThrow(
      `${path.join(source, 'apps', 'web', 'package.json')} cannot be read as JSON`,
    );
    const empty = await temporaryDirectory();
    await expect(stagePlatform(empty, 'apps/web')).rejects.toThrow('is not a workspace package');
  });

  it('refuses a workspace dependency the checkout does not have', async () => {
    const source = await temporaryDirectory();
    await put(source, 'apps/web/package.json', manifest('web', { '@t/missing': 'workspace:*' }));

    await expect(stagePlatform(source, 'apps/web')).rejects.toThrow(
      'depends on the workspace package @t/missing, which the checkout does not have',
    );
  });

  it('keeps the package.json of a workspace package that has no name, so the lockfile still matches', async () => {
    const source = await workspace();
    await put(source, 'packages/nameless/package.json', JSON.stringify({ private: true }));
    await put(source, 'packages/nameless/src/index.ts', 'export {};');

    const staged = await stagePlatform(source, 'packages/gateway');
    created.push(staged);

    const uploaded = await files(staged);
    expect(uploaded).toContain('packages/nameless/package.json');
    expect(uploaded).not.toContain('packages/nameless/src/index.ts');
  });

  it('refuses up front what staging would refuse', async () => {
    const source = await workspace();
    await expect(assertStageable(source, 'packages/gateway')).resolves.toBeUndefined();
    await put(
      source,
      'apps/runner/package.json',
      manifest('runner', { '@t/missing': 'workspace:*' }),
    );
    await expect(assertStageable(source, 'apps/runner')).rejects.toThrow(
      'depends on the workspace package @t/missing',
    );
  });

  it("uploads a project's web directory without its dependencies, output or secrets", async () => {
    const web = await temporaryDirectory();
    await put(web, 'package.json', '{}');
    await put(web, 'src/main.tsx');
    await put(web, 'src/main.test.tsx');
    await put(web, 'node_modules/react/index.js');
    await put(web, 'dist/index.html');
    await put(web, '.env');
    await put(web, '.env.production');
    await put(web, '.git/HEAD');

    const staged = await stageDirectory(web);
    created.push(staged);

    expect((await files(staged)).sort()).toEqual(['package.json', 'src/main.tsx']);
  });

  it.each([
    'node_modules',
    '.git',
    '.nx',
    'dist',
    '.env',
    '.env.local',
    'a.test.ts',
    'a.tsbuildinfo',
  ])('excludes %s', (name) => {
    expect(isExcluded(name)).toBe(true);
  });

  it.each(['src', 'package.json', 'environment.ts', 'tsconfig.json', 'latest.ts'])(
    'keeps %s',
    (name) => {
      expect(isExcluded(name)).toBe(false);
    },
  );

  it('re-exports the package function at the upload root, and refuses a package without one', async () => {
    const source = await workspace();
    await put(source, 'packages/gateway/src/api/index.ts', 'export default 1;');

    await expect(
      assertStageable(source, 'packages/gateway', { functionEntry: true }),
    ).resolves.toBe(undefined);
    await expect(assertStageable(source, 'apps/runner', { functionEntry: true })).rejects.toThrow(
      /apps[\\/]runner[\\/]src[\\/]api[\\/]index\.ts does not exist.*Nothing was run/u,
    );

    const staged = await stagePlatform(source, 'packages/gateway');
    created.push(staged);
    await writeFunctionEntry(staged, 'packages/gateway');
    expect(await readFile(path.join(staged, VERCEL_FUNCTION_ENTRY), 'utf8')).toBe(
      "export { default } from '../packages/gateway/dist/api/index.js';\n",
    );
    // Vercel is given JavaScript only: no TypeScript for its own compile to skip.
    expect(await files(path.join(staged, 'api'))).toEqual(['index.js']);
    await expect(writeFunctionEntry(staged, 'packages/core')).rejects.toThrow(/does not exist/u);
  });

  it('puts every function the rendered settings name, and the control plane package, under the effective root', async () => {
    const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
    const profile = defaultProfile({ cloud: 'vercel', projectName: 'a' });
    const settings = (contents: string | undefined) =>
      JSON.parse(contents ?? 'null') as { functions?: Record<string, unknown> };
    const parts = renderVercelPartSettings(profile);
    const rendered = (fileName: string) =>
      settings(parts.find((part) => part.fileName === fileName)?.contents);
    // The effective root is the upload root, or the Root Directory `aw deploy` sets (apps/web).
    const cases = [
      ['packages/gateway', '', rendered('gateway.json'), true],
      ['apps/runner', '', rendered('manager.json'), true],
      ['apps/web', 'apps/web', settings(renderVercelProject(profile)?.contents), false],
    ] as const;
    for (const [directory, rootDirectory, config, isFunction] of cases) {
      const staged = await stagePlatform(checkout, directory);
      created.push(staged);
      if (isFunction) await writeFunctionEntry(staged, directory);
      const root = path.join(staged, rootDirectory);
      for (const pattern of Object.keys(config.functions ?? {})) {
        expect((await stat(path.join(root, pattern))).isFile()).toBe(true);
      }
      expect(Object.keys(config.functions ?? {}).length > 0).toBe(isFunction);
      if (!isFunction) {
        const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        expect(Object.keys(manifest.dependencies ?? {})).toContain('next');
      }
    }
  }, 60_000);

  it.each(['packages/gateway', 'apps/runner'])(
    'builds %s after the scoped install and resolves the generated entry to the default export',
    async (directory) => {
      const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
      const staged = await stagePlatform(checkout, directory);
      created.push(staged);
      await writeFunctionEntry(staged, directory);
      const run = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { cwd: staged, encoding: 'utf8' });
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
      };
      // The rendered install and build, offline: a store missing a package fails here, never skips.
      const installed = run('pnpm', [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--filter',
        `{./${directory}}...`,
      ]);
      expect(installed.status, installed.output).toBe(0);
      const built = run('pnpm', ['--filter', `{./${directory}}...`, 'run', 'build']);
      expect(built.status, built.output).toBe(0);

      // What Vercel bundles is `api/index.js`; it must load and hand over the package's function.
      const entry = pathToFileURL(path.join(staged, VERCEL_FUNCTION_ENTRY)).href;
      const loaded = run('node', [
        '--input-type=module',
        '-e',
        `const { default: handler } = await import(${JSON.stringify(entry)}); if (handler === undefined) process.exit(3);`,
      ]);
      expect(loaded.status, loaded.output).toBe(0);
    },
    180_000,
  );

  it('builds the control plane dependencies after its scoped install, so every workspace import of apps/web resolves to a built file', async () => {
    const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
    const staged = await stagePlatform(checkout, 'apps/web');
    created.push(staged);
    const rendered = JSON.parse(
      renderVercelProject(defaultProfile({ cloud: 'vercel', projectName: 'a' }))?.contents ??
        'null',
    ) as { installCommand: string; buildCommand: string };
    // Vercel runs both in the Root Directory. Offline: a store missing a package fails, never skips.
    const root = path.join(staged, 'apps', 'web');
    const run = (command: string, args: string[], environment: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const installed = run('sh', ['-c', rendered.installCommand], { npm_config_offline: 'true' });
    expect(installed.status, installed.output).toBe(0);
    // The dependencies' build, not `next build`, which is the part after the last `&&`.
    const dependencies = rendered.buildCommand.split(' && ').slice(0, -1).join(' && ');
    const built = run('sh', ['-c', dependencies]);
    expect(built.status, built.output).toBe(0);

    const specifiers = new Set<string>();
    for (const file of await files(root)) {
      // What `next build` bundles: the sources, not installed packages or tests.
      if (!/\.tsx?$/u.test(file) || /(?:^|\/)node_modules\//u.test(file)) continue;
      if (/\.test\.tsx?$/u.test(file)) continue;
      const source = await readFile(path.join(root, file), 'utf8');
      for (const [, specifier] of source.matchAll(/['"](@agent-workspace\/[^'"\s]+)['"]/gu)) {
        if (specifier !== undefined) specifiers.add(specifier);
      }
    }
    expect(
      [...specifiers].some((specifier) => specifier.startsWith('@agent-workspace/engine')),
    ).toBe(true);
    const probe = path.join(root, 'resolve-probe.mjs');
    await writeFile(
      probe,
      `import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const missing = [];
for (const specifier of ${JSON.stringify([...specifiers])}) {
  try {
    if (!existsSync(fileURLToPath(import.meta.resolve(specifier)))) missing.push(specifier + ' (not built)');
  } catch {
    missing.push(specifier + ' (not resolvable)');
  }
}
console.log(JSON.stringify(missing));
`,
    );
    const resolved = run('node', [probe]);
    expect(resolved.status, resolved.output).toBe(0);
    expect(JSON.parse(resolved.output) as string[]).toEqual([]);
  }, 600_000);

  it('keeps the real checkout, for each part, far below 5000 files and free of node_modules and .git', async () => {
    const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
    for (const directory of ['packages/gateway', 'apps/runner', 'apps/web']) {
      const staged = await stagePlatform(checkout, directory);
      created.push(staged);
      const uploaded = await files(staged);
      expect(uploaded.filter((entry) => /(^|\/)(node_modules|\.git)\//u.test(entry))).toEqual([]);
      expect(uploaded).toContain(`${directory}/package.json`);
      expect(uploaded).toContain('pnpm-lock.yaml');
      expect(uploaded.length).toBeLessThan(2500);
    }
  }, 60_000);
});
