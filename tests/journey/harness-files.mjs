import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { JourneyFailure } from './harness-failure.mjs';

/**
 * What `npm install` and `aw dev` own inside the project: the installed packages, npm's lockfile
 * and the local runtime's state directory. A path that ends with `/` is a directory, compared by
 * prefix; any other is one file. Everything else in `demo/` must stay as `npm create` wrote it.
 * `.aw/` holds the runtime log (`.aw/logs/runtime.log`); the template's `.gitignore` lists it.
 */
export const TOOL_OWNED_PATHS = ['node_modules/', 'package-lock.json', '.agent-workspace/', '.aw/'];

/**
 * @param {string} relative a `/`-separated path relative to the snapshot root
 * @param {readonly string[]} excluded
 */
function isExcluded(relative, excluded) {
  return excluded.some((entry) =>
    entry.endsWith('/')
      ? relative === entry.slice(0, -1) || relative.startsWith(entry)
      : relative === entry,
  );
}

/** @param {string | Buffer} contents */
function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Calls `visit` for everything under `dir` that is not a directory (relative `/`-separated path,
 * absolute path, its `lstat`); an excluded directory is not entered and a link is not followed.
 *
 * @param {string} dir @param {readonly string[]} excluded
 * @param {(relative: string, absolute: string, stat: import('node:fs').Stats) => void} visit
 */
function walkFiles(dir, excluded, visit) {
  /** @param {string} relative */
  const walk = (relative) => {
    const absolute = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    for (const name of readdirSync(absolute)) {
      const child = relative === '' ? name : `${relative}/${name}`;
      if (isExcluded(child, excluded)) continue;
      const childPath = path.join(absolute, name);
      const stat = lstatSync(childPath);
      if (stat.isDirectory()) walk(child);
      else visit(child, childPath, stat);
    }
  };
  walk('');
}

/** @param {string} left @param {string} right */
function byPath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every file under `dir`, as `{relativePath: sha256}` sorted by path. A symbolic link is hashed
 * by its target and not followed; an excluded directory is not entered.
 *
 * @param {string} dir @param {readonly string[]} [excluded]
 * @returns {Record<string, string>}
 */
export function snapshotTree(dir, excluded = TOOL_OWNED_PATHS) {
  /** @type {[string, string][]} */
  const entries = [];
  walkFiles(dir, excluded, (relative, absolute, stat) => {
    entries.push([
      relative,
      stat.isSymbolicLink()
        ? sha256(`symlink:${readlinkSync(absolute)}`)
        : sha256(readFileSync(absolute)),
    ]);
  });
  entries.sort(([left], [right]) => byPath(left, right));
  return Object.fromEntries(entries);
}

/**
 * What the secret check leaves out of a project: the installed packages, which hold no secret of
 * the run, and the sealed store, the embedded PostgreSQL that keeps the connector's credential
 * sealed (`packages/embedded/src/embedded-db.ts`). Transcripts and the rest of `.agent-workspace/`
 * are read.
 */
export const SEALED_PATHS = ['node_modules/', '.agent-workspace/postgres/'];

/**
 * The regular files under `dir` whose bytes contain `secret`, sorted, the excluded paths left out;
 * no link is followed and no socket or pipe (a running runtime's) is opened. A blank secret is
 * refused: it would be found everywhere and prove nothing.
 *
 * @param {string} dir @param {string} secret @param {readonly string[]} [excluded]
 */
export function filesContaining(dir, secret, excluded = SEALED_PATHS) {
  if (secret === '') throw new JourneyFailure('the secret check was given no secret');
  const needle = Buffer.from(secret, 'utf8');
  /** @type {string[]} */
  const found = [];
  walkFiles(dir, excluded, (relative, absolute, stat) => {
    if (stat.isFile() && readFileSync(absolute).includes(needle)) found.push(relative);
  });
  return found.sort(byPath);
}

/**
 * None of `places` (`{ name: text }`: a log, an environment, a request body) contains `secret`, or
 * the run fails naming each place it is in, never the secret itself.
 *
 * @param {Readonly<Record<string, string>>} places @param {string} secret
 */
export function assertSecretAbsent(places, secret) {
  if (secret === '') throw new JourneyFailure('the secret check was given no secret');
  const holding = Object.keys(places).filter((name) => places[name]?.includes(secret));
  if (holding.length > 0) {
    throw new JourneyFailure(`the token appears in: ${holding.join(', ')}`);
  }
}

/**
 * What changed between two snapshots, each list sorted.
 *
 * @param {Readonly<Record<string, string>>} before @param {Readonly<Record<string, string>>} after
 */
export function diffTrees(before, after) {
  const added = Object.keys(after).filter((file) => !Object.hasOwn(before, file));
  const removed = Object.keys(before).filter((file) => !Object.hasOwn(after, file));
  const changed = Object.keys(after).filter(
    (file) => Object.hasOwn(before, file) && before[file] !== after[file],
  );
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Nothing but the tool-owned paths changed in the project `label` names (`demo`, `demo-tools`)
 * since `npm create` wrote it: the journey edits no file by hand, and neither may anything it runs.
 * Every changed path is listed. `allowedAdded` names the developer's own input files (B3a's OpenAPI
 * document), which may be added but, like every other file, never changed once they are there.
 *
 * @param {string} label @param {Readonly<Record<string, string>>} before
 * @param {Readonly<Record<string, string>>} after @param {readonly string[]} [allowedAdded]
 */
export function assertUnchanged(label, before, after, allowedAdded = []) {
  const diff = diffTrees(before, after);
  const { changed, removed } = diff;
  const added = diff.added.filter((file) => !allowedAdded.includes(file));
  if (added.length + changed.length + removed.length === 0) return;
  const lines = [
    ...added.map((file) => `  added: ${file}`),
    ...changed.map((file) => `  changed: ${file}`),
    ...removed.map((file) => `  removed: ${file}`),
  ];
  throw new JourneyFailure(`${label}/ changed after init:\n${lines.join('\n')}`);
}

/**
 * `text` with every occurrence of `secret` replaced by `<fake key>`. A blank secret leaves the
 * text as it is.
 *
 * @param {string} text @param {string} secret
 */
export function redact(text, secret) {
  return secret === '' ? text : text.split(secret).join('<fake key>');
}

/**
 * One evidence file with every secret redacted, or `null` when it is binary (a screenshot, a trace
 * archive) and holds a secret, so it cannot be redacted and must not be kept.
 *
 * @param {Buffer} bytes @param {Iterable<string>} secrets
 * @returns {Buffer | null}
 */
export function scrubbedEvidence(bytes, secrets) {
  const text = bytes.toString('utf8');
  const list = [...secrets].filter((secret) => secret !== '');
  if (Buffer.from(text, 'utf8').equals(bytes)) {
    return Buffer.from(
      list.reduce((clean, secret) => redact(clean, secret), text),
      'utf8',
    );
  }
  return list.some((secret) => bytes.includes(secret)) ? null : bytes;
}
