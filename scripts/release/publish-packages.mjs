/**
 * Publish the tarballs `pack-packages.mjs` printed, in that order, and confirm npm serves every one
 * (issue #246, ADR-0082). The release workflow runs it; nothing else should.
 *
 *   GITHUB_REF_NAME=packages-v<version> EXPECTED_DIGESTS="$(sha256sum *.tgz)" \
 *     NPM_PROVENANCE=false node scripts/release/publish-packages.mjs <file listing the tarballs>
 *
 * - Every tarball must be byte-for-byte one the verify job recorded in `EXPECTED_DIGESTS` before
 *   its smoke ran third-party code, and must pass again every check `pack-packages.mjs` ran after
 *   packing it (`verifyTarball`: entries, manifest, scope, shebangs), at the version the tag
 *   `GITHUB_REF_NAME` names; otherwise nothing is published.
 * - Before the first `npm publish`, every package must already have a version on npm
 *   (`npm view <name> versions --json`): trusted publishing needs a package's first version to be
 *   the Owner's manual step (docs/release/README.md), and a release refused at the fifth package
 *   would leave a partial lock-step set. A package npm has never served (E404 or no versions), or
 *   a lookup that fails any other way (network, registry error), refuses the whole release with a
 *   `ReleaseRefusedError` before anything is published; an unknown answer is never read as
 *   "known". There is no in-workflow bootstrap path: the placeholder is published by hand.
 * - The list must name exactly `PUBLISHED_PACKAGES` (contracts, platforms, sdk, react, aw, cli,
 *   embedded, create),
 *   in that order and at one version (ADR-0082 D3), or nothing is published: a sibling must be on
 *   npm before a package that depends on it, and a partial list would release a partial set.
 * - Each line is a tarball path resolved against the list file's directory, so the publish job can
 *   list basenames next to the tarballs of an artifact it downloaded.
 * - A version is skipped only when `npm view <name>@<version> version` prints exactly that version.
 *   npm prints nothing, and may still exit 0, when the package exists but the version does not; an
 *   exit status alone would skip every tarball silently.
 * - After the loop every package, all eight, must be served at its version, or the run fails: a
 *   skip or a publish that did not land is never reported as success.
 * - `NPM_PROVENANCE` is the one provenance switch: `true` publishes with `--provenance`, and is
 *   refused before anything is published unless the repository is public (npm's registry rejects a
 *   provenance bundle from a non-public repository after the CLI has already written the signed
 *   attestation to the public transparency log); unset or `false` publishes with
 *   `--provenance=false`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { PUBLISHED_PACKAGES, verifyTarball } from './pack-packages.mjs';

/**
 * The provenance switch, from `NPM_PROVENANCE`.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function provenanceSetting(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`NPM_PROVENANCE must be 'true' or 'false', not ${JSON.stringify(value)}`);
}

/**
 * Why provenance cannot be used for this repository, or `undefined` when it can.
 * @param {boolean} provenance
 * @param {string | undefined} visibility the event payload's `repository.visibility`
 * @returns {string | undefined}
 */
export function provenanceRefusal(provenance, visibility) {
  if (!provenance || visibility === 'public') return undefined;
  return `NPM_PROVENANCE=true needs a public repository; this one is ${visibility ?? 'of unknown visibility'}`;
}

/**
 * Whether `npm view <name>@<version> version` printed the version, i.e. npm serves it.
 * @param {string} viewOutput
 * @param {string} version
 */
export function isPublished(viewOutput, version) {
  return viewOutput.trim() === version;
}

/**
 * Why the tarball list is not the release: every published package, in publish order, at one
 * version. Empty when it is.
 * @param {readonly Package[]} packages
 * @returns {string[]}
 */
export function checkPublishOrder(packages) {
  const expected = PUBLISHED_PACKAGES.map((name) => `@indx-workspace/${name}`);
  const actual = packages.map(({ name }) => name);
  /** @type {string[]} */
  const failures = [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`the tarballs are ${actual.join(', ') || 'none'}, not ${expected.join(', ')}`);
  }
  const versions = [...new Set(packages.map(({ version }) => version))];
  if (versions.length > 1) failures.push(`the tarballs are not lock-step: ${versions.join(', ')}`);
  return failures;
}

/**
 * The tarball paths a list file names, one per non-blank line, each resolved against the list
 * file's directory: an absolute line stays as it is, a basename names a file next to the list.
 * @param {string} listFile the path of the list file
 * @param {string} text its contents
 * @returns {string[]}
 */
export function tarballPaths(listFile, text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => path.resolve(path.dirname(listFile), line));
}

/** @param {string} tarball @param {boolean} provenance */
export function publishArguments(tarball, provenance) {
  return ['publish', tarball, '--access', 'public', `--provenance=${String(provenance)}`];
}

/**
 * @typedef {{ tarball: string, name: string, version: string }} Package
 * @typedef {(args: readonly string[]) => { status: number | null, stdout: string, stderr?: string }} Npm
 * @typedef {'known' | 'never-published' | 'unreachable'} RegistryState
 * @typedef {(name: string) => RegistryState} Registry
 */

/** Where the Owner's first-publish step is documented; every never-published refusal names it. */
export const FIRST_PUBLISH_STEP =
  'docs/release/README.md, "First publish of a new package name (Owner, once)"';

/**
 * The whole release is refused before anything is published. `code` says why:
 * `NEVER_PUBLISHED` (npm has never served `packages`; the Owner's first-publish step is missing)
 * or `REGISTRY_UNREACHABLE` (npm could not say whether `packages` exist).
 */
export class ReleaseRefusedError extends Error {
  /**
   * @param {'NEVER_PUBLISHED' | 'REGISTRY_UNREACHABLE'} code
   * @param {readonly string[]} packages
   * @param {string} message
   */
  constructor(code, packages, message) {
    super(message);
    this.name = 'ReleaseRefusedError';
    this.code = code;
    this.packages = [...packages];
  }
}

/**
 * Whether npm has ever served `name`, from `npm view <name> versions --json`: a non-empty version
 * list is `known`; an E404, or an empty list, is `never-published`; anything else (a network or
 * registry error, unparsable output) is `unreachable`, never `known`.
 * @param {Npm} npm
 * @returns {Registry}
 */
export function npmRegistry(npm) {
  return (name) => {
    const view = npm(['view', name, 'versions', '--json']);
    const output = `${view.stdout}\n${view.stderr ?? ''}`;
    if (view.status !== 0) return /\bE404\b/u.test(output) ? 'never-published' : 'unreachable';
    /** @type {unknown} */
    let versions;
    try {
      versions = JSON.parse(view.stdout);
    } catch {
      return 'unreachable';
    }
    // npm prints a bare string when the package has exactly one version.
    if (typeof versions === 'string') return versions === '' ? 'never-published' : 'known';
    if (!Array.isArray(versions)) return 'unreachable';
    return versions.length > 0 ? 'known' : 'never-published';
  };
}

/**
 * Refuse the whole release unless npm has served every package before. Runs before the first
 * `npm publish`, so a refusal publishes nothing.
 * @param {readonly Package[]} packages @param {Registry} registry
 */
export function requireRegistered(packages, registry) {
  const states = packages.map(({ name }) => ({ name, state: registry(name) }));
  const named = (/** @type {RegistryState} */ state) =>
    states.filter((entry) => entry.state === state).map(({ name }) => name);
  const neverPublished = named('never-published');
  if (neverPublished.length > 0) {
    throw new ReleaseRefusedError(
      'NEVER_PUBLISHED',
      neverPublished,
      `refusing to publish anything: npm has never served ${neverPublished.join(', ')}. Trusted ` +
        "publishing needs a package's first version to be published by hand: the Owner publishes " +
        `a 0.0.0-bootstrap placeholder and configures its trusted publisher (${FIRST_PUBLISH_STEP}), ` +
        'then re-runs this workflow. Nothing was published.',
    );
  }
  const unreachable = named('unreachable');
  if (unreachable.length > 0) {
    throw new ReleaseRefusedError(
      'REGISTRY_UNREACHABLE',
      unreachable,
      `refusing to publish anything: npm could not say whether ${unreachable.join(', ')} exist ` +
        '(network or registry error). Nothing was published; re-run the publish job.',
    );
  }
}

/** How long the confirmation waits for npm to serve every package: npm can lag a publish by minutes. */
export const SERVE_TIMEOUT_MS = 15 * 60_000;
const FIRST_POLL_DELAY_MS = 10_000;
const MAX_POLL_DELAY_MS = 60_000;

/**
 * Refuse the whole release unless npm has served every package before (`requireRegistered`),
 * then publish each package unless npm already serves its version, then require npm to serve all
 * of them. The registry can lag a publish by minutes ("Your package is being processed and may take a
 * few minutes to become available"), so the check polls with a doubling delay (10 s up to 60 s)
 * until `timeoutMs` has passed, and only then fails, naming each package's state.
 * @param {readonly Package[]} packages in publish order
 * @param {{ provenance: boolean, npm: Npm, registry?: Registry, wait?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number }} options
 */
export async function publishAll(packages, options) {
  const {
    provenance,
    npm,
    registry = npmRegistry(npm),
    wait = (ms) => delay(ms),
    now = () => Date.now(),
    timeoutMs = SERVE_TIMEOUT_MS,
  } = options;
  const served = (/** @type {Package} */ { name, version }) => {
    const view = npm(['view', `${name}@${version}`, 'version']);
    return view.status === 0 && isPublished(view.stdout, version);
  };
  requireRegistered(packages, registry);
  /** @type {string[]} */
  const published = [];
  /** @type {string[]} */
  const skipped = [];
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    if (served(pkg)) {
      skipped.push(id);
      continue;
    }
    const result = npm(publishArguments(pkg.tarball, provenance));
    if (result.status !== 0) throw new Error(`npm publish ${id} failed`);
    published.push(id);
  }
  const deadline = now() + timeoutMs;
  let pause = FIRST_POLL_DELAY_MS;
  /** @type {readonly Package[]} */
  let pending = packages;
  for (;;) {
    pending = pending.filter((pkg) => !served(pkg));
    if (pending.length === 0) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const ms = Math.min(pause, remaining);
    process.stdout.write(
      `npm does not serve ${pending.map(idOf).join(', ')} yet; checking again in ${Math.ceil(ms / 1000)} s\n`,
    );
    await wait(ms);
    pause = Math.min(pause * 2, MAX_POLL_DELAY_MS);
  }
  if (pending.length > 0) {
    const confirmed = packages.filter((pkg) => !pending.includes(pkg));
    throw new Error(
      `npm does not serve ${pending.map(idOf).join(', ')} after ${Math.round(timeoutMs / 60_000)} min (served: ${confirmed.map(idOf).join(', ') || 'none'}; still pending: ${pending.map(idOf).join(', ')})`,
    );
  }
  return { published, skipped };
}

/** @param {Package} pkg */
function idOf({ name, version }) {
  return `${name}@${version}`;
}

const TAG_PREFIX = 'packages-v';

/**
 * The version a release tag names: `packages-v<version>`.
 * @param {string | undefined} tag `GITHUB_REF_NAME`
 * @returns {string}
 */
export function releaseVersion(tag) {
  const version = tag?.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`GITHUB_REF_NAME must be ${TAG_PREFIX}<version>, not ${JSON.stringify(tag)}`);
  }
  return version;
}

/**
 * The sha256 of each tarball the verify job packed, from `sha256sum` output (`<hex>  <file>` or
 * `<hex> *<file>`, one per line), by file name. A line in any other shape, or a file named twice,
 * fails.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseDigests(text) {
  /** @type {Map<string, string>} */
  const digests = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const [, digest, file] = /^([0-9a-f]{64}) [ *](\S+)$/u.exec(line.trim()) ?? [];
    if (digest === undefined || file === undefined || digests.has(file)) {
      throw new Error(`EXPECTED_DIGESTS holds a malformed or repeated line: ${line}`);
    }
    digests.set(file, digest);
  }
  return digests;
}

/**
 * Why the downloaded tarballs are not the bytes the verify job packed before its smoke ran: a
 * tarball without a recorded digest, one whose digest differs, or a recorded one not downloaded.
 * @param {ReadonlyMap<string, string>} actual the digest of each downloaded tarball, by file name
 * @param {ReadonlyMap<string, string>} expected the digests the verify job recorded
 * @returns {string[]}
 */
export function checkDigests(actual, expected) {
  /** @type {string[]} */
  const failures = [];
  if (expected.size === 0) return ['no digests from the verify job (EXPECTED_DIGESTS is empty)'];
  for (const [file, digest] of actual) {
    const recorded = expected.get(file);
    if (recorded === undefined) failures.push(`${file} has no digest from the verify job`);
    else if (recorded !== digest) {
      failures.push(`${file} is not the tarball the verify job packed (sha256 ${digest})`);
    }
  }
  for (const file of expected.keys()) {
    if (!actual.has(file)) failures.push(`${file} was packed but is not in the list`);
  }
  return failures;
}

/**
 * Read, digest and verify one downloaded tarball with the checks `pack-packages.mjs` ran after
 * packing it, at the version the tag names.
 * @param {string} tarball @param {string} version
 * @returns {Promise<{ pkg: Package, digest: string, failures: string[] }>}
 */
async function inspect(tarball, version) {
  const bytes = await readFile(tarball);
  const { manifest, failures } = verifyTarball(bytes, version);
  const pkg = { tarball, name: String(manifest['name']), version: String(manifest['version']) };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = path.basename(tarball);
  return { pkg, digest, failures: failures.map((failure) => `${file}: ${failure}`) };
}

/** @type {Npm} */
function npmCli(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' });
  if (args[0] === 'publish') process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @param {readonly string[]} argv */
async function main(argv) {
  const list = argv[0];
  if (list === undefined)
    throw new Error('usage: publish-packages.mjs <file listing the tarballs>');
  const provenance = provenanceSetting(process.env['NPM_PROVENANCE']);
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  const event = eventPath === undefined ? {} : JSON.parse(await readFile(eventPath, 'utf8'));
  const refusal = provenanceRefusal(provenance, event?.repository?.visibility);
  if (refusal !== undefined) throw new Error(refusal);
  const version = releaseVersion(process.env['GITHUB_REF_NAME']);
  const expected = parseDigests(process.env['EXPECTED_DIGESTS'] ?? '');
  const tarballs = tarballPaths(list, await readFile(list, 'utf8'));
  /** @type {Package[]} */
  const packages = [];
  /** @type {Map<string, string>} */
  const digests = new Map();
  /** @type {string[]} */
  const failures = [];
  for (const tarball of tarballs) {
    const inspected = await inspect(tarball, version);
    packages.push(inspected.pkg);
    digests.set(path.basename(tarball), inspected.digest);
    failures.push(...inspected.failures);
  }
  failures.push(...checkDigests(digests, expected), ...checkPublishOrder(packages));
  if (failures.length > 0) {
    throw new Error(`refusing to publish:\n  ${failures.join('\n  ')}`);
  }
  const { published, skipped } = await publishAll(packages, { provenance, npm: npmCli });
  for (const id of skipped) process.stdout.write(`${id} was already on npm; skipped\n`);
  process.stdout.write(
    `published ${published.join(', ') || 'nothing new'} (provenance ${provenance ? 'on' : 'off'}); npm serves ${packages.map(({ name, version }) => `${name}@${version}`).join(', ')}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
