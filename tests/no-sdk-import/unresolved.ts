import path from 'node:path';

import { isResearchFixture, RESEARCH_FIXTURE_ROOT } from './boundaries.js';
import { namesPackage, packageNameOf } from './packages.js';
import type { ModuleReference } from './scan.js';
import { readTracked, trackedSet } from './tracked.js';

/** A README this gate read, so a failure can name the file a reader has to edit. */
export type FixtureReadme = { readonly file: string; readonly text: string };

const readmeCache = new Map<string, FixtureReadme | null>();

/**
 * The nearest tracked `README.md` at or above a fixture, stopping at {@link RESEARCH_FIXTURE_ROOT}.
 *
 * `null` (no README covers the file) is a refusal at the call site, not a pass: ADR-0032 clause 3
 * makes the README the thing the classification rests on. The search is over the tracked tree, so
 * an untracked README documents nothing.
 *
 * The climb is bounded at both ends, and a test found that it had to be: a file outside the tree
 * is `null` before the walk starts, and a file inside it stops at the fixture root rather than
 * continuing into `docs/`, whose README is a research-note checklist with nothing to say about
 * anybody's installation.
 */
export function researchFixtureReadme(file: string): FixtureReadme | null {
  if (!isResearchFixture(file)) return null;
  const cached = readmeCache.get(file);
  if (cached !== undefined) return cached;
  const found = findReadmeAbove(file);
  readmeCache.set(file, found);
  return found;
}

function findReadmeAbove(file: string): FixtureReadme | null {
  // git reports forward slashes on every platform, so the posix functions split them:
  // `path.dirname` on win32 would also split on a backslash a name may contain.
  let dir = path.posix.dirname(file);
  for (;;) {
    const candidate = `${dir}/README.md`;
    if (trackedSet.has(candidate)) return { file: candidate, text: readTracked(candidate) };
    if (dir === RESEARCH_FIXTURE_ROOT) return null;
    const up = path.posix.dirname(dir);
    if (up === dir || !up.startsWith(RESEARCH_FIXTURE_ROOT)) return null;
    dir = up;
  }
}

/**
 * What an unresolvable reference is. Two verdicts and no third path.
 *
 *   * `refused`: the ADR-0031 clause 1 hard failure, naming the file and the reference.
 *   * `undeclared-package`: the ADR-0032 clause 1 classification, *a package this repository does
 *     not declare, in a directory nothing here imports*. It is recorded by name and asserted as a
 *     set; it is never a skip.
 */
export type UnresolvedVerdict =
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'undeclared-package';
      readonly packageName: string;
      readonly readme: string;
    };

const NO_PACKAGE_ADDENDUM =
  `. It is under ${RESEARCH_FIXTURE_ROOT}/, where a bare specifier naming a package this ` +
  `repository does not declare is a classified verdict, but this specifier names no ` +
  `package. A relative or absolute reference points at a file this repository contains ` +
  `wherever it is written, so one that resolves nowhere is a broken link and is refused ` +
  `here exactly as it is everywhere else (ADR-0032 clause 2).`;

function undeclaredIn(packageName: string): string {
  return (
    `. It is under ${RESEARCH_FIXTURE_ROOT}/ and names the package ${packageName}, which this ` +
    `repository does not declare`
  );
}

/**
 * Decide one reference the resolver placed nowhere.
 *
 * The README is reached through a parameter rather than read here, so the clause-3 red proof can
 * hand this function a README with the package name taken out and watch the verdict turn into a
 * refusal, without a committed README being edited to prove it.
 */
export function decideUnresolvedReference(
  file: string,
  reference: ModuleReference,
  readmeFor: (fixtureFile: string) => FixtureReadme | null,
): UnresolvedVerdict {
  const refused = (addendum: string): UnresolvedVerdict => ({
    kind: 'refused',
    reason:
      `${reference.form} names ${JSON.stringify(reference.specifier)}, and neither the project ` +
      `that owns this file nor the package that declares the SDK could resolve it, so this gate ` +
      `cannot say which file it reaches${addendum}`,
  });
  if (!isResearchFixture(file)) return refused('');
  const packageName = packageNameOf(reference.specifier);
  if (packageName === null) return refused(NO_PACKAGE_ADDENDUM);
  const readme = readmeFor(file);
  if (readme === null) {
    return refused(
      `${undeclaredIn(packageName)} but no README.md between this file and ` +
        `${RESEARCH_FIXTURE_ROOT}/ says where that package comes from, so nothing here documents ` +
        `the installation the probe is run from (ADR-0032 clause 3).`,
    );
  }
  if (!namesPackage(readme.text, packageName)) {
    return refused(
      `${undeclaredIn(packageName)} and ${readme.file} does not name ${packageName}, so the ` +
        `verdict rests on nothing. Name the package in that README, beside the install command a ` +
        `reader runs, or stop importing it here (ADR-0032 clause 3).`,
    );
  }
  return { kind: 'undeclared-package', packageName, readme: readme.file };
}
