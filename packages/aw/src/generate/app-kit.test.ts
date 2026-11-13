import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';
import {
  appKitEnvironment,
  appKitPackages,
  resolveAppKit,
  resourceTableSql,
  runAppKit,
} from './app-kit.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function projectWithKit(manifest: Record<string, unknown>, bin?: string): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  const kit = path.join(root, 'node_modules', '@indx-workspace', 'app');
  await mkdir(kit, { recursive: true });
  await writeFile(path.join(kit, 'package.json'), JSON.stringify(manifest));
  if (bin !== undefined) await writeFile(path.join(kit, 'bin.js'), bin);
  return root;
}

const KIT = { name: '@indx-workspace/app', version: AW_VERSION, bin: { 'aw-app': './bin.js' } };

function options(cwd: string, env: Record<string, string | undefined> = {}) {
  return { cwd, env, signal: new AbortController().signal };
}

describe('resolveAppKit', () => {
  it('finds the aw-app bin of the app kit the project installed at aw’s version', async () => {
    const root = await projectWithKit(KIT, '');
    const nested = path.join(root, 'app', 'api');
    await mkdir(nested, { recursive: true });

    const resolved = await resolveAppKit(nested);

    expect(resolved.version).toBe(AW_VERSION);
    expect(path.basename(resolved.binPath)).toBe('bin.js');
  });

  it('refuses a missing app kit as app_kit_not_installed, with npm install', async () => {
    const root = await tempDirectory();
    temporary.push(root);

    await expect(resolveAppKit(root)).rejects.toThrow(
      /^app_kit_not_installed: @indx-workspace\/app is not installed/u,
    );
    await expect(resolveAppKit(root)).rejects.toMatchObject({ fix: 'npm install' });
  });

  it('refuses a version-mismatched app kit as app_kit_not_installed', async () => {
    const root = await projectWithKit({ ...KIT, version: '0.0.1' }, '');

    await expect(resolveAppKit(root)).rejects.toMatchObject({
      message: `app_kit_not_installed: @indx-workspace/app 0.0.1 is installed, but aw ${AW_VERSION} needs @indx-workspace/app ${AW_VERSION}`,
      fix: 'npm install',
    });
  });

  it('refuses a package without the bin, one whose bin is missing, and one whose bin leaves it', async () => {
    const noBin = await projectWithKit({ name: KIT.name, version: AW_VERSION });
    const missing = await projectWithKit(KIT);
    const outside = await projectWithKit({ ...KIT, bin: { 'aw-app': './escape.js' } });
    const kit = path.join(outside, 'node_modules', '@indx-workspace', 'app');
    await writeFile(path.join(outside, 'elsewhere.js'), '');
    await symlink(path.join(outside, 'elsewhere.js'), path.join(kit, 'escape.js'));

    for (const root of [noBin, missing, outside]) {
      await expect(resolveAppKit(root)).rejects.toThrow(/^app_kit_not_installed: /u);
    }
  });
});

describe('runAppKit', () => {
  it('passes only the allowlisted environment to the bin', async () => {
    const root = await projectWithKit(
      KIT,
      'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));',
    );
    const { binPath } = await resolveAppKit(root);

    const run = await runAppKit(
      binPath,
      [],
      options(root, {
        PATH: '/usr/bin',
        AGENT_WORKSPACE_API_KEY: 'ak_live_secret',
        ANTHROPIC_API_KEY: 'sk-secret',
        NODE_OPTIONS: '--require ./evil.js',
      }),
    );

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as string[]).filter((name) => name !== 'PWD')).toEqual(['PATH']);
  });

  it('keeps the allowlist by upper-case name and drops undefined values', () => {
    expect(appKitEnvironment({ Path: 'C:\\bin', TEMP: undefined, SECRET: 'x' })).toEqual({
      Path: 'C:\\bin',
    });
  });
});

describe('resourceTableSql', () => {
  it('answers what aw-app sql printed', async () => {
    const root = await projectWithKit(
      KIT,
      "process.stdout.write(process.argv.slice(2, 4).join(' ') + ' ' + JSON.parse(process.argv[5]).name);",
    );

    expect(await resourceTableSql('desk', { name: 'ticket', fields: [] }, options(root))).toBe(
      'sql --app ticket',
    );
  });

  it('refuses with the reason the bin printed', async () => {
    const root = await projectWithKit(
      KIT,
      "process.stderr.write('error: the resource spec is refused\\n'); process.exitCode = 1;",
    );

    await expect(
      resourceTableSql('desk', { name: 'ticket', fields: [] }, options(root)),
    ).rejects.toThrow('aw-app sql could not write the migration: the resource spec is refused');
  });
});

describe('appKitPackages', () => {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));

  async function manifest(relative: string): Promise<Record<string, Record<string, string>>> {
    return JSON.parse(await readFile(path.join(repository, relative), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
  }

  it('pins the versions this repository builds and tests the app kit with', async () => {
    const app = await manifest('packages/app/package.json');
    const web = await manifest('apps/web/package.json');
    const root = await manifest('package.json');
    const pins = Object.fromEntries(appKitPackages().map((pin) => [pin.name, pin.version]));

    expect(pins).toEqual({
      '@indx-workspace/app': app['version'],
      'drizzle-orm': app['devDependencies']?.['drizzle-orm'],
      next: web['dependencies']?.['next'],
      pg: app['devDependencies']?.['pg'],
      react: app['devDependencies']?.['react'],
      'react-dom': app['devDependencies']?.['react-dom'],
      'dependency-cruiser': root['devDependencies']?.['dependency-cruiser'],
    });
  });
});
