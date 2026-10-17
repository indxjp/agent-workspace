/**
 * The build test of ADR-0109's local runtime package. It reads what
 * `pnpm --filter @indx-workspace/embedded build` wrote (the Nx `test` target depends on `build`)
 * and fails, never skips, when that output is missing.
 *
 * The first three groups are S1-10's feasibility gate: no private workspace scope anywhere in the
 * bundle, the web build or the packed tarball, and the tarball's packed and unpacked sizes logged
 * for the size budget (ADR-0016: measured, not invented).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  checkDistContents,
  checkPackedManifest,
  checkTarballEntries,
  readTar,
} from '../../../scripts/release/pack-packages.mjs';
import { BUNDLE_ENTRY_REFUSAL } from './launch.js';
import {
  EMBEDDED_NEXT_DIST_DIR,
  NEXT_STANDALONE_CONFIG_ENV,
  standaloneNextConfig,
} from './next-config.js';
import { packageNameOf, readWebpackServerExternals } from './packaging/externals.ts';
import { resolveInstalledPackage } from './packaging/staging.ts';

const FOREIGN_SCOPE = '@agent-workspace/';
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(packageDirectory, 'dist');
const publish = path.join(packageDirectory, 'publish');
const nextDist = path.join(dist, 'web', EMBEDDED_NEXT_DIST_DIR);

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Every module specifier a bundle loads: static `import … from`, bare `import '…'` and `import()`. */
function specifiersOf(source: string): string[] {
  const pattern =
    /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gmu;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/** The `pnpm` that runs this suite (`npm_execpath`), or the one on PATH through a shell. */
function pnpm(args: readonly string[], cwd: string): string {
  const execPath = process.env['npm_execpath'];
  const viaNode = execPath !== undefined && /pnpm/u.test(execPath) && /\.[cm]?js$/u.test(execPath);
  const native = execPath !== undefined && /pnpm/u.test(execPath) && !viaNode;
  const result = viaNode
    ? spawnSync(process.execPath, [execPath, ...args], { cwd, encoding: 'utf8' })
    : native
      ? spawnSync(execPath, [...args], { cwd, encoding: 'utf8' })
      : spawnSync(['pnpm', ...args].join(' '), {
          cwd,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed in ${cwd}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const packedManifestSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
});

/** `dist/launch.js` and the chunks it splits into (`dist/chunks/*.js`). */
function bundleFiles(): string[] {
  return [path.join(dist, 'launch.js'), ...filesUnder(path.join(dist, 'chunks'))];
}

beforeAll(() => {
  const missing = ['launch.js', 'bin.js', 'web', 'migrations']
    .map((output) => path.join(dist, output))
    .concat(path.join(publish, 'package.json'))
    .filter((output) => !existsSync(output));
  if (missing.length > 0) {
    throw new Error(
      `run pnpm --filter @indx-workspace/embedded build first; missing: ${missing.join(', ')}`,
    );
  }
});

describe('the built runtime names no private workspace package', () => {
  it('holds no @agent-workspace/ string in the bundle, its chunks, dist/bin.js, dist/web/** or the vendored dist/node_modules/**', () => {
    const scanned = [
      ...bundleFiles(),
      path.join(dist, 'bin.js'),
      ...filesUnder(path.join(dist, 'web')),
      ...filesUnder(path.join(dist, 'node_modules')),
    ];
    const leaks = scanned
      .filter((file) => readFileSync(file).includes(FOREIGN_SCOPE))
      .map((file) => path.relative(packageDirectory, file));
    expect(leaks).toStrictEqual([]);
  });

  it('keeps dist/bin.js to one module import, ./launch.js, besides Node builtins', () => {
    const bin = readFileSync(path.join(dist, 'bin.js'), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imports = specifiersOf(bin).filter((specifier) => !specifier.startsWith('node:'));
    expect(imports).toStrictEqual(['./launch.js']);
  });

  it('refuses to run dist/launch.js directly, at once and without starting a server', () => {
    const run = spawnSync(process.execPath, [path.join(dist, 'launch.js')], {
      cwd: packageDirectory,
      encoding: 'utf8',
      // A server would keep the process alive; the refusal exits before anything listens.
      timeout: 30_000,
      env: { ...process.env, DATABASE_URL: 'postgresql://refused.invalid/none' },
    });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(BUNDLE_ENTRY_REFUSAL);
  }, 60_000);
});

/** The package names under dist/node_modules: what the runtime carries itself. */
function vendoredNames(): string[] {
  const directory = path.join(dist, 'node_modules');
  return readdirSync(directory).flatMap((name) =>
    name.startsWith('@')
      ? readdirSync(path.join(directory, name)).map((inner) => name + '/' + inner)
      : [name],
  );
}

describe('the staging manifest', () => {
  const vendored = vendoredNames();
  const manifest = packedManifestSchema.parse(
    JSON.parse(readFileSync(path.join(publish, 'package.json'), 'utf8')),
  );
  // An optional peer is staged like a dependency; npm only leaves it out unless the project names it.
  const dependencies = [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ];

  it('vendors next, react and react-dom in dist/node_modules instead of depending on them', () => {
    for (const name of ['next', 'react', 'react-dom']) {
      expect(existsSync(path.join(dist, 'node_modules', name, 'package.json'))).toBe(true);
    }
    expect(vendored.filter((name) => dependencies.includes(name))).toStrictEqual([]);
    // Neither the compiler nor the image optimiser ships: both are native binaries of one platform.
    expect(
      vendored.filter(
        (name) => name.startsWith('@next/swc') || name === 'sharp' || name.startsWith('@img/'),
      ),
    ).toStrictEqual([]);
  });

  it('makes no package both a dependency and an optional peer', () => {
    expect(
      Object.keys(manifest.peerDependencies).filter((name) => name in manifest.dependencies),
    ).toStrictEqual([]);
  });

  it('has a dependency or peer for every external import, and none nothing imports', async () => {
    const bundleImports = bundleFiles()
      .flatMap((file) => specifiersOf(readFileSync(file, 'utf8')))
      .map((specifier) => packageNameOf(specifier))
      .filter((name): name is string => name !== undefined);
    const imported = new Set([...bundleImports, ...(await readWebpackServerExternals(nextDist))]);
    expect(
      [...imported].filter((name) => !dependencies.includes(name) && !vendored.includes(name)),
    ).toStrictEqual([]);

    // …and names nothing else: an entry is imported, or a required peer or pinned-family
    // dependency of an imported entry.
    const peers = new Set<string>();
    const queue = [...imported];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const installed = resolveInstalledPackage(name, path.join(packageDirectory, 'package.json'));
      for (const next of [
        ...(installed?.requiredPeers ?? []),
        ...(installed?.familyDependencies ?? []),
      ]) {
        if (!peers.has(next)) {
          peers.add(next);
          queue.push(next);
        }
      }
    }
    expect(dependencies.filter((name) => !imported.has(name) && !peers.has(name))).toStrictEqual(
      [],
    );
  });
});

describe('the packed tarball', () => {
  let out = '';
  let tarball = '';
  let entries: readonly string[] = [];
  let contents: ReadonlyMap<string, Buffer> = new Map();

  beforeAll(() => {
    out = mkdtempSync(path.join(tmpdir(), 'embedded-pack-'));
    pnpm(['pack', '--pack-destination', out], publish);
    const [file] = readdirSync(out).filter((name) => name.endsWith('.tgz'));
    if (file === undefined) throw new Error(`pnpm pack wrote no tarball into ${out}`);
    tarball = path.join(out, file);
    const archive = readTar(gunzipSync(readFileSync(tarball)), () => true);
    entries = archive.names;
    contents = archive.contents;
  }, 120_000);

  afterAll(() => {
    if (out !== '') rmSync(out, { recursive: true, force: true });
  });

  it('passes the release checks of scripts/release/pack-packages.mjs', () => {
    const packed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(contents.get('package/package.json')?.toString('utf8') ?? 'null'));
    expect(checkTarballEntries(entries)).toStrictEqual([]);
    expect(checkPackedManifest(packed, CONTRACTS_VERSION)).toStrictEqual([]);
    expect(checkDistContents(contents)).toStrictEqual([]);
    expect(packed).not.toHaveProperty('devDependencies');
  });

  it('carries the wrapper, the bundle, the web build, vendored Next, the migrations and the manifests only', () => {
    const allowed =
      /^package\/(?:dist\/(?:bin\.js|launch\.js|chunks\/[\w-]+\.js|node_modules\/.+|web\/.+|migrations\/.+)|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/u;
    expect(entries.filter((entry) => !allowed.test(entry))).toStrictEqual([]);
    expect(entries.filter((entry) => entry.endsWith('.map'))).toStrictEqual([]);
    for (const required of ['dist/bin.js', 'dist/launch.js', 'package.json', 'README.md']) {
      expect(entries).toContain(`package/${required}`);
    }
    expect(entries).toContain('package/LICENSE');
    expect(entries).toContain('package/CHANGELOG.md');
  });

  it('holds no @agent-workspace/ string in any entry, and logs its sizes', () => {
    const leaks = [...contents]
      .filter(([, bytes]) => bytes.includes(FOREIGN_SCOPE))
      .map(([entry]) => entry);
    const unpacked = [...contents.values()].reduce((total, bytes) => total + bytes.length, 0);
    console.log(
      `@indx-workspace/embedded tarball: ${String(statSync(tarball).size)} bytes packed, ` +
        `${String(unpacked)} bytes unpacked in ${String(entries.length)} entries`,
    );
    expect(leaks).toStrictEqual([]);
  });
});

/**
 * The child that serves `dist/web` with the vendored Next: it resolves `next` from a chunk of the
 * bundle, as the runtime does, so the workspace's own `next` cannot stand in for a missing file.
 */
const SERVE_WITH_VENDORED_NEXT = `
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const [chunk, dir, asset] = process.argv.slice(1);
const resolved = createRequire(chunk).resolve('next/dist/server/next.js');
const { default: next } = await import(pathToFileURL(resolved).href);
const app = next({ dev: false, dir, hostname: '127.0.0.1', port: 0, customServer: true });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => void handle(request, response));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const results = { resolved };
for (const route of [asset, '/signin']) {
  const response = await fetch(origin + route, { redirect: 'manual' });
  results[route] = { status: response.status, body: (await response.text()).slice(0, 64) };
}
process.stdout.write('RESULT ' + JSON.stringify(results) + '\\n');
process.exit(0);
`;

const servedSchema = z.looseObject({
  resolved: z.string(),
  '/signin': z.object({ status: z.number(), body: z.string() }),
});

describe('dist/web serves as a production Next app on the vendored Next', () => {
  it('resolves next from dist/node_modules, prepares from dist/web and renders a page', () => {
    const asset = readdirSync(path.join(nextDist, 'static', 'chunks')).find((name) =>
      name.endsWith('.js'),
    );
    expect(asset).toBeDefined();
    const route = `/_next/static/chunks/${asset ?? ''}`;
    const [chunk] = filesUnder(path.join(dist, 'chunks'));
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        SERVE_WITH_VENDORED_NEXT,
        chunk ?? '',
        path.join(dist, 'web'),
        route,
      ],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          [NEXT_STANDALONE_CONFIG_ENV]: standaloneNextConfig(path.join(dist, 'web')),
          SESSION_SECRET: 'embedded-bundle-test-session-secret-0123456789',
        },
      },
    );
    const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT '));
    expect(line, run.stderr).toBeDefined();
    const results = servedSchema.parse(JSON.parse(line?.slice('RESULT '.length) ?? 'null'));
    expect(path.relative(path.join(dist, 'node_modules'), results.resolved)).toBe(
      path.join('next', 'dist', 'server', 'next.js'),
    );
    expect(z.object({ status: z.number() }).parse(results[route]).status).toBe(200);
    expect(results['/signin'].status).toBe(200);
    expect(results['/signin'].body).toContain('<html');
  }, 120_000);
});
