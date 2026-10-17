#!/usr/bin/env node
/**
 * Wave ownership disjointness checker.
 *
 * A wave buys its parallelism with file ownership: two tasks at the same parallel level must not
 * be able to touch one file. The plan asserts that in prose, and prose has been wrong about it
 * once already — Wave 1's task cards gave two parallel tasks intersecting globs, which is
 * `docs/adr/0013-wave-1-ownership-split-and-substacks.md`. This script decides it instead, so a
 * dispatch plan cannot claim disjointness it does not have.
 *
 * ## What it reads
 *
 * A wave plan's `## Ownership` section. Every `###` heading under it is one **parallel level**;
 * every markdown table row under that heading is one task. The task id is the bolded name in the
 * first cell; the globs are the backticked items in the cell of the `Owns` column.
 *
 * A level whose tasks are documented as running serially is still checked. Serial tasks may share
 * files, so a plan says so by putting them under a heading containing the word `serial`, and this
 * script reports them as `skipped (serial)` rather than passing them silently. Declaring the
 * exemption is the point; an unmarked level is always checked.
 *
 * ## How intersection is decided, and why it fails loudly
 *
 * Glob intersection is not decidable by comparing strings, so this uses witnesses: each glob is
 * expanded into concrete example paths by substituting its wildcards, and every witness of one
 * glob is tested against the regex of the other, in both directions. A hit is a proven
 * intersection and names the witness, so a failure is never a matter of opinion.
 *
 * The converse — no witness hit — is *not* proof of disjointness, and this script does not pretend
 * it is (ADR-0015: a check decides on a positive assertion). Two constructs it cannot reason about
 * are refused outright rather than passed:
 *
 *   * a character class (`[0-9]`), which `scripts/check-file-ownership.mjs` does not implement
 *     either — a glob containing one matches nothing there, which is how PR #34 failed CI while
 *     being entirely inside its declared globs;
 *   * a brace list nested inside another brace list, which this expander does not flatten.
 *
 * Both exit non-zero naming the glob. A checker that cannot read its input reports that it cannot
 * read its input.
 */
/* global console, process */ // The root ESLint config declares no environment globals.
import { readFileSync } from 'node:fs';

/** Wildcard substitutions used to build witnesses. Chosen to exercise both `*` and `**` depths. */
const WITNESS_SEGMENTS = ['a', 'a/b', 'a/b/c'];

/** A glob's wildcards, expanded into concrete paths that the glob certainly matches. */
function witnessesFor(glob) {
  let forms = [''];
  const parts = glob.split(/(\*\*|\*|\?)/u);
  for (const part of parts) {
    let options;
    if (part === '**') options = ['', ...WITNESS_SEGMENTS];
    else if (part === '*') options = ['a', 'ab'];
    else if (part === '?') options = ['a'];
    else options = [part];
    const next = [];
    for (const prefix of forms) for (const option of options) next.push(prefix + option);
    forms = next;
    if (forms.length > 4000) throw new Error(`glob expands too far to check: ${glob}`);
  }
  // `dir/**` should also witness `dir` itself, and `**/` collapses to nothing.
  return [...new Set(forms.map((f) => f.replace(/\/{2,}/gu, '/').replace(/\/$/u, '')))];
}

/** Brace lists are flattened before anything else looks at the glob. One level only, by design. */
function expandBraces(glob) {
  const match = /\{([^{}]*)\}/u.exec(glob);
  if (match === null) return [glob];
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);
  if (/[{}]/u.test(tail) && /\{[^{}]*\{/u.test(glob)) {
    throw new Error(`nested brace list is not supported: ${glob}`);
  }
  return match[1].split(',').flatMap((option) => expandBraces(`${head}${option.trim()}${tail}`));
}

function globToRegExp(glob) {
  let source = '';
  for (const part of glob.split(/(\*\*\/|\*\*|\*|\?)/u)) {
    if (part === '**/') source += '(?:.*/)?';
    else if (part === '**') source += '.*';
    else if (part === '*') source += '[^/]*';
    else if (part === '?') source += '[^/]';
    else source += part.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

function refuseUnsupported(glob) {
  if (/\[[^\]]*\]/u.test(glob)) {
    throw new Error(
      `character class is not supported by scripts/check-file-ownership.mjs either, so this glob ` +
        `would match nothing at CI time: ${glob}`,
    );
  }
}

/** Every glob of a task, brace-expanded and validated. */
function normalise(globs) {
  return globs.flatMap((glob) => {
    refuseUnsupported(glob);
    return expandBraces(glob);
  });
}

/** A proven intersection, or `null`. Never "probably disjoint". */
function intersection(aGlobs, bGlobs) {
  for (const a of aGlobs) {
    const aRe = globToRegExp(a);
    for (const b of bGlobs) {
      const bRe = globToRegExp(b);
      for (const witness of [...witnessesFor(a), ...witnessesFor(b)]) {
        if (witness !== '' && aRe.test(witness) && bRe.test(witness)) {
          return { a, b, witness };
        }
      }
    }
  }
  return null;
}

/** Parse the `## Ownership` section into `[{ level, serial, tasks: [{ id, globs }] }]`. */
function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+Ownership\s*$/u.test(line));
  if (start === -1) throw new Error('no `## Ownership` section in this plan');

  const levels = [];
  let current = null;
  let columns = null;

  for (const line of lines.slice(start + 1)) {
    if (/^##\s+(?!#)/u.test(line)) break;
    const heading = /^###\s+(.*)$/u.exec(line);
    if (heading !== null) {
      current = { level: heading[1].trim(), serial: /serial/iu.test(heading[1]), tasks: [] };
      levels.push(current);
      columns = null;
      continue;
    }
    if (current === null || !line.trimStart().startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (columns === null) {
      columns = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (cells.every((cell) => /^-+$/u.test(cell.replace(/:/gu, '')))) continue;

    const ownsAt = columns.indexOf('owns');
    if (ownsAt === -1) {
      throw new Error(`table under "${current.level}" has no "Owns" column`);
    }
    const id = /\*\*([^*]+)\*\*/u.exec(cells[0] ?? '')?.[1]?.trim();
    if (id === undefined) continue;
    const globs = [...(cells[ownsAt] ?? '').matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
    if (globs.length === 0) {
      // ADR-0015: a row that declares nothing is not a row that owns nothing.
      throw new Error(`task ${id} under "${current.level}" declares no globs`);
    }
    current.tasks.push({ id, globs: normalise(globs) });
  }
  return levels;
}

function main() {
  const planPath = process.argv[2];
  if (planPath === undefined) {
    console.error('usage: node scripts/check-wave-ownership.mjs <wave-plan.md>');
    process.exit(2);
  }

  const levels = parsePlan(readFileSync(planPath, 'utf8'));
  if (levels.length === 0) throw new Error('no `###` levels under `## Ownership`');

  let failed = false;
  for (const level of levels) {
    if (level.tasks.length === 0) {
      console.error(`FAIL  ${level.level}: no task rows found — the table shape changed`);
      failed = true;
      continue;
    }
    if (level.serial) {
      console.log(`skip  ${level.level}: declared serial, ${level.tasks.length} task(s)`);
      continue;
    }
    let clean = true;
    for (let i = 0; i < level.tasks.length; i += 1) {
      for (let j = i + 1; j < level.tasks.length; j += 1) {
        const a = level.tasks[i];
        const b = level.tasks[j];
        const hit = intersection(a.globs, b.globs);
        if (hit !== null) {
          console.error(
            `FAIL  ${level.level}: ${a.id} and ${b.id} both claim "${hit.witness}"\n` +
              `        via ${a.id}:\`${hit.a}\` and ${b.id}:\`${hit.b}\``,
          );
          clean = false;
          failed = true;
        }
      }
    }
    if (clean) {
      console.log(
        `ok    ${level.level}: ${level.tasks.length} task(s) pairwise disjoint ` +
          `(${level.tasks.map((t) => t.id).join(', ')})`,
      );
    }
  }

  if (failed) {
    console.error(
      '\nAn intersection at a parallel level is a defect in the plan, not in the code. ' +
        'Split the tasks or move one to another level; do not narrow a glob to hide it.',
    );
    process.exit(1);
  }
  console.log('\nAll parallel levels are pairwise disjoint.');
}

try {
  main();
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
