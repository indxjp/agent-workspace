/**
 * Every repository path this task's own artefacts name must be a path that exists.
 *
 * ## Why
 *
 * Three references shipped on this branch pointing at files that were never committed, and each
 * was the pointer to the evidence for one of the PR's three largest declared gaps. The file-backed transcript store
 * sent a reader after the PostgreSQL DDL to an ADR filename one clause short of the real one;
 * `resume.acceptance.ts` did the same for the live 403 transcript; and an ADR named the acceptance
 * harness with a `.test.ts` suffix — a filename that deliberately does not exist, because the
 * commit that renamed it exists precisely to stop the harness being collected as a test. (The
 * three dead spellings are not written out here, because this gate would then be reporting itself.
 * They are on the PR.) All three were prose, so `tsc` never looked at them and nothing in CI
 * resolved them. ADR-0016: an artefact must not assert something that is not so, and *"the
 * evidence is in that file"* is an assertion.
 *
 * A dangling pointer is worse than a missing one. A reader who follows it finds nothing and
 * concludes the evidence is gone; a reader who does not follow it assumes the evidence is there.
 *
 * ## What this checks, and what it cannot
 *
 * It scans the files **this task owns** — the globs on its PR, listed below — for tokens that are
 * repository-relative paths, and asserts each one exists. Three bounds, stated rather than implied
 * (ADR-0031, a static check cannot be complete):
 *
 *  1. **It is a text scan, and that is the right tool here but not for imports.** These are prose
 *     references inside comments and Markdown, not module specifiers; a module specifier is
 *     resolved by the compiler and `tests/no-sdk-import.test.ts` is where that happens (ADR-0030).
 *  2. **A reference this scanner does not recognise is not checked.** It recognises a token that
 *     begins with one of this repository's top-level directories and ends in a file extension. A
 *     path written some other way — split across two lines, or built out of prose — is outside it.
 *     What it will not do is pass a token it *did* recognise and could not resolve.
 *  3. **It is scoped to this task's files**, because a repository-wide version of it is a
 *     cross-cutting gate and `tests/` is not this task's to add one to. That is reported on the
 *     PR rather than silently narrowed here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The files this task owns, as directories to walk and single files to read.
 *
 * This mirrors the `Owns globs:` line of the PR. Each entry must match at least one real file —
 * an entry that matches nothing fails below rather than quietly shrinking the scan, which is the
 * one way a gate like this stops meaning anything (ADR-0015).
 */
const OWNED: readonly string[] = [
  'apps/web/server/sessions',
  'apps/web/app/api/sessions',
  'apps/runner/src/session.ts',
  'apps/runner/src/session.test.ts',
  'tests/route-declarations/W2-CP-07.ts',
  // `docs/adr/W2-CP-07-*.md` — expanded from the directory listing below, so a record added later
  // is scanned without this list being edited.
];

const TEXT_SUFFIXES = ['.ts', '.tsx', '.mjs', '.md', '.json'];

function filesUnder(entry: string): string[] {
  const absolute = path.join(REPOSITORY_ROOT, entry);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  const out: string[] = [];
  for (const name of readdirSync(absolute)) {
    out.push(...filesUnder(path.join(entry, name)));
  }
  return out.filter((file) => TEXT_SUFFIXES.includes(path.extname(file)));
}

function ownedFiles(): string[] {
  const files: string[] = [];
  for (const entry of OWNED) {
    const matched = filesUnder(entry);
    if (matched.length === 0) {
      throw new Error(
        `this task declares it owns ${entry}, and nothing is there. Either the glob moved or this ` +
          `list is stale; a scan over an empty set is a gate that cannot fail.`,
      );
    }
    files.push(...matched);
  }
  const adrs = readdirSync(path.join(REPOSITORY_ROOT, 'docs/adr'))
    .filter((name) => name.startsWith('W2-CP-07-') && name.endsWith('.md'))
    .map((name) => path.join(REPOSITORY_ROOT, 'docs/adr', name));
  if (adrs.length === 0) {
    throw new Error('docs/adr holds no W2-CP-07 record, so this task wrote none or they moved.');
  }
  files.push(...adrs);
  return files;
}

/**
 * The top-level directories a repository-relative path can start with. Derived from the tree
 * rather than typed, so a directory added later is covered without editing this file.
 */
const ROOTS = readdirSync(REPOSITORY_ROOT, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
  )
  .map((entry) => entry.name);

const REFERENCE = new RegExp(
  `\\b(?:${ROOTS.join('|')})/[A-Za-z0-9_./-]*\\.(?:${TEXT_SUFFIXES.map((s) => s.slice(1)).join('|')}|jsonl|sh|yaml|yml)`,
  'g',
);

/** Every repository path named in one file, with the trailing punctuation of prose trimmed. */
function referencesIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(REFERENCE)) {
    let token = match[0];
    while (token.length > 0 && (token.endsWith('.') || token.endsWith(','))) {
      token = token.slice(0, -1);
    }
    if (token.length > 0) found.add(token);
  }
  return [...found];
}

describe('every path this task points a reader at exists', () => {
  const files = ownedFiles();

  it('scans a non-empty set of owned files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('finds no dangling reference', () => {
    const dangling: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const reference of referencesIn(file)) {
        checked += 1;
        if (existsSync(path.join(REPOSITORY_ROOT, reference))) continue;
        dangling.push(
          `${path.relative(REPOSITORY_ROOT, file).replace(/\\/g, '/')} -> ${reference}`,
        );
      }
    }
    // A run that recognised nothing would report no dangling reference and mean nothing by it.
    expect(checked).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });
});
