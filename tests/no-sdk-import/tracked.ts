import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isResearchFixture, REPO_ROOT } from './boundaries.js';
import {
  classifyFile,
  classifyResearchFixture,
  isPackageManifest,
  type FileClass,
  type FixtureVerdict,
} from './classify.js';

/**
 * The tracked tree, from `git ls-files` with no pathspec, so every narrowing of it happens in
 * this gate where a reader can see it.
 *
 * Throws rather than returning an empty list if git cannot be read: every assertion is quantified
 * over this array, and an empty array satisfies all of them vacuously (ADR-0015).
 *
 * Names come from git and contents come from the working tree, on purpose: an uncommitted edit
 * to a tracked file fails the gate while a person can still act on it, and an untracked file is
 * invisible, because the §42 permit is a statement about what this repository carries and `git
 * add` is what puts a file inside it. In CI the two agree, because the checkout is the commit.
 */
function trackedFiles(): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // `-z` ends each name with a NUL, so the split leaves one empty string at the end: dropping it
  // removes the terminator, not a file.
  const files = stdout.split('\0').filter((f) => f.length > 0);
  if (files.length === 0) {
    throw new Error(
      '`git ls-files` returned nothing, so this gate has no tree to scan. It must fail rather than report a repository with no SDK imports.',
    );
  }
  return files;
}

/** A file git lists that the working tree lacks throws: a name this gate cannot read is a file whose imports it cannot see. */
export function readTracked(file: string): string {
  const absolute = path.join(REPO_ROOT, file);
  if (!existsSync(absolute)) {
    throw new Error(
      `${file} is tracked by git but absent from the working tree, so this gate could not scan it.`,
    );
  }
  return readFileSync(absolute, 'utf8');
}

export const tracked = trackedFiles();
export const trackedSet = new Set(tracked);

export const classified = new Map<string, FileClass>(tracked.map((f) => [f, classifyFile(f)]));
export const unclassified = tracked.filter((f) => classified.get(f) === 'unclassified');
export const scanned = tracked.filter(
  (f) => classified.get(f) === 'module-source' || classified.get(f) === 'markup',
);
export const packageManifests = tracked.filter(
  (f) => classified.get(f) === 'structured-data' && isPackageManifest(f),
);

/**
 * The §42 permit, derived from the tracked tree by shape (ADR-0027).
 *
 * The two derived partitions fail in opposite directions:
 *
 *   * `researchProbes` is the **permitted** set. A file wrongly *dropped* from it makes the gate
 *     **stricter**: it becomes an unexpected importer and the §42 equality goes red naming it.
 *     That is why an `unrecognised` fixture is left out of the permit as well as reported.
 *   * `scanned` is the **inspected** set. A file wrongly dropped from it is never read, so the
 *     gate **fails open**. Nothing narrows it, and a test asserts every derived probe is inside it.
 */
export const researchFixtures = tracked.filter(isResearchFixture);
const fixtureVerdicts = new Map<string, FixtureVerdict>(
  researchFixtures.map((f) => [f, classifyResearchFixture(f)]),
);
export const researchProbes = researchFixtures
  .filter((f) => fixtureVerdicts.get(f)?.kind === 'probe')
  .sort((a, b) => a.localeCompare(b));
export const unrecognisedFixtures = researchFixtures.flatMap((f) => {
  const verdict = fixtureVerdicts.get(f);
  return verdict?.kind === 'unrecognised' ? [`${f}: ${verdict.reason}`] : [];
});
