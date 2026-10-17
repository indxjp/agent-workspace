/* global AbortSignal, fetch */
/**
 * Pack, verify and smoke-test the npm packages this repository publishes (issue #246, ADR-0082).
 *
 *   node scripts/release/pack-packages.mjs [--out <dir>] [--smoke] [--expect-tag <tag>]
 *   node scripts/release/pack-packages.mjs [--out <dir>] --packages <name,name,...>
 *
 * Run it after `pnpm build`. It packs `contracts`, `platforms`, `sdk`, `react`, `aw`, `cli`, `embedded` and `create` with
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
 * smoke always pack all eight. An unknown option fails the run. Prints the tarball paths, one per
 * line, in publish order, and nothing else on stdout.
 */
import { fork, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
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
 * The parent variables a smoke consumer inherits, compared case-insensitively (Windows spells
 * `Path`): where programs, the home and temporary directories are, the locale, and how to reach
 * the registry. Everything else stays behind, so a CI credential (the OIDC request token, a cache
 * or S3 secret) never reaches `npm install`, `npm rebuild` of a third-party install script, or the
 * runtime with its registry-resolved transitive dependencies. The embedded launcher sets every
 * variable the runtime reads itself.
 */
const INHERITED_VARIABLES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'TZ',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * The environment every smoke command runs with: only the parent variables
 * {@link INHERITED_VARIABLES} names, and the `LC_*` locale variables.
 * @param {NodeJS.ProcessEnv} parent
 * @returns {Record<string, string>}
 */
export function consumerEnvironment(parent) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (INHERITED_VARIABLES.has(upper) || upper.startsWith('LC_')) environment[key] = value;
  }
  return environment;
}

/**
 * The environment the boot smoke forks the embedded runtime with: {@link consumerEnvironment},
 * plus the gateway and runner ports.
 * @param {NodeJS.ProcessEnv} parent
 * @param {{ gateway: number, runner: number }} ports
 * @returns {Record<string, string>}
 */
export function runtimeEnvironment(parent, ports) {
  return {
    ...consumerEnvironment(parent),
    GATEWAY_PORT: String(ports.gateway),
    RUNNER_PORT: String(ports.runner),
  };
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
 * Every `@indx-workspace/*` module specifier the given documents import, in any of the forms
 * `import { x } from '…'`, `import '…'` and `import('…')`.
 * @param {readonly string[]} documents
 * @returns {string[]}
 */
export function importedSpecifiers(documents) {
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(?\s*)['"](@indx-workspace\/[a-z-]+(?:\/[a-z-]+)*)['"]/gu;
  /** @type {Set<string>} */
  const specifiers = new Set();
  for (const document of documents) {
    for (const match of document.matchAll(pattern)) specifiers.add(match[1] ?? '');
  }
  return [...specifiers].sort();
}

/**
 * The records of a pax extended header body: `<length> <key>=<value>\n`, where `length` counts
 * the bytes of the whole record. A malformed record fails, because a misread header would name the
 * next entry wrongly and the checks would scan it under the wrong path.
 * @param {Buffer} body
 * @returns {Map<string, string>}
 */
function paxRecords(body) {
  /** @type {Map<string, string>} */
  const records = new Map();
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const space = body.indexOf(0x20, offset);
    const lengthText = space < 0 ? '' : body.subarray(offset, space).toString('utf8');
    const length = /^[1-9]\d*$/u.test(lengthText) ? Number.parseInt(lengthText, 10) : 0;
    if (length === 0 || offset + length > body.length || body[offset + length - 1] !== 0x0a) {
      throw new Error(`a pax extended header holds a malformed record at byte ${offset}`);
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error(`a pax extended header record has no key: ${record}`);
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/** The tar entry types that hold a regular file: `0`, the pre-POSIX empty type, and contiguous `7`. */
const REGULAR_FILE_TYPES = new Set(['0', '', '7']);

/**
 * The entries of an uncompressed tar archive, with the contents of the ones `keep` selects. A
 * ustar name is `prefix/name`; a pax extended header (`x`) `path` record or a GNU long name (`L`)
 * overrides the name of the entry that follows it, and a pax `size` record its size, so an entry
 * whose path does not fit the ustar fields (a deep `dist/web/` path) is named and scanned by its
 * real path. A pax global header (`g`) and a GNU long link name (`K`) name no file. Every other
 * entry is named in `names`; one that is not a regular file (a hard or symbolic link, a directory,
 * a device) is also named in `special`, so the checks refuse it rather than miss it.
 * @param {Buffer} archive
 * @param {(name: string) => boolean} keep
 */
export function readTar(archive, keep) {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const special = [];
  /** @type {Map<string, Buffer>} */
  const contents = new Map();
  /** @type {{ path?: string, size?: number }} */
  let next = {};
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (/** @type {number} */ start, /** @type {number} */ length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/su, '');
    const prefix = field(345, 155);
    const headerName = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const headerSize = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const body = offset + 512;
    if (type === 'x' || type === 'L') {
      const bytes = archive.subarray(body, body + headerSize);
      if (type === 'L') next = { ...next, path: bytes.toString('utf8').replace(/\0.*$/su, '') };
      else {
        const records = paxRecords(bytes);
        const paxPath = records.get('path');
        const paxSize = records.get('size');
        if (paxPath !== undefined) next = { ...next, path: paxPath };
        if (paxSize !== undefined) {
          if (!/^\d+$/u.test(paxSize)) throw new Error(`a pax size record is ${paxSize}`);
          next = { ...next, size: Number.parseInt(paxSize, 10) };
        }
      }
      offset = body + Math.ceil(headerSize / 512) * 512;
      continue;
    }
    const size = type === 'g' || type === 'K' ? headerSize : (next.size ?? headerSize);
    if (type !== 'g' && type !== 'K') {
      const name = next.path ?? headerName;
      next = {};
      names.push(name);
      if (REGULAR_FILE_TYPES.has(type)) {
        if (keep(name)) contents.set(name, archive.subarray(body, body + size));
      } else {
        special.push(name);
      }
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return { names, contents, special };
}

/** What `cmd.exe` passes through unquoted: no space and no character it or the CRT interprets. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/u;

/**
 * One `cmd.exe` command line for a `.cmd` shim such as `npm` or `pnpm`, each argument quoted when
 * it needs it (a path with a space). A quoted argument keeps its backslashes, doubled at its end so
 * the closing quote is not escaped. An argument holding a double quote, `%`, `!` or a line break is
 * refused, because `cmd.exe` expands or ends on those even inside quotes.
 * @param {string} command @param {readonly string[]} args
 * @returns {string}
 */
export function windowsCommandLine(command, args) {
  return [command, ...args]
    .map((argument) => {
      if (PLAIN_ARGUMENT.test(argument)) return argument;
      if (argument === '' || /["%!\r\n]/u.test(argument)) {
        throw new Error(`cannot pass ${JSON.stringify(argument)} through cmd.exe`);
      }
      return `"${argument.replace(/(\\+)$/u, '$1$1')}"`;
    })
    .join(' ');
}

/**
 * @param {string} command @param {readonly string[]} args @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, input?: string }} [options]
 */
function run(command, args, cwd, options = {}) {
  // On Windows `npm`, `npx` and a `pnpm` found on PATH are `.cmd` shims only a shell runs.
  const viaShell = process.platform === 'win32' && !path.isAbsolute(command);
  const spawnOptions = { cwd, encoding: /** @type {const} */ ('utf8'), ...options };
  const result = viaShell
    ? spawnSync(windowsCommandLine(command, args), { ...spawnOptions, shell: true })
    : spawnSync(command, args, spawnOptions);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout;
}

/**
 * {@link run} in a smoke consumer, with {@link consumerEnvironment} unless `options.env` is given
 * (built from it too): what runs there is registry-resolved third-party code.
 * @param {string} command @param {readonly string[]} args @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, input?: string }} [options]
 */
function runInConsumer(command, args, cwd, options = {}) {
  return run(command, args, cwd, { env: consumerEnvironment(process.env), ...options });
}

/** `pnpm`, the one that runs this script when it is a package script, else the one on PATH. */
function pnpmCommand() {
  const execPath = process.env['npm_execpath'];
  if (execPath === undefined || !/pnpm/u.test(execPath)) return { command: 'pnpm', prefix: [] };
  // pnpm is either a JavaScript entry point node runs, or `@pnpm/exe`'s native binary.
  return /\.[cm]?js$/u.test(execPath)
    ? { command: process.execPath, prefix: [execPath] }
    : { command: execPath, prefix: [] };
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

/** @param {string} directory @returns {Promise<string[]>} */
async function siteDocuments(directory) {
  /** @type {string[]} */
  const documents = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      documents.push(await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
    }
  }
  return documents;
}

const CONSUMER_SOURCE = `import '@indx-workspace/react/styles.css';
import { createClient, ApiProblemError } from '@indx-workspace/sdk';
import { fetchDouble, fixtures, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { RunResourceSchema, type RunResource } from '@indx-workspace/contracts/runs';

const run: RunResource = fixtures.run({ status: 'completed' });
const api = fetchDouble((request: RecordedRequest) => jsonResponse(200, { run: RunResourceSchema.parse(run) }, { 'x-request': request.method }));
const aw = createClient({ baseUrl: 'https://aw.example.com', auth: { kind: 'api-key', apiKey: 'k' }, fetch: api.fetch });
const settled: Promise<RunResource> = aw.runs.get(run.id);
export const checks: readonly unknown[] = [settled, ApiProblemError, fixtures.agent().name, fixtures.session().status];
`;

/**
 * Type-check a strict consumer against the installed packages' published declarations. TypeScript
 * is imported here, not at the top, so `publish-packages.mjs`, which imports this module, runs in
 * the publish job with no `node_modules`.
 */
async function typecheckConsumer(/** @type {string} */ consumer) {
  const { default: ts } = await import('typescript');
  const file = path.join(consumer, 'consumer.ts');
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (/** @type {string} */ name) => name,
      getCurrentDirectory: () => consumer,
      getNewLine: () => '\n',
    };
    throw new Error(
      `the consumer does not type-check:\n${ts.formatDiagnostics(diagnostics, host)}`,
    );
  }
}

/** A digest reference no registry is asked about: the generator accepts it without a network. */
const OFFLINE_DIGEST = (/** @type {string} */ image, /** @type {number} */ n) =>
  `registry.invalid/${image}@sha256:${String(n).repeat(64)}`;

/**
 * The `npm create @indx-workspace <directory> ...args` runs of the smoke, each with the exact
 * dependencies its generated `package.json` must declare at the release version. The flags follow
 * npm's `--`, so they reach the bin: before it, npm would take `--yes` as its own and drop it.
 *
 * - `generated`: `-- --cloud local`, the v1 Compose project, whose four answers are the defaults without a person.
 * - `v2`: `-- --yes --no-install`, the default v2 project with the recommended answers (S1-16); the smoke installs from the tarballs itself.
 *   Besides the three packages it pins the default engine's (#691), which `enginePackages` names:
 *   the smoke reads them from the `ENGINE_PACKAGES` of the SDK it installed from its tarball.
 * @type {ReadonlyArray<Readonly<{ directory: string, args: readonly string[], dependencies: (version: string, enginePackages: Readonly<Record<string, string>>) => Record<string, string> }>>}
 */
export const CREATE_SMOKE_CASES = Object.freeze([
  Object.freeze({
    directory: 'generated',
    args: Object.freeze(['--offline', '--', '--cloud', 'local']),
    dependencies: (/** @type {string} */ version) => ({ '@indx-workspace/cli': version }),
  }),
  Object.freeze({
    directory: 'v2',
    args: Object.freeze(['--offline', '--', '--yes', '--no-install']),
    dependencies: (
      /** @type {string} */ version,
      /** @type {Readonly<Record<string, string>>} */ enginePackages,
    ) => ({
      '@indx-workspace/aw': version,
      '@indx-workspace/embedded': version,
      '@indx-workspace/sdk': version,
      ...enginePackages,
    }),
  }),
]);

/**
 * Every problem with a `package.json` that `npm create` wrote: text that is not a JSON object,
 * `dependencies` that are not exactly `expected` (compared as sorted entries, so the key order the
 * generator writes does not matter, but an extra, a missing or a different version does), and a
 * `workspace:` specifier or an `@agent-workspace/` name anywhere in the text.
 * @param {string} text @param {Readonly<Record<string, string>>} expected
 * @returns {string[]}
 */
export function checkCreatedManifest(text, expected) {
  /** @type {string[]} */
  const problems = [];
  if (text.includes('workspace:')) problems.push('keeps a workspace: specifier');
  if (text.includes(FOREIGN_SCOPE)) problems.push(`names ${FOREIGN_SCOPE}`);
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [...problems, 'is not JSON'];
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [...problems, 'is not a JSON object'];
  }
  const dependencies = /** @type {Record<string, unknown>} */ (manifest)['dependencies'];
  const sorted = (/** @type {object} */ value) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    sorted(dependencies) !== sorted(expected)
  ) {
    problems.push(
      `dependencies are ${JSON.stringify(dependencies)}, not exactly ${JSON.stringify(expected)}`,
    );
  }
  return problems;
}

/**
 * Run every {@link CREATE_SMOKE_CASES} entry in `consumer`, where the tarballs are installed,
 * without the network: npm runs the installed `@indx-workspace/create`, every image override is a
 * digest reference (so nothing is resolved from a registry), and no person is there (stdin is
 * empty, so every v1 answer is the default, and the v2 run relies on `--yes`). Each generated `package.json` must
 * pass {@link checkCreatedManifest} with its case's dependencies at the release version.
 * @param {string} consumer @param {string} version
 */
function smokeCreate(consumer, version) {
  // The default engine's packages as the SDK installed from its tarball names them, read by a
  // child Node in `consumer` so the specifier resolves there.
  const printed = runInConsumer(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project'; " +
        "process.stdout.write(JSON.stringify(ENGINE_PACKAGES['claude-agent-sdk']));",
    ],
    consumer,
  );
  const defaultEnginePackages = /** @type {Record<string, string>} */ (JSON.parse(printed));
  const images = ['web', 'gateway', 'runner', 'runtime', 'postgres', 'seaweedfs'];
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...consumerEnvironment(process.env),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  images.forEach((image, index) => {
    env[`AW_${image.toUpperCase()}_IMAGE`] = OFFLINE_DIGEST(image, index + 1);
  });
  for (const { directory, args, dependencies } of CREATE_SMOKE_CASES) {
    runInConsumer('npm', ['create', '@indx-workspace', directory, ...args], consumer, {
      env,
      input: '',
    });
    const text = readFileSync(path.join(consumer, directory, 'package.json'), 'utf8');
    const problems = checkCreatedManifest(text, dependencies(version, defaultEnginePackages));
    if (problems.length > 0) {
      throw new Error(
        `npm create @indx-workspace ${directory} ${args.join(' ')} wrote a package.json that ${problems.join('; ')}:\n${text}`,
      );
    }
  }
}

/**
 * The module that imports every specifier, as a customer would. A specifier whose export target is
 * a JSON file (`@indx-workspace/embedded/package.json`) is imported with `{ type: 'json' }`: Node
 * refuses a JSON module without the attribute (`ERR_IMPORT_ATTRIBUTE_MISSING`). A specifier whose
 * target is a stylesheet (`@indx-workspace/react/styles.css`) cannot be imported at all
 * (`ERR_UNKNOWN_FILE_EXTENSION`): it is resolved inside the install and must be a non-empty file.
 * @param {Iterable<string>} specifiers
 * @param {ReadonlySet<string>} jsonSpecifiers
 * @param {ReadonlySet<string>} [cssSpecifiers]
 * @returns {string}
 */
export function resolveProbe(specifiers, jsonSpecifiers, cssSpecifiers = new Set()) {
  const lines = [...specifiers].map((specifier) => {
    const name = JSON.stringify(specifier);
    if (cssSpecifiers.has(specifier)) {
      return `if (readFileSync(fileURLToPath(import.meta.resolve(${name}))).length === 0) throw new Error(${JSON.stringify(`${specifier} is empty`)});`;
    }
    return jsonSpecifiers.has(specifier)
      ? `await import(${name}, { with: { type: 'json' } });`
      : `await import(${name});`;
  });
  const head = cssSpecifiers.size
    ? "import { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n"
    : '';
  return `${head}${lines.join('\n')}\n`;
}

/**
 * Install the tarballs into an empty project and use them the way a customer would.
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 * @param {string} version
 */
async function smoke(packed, version) {
  const consumer = await mkdtemp(path.join(tmpdir(), 'indx-workspace-consumer-'));
  try {
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const { tarball, manifest } of packed) {
      const relative = path.relative(consumer, tarball).split(path.sep).join('/');
      dependencies[String(manifest['name'])] = `file:${relative}`;
    }
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        private: true,
        type: 'module',
        dependencies,
        overrides: dependencies,
      }),
    );
    runInConsumer('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], consumer);

    const specifiers = new Set(
      importedSpecifiers(await siteDocuments(path.join(ROOT, 'docs/sdk/site'))),
    );
    /** @type {Set<string>} */
    const jsonSpecifiers = new Set();
    /** @type {Set<string>} */
    const cssSpecifiers = new Set();
    for (const { manifest } of packed) {
      const exportsMap = /** @type {Record<string, unknown>} */ (manifest['exports'] ?? {});
      for (const [key, target] of Object.entries(exportsMap)) {
        const specifier =
          key === '.' ? String(manifest['name']) : `${String(manifest['name'])}/${key.slice(2)}`;
        specifiers.add(specifier);
        // A stylesheet export is `{ types, default }`, so a strict consumer can import it.
        const file =
          typeof target === 'object' && target !== null
            ? /** @type {Record<string, unknown>} */ (target)['default']
            : target;
        if (typeof file === 'string' && file.endsWith('.json')) jsonSpecifiers.add(specifier);
        if (typeof file === 'string' && file.endsWith('.css')) cssSpecifiers.add(specifier);
      }
    }
    await writeFile(
      path.join(consumer, 'resolve.mjs'),
      resolveProbe(specifiers, jsonSpecifiers, cssSpecifiers),
    );
    runInConsumer(process.execPath, ['resolve.mjs'], consumer);

    await writeFile(path.join(consumer, 'consumer.ts'), CONSUMER_SOURCE);
    await typecheckConsumer(consumer);

    const printed = runInConsumer('npx', ['--no-install', 'aw', '--version'], consumer);
    const expected = `aw ${version} (contracts ${version})`;
    if (printed.trim() !== expected)
      throw new Error(`npx aw --version printed ${printed}, not ${expected}`);

    const operatorVersion = runInConsumer(
      'npx',
      ['--no-install', 'agent-workspace', '--version'],
      consumer,
    );
    const operatorExpected = `agent-workspace ${version} (contracts ${version})`;
    if (operatorVersion.trim() !== operatorExpected) {
      throw new Error(
        `npx agent-workspace --version printed ${operatorVersion}, not ${operatorExpected}`,
      );
    }

    const help = runInConsumer('npx', ['--no-install', 'agent-workspace', '--help'], consumer);
    if (!help.startsWith('Usage: agent-workspace start|stop|validate')) {
      throw new Error(`npx agent-workspace --help printed ${help}`);
    }
    smokeCreate(consumer, version);
    return [...specifiers].sort();
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

/** How long the embedded runtime may take to send `ready` and then `credential`. */
const BOOT_TIMEOUT_MS = 240_000;
/** How long the embedded runtime may take to exit after SIGINT. */
const STOP_TIMEOUT_MS = 60_000;
/** The embedded PostgreSQL port the launcher always uses (ADR-0109). */
const EMBEDDED_DATABASE_PORT = 25432;

/**
 * @typedef {{ type: 'ready', url: string, contractsVersion: string }
 *   | { type: 'credential', token: string, expiresAt: string, workspaceId: string, workspaceSlug: string }
 *   | { type: 'failed', message: string }} ChildMessage
 * @typedef {{ kind: 'launch', path: string }
 *   | { kind: 'checked', id: number, valid: true, message: ChildMessage }
 *   | { kind: 'checked', id: number, valid: false }} CheckerReply
 */

/**
 * The message checker the boot smoke forks inside its consumer. It imports
 * `LocalRuntimeChildMessageSchema` from the installed `@indx-workspace/contracts` tarball and
 * resolves `@indx-workspace/embedded/launch`, so both are found by Node's own resolution from the
 * consumer (`aw dev` reads the same `./launch` export from the installed `package.json`,
 * ADR-0109). It is written into the consumer as text, like `resolve.mjs`: a resolver built here on
 * a computed path would be a module reference the §42 boundary gate (tests/no-sdk-import.test.ts,
 * ADR-0031) cannot decide, and it refuses one.
 */
const BOOT_CHECKER_SOURCE = `import { createRequire } from 'node:module';
import process from 'node:process';
import { LocalRuntimeChildMessageSchema } from '@indx-workspace/contracts/local-runtime';

const require = createRequire(import.meta.url);
process.send({ kind: 'launch', path: require.resolve('@indx-workspace/embedded/launch') });
process.on('message', ({ id, message }) => {
  const parsed = LocalRuntimeChildMessageSchema.safeParse(message);
  process.send(
    parsed.success
      ? { kind: 'checked', id, valid: true, message: parsed.data }
      : { kind: 'checked', id, valid: false },
  );
});
`;

/**
 * Whether a message from the checker has the shape {@link BOOT_CHECKER_SOURCE} sends. The message
 * of a valid reply has already passed the installed contracts' schema.
 * @param {unknown} value
 * @returns {value is CheckerReply}
 */
function isCheckerReply(value) {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind === 'launch') return 'path' in value && typeof value.path === 'string';
  return (
    value.kind === 'checked' &&
    'id' in value &&
    typeof value.id === 'number' &&
    'valid' in value &&
    typeof value.valid === 'boolean' &&
    (value.valid === false ||
      ('message' in value && typeof value.message === 'object' && value.message !== null))
  );
}

/** Distinct free loopback ports, held open together so no two are the same. */
async function freePorts(/** @type {number} */ count) {
  /** @type {import('node:net').Server[]} */
  const servers = [];
  try {
    /** @type {number[]} */
    const ports = [];
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(undefined));
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no loopback port');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))),
    );
  }
}

/**
 * Boot the embedded runtime from its tarball, as `aw dev` starts it, and use it: a consumer
 * installs `@indx-workspace/embedded` and `@indx-workspace/contracts` without install scripts,
 * rebuilds the `@embedded-postgres/*` binary packages by name, and forks the resolved
 * `@indx-workspace/embedded/launch`. Every message must pass the installed contracts'
 * `LocalRuntimeChildMessageSchema`, so the published protocol is proved across two published
 * packages; `ready` and then `credential` must arrive, `GET /api/me` with the credential must answer
 * 200, and SIGINT (on Windows, closing the IPC channel) must end the runtime with exit code 0. The
 * token is never printed: it is redacted from every failure message.
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 * @param {string} version
 */
async function bootSmoke(packed, version) {
  const consumer = await mkdtemp(path.join(tmpdir(), 'indx-workspace-boot-'));
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let checker;
  /** @type {Promise<void>} */
  let exited = Promise.resolve();
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exit = null;
  try {
    /** @type {Record<string, string>} */
    const overrides = {};
    for (const { tarball, manifest } of packed) {
      const relative = path.relative(consumer, tarball).split(path.sep).join('/');
      overrides[String(manifest['name'])] = `file:${relative}`;
    }
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const name of ['@indx-workspace/embedded', '@indx-workspace/contracts']) {
      const specifier = overrides[name];
      if (specifier === undefined) throw new Error(`the boot smoke needs the ${name} tarball`);
      dependencies[name] = specifier;
    }
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        name: 'boot-consumer',
        private: true,
        type: 'module',
        dependencies,
        overrides,
      }),
    );
    runInConsumer('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], consumer);
    const binaries = path.join(consumer, 'node_modules', '@embedded-postgres');
    const platformPackages = existsSync(binaries)
      ? (await readdir(binaries, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => `@embedded-postgres/${entry.name}`)
      : [];
    if (platformPackages.length === 0) {
      throw new Error(
        'the boot smoke installed no @embedded-postgres/* package for this platform: the embedded runtime has no PostgreSQL binary',
      );
    }
    runInConsumer('npm', ['rebuild', ...platformPackages], consumer);

    /** @type {ChildMessage[]} */
    const messages = [];
    let invalidMessages = 0;
    let output = '';
    /** @type {Error | undefined} */
    let spawnError;
    let checkerOutput = '';
    /** @type {string | undefined} */
    let checkerGone;
    /** @type {Set<() => void>} */
    const waiters = new Set();
    const notify = () => {
      for (const waiter of waiters) waiter();
    };

    const checkerFile = path.join(consumer, 'check-messages.mjs');
    await writeFile(checkerFile, BOOT_CHECKER_SOURCE);
    const messageChecker = fork(checkerFile, [], {
      cwd: consumer,
      env: consumerEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    checker = messageChecker;
    messageChecker.stdout?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      checkerOutput += chunk;
    });
    messageChecker.stderr?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      checkerOutput += chunk;
    });
    /** @type {(path: string) => void} */
    let launchResolved = () => undefined;
    /** @type {Promise<string>} */
    const launchPath = new Promise((resolve) => {
      launchResolved = resolve;
    });
    messageChecker.on('message', (/** @type {unknown} */ reply) => {
      if (!isCheckerReply(reply)) {
        checkerGone = `the message checker sent ${JSON.stringify(reply).slice(0, 200)}`;
      } else if (reply.kind === 'launch') {
        launchResolved(reply.path);
      } else if (reply.valid) {
        messages.push(reply.message);
      } else {
        invalidMessages += 1;
      }
      notify();
    });
    messageChecker.once('exit', (code, signal) => {
      checkerGone ??=
        `the message checker exited ${JSON.stringify({ code, signal })}: ` +
        checkerOutput.slice(-2000);
      notify();
    });
    const launch = await Promise.race([
      launchPath,
      new Promise((_resolve, reject) => {
        const failed = () => {
          if (checkerGone === undefined) return;
          waiters.delete(failed);
          reject(new Error(`boot smoke: ${checkerGone}`));
        };
        waiters.add(failed);
        failed();
      }),
    ]);
    if (typeof launch !== 'string') throw new Error('boot smoke: no launch module was resolved');
    const [gateway = 0, runner = 0, web = 0] = await freePorts(3);
    let nextCheck = 0;
    /** @param {() => boolean} condition @param {number} timeoutMs @param {string} what */
    const until = (condition, timeoutMs, what) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!condition()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(undefined);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });

    const runtime = fork(launch, [], {
      cwd: consumer,
      env: runtimeEnvironment(process.env, { gateway, runner }),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    child = runtime;
    runtime.stdout?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      output += chunk;
    });
    runtime.stderr?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      output += chunk;
    });
    // IPC keeps order in both directions, so the checker's replies arrive in the order the runtime
    // sent the messages they check.
    runtime.on('message', (/** @type {unknown} */ message) => {
      nextCheck += 1;
      messageChecker.send({ id: nextCheck, message });
    });
    runtime.on('error', (error) => {
      spawnError = error;
      notify();
    });
    exited = new Promise((resolve) => {
      runtime.once('exit', (code, signal) => {
        exit = { code, signal };
        notify();
        resolve();
      });
    });

    /** @type {string | undefined} */
    let token;
    /** What the runtime printed, the token redacted, for a failure message. */
    const printed = () => {
      const tail = output.slice(-4000);
      return token === undefined ? tail : tail.split(token).join('[token]');
    };
    const refuse = (/** @type {string} */ reason) =>
      new Error(
        `boot smoke: ${reason}` +
          (exit === null ? '' : `; the runtime exited ${JSON.stringify(exit)}`) +
          `\n${printed()}`,
      );
    // An exit counts once every message sent before it has been checked, so a `failed` the runtime
    // sent just before exiting is reported rather than the bare exit.
    const checked = () => messages.length + invalidMessages === nextCheck;
    const settled = () =>
      invalidMessages > 0 ||
      (exit !== null && checked()) ||
      spawnError !== undefined ||
      checkerGone !== undefined;
    const refuseFailures = () => {
      if (spawnError !== undefined)
        throw refuse(`the runtime did not start: ${spawnError.message}`);
      if (checkerGone !== undefined) throw refuse(checkerGone);
      if (invalidMessages > 0) {
        throw refuse('the runtime sent a message LocalRuntimeChildMessageSchema refuses');
      }
      const failed = messages.find((message) => message.type === 'failed');
      if (failed?.type === 'failed') {
        const collision = failed.message.includes(String(EMBEDDED_DATABASE_PORT))
          ? ` The embedded PostgreSQL port ${String(EMBEDDED_DATABASE_PORT)} is taken: stop the ` +
            'other embedded runtime on this host (pnpm start:embedded, aw dev) and run again.'
          : '';
        throw refuse(`the runtime sent failed: ${failed.message}.${collision}`);
      }
    };

    const start = {
      type: 'start',
      projectDir: consumer,
      environment: { port: web, runtimeDriver: 'local', bootstrapAdmin: 'admin@localhost.test' },
    };
    await new Promise((resolve, reject) => {
      runtime.send(start, (error) => (error === null ? resolve(undefined) : reject(error)));
    });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    await until(() => settled() || messages.length >= 1, remaining(), 'ready');
    refuseFailures();
    const [ready] = messages;
    if (ready?.type !== 'ready') {
      throw refuse(`expected ready first, got [${messages.map(({ type }) => type).join(', ')}]`);
    }
    if (ready.contractsVersion !== version) {
      throw refuse(`the runtime reports contracts ${ready.contractsVersion}, not ${version}`);
    }
    process.stderr.write('smoke: embedded ready\n');

    await until(() => settled() || messages.length >= 2, remaining(), 'credential');
    refuseFailures();
    const credential = messages[1];
    if (credential?.type !== 'credential') {
      throw refuse(
        `expected credential after ready, got [${messages.map(({ type }) => type).join(', ')}]`,
      );
    }
    token = credential.token;
    process.stderr.write('smoke: credential received\n');

    const response = await fetch(new URL('/api/me', ready.url), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (response.status !== 200) {
      throw refuse(
        `GET /api/me answered ${String(response.status)}: ${body.slice(0, 500).split(token).join('[token]')}`,
      );
    }
    process.stderr.write('smoke: /api/me 200\n');

    // Windows cannot deliver SIGINT to a child (`kill` terminates it outright), so there the IPC
    // channel is closed instead, the other shutdown trigger the launcher handles the same way.
    if (process.platform === 'win32') runtime.disconnect();
    else runtime.kill('SIGINT');
    try {
      await until(() => exit !== null, STOP_TIMEOUT_MS, 'the runtime to exit after SIGINT');
    } catch (error) {
      runtime.kill('SIGKILL');
      throw refuse(error instanceof Error ? error.message : String(error));
    }
    const stopped = /** @type {{ code: number | null, signal: string | null } | null} */ (exit);
    if (stopped?.code !== 0) throw refuse('the runtime did not exit 0 after SIGINT');
  } finally {
    if (child !== undefined && exit === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    if (checker !== undefined && checker.exitCode === null && checker.signalCode === null) {
      const checkerExited = new Promise((resolve) => checker?.once('exit', resolve));
      checker.kill('SIGKILL');
      await Promise.race([checkerExited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    await rm(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
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
