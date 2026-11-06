#!/usr/bin/env node
/* global console */
/**
 * The Generated cell of the apps benchmark (issue #1531): an example app under `examples/<id>` is
 * exactly what its command script generates, for every file `aw-generated.json` records.
 *
 *   pnpm build && node tests/apps/regenerate.mjs --check <id>
 *   pnpm build && node tests/apps/regenerate.mjs --write <id>
 *
 * 1. Pack the published `@indx-workspace` packages (`scripts/release/pack-packages.mjs`) and install
 *    them into an empty consumer from `file:`, so `create` is the one a developer gets from npm.
 * 2. Run `examples/<id>/commands.sh` in a new temporary directory with an `npm` shim first on
 *    `PATH`. The shim turns `npm create @indx-workspace <dir> -- <args>` into the packed `create`
 *    with `--yes --no-install --no-start`, points the new project's `pnpm-workspace.yaml` at the
 *    tarballs (`withPackedOverrides`) and installs it; every other `npm` command is npm's own.
 *    `npx aw generate …` then runs the project's own installed `aw`.
 * 3. Compare every file every manifest entry records, and the manifest itself, with
 *    `examples/<id>`. `--check` exits non-zero naming each file that differs or is missing;
 *    `--write` copies them over and leaves every file the manifest does not record alone. Both
 *    leave out the generated files the app's `benchmark.ts` lists as `takenOver` (they count
 *    as handwritten), but never the manifest, whose hashes still catch a generator that changed one.
 *
 * Two things are normalised, and nothing else: the tarball overrides step 2 appends to
 * `pnpm-workspace.yaml` (they are not part of what a developer gets), and, for `--check`, the
 * lock-step `@indx-workspace/*` version (a release bumps it in every example's `package.json`
 * and so in the manifest's hashes; the example keeps the version it was written at until it is
 * written again).
 *
 * It needs `npm`, `pnpm` and network access to the npm registry. `APPS_WORK_DIR` names the work
 * directory (default: a new temporary directory, kept when the run fails).
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { packPackages } from '../app-kit/run.mjs';
import { run } from '../generated-project/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(ROOT, 'examples');
const MANIFEST_FILE = 'aw-generated.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const SCOPE = '@indx-workspace/';

/**
 * The command line: `--check <id>` or `--write <id>`, the id a directory under `examples/`.
 *
 * @param {readonly string[]} argv
 * @returns {{ mode: 'check' | 'write', id: string }}
 */
export function parseRegenerateArgs(argv) {
  const [flag, id, ...rest] = argv;
  if ((flag !== '--check' && flag !== '--write') || id === undefined || rest.length > 0) {
    throw new Error('usage: node tests/apps/regenerate.mjs --check <id> | --write <id>');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`${id} is not an example id`);
  return { mode: flag === '--check' ? 'check' : 'write', id };
}

/** The line that starts the tarball overrides, so they are told apart from the project's own. */
export const PACKED_OVERRIDES_MARK =
  '# tests/apps/regenerate.mjs: the packed @indx-workspace tarballs, not part of the example';

/**
 * `pnpm-workspace.yaml` with every `@indx-workspace/*` package overridden by its packed tarball,
 * after {@link PACKED_OVERRIDES_MARK}: appended to the project's own `overrides:` (the template
 * writes its security overrides there, last), or as a new `overrides:` block. The generated-project
 * E2E's `withTarballOverrides` refuses a file that has overrides already, which a v2 project
 * now does.
 *
 * @param {string} workspaceYaml @param {Readonly<Record<string, string>>} tarballs
 */
export function withPackedOverrides(workspaceYaml, tarballs) {
  const entries = Object.entries(tarballs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, file]) => `  '${name}': 'file:${file.split(path.sep).join('/')}'`)
    .join('\n');
  const body = workspaceYaml.trimEnd();
  const at = body.search(/^overrides:$/mu);
  if (at === -1) return `${body}\n${PACKED_OVERRIDES_MARK}\noverrides:\n${entries}\n`;
  const after = body.slice(at).split('\n').slice(1);
  if (after.some((line) => line !== '' && !line.startsWith(' ') && !line.startsWith('#'))) {
    throw new Error('the generated pnpm-workspace.yaml has a block after its overrides');
  }
  return `${body}\n  ${PACKED_OVERRIDES_MARK}\n${entries}\n`;
}

/**
 * `pnpm-workspace.yaml` as `create` wrote it: without what {@link withPackedOverrides} added.
 *
 * @param {string} text
 */
export function withoutPackedOverrides(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === PACKED_OVERRIDES_MARK);
  return at === -1 ? text : `${lines.slice(0, at).join('\n')}\n`;
}

/**
 * `text` with every `@indx-workspace/*` pin at `from` moved to `to`: the pins of `package.json`
 * and the package edits `aw-generated.json` records as escaped JSON.
 *
 * @param {string} text @param {string} from @param {string} to
 */
export function withScopeVersion(text, from, to) {
  if (from === to) return text;
  const version = from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const plain = new RegExp(`("@indx-workspace/[a-z-]+":\\s*)"${version}"`, 'gu');
  const escaped = new RegExp(`(\\\\"@indx-workspace/[a-z-]+\\\\":\\\\")${version}(\\\\")`, 'gu');
  return text.replace(plain, `$1"${to}"`).replace(escaped, `$1${to}$2`);
}

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The `@indx-workspace/*` version a project's `package.json` pins, `undefined` when it pins none.
 *
 * @param {string | undefined} packageJson
 */
export function scopeVersionOf(packageJson) {
  if (packageJson === undefined) return undefined;
  const manifest = JSON.parse(packageJson);
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith(SCOPE) && typeof spec === 'string') return spec;
    }
  }
  return undefined;
}

/**
 * The generated files as they compare with an example at version `to`: each file's text with
 * {@link withScopeVersion} applied, and the manifest's hash of every file that changed replaced
 * by the hash of its new text.
 *
 * @param {ReadonlyMap<string, string>} files path to text, the manifest included
 * @param {string} from @param {string | undefined} to
 * @returns {Map<string, string>}
 */
export function atScopeVersion(files, from, to) {
  if (to === undefined || to === from) return new Map(files);
  const moved = new Map();
  let manifest = files.get(MANIFEST_FILE) ?? '';
  for (const [file, text] of files) {
    if (file === MANIFEST_FILE) continue;
    const next = withScopeVersion(text, from, to);
    if (next !== text) manifest = manifest.replaceAll(`"${sha256(text)}"`, `"${sha256(next)}"`);
    moved.set(file, next);
  }
  moved.set(MANIFEST_FILE, withScopeVersion(manifest, from, to));
  return moved;
}

/**
 * Every path the manifest's entries record, and the manifest itself, sorted.
 *
 * @param {string} manifestText
 */
export function recordedPaths(manifestText) {
  /** @type {{ entries: Record<string, { files: Record<string, string> }> }} */
  const manifest = JSON.parse(manifestText);
  const paths = new Set([MANIFEST_FILE]);
  for (const entry of Object.values(manifest.entries)) {
    for (const file of Object.keys(entry.files)) paths.add(file);
  }
  return [...paths].sort();
}

/**
 * The files of `generated` that the example at `exampleDir` does not hold byte for byte, except
 * the ones it has taken over (its benchmark's `takenOver`: generated files edited into its own code).
 * The manifest is never left out, so a generator that writes one of those files differently still
 * shows as a changed `aw-generated.json`.
 *
 * @param {ReadonlyMap<string, string>} generated @param {string} exampleDir
 * @param {readonly string[]} [takenOver]
 * @returns {string[]}
 */
export function differingFiles(generated, exampleDir, takenOver = []) {
  return [...generated].flatMap(([file, text]) => {
    if (file !== MANIFEST_FILE && takenOver.includes(file)) return [];
    const target = path.join(exampleDir, file);
    if (!existsSync(target)) return [`${file} (missing)`];
    return readFileSync(target, 'utf8') === text ? [] : [file];
  });
}

/**
 * The `npm` shim `commands.sh` runs with: `create` goes to the packed one, the rest to npm.
 *
 * @param {{ create: string, npm: string, workspaceTarballs: string }} options
 */
function npmShim({ create, npm, workspaceTarballs }) {
  return `// Written by tests/apps/regenerate.mjs; not part of an example.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { withPackedOverrides } from ${JSON.stringify(fileURLToPath(import.meta.url))};

const args = process.argv.slice(2);
const pass = (command, argv, cwd) => {
  const result = spawnSync(command, argv, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (args[0] !== 'create' || args[1] !== '@indx-workspace') {
  pass(${JSON.stringify(npm)}, args, process.cwd());
  process.exit(0);
}
const [dir, separator, ...rest] = args.slice(2);
if (dir === undefined || (separator !== undefined && separator !== '--')) {
  console.error('the shim takes npm create @indx-workspace <dir> -- <args>');
  process.exit(2);
}
const flags = ['--yes', '--no-install', '--no-start'].filter((flag) => !rest.includes(flag));
pass(process.execPath, [${JSON.stringify(create)}, dir, ...rest, ...flags], process.cwd());
const project = path.resolve(dir);
const workspace = path.join(project, 'pnpm-workspace.yaml');
const tarballs = JSON.parse(readFileSync(${JSON.stringify(workspaceTarballs)}, 'utf8'));
writeFileSync(workspace, withPackedOverrides(readFileSync(workspace, 'utf8'), tarballs));
pass('pnpm', ['install', '--no-frozen-lockfile'], project);
`;
}

/** @param {string} work @param {Record<string, string>} tarballs */
function installCreate(work, tarballs) {
  const consumer = path.join(work, 'consumer');
  mkdirSync(consumer, { recursive: true });
  const specs = Object.fromEntries(
    Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
  );
  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'consumer', private: true, dependencies: specs, overrides: specs }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer, timeoutMs: 900_000 });
  return path.join(consumer, 'node_modules/@indx-workspace/create/dist/index.js');
}

/**
 * Run the example's command script in `work` and read back every file the manifest records. The
 * packages are packed into `work/packs` unless `tarballs` names them already (the apps lane packs
 * once for every app).
 *
 * @param {string} id @param {string} work @param {Record<string, string>} [tarballs]
 * @returns {{ files: Map<string, string>, version: string }}
 */
export function regenerate(id, work, tarballs) {
  const script = path.join(EXAMPLES, id, 'commands.sh');
  if (!existsSync(script)) throw new Error(`examples/${id}/commands.sh does not exist`);
  if (tarballs === undefined) {
    console.log(`== packing the @indx-workspace packages into ${work}/packs`);
    return regenerate(id, work, packPackages(path.join(work, 'packs')));
  }
  const create = installCreate(work, tarballs);
  const bin = path.join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const workspaceTarballs = path.join(work, 'tarballs.json');
  writeFileSync(workspaceTarballs, JSON.stringify(tarballs));
  const npm = run('sh', ['-c', 'command -v npm']).trim();
  const shim = path.join(work, 'npm-shim.mjs');
  writeFileSync(shim, npmShim({ create, npm, workspaceTarballs }));
  const launcher = path.join(bin, 'npm');
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(shim)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  const project = path.join(work, 'project');
  mkdirSync(project, { recursive: true });
  console.log(`== running examples/${id}/commands.sh`);
  run('sh', [script], {
    cwd: project,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
    timeoutMs: 1_800_000,
  });
  const appDir = path.join(project, id);
  const manifestText = readFileSync(path.join(appDir, MANIFEST_FILE), 'utf8');
  const files = new Map();
  for (const file of recordedPaths(manifestText)) {
    const text = readFileSync(path.join(appDir, file), 'utf8');
    files.set(file, file === WORKSPACE_FILE ? withoutPackedOverrides(text) : text);
  }
  const version = scopeVersionOf(files.get('package.json'));
  if (version === undefined) throw new Error('the generated package.json pins no @indx-workspace');
  return { files, version };
}

/**
 * The files of a regeneration that `examples/<id>` does not hold, at the example's own lock-step
 * version ({@link atScopeVersion}), its `takenOver` files aside: what `--check` reports.
 *
 * @param {string} id @param {{ files: ReadonlyMap<string, string>, version: string }} generated
 * @param {readonly string[]} [takenOver]
 */
export function differingFromExample(id, generated, takenOver = []) {
  const exampleDir = path.join(EXAMPLES, id);
  const pinned = existsSync(path.join(exampleDir, 'package.json'))
    ? scopeVersionOf(readFileSync(path.join(exampleDir, 'package.json'), 'utf8'))
    : undefined;
  return differingFiles(
    atScopeVersion(generated.files, generated.version, pinned),
    exampleDir,
    takenOver,
  );
}

/**
 * The generated files the registered app `id` has taken over (none for an app not registered).
 *
 * @param {string} id
 * @returns {Promise<readonly string[]>}
 */
async function takenOverBy(id) {
  const { loadExampleApps } = await import('./registry.ts');
  const app = loadExampleApps().find(
    (/** @type {any} */ candidate) => candidate.benchmark.id === id,
  );
  return app?.benchmark.takenOver ?? [];
}

async function main() {
  const { mode, id } = parseRegenerateArgs(process.argv.slice(2));
  const takenOver = await takenOverBy(id);
  const exampleDir = path.join(EXAMPLES, id);
  const keep = process.env['APPS_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['APPS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), `apps-${id}-`)),
  );
  const generated = regenerate(id, work);
  if (mode === 'write') {
    for (const [file, text] of generated.files) {
      if (takenOver.includes(file)) continue;
      mkdirSync(path.dirname(path.join(exampleDir, file)), { recursive: true });
      writeFileSync(path.join(exampleDir, file), text);
    }
    const kept = takenOver.length === 0 ? '' : ` (left its taken-over ${takenOver.join(', ')})`;
    console.log(
      `== wrote ${String(generated.files.size - takenOver.length)} files to examples/${id}${kept}`,
    );
  } else {
    const differing = differingFromExample(id, generated, takenOver);
    if (differing.length > 0) {
      console.error(
        `examples/${id} differs from what commands.sh generates:\n${differing.map((file) => `  ${file}`).join('\n')}\n` +
          `run node tests/apps/regenerate.mjs --write ${id} after a generator change, and keep your own code in files the generators did not write (or list a generated file you made your own in its benchmark's takenOver)`,
      );
      console.error(`the regenerated project is kept at ${work}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `== examples/${id} is what commands.sh generates (${String(generated.files.size)} files)`,
    );
  }
  if (!keep) rmSync(work, { recursive: true, force: true });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
