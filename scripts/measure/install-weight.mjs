/**
 * Measure what a developer installs today (issue #691 FH-04, PR 1: no behaviour change).
 *
 *   node scripts/measure/install-weight.mjs                      # pack this checkout, publish to Verdaccio, install
 *   node scripts/measure/install-weight.mjs --from-npm [0.3.0]   # install the public packages instead
 *   [--out <file>]   default: install-weight.md in the internal delivery notes
 *
 * The fresh project depends on `@indx-workspace/aw`, `embedded` and `sdk`, the base of what
 * `npm create @indx-workspace` writes (`CREATE_SMOKE_CASES`; it adds the chosen engine's packages,
 * ADR-0139). It installs with a cold, throwaway npm cache. The Verdaccio route reuses the
 * journey's pinned image and `verdaccio.yaml`, and `pack-packages.mjs`; run it after `pnpm build`.
 * It writes package count, `node_modules` size, the top 15 dependencies by size and the install
 * wall time, plus where and how they were measured.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { publishPackages, VERDACCIO_IMAGE, waitForRegistry } from '../../tests/journey/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = path.join(
  ROOT,
  'internal',
  'developer-platform',
  'delivery',
  'install-weight.md',
);
const PROJECT_PACKAGES = ['aw', 'embedded', 'sdk'];

/** @param {number} bytes */
export function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;
}

/**
 * Sum the sizes of one name across its installed copies, then rank largest first (ties by name).
 *
 * @param {readonly { name: string, bytes: number }[]} packages @param {number} limit
 */
export function rankBySize(packages, limit) {
  /** @type {Map<string, { name: string, bytes: number, copies: number }>} */
  const byName = new Map();
  for (const { name, bytes } of packages) {
    const entry = byName.get(name) ?? { name, bytes: 0, copies: 0 };
    entry.bytes += bytes;
    entry.copies += 1;
    byName.set(name, entry);
  }
  return [...byName.values()]
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Every package copy under `nodeModules` (nested copies included) and the bytes of its own files.
 * Symlinks count as themselves, never as their target.
 *
 * @param {string} nodeModules
 * @returns {{ name: string, bytes: number }[]}
 */
export function measureTree(nodeModules) {
  /** @type {{ name: string, bytes: number }[]} */
  const found = [];
  /** @param {string} dir @returns {number} */
  const filesBytes = (dir) => {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') total += filesBytes(full);
      } else {
        total += lstatSync(full).size;
      }
    }
    return total;
  };
  /** @param {string} dir @param {string} root the closest node_modules, so a nested copy keeps its package name */
  const visit = (dir, root) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        visit(full, root);
        continue;
      }
      const name = path.relative(root, full).split(path.sep).join('/');
      found.push({ name, bytes: filesBytes(full) });
      const nested = path.join(full, 'node_modules');
      if (existsSync(nested)) visit(nested, nested);
    }
  };
  visit(nodeModules, nodeModules);
  return found;
}

/**
 * @param {{
 *   how: string, host: string, packages: readonly { name: string, bytes: number }[],
 *   seconds: number, date: string
 * }} m
 */
export function renderReport(m) {
  const total = m.packages.reduce((sum, p) => sum + p.bytes, 0);
  const rows = rankBySize(m.packages, 15).map(
    (p, i) =>
      `| ${String(i + 1)} | \`${p.name}\` | ${formatBytes(p.bytes)} | ${String(p.copies)} |`,
  );
  return [
    '# Install weight (baseline)',
    '',
    'Written by `node scripts/measure/install-weight.mjs` (issue #691, FH-04 PR 1).',
    '',
    `Measured ${m.date}. ${m.how}`,
    '',
    `Host: ${m.host}`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Packages installed (copies) | ${String(m.packages.length)} |`,
    `| \`node_modules\` size | ${formatBytes(total)} |`,
    `| \`npm install\` wall time (cold cache) | ${m.seconds.toFixed(1)} s |`,
    '',
    '## Top 15 dependencies by size',
    '',
    '| # | Package | Size | Copies |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * @param {string} command @param {readonly string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [options]
 */
function run(command, args, options = { encoding: 'utf8' }) {
  // Windows runs npm through its .cmd shim, which needs a shell; the line is quoted by hand
  // because Node warns about (and does not escape) args passed alongside `shell`.
  const windowsNpm = process.platform === 'win32' && command === 'npm';
  const result = windowsNpm
    ? spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, {
        shell: true,
        maxBuffer: 64 * 1024 * 1024,
        ...options,
      })
    : spawnSync(command, [...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Pack this checkout and publish it to a throwaway Verdaccio.
 *
 * @param {string} work
 * @returns {Promise<{ url: string, cleanup: () => void }>}
 */
async function startVerdaccio(work) {
  const name = `install-weight-${randomBytes(4).toString('hex')}`;
  const port = 4873 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${String(port)}/`;
  const utf8 = { encoding: /** @type {const} */ ('utf8') };
  run(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--publish',
      `127.0.0.1:${String(port)}:4873`,
      '--volume',
      `${path.join(ROOT, 'tests', 'journey', 'verdaccio.yaml')}:/verdaccio/conf/config.yaml:ro`,
      VERDACCIO_IMAGE,
    ],
    utf8,
  );
  const cleanup = () => {
    spawnSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' });
  };
  try {
    const deadline = Date.now() + 15 * 60_000;
    await waitForRegistry(url, deadline);
    const secrets = path.join(work, 'secrets');
    mkdirSync(secrets);
    await publishPackages(work, secrets, url, deadline);
    return { url, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  /** @param {string} flag */
  const option = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const out = option('--out') ?? DEFAULT_OUT;
  const fromNpm = argv.includes('--from-npm');
  const requested = option('--from-npm');
  const version = requested !== undefined && !requested.startsWith('--') ? requested : 'latest';
  const utf8 = { encoding: /** @type {const} */ ('utf8') };
  const work = mkdtempSync(path.join(os.tmpdir(), 'install-weight-'));
  /** @type {() => void} */
  let cleanup = () => undefined;
  try {
    const names = `@indx-workspace/{${PROJECT_PACKAGES.join(',')}}`;
    let registry = 'https://registry.npmjs.org/';
    let how = `Installed the public npm \`${names}@${version}\` into an empty project. This is the public release, not this checkout, so it is not comparable with a Verdaccio run on the journey host; PR 2 re-measures before and after on the same host.`;
    if (!fromNpm) {
      const started = await startVerdaccio(work);
      registry = started.url;
      cleanup = started.cleanup;
      const commit = run('git', ['rev-parse', '--short', 'HEAD'], { ...utf8, cwd: ROOT }).trim();
      how = `Packed this checkout (\`pack-packages.mjs\`, commit ${commit}), published it to a throwaway Verdaccio (\`tests/journey/verdaccio.yaml\`) and installed \`${names}\` from there into an empty project; third-party packages came from npmjs.`;
    }
    const project = path.join(work, 'project');
    mkdirSync(project);
    writeFileSync(
      path.join(project, 'package.json'),
      '{"name":"install-weight","private":true,"version":"0.0.0"}\n',
    );
    const started = performance.now();
    run(
      'npm',
      [
        'install',
        ...PROJECT_PACKAGES.map((p) => `@indx-workspace/${p}@${version}`),
        '--registry',
        registry,
        '--cache',
        path.join(work, 'cache'),
        '--no-audit',
        '--no-fund',
      ],
      { ...utf8, cwd: project, timeout: 900_000 },
    );
    const seconds = (performance.now() - started) / 1000;
    const packages = measureTree(path.join(project, 'node_modules'));
    const npmVersion = run('npm', ['--version'], utf8).trim();
    const host = `${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}, npm ${npmVersion}`;
    mkdirSync(path.dirname(out), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(out, renderReport({ how, host, packages, seconds, date }));
    process.stdout.write(`wrote ${out}\n`);
  } finally {
    cleanup();
    rmSync(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
