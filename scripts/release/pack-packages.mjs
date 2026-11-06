import { bootSmoke } from './boot-smoke.mjs';
import { pnpmCommand, run } from './consumer-process.mjs';
import { smoke } from './package-smoke.mjs';
import { readTar } from './package-tar.mjs';
export {
  consumerEnvironment,
  runtimeEnvironment,
  windowsCommandLine,
} from './consumer-process.mjs';
export {
  checkCreatedManifest,
  CREATE_SMOKE_CASES,
  importedSpecifiers,
  resolveProbe,
} from './package-smoke.mjs';
export { readTar } from './package-tar.mjs';
/**
 * Pack, verify and smoke-test the npm packages this repository publishes (issue #246, ADR-0082).
 *
 *   node scripts/release/pack-packages.mjs [--out <dir>] [--smoke] [--expect-tag <tag>]
 *   node scripts/release/pack-packages.mjs [--out <dir>] --packages <name,name,...>
 *
 * Run it after `pnpm build`. It packs `contracts`, `platforms`, `sdk`, `react`, `app`, `aw`, `cli`, `embedded` and `create` with
 * `pnpm pack`, which applies each manifest's `publishConfig` and turns `workspace:*` into the exact
 * sibling version. `embedded` packs from its generated staging directory `packages/embedded/publish`
 * (`PACK_DIRECTORIES`), whose manifest names third-party externals only, because its build inlines
 * every workspace member (ADR-0109); a missing staging directory fails the run, never skips it.
 * Every tarball is then refused when it:
 *
 * - carries anything but `dist/` (without source maps), the manifests (`package.json`,
 *   `README.md`, `LICENSE`, `CHANGELOG.md`), and, for `cli` alone, the generator's `templates/`,
 *   the profile's JSON Schema under `schema/` and the gcp-cloudrun Terraform module under `modules/`;
 * - is not named `@indx-workspace/*`, is `private`, or is not at `CONTRACTS_VERSION` (lock-step);
 * - names `@agent-workspace/*` anywhere in its manifest or in any `dist/` or `templates/` file,
 *   keeps a `workspace:` specifier, or depends on a sibling at any version but its own;
 * - points an `exports`, `types` or `bin` target outside `dist/`, or ships a bin without a shebang.
 *   The one exception is `@indx-workspace/embedded`'s self-export
 *   `"./package.json": "./package.json"`: `aw dev` reads `@indx-workspace/embedded/package.json`
 *   to check the embedded runtime's version (ADR-0109). Every other package keeps the rule.
 *
 * `--smoke` then installs the tarballs into an empty consumer project from `file:` (no registry
 * holds them), imports every subpath each manifest exports and every one the developer site
 * imports, type-checks a strict consumer of `@indx-workspace/sdk/testing`, runs `npx aw --version`,
 * `npx agent-workspace --version` and `npx agent-workspace --help`, and runs
 * `npm create @indx-workspace` offline once per `CREATE_SMOKE_CASES` entry: `-- --cloud local`
 * writes the v1 Compose project, whose `package.json` must depend on `@indx-workspace/cli` at the
 * release version and on nothing else, and `-- --yes` writes the default v2 project, whose
 * `package.json` must depend on exactly `@indx-workspace/aw`, `embedded` and `sdk` at the release
 * version (`checkCreatedManifest`). The flags follow npm's `--`, or npm would take `--yes` as its
 * own. `--expect-tag` fails
 * unless the tag is `packages-v<CONTRACTS_VERSION>`, so a release workflow cannot publish a
 * version its tag does not name.
 *
 * `--smoke` also runs the boot smoke: a second consumer installs `@indx-workspace/embedded` and
 * `@indx-workspace/contracts` from their tarballs, rebuilds the `@embedded-postgres/*` binary
 * packages by name, forks the installed `@indx-workspace/embedded/launch` (the `./launch` export
 * `aw dev` also starts), checks every message it sends against the installed contracts'
 * `LocalRuntimeChildMessageSchema`, calls `GET /api/me` with the credential it sends, and requires
 * a clean exit on SIGINT. It reports `smoke: embedded ready`, `smoke: credential received` and
 * `smoke: /api/me 200` on stderr, and never prints the token.
 *
 * Every command in a smoke consumer (`npm install`, `npm rebuild`, `npx`, `npm create`, the
 * resolve probe, the message checker) and the runtime itself run with an allowlisted environment
 * (`consumerEnvironment`): what they run is third-party code resolved from the registry, so a CI
 * credential in this process's environment (an OIDC request token, a cache or S3 secret) stays
 * behind.
 *
 * `--packages` packs a subset, in publish order, for a job that builds only some packages (the
 * generated-project E2E); it is refused with `--smoke` or `--expect-tag`, because a release and the
 * smoke always pack all nine. An unknown option fails the run. Prints the tarball paths, one per
 * line, in publish order, and nothing else on stdout.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPE = '@indx-workspace/';
const FOREIGN_SCOPE = '@agent-workspace/';
const REPOSITORY_URL = 'git+https://github.com/indxjp/agent-workspace.git';
const TAG_PREFIX = 'packages-v';

/**
 * The published packages, in publish order: each one's siblings are published before it. The
 * directory under `packages/` is the name under `@indx-workspace/`.
 */
export const PUBLISHED_PACKAGES = /** @type {const} */ ([
  'contracts',
  'platforms',
  'sdk',
  'react',
  'app',
  'aw',
  'cli',
  'embedded',
  'create',
]);

/**
 * Where a package is packed from, relative to the repository root, when it is not `packages/<name>`:
 * `embedded` packs from the staging directory its build generates, whose manifest carries the
 * whitelisted fields and the third-party externals only (ADR-0109).
 * @type {Readonly<Record<string, string>>}
 */
export const PACK_DIRECTORIES = { embedded: 'packages/embedded/publish' };

/**
 * The packages `--packages` names, validated, in publish order; every published package when
 * `value` is `undefined`. Refuses an empty list, an unknown name and a name given twice.
 * @param {string | undefined} value a comma-separated list such as `contracts,sdk`
 * @returns {string[]}
 */
export function selectPackages(value) {
  if (value === undefined) return [...PUBLISHED_PACKAGES];
  const names = value.split(',').map((name) => name.trim());
  if (names.some((name) => name === '')) {
    throw new Error(`--packages ${JSON.stringify(value)} names an empty package`);
  }
  /** @type {readonly string[]} */
  const published = PUBLISHED_PACKAGES;
  const unknown = names.filter((name) => !published.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `--packages names ${unknown.join(', ')}, not one of ${PUBLISHED_PACKAGES.join(', ')}`,
    );
  }
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) throw new Error(`--packages names ${repeated.join(', ')} twice`);
  return published.filter((name) => names.includes(name));
}

/**
 * The command line, parsed strictly: an unknown option, a positional argument, an option without
 * its value, an option given twice (the last would silently win) and an empty `--out` (it would
 * resolve to the working directory) fail. `--packages` is refused with `--smoke` or
 * `--expect-tag`, because a release and the smoke pack every published package.
 * @param {readonly string[]} argv
 * @returns {{ out: string | undefined, smoke: boolean, expectTag: string | undefined, packages: string[] }}
 */
export function parseOptions(argv) {
  const { values, tokens } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      out: { type: 'string' },
      smoke: { type: 'boolean' },
      'expect-tag': { type: 'string' },
      packages: { type: 'string' },
    },
  });
  /** @type {Set<string>} */
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} is given more than once`);
    seen.add(token.name);
  }
  if (values.out !== undefined && values.out.trim() === '') {
    throw new Error('--out names no directory');
  }
  const smoke = values.smoke === true;
  const expectTag = values['expect-tag'];
  if (values.packages !== undefined && (smoke || expectTag !== undefined)) {
    throw new Error(
      '--packages cannot be combined with --smoke or --expect-tag: a release and the smoke pack all published packages',
    );
  }
  return { out: values.out, smoke, expectTag, packages: selectPackages(values.packages) };
}

/**
 * What a package ships besides `dist/` and the manifests: the generator copies `templates/` into
 * every `local` project it writes, and `schema/` holds the JSON Schema the `$schema` line of every
 * generated profile names on unpkg (ADR-0091), and `modules/` holds the gcp-cloudrun Terraform
 * module `aw deploy` applies without `--infra` (#794).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const EXTRA_DIRECTORIES = { cli: ['templates/', 'schema/', 'modules/'] };

const MANIFEST_FILES = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);

/**
 * The files one tarball may carry. `entries` are paths inside the tarball (`package/...`).
 * @param {readonly string[]} entries
 * @param {readonly string[]} [extraDirectories] what else this package ships, e.g. `templates/`
 * @returns {string[]} one failure per offending or missing entry
 */
export function checkTarballEntries(entries, extraDirectories = []) {
  /** @type {string[]} */
  const failures = [];
  const files = entries.map((entry) => entry.replace(/^package\//u, ''));
  for (const file of files) {
    if (MANIFEST_FILES.has(file)) continue;
    if (extraDirectories.some((directory) => file.startsWith(directory))) continue;
    if (!file.startsWith('dist/')) {
      failures.push(
        `${file}: only dist/, the manifests and ${extraDirectories.join(', ') || 'nothing else'} ship`,
      );
    } else if (file.endsWith('.map')) failures.push(`${file}: source maps point at unshipped src/`);
    else if (/\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.d\.ts$/u.test(file)) {
      failures.push(`${file}: a test file must not ship`);
    }
  }
  for (const required of MANIFEST_FILES) {
    if (!files.includes(required)) failures.push(`${required}: missing from the tarball`);
  }
  if (!files.some((file) => file.startsWith('dist/'))) failures.push('dist/: nothing built ships');
  return failures;
}

/** @param {unknown} value @returns {string[]} */
function targetsOf(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap((item) => targetsOf(item));
}

/** The one `exports` entry allowed outside `dist/`: the manifest exporting itself. */
const SELF_EXPORT = './package.json';

/** The one package allowed {@link SELF_EXPORT}; every other package keeps the dist-only rule. */
const SELF_EXPORTING_PACKAGE = '@indx-workspace/embedded';

/**
 * The `exports` targets, without the manifest's self-export `"./package.json": "./package.json"`,
 * which `aw dev` reads from the installed package to check the version of the
 * embedded runtime it forks (ADR-0109). Only that exact key and string target pair is exempt: a
 * `./package.json` target under another key, or a `./package.json` key pointing anywhere else or
 * holding a condition object, is still checked, and so is every package but the embedded one.
 * @param {string} name @param {unknown} exportsField @returns {string[]}
 */
function exportTargetsOf(name, exportsField) {
  if (
    name !== SELF_EXPORTING_PACKAGE ||
    exportsField === null ||
    typeof exportsField !== 'object'
  ) {
    return targetsOf(exportsField);
  }
  return Object.entries(exportsField).flatMap(([key, value]) =>
    key === SELF_EXPORT && value === SELF_EXPORT ? [] : targetsOf(value),
  );
}

/**
 * The packed manifest, as `pnpm pack` rewrote it. Every entry target must lie under `./dist/`,
 * except the embedded package's `./package.json` self-export (see `exportTargetsOf`).
 * @param {Record<string, unknown>} manifest
 * @param {string} version the contracts version every published package carries
 * @returns {string[]}
 */
export function checkPackedManifest(manifest, version) {
  /** @type {string[]} */
  const failures = [];
  const name = String(manifest['name']);
  if (!name.startsWith(SCOPE)) failures.push(`name ${name} is not in ${SCOPE}*`);
  if (manifest['private'] === true) failures.push(`${name} is private`);
  if (manifest['version'] !== version) {
    failures.push(
      `${name} is ${String(manifest['version'])}, not the contracts version ${version}`,
    );
  }
  if (JSON.stringify(manifest).includes(FOREIGN_SCOPE)) {
    failures.push(`${name} names ${FOREIGN_SCOPE}*, a scope a third party owns on npm`);
  }
  const repository = /** @type {{ url?: unknown } | undefined} */ (manifest['repository']);
  if (repository?.url !== REPOSITORY_URL) {
    failures.push(`${name} repository.url must be ${REPOSITORY_URL} for provenance`);
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = /** @type {Record<string, unknown> | undefined} */ (manifest[field]);
    for (const [dependency, specifier] of Object.entries(dependencies ?? {})) {
      if (typeof specifier !== 'string') {
        failures.push(`${name} ${field}.${dependency} is not a string specifier`);
      } else if (specifier.startsWith('workspace:')) {
        failures.push(`${name} ${field}.${dependency} kept ${specifier}`);
      } else if (dependency.startsWith(SCOPE) && specifier !== version) {
        failures.push(`${name} ${field}.${dependency} is ${specifier}, not lock-step ${version}`);
      }
    }
  }
  const entryTargets = [
    ...exportTargetsOf(name, manifest['exports']),
    ...targetsOf(manifest['types']),
    ...targetsOf(manifest['main']),
    ...targetsOf(manifest['bin']),
  ];
  for (const target of entryTargets) {
    // Normalized as well, so `./dist/../src/x.js` cannot leave dist/ behind a matching prefix.
    if (!target.startsWith('./dist/') || !path.posix.normalize(target).startsWith('dist/')) {
      failures.push(`${name} entry ${target} is outside dist/`);
    }
  }
  return failures;
}

/** The shipped files whose contents are scanned: what runs, and what the generator copies. */
const SCANNED = /^package\/(?:dist|templates)\//u;

/**
 * The shipped files that name the third party's scope: a lazy `import()`, a type-only import in a
 * declaration file or a `require.resolve` string would resolve to its package, a template would
 * hand it to every generated project, and the smoke test only loads what it imports. `contents`
 * maps tarball entries to their bytes.
 * @param {ReadonlyMap<string, Buffer>} contents
 * @returns {string[]}
 */
export function checkDistContents(contents) {
  /** @type {string[]} */
  const failures = [];
  for (const [entry, bytes] of contents) {
    if (SCANNED.test(entry) && bytes.toString('utf8').includes(FOREIGN_SCOPE)) {
      failures.push(`${entry} names ${FOREIGN_SCOPE}*, a scope a third party owns on npm`);
    }
  }
  return failures;
}

/**
 * The file `pnpm pack` writes for a manifest, e.g. `indx-workspace-sdk-0.1.0.tgz`.
 * @param {{ name: string, version: string }} manifest
 */
export function tarballName({ name, version }) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * `CONTRACTS_VERSION`, read from the contracts manifest: `packages/aw/src/version.test.ts` pins the
 * two equal, and a manifest read needs no computed module import.
 */
async function contractsVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, 'packages/contracts/package.json'), 'utf8'),
  );
  return /** @type {string} */ (manifest.version);
}

/**
 * Every check one gzipped tarball must pass to be published at `version`: its entries, its packed
 * manifest, the third-party scope in its shipped files, and a shebang on every bin. The extra
 * directories it may ship are looked up by its own name (`@indx-workspace/<name>`). Both this
 * script, right after packing, and `publish-packages.mjs`, right before publishing, run it.
 * @param {Buffer} gzipped @param {string} version
 * @returns {{ manifest: Record<string, unknown>, failures: string[] }}
 */
export function verifyTarball(gzipped, version) {
  const { names, contents, special } = readTar(
    gunzipSync(gzipped),
    (entry) => entry === 'package/package.json' || SCANNED.test(entry),
  );
  const manifestBytes = contents.get('package/package.json');
  if (manifestBytes === undefined) {
    return { manifest: {}, failures: ['package.json: missing from the tarball'] };
  }
  /** @type {Record<string, unknown>} */
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const name = String(manifest['name']);
  const extra = name.startsWith(SCOPE) ? EXTRA_DIRECTORIES[name.slice(SCOPE.length)] : undefined;
  const failures = [
    ...special.map((entry) => `${entry}: only regular files ship, not a link or a directory`),
    ...checkTarballEntries(names, extra ?? []),
    ...checkPackedManifest(manifest, version),
    ...checkDistContents(contents),
  ];
  for (const target of targetsOf(manifest['bin'])) {
    const bin = contents.get(`package/${target.replace(/^\.\//u, '')}`);
    if (bin === undefined || !bin.toString('utf8').startsWith('#!/usr/bin/env node\n')) {
      failures.push(`${name} bin ${target} must start with #!/usr/bin/env node`);
    }
  }
  return { manifest, failures };
}

/**
 * Pack one package and verify its tarball.
 * @param {string} name the directory under `packages/` @param {string} out @param {string} version
 */
async function packAndVerify(name, out, version) {
  const directory = PACK_DIRECTORIES[name] ?? `packages/${name}`;
  const pnpm = pnpmCommand();
  const sourceManifest = path.join(ROOT, directory, 'package.json');
  if (!existsSync(sourceManifest)) {
    throw new Error(
      `${directory}/package.json is missing: run pnpm --filter @indx-workspace/${name} build first`,
    );
  }
  const source = JSON.parse(await readFile(sourceManifest, 'utf8'));
  // Named, not found by diffing the directory: a re-run into the same --out overwrites the file.
  const tarball = path.join(out, tarballName(source));
  await rm(tarball, { force: true });
  run(
    pnpm.command,
    [...pnpm.prefix, 'pack', '--pack-destination', out],
    path.join(ROOT, directory),
  );
  const { manifest, failures } = verifyTarball(await readFile(tarball), version);
  if (manifest['name'] !== `${SCOPE}${name}`) {
    failures.push(`${String(manifest['name'])} was packed from ${directory}, not ${SCOPE}${name}`);
  }
  if (failures.length > 0) {
    throw new Error(`${directory}: the tarball is not publishable:\n  ${failures.join('\n  ')}`);
  }
  return { tarball, manifest };
}

/** @param {readonly string[]} argv */
async function main(argv) {
  const options = parseOptions(argv);
  const version = await contractsVersion();
  const tag = options.expectTag;
  if (tag !== undefined && tag !== `${TAG_PREFIX}${version}`) {
    throw new Error(
      `tag ${tag} does not name the contracts version: expected ${TAG_PREFIX}${version}`,
    );
  }
  const out = path.resolve(
    options.out ?? (await mkdtemp(path.join(tmpdir(), 'indx-workspace-packs-'))),
  );
  await mkdir(out, { recursive: true });
  const packed = [];
  for (const name of options.packages) packed.push(await packAndVerify(name, out, version));
  if (options.smoke) {
    const resolved = await smoke(packed, version);
    process.stderr.write(
      `smoke passed: ${resolved.join(', ')} resolve; aw --version prints ${version}; ` +
        `agent-workspace --version prints ${version}; agent-workspace --help prints its usage; ` +
        `npm create @indx-workspace wrote a -- --cloud local project that depends on ` +
        `@indx-workspace/cli@${version} alone and a -- --yes v2 project that depends on ` +
        `@indx-workspace/aw, embedded and sdk@${version} alone\n`,
    );
    await bootSmoke(packed, version);
    process.stderr.write(
      `boot smoke passed: @indx-workspace/embedded@${version} booted from its tarball, ` +
        `answered /api/me and exited 0\n`,
    );
  }
  process.stdout.write(`${packed.map(({ tarball }) => tarball).join('\n')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
