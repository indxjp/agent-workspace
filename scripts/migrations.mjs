#!/usr/bin/env node
/**
 * Keeps `migrations/` mergeable when two branches each add a migration.
 *
 *   node scripts/migrations.mjs check                  (pnpm migrations:check)
 *   node scripts/migrations.mjs renumber [--onto REF]  (pnpm migrations:renumber, REF = origin/main)
 *
 * Drizzle numbers migrations by position (`0058_…`) and records them in one shared array,
 * `migrations/meta/_journal.json`, plus a chained snapshot per migration. Two branches that both
 * generate the next migration collide on the journal and on `meta/NNNN_snapshot.json`.
 *
 * `renumber` is run in the middle of `git merge origin/main` (conflicted or not). It reads both
 * sides from git objects, so conflict markers on disk do not matter, and rewrites `migrations/`
 * so that main's migrations are exactly main's and this branch's new ones follow them:
 *
 * - each moved entry gets the next `idx`, its tag's number prefix is rewritten, and its `when`
 *   becomes strictly later than the previous entry's. The migrator applies a migration only when
 *   its `when` is later than the newest one already applied, so this is what stops it being
 *   skipped silently (see packages/core/src/db/migrate.ts);
 * - the SQL is copied byte for byte, so its hash is unchanged;
 * - each moved snapshot is a three-way merge of main's newest snapshot with this branch's
 *   changes, re-chained onto main's newest snapshot id, so the next `pnpm db:generate` diffs
 *   against a schema that contains both branches.
 *
 * Migrations already on main are never renamed or edited: databases have applied them, and the
 * ledger records their `when` and hash.
 *
 * `lint [--base REF]` (pnpm migrations:lint, REF = origin/main) reads the migrations ADDED since the
 * merge base with REF and rejects DDL that is not expand-only: `DROP`, `RENAME`, `SET NOT NULL`,
 * `ALTER COLUMN ... TYPE`, and a CHECK added to an existing table without `NOT VALID`. A
 * statement (Drizzle separates them with `--> statement-breakpoint`) passes when it carries a
 * `-- safe: <reason>` comment. Migrations already on REF are never linted.
 *
 * `check` validates the working tree: dense `idx`, tag prefixes, strictly increasing `when`, one
 * SQL file and one snapshot per entry, no stray SQL file, and an unbroken snapshot chain.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/* global console */

/**
 * @typedef {{ idx: number, version: string, when: number, tag: string, breakpoints: boolean }} Entry
 * @typedef {{ entries: Entry[], [key: string]: unknown }} Journal
 * @typedef {{ id: string, prevId: string, [key: string]: unknown }} Snapshot
 * @typedef {(file: string) => Buffer} Reader reads `migrations/<file>` from one side
 */

const FIX = 'Run `pnpm migrations:renumber` (during `git merge origin/main`) to repair it.';

/** @param {number} idx */
const pad = (idx) => String(idx).padStart(4, '0');
/** @param {number} idx */
const snapshotName = (idx) => `meta/${pad(idx)}_snapshot.json`;
/** @param {unknown} value */
const stringify = (value) => JSON.stringify(value, null, 2);

/**
 * Every problem with the migrations directory, or `[]`.
 *
 * @param {string} dir the `migrations/` directory
 * @returns {string[]}
 */
export function checkMigrations(dir) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Partial<Journal> | null} */
  let journal;
  try {
    journal = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8'));
  } catch (cause) {
    return [`meta/_journal.json cannot be read as JSON: ${String(cause)}`];
  }
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  if (entries.length === 0) problems.push('meta/_journal.json has no entries');
  /** @type {string | undefined} */
  let previousId;
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(`journal entry ${String(position)} has idx ${String(entry.idx)}`);
    }
    if (typeof entry.tag !== 'string' || !entry.tag.startsWith(`${pad(position)}_`)) {
      problems.push(`journal entry ${String(position)} has tag ${String(entry.tag)}`);
    }
    const previous = entries[position - 1];
    if (!Number.isInteger(entry.when) || (previous && !(entry.when > previous.when))) {
      problems.push(
        `journal entry ${String(position)} (${String(entry.tag)}) has when ${String(entry.when)}, ` +
          'not strictly later than the entry before it; the migrator would skip it silently',
      );
    }
    if (!existsSync(path.join(dir, `${entry.tag}.sql`))) {
      problems.push(`${String(entry.tag)}.sql is missing`);
    }
    /** @type {Snapshot} */
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(path.join(dir, snapshotName(position)), 'utf8'));
    } catch (cause) {
      problems.push(`${snapshotName(position)} cannot be read as JSON: ${String(cause)}`);
      previousId = undefined;
      return;
    }
    if (previousId !== undefined && snapshot.prevId !== previousId) {
      problems.push(
        `${snapshotName(position)} has prevId ${String(snapshot.prevId)}, not the previous ` +
          `snapshot's id ${previousId}`,
      );
    }
    previousId = snapshot.id;
  });
  const tags = new Set(entries.map((entry) => `${entry.tag}.sql`));
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.sql') && !tags.has(file)) {
      problems.push(`${file} is not in meta/_journal.json`);
    }
  }
  return problems;
}

/**
 * Whether one `ADD ... CHECK` clause of the statement lacks `NOT VALID`. Each `;`-terminated
 * statement and each `, ADD` clause is tested on its own, so a later clause's `NOT VALID` does not
 * cover an earlier one.
 * @param {string} code
 */
function addsValidatedCheck(code) {
  return code
    .split(/;|,\s*(?=ADD\b)/i)
    .some((clause) =>
      /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?CHECK\b(?![\s\S]*\bNOT\s+VALID\b)/i.test(clause),
    );
}

/** Expand-only rules: [name, test over a statement with comments removed]. */
const LINT_RULES = /** @type {const} */ ([
  ['DROP', /\bDROP\s+(?!DEFAULT\b|NOT\s+NULL\b)/i],
  ['RENAME', /\bRENAME\b/i],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/i],
  ['ALTER COLUMN TYPE', /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i],
  // Adding a CHECK to an existing table scans it under ACCESS EXCLUSIVE. `NOT VALID` skips the scan,
  // and a later `VALIDATE CONSTRAINT` checks old rows under a weaker lock.
  ['CHECK without NOT VALID', { test: addsValidatedCheck }],
]);

/**
 * Destructive or non-expand statements in one migration's SQL that lack `-- safe: <reason>`.
 *
 * @param {string} sql
 * @returns {string[]} one message per offending statement and rule
 */
export function lintSql(sql) {
  /** @type {string[]} */
  const problems = [];
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (/--[ \t]*safe:[ \t]*\S/.test(statement)) continue;
    const code = statement.replace(/--[^\n]*/g, '');
    for (const [name, pattern] of LINT_RULES) {
      if (pattern.test(code)) problems.push(`${name}: ${code.trim().split('\n')[0] ?? ''}`);
    }
  }
  return problems;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Key order of a merged object. Drizzle writes columns (and tables) in schema-declaration order and
 * the formal ER test compares that order, so a key only `theirs` has goes right after the key that
 * precedes it in `theirs`, not at the end. Ours keeps its own order.
 * ponytail: JSON alone cannot tell where two branches' new keys belong relative to each other; the
 * branch's keys come first at a shared position. `pnpm db:generate` is the source of truth.
 *
 * @param {string[]} ours
 * @param {string[]} theirs
 * @returns {string[]}
 */
function mergedKeyOrder(ours, theirs) {
  const order = [...ours];
  const inOurs = new Set(ours);
  let at = -1;
  for (const key of theirs) {
    if (inOurs.has(key)) {
      at = order.indexOf(key);
    } else {
      order.splice(++at, 0, key);
    }
  }
  return order;
}

/**
 * Three-way merge of two snapshots that both descend from `base`. Objects merge key by key;
 * anything else is a leaf. `undefined` means absent. Throws on a leaf both sides changed
 * differently, naming its path.
 *
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @param {string} [at] the dotted path, for the error
 * @returns {unknown}
 */
export function mergeSnapshots(base, ours, theirs, at = '') {
  if (isDeepStrictEqual(ours, theirs) || isDeepStrictEqual(base, theirs)) return ours;
  if (isDeepStrictEqual(base, ours)) return theirs;
  if (!isObject(ours) || !isObject(theirs)) {
    throw new Error(
      `Both branches changed ${at.slice(1) || 'the snapshot'} differently. Resolve the schema ` +
        'conflict, then delete this branch’s migration and re-run `pnpm db:generate`.',
    );
  }
  const from = isObject(base) ? base : {};
  /** @type {Record<string, unknown>} */
  const merged = {};
  for (const key of mergedKeyOrder(Object.keys(ours), Object.keys(theirs))) {
    const value = mergeSnapshots(from[key], ours[key], theirs[key], `${at}.${key}`);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * A snapshot without `id`/`prevId`: those are the chain, rewritten rather than merged.
 *
 * @param {Snapshot} snapshot
 */
function schema(snapshot) {
  /** @type {Record<string, unknown>} */
  const rest = { ...snapshot };
  delete rest['id'];
  delete rest['prevId'];
  return rest;
}

/**
 * @param {string} root the repository root
 * @param {string} ref a git revision
 * @returns {Reader}
 */
function gitReader(root, ref) {
  return (file) =>
    execFileSync('git', ['show', `${ref}:migrations/${file}`], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * @template T
 * @param {Reader} read
 * @param {string} file
 * @returns {T} parsed JSON; our own committed files, so not validated beyond JSON
 */
const json = (read, file) => JSON.parse(read(file).toString('utf8'));

/**
 * Computes the renumbered `migrations/` files from main (`onto`) and this branch (`mine`).
 *
 * @param {Reader} onto
 * @param {Reader} mine
 * @returns {{ writes: Map<string, string | Buffer>, removes: Set<string>, moved: number, ontoCount: number }}
 */
function planRenumber(onto, mine) {
  /** @type {Journal} */
  const ontoJournal = json(onto, 'meta/_journal.json');
  /** @type {Journal} */
  const mineJournal = json(mine, 'meta/_journal.json');
  const ontoEntries = ontoJournal.entries;
  const ontoTags = new Set(ontoEntries.map((entry) => entry.tag));
  const firstAdded = mineJournal.entries.findIndex((entry) => !ontoTags.has(entry.tag));
  const sharedCount = firstAdded === -1 ? mineJournal.entries.length : firstAdded;
  const added = mineJournal.entries.slice(sharedCount);
  if (sharedCount === 0) throw new Error('This branch shares no migration with the target.');
  mineJournal.entries.slice(0, sharedCount).forEach((entry, position) => {
    if (ontoEntries[position]?.tag !== entry.tag) {
      throw new Error(
        `This branch's migration ${entry.tag} is not at the same position on the target. ` +
          'Migrations on main are never renamed; fix the branch by hand.',
      );
    }
  });
  if (added.some((entry) => ontoTags.has(entry.tag))) {
    throw new Error("This branch's new migrations are interleaved with the target's.");
  }

  /** @type {Map<string, string | Buffer>} */
  const writes = new Map();
  /** @type {Set<string>} */
  const removes = new Set();
  // Main's side is written verbatim: it resolves the add/add conflicts git leaves on disk.
  ontoEntries.slice(sharedCount).forEach((entry, offset) => {
    writes.set(`${entry.tag}.sql`, onto(`${entry.tag}.sql`));
    writes.set(snapshotName(sharedCount + offset), onto(snapshotName(sharedCount + offset)));
  });
  /** @type {Snapshot} */
  const base = json(mine, snapshotName(sharedCount - 1));
  /** @type {Snapshot} */
  const ontoNewest = json(onto, snapshotName(ontoEntries.length - 1));
  const entries = [...ontoEntries];
  let prevId = ontoNewest.id;
  let previousWhen = ontoEntries[ontoEntries.length - 1]?.when ?? 0;
  added.forEach((entry, offset) => {
    const idx = ontoEntries.length + offset;
    const tag = `${pad(idx)}${entry.tag.slice(entry.tag.indexOf('_'))}`;
    const when = Math.max(entry.when, previousWhen + 1);
    previousWhen = when;
    entries.push({ ...entry, idx, tag, when });
    writes.set(`${tag}.sql`, mine(`${entry.tag}.sql`));
    if (tag !== entry.tag) removes.add(`${entry.tag}.sql`);
    /** @type {Snapshot} */
    const snapshot = json(mine, snapshotName(entry.idx));
    const merged = mergeSnapshots(schema(base), schema(snapshot), schema(ontoNewest));
    writes.set(snapshotName(idx), stringify({ id: snapshot.id, prevId, ...Object(merged) }));
    prevId = snapshot.id;
  });
  writes.set('meta/_journal.json', stringify({ ...ontoJournal, entries }));
  for (const file of writes.keys()) removes.delete(file);
  return { writes, removes, moved: added.length, ontoCount: ontoEntries.length };
}

/** @param {string[]} argv */
function main(argv) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const dir = path.join(root, 'migrations');
  const [command, ...rest] = argv;
  if (command === 'lint') {
    const flag = rest.indexOf('--base');
    const base = flag === -1 ? 'origin/main' : rest[flag + 1];
    if (!base) throw new Error('--base needs a git ref');
    if (flag === -1) {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
          cwd: root,
          stdio: 'ignore',
        });
      } catch {
        console.log('migrations:lint: origin/main not available; skipping (CI lints with --base)');
        return;
      }
    }
    const added = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', 'migrations/*.sql'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    const problems = added.flatMap((file) =>
      lintSql(readFileSync(path.join(root, file), 'utf8')).map((problem) => `${file}: ${problem}`),
    );
    if (problems.length > 0) {
      console.error(
        `New migrations contain DDL that is not expand-only:\n- ${problems.join('\n- ')}\n` +
          'Use expand/contract, or put `-- safe: <reason>` in the statement (see AGENTS.md).',
      );
      process.exitCode = 1;
    } else {
      console.log(`migrations:lint — ${String(added.length)} new migration(s) vs ${base}, clean.`);
    }
    return;
  }
  if (command !== 'renumber' && command !== 'check') {
    console.error(
      'usage: node scripts/migrations.mjs check | lint [--base <ref>] | renumber [--onto <ref>]',
    );
    process.exitCode = 2;
    return;
  }
  if (command === 'renumber') {
    const ontoFlag = rest.indexOf('--onto');
    const ref = ontoFlag === -1 ? 'origin/main' : rest[ontoFlag + 1];
    if (!ref) throw new Error('--onto needs a git ref');
    const plan = planRenumber(gitReader(root, ref), gitReader(root, 'HEAD'));
    for (const file of plan.removes) rmSync(path.join(dir, file), { force: true });
    for (const [file, content] of plan.writes) writeFileSync(path.join(dir, file), content);
    console.log(
      `migrations:renumber — ${String(plan.moved)} migration(s) of this branch now follow ` +
        `${ref}'s ${String(plan.ontoCount)}. Stage migrations/ and finish the merge; ` +
        '`pnpm db:generate` should then report no schema changes.',
    );
  }
  const problems = checkMigrations(dir);
  if (problems.length > 0) {
    console.error(`migrations/ is inconsistent:\n- ${problems.join('\n- ')}\n${FIX}`);
    process.exitCode = 1;
  } else if (command === 'check') {
    console.log('migrations:check — journal, SQL files and snapshot chain are consistent.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
