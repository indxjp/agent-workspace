import { parseOwnership, trackedAreaNames } from './body.mjs';
import { matchAny } from './globs.mjs';
/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'|'body'|'noRoot'|'areaGlobs'|'ownsLine'>} context */
export function runGlobNotationCases({ check, parses, body, noRoot, areaGlobs, ownsLine }) {
  // A brace list contains a comma, so the Owns line must be split at brace depth 0 only.
  // `.split(',')` produced `*.{json` and `mjs}`, two globs that match nothing at all.
  check(
    'a scoped root brace list is still allowed',
    parses('## Ownership\nOwns globs: `*.{json,mjs}`'),
    ['*.{json,mjs}'],
  );

  check(
    'a brace list is one glob, not two',
    parses('## Ownership\nOwns globs: `apps/{web,runner}/**`, `docs/**`'),
    ['apps/{web,runner}/**', 'docs/**'],
  );

  const braceList = parseOwnership('## Ownership\nOwns globs: `apps/{web,runner}/**`');
  if (!braceList.ok) throw new Error(braceList.reason);
  check(
    'a brace list still matches both branches',
    matchAny(braceList.globs, 'apps/runner/src/index.ts', noRoot),
    true,
  );

  check("this task's own two globs are still allowed", parses(body), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);

  // ROUND-4 FIXTURES — the guard used to run on the RAW spelling while enforcement ran on the
  // normalised one, so a bare directory name (which normalizeGlob expands to `dir/**` against
  // the real tree) was invisible to the guard. The first fixture is the bypass that found it:
  // it is the `**`-spelt set two lines below, which the guard has always refused. Both sets
  // are derived from the tracked tree for the reason the probes are: typed out, they named the
  // six directories of this branch and silently stopped covering the repository one commit
  // later, when W0-DOC-01's `.claude/workflows/` made a seventh — at which point the "bypass"
  // fixture asserted nothing and passed by not being a whole-repo claim at all.
  check(
    'bare directory names cannot walk around the whole-repo guard',
    parses(ownsLine([...trackedAreaNames(), '*.*'])),
    'REJECTED',
  );

  check(
    'the same claim spelt with /** is refused as before',
    parses(ownsLine([...areaGlobs, '*.*'])),
    'REJECTED',
  );

  check(
    'a bare `.` is a whole-repo claim once normalised',
    parses('## Ownership\nOwns globs: `.`'),
    'REJECTED',
  );

  // A bare directory is still a legitimate way to write a scoped claim; it comes back in the
  // form enforcement will actually match, so what is printed is what is checked.
  check(
    'a single bare directory is normalised, not refused',
    parses('## Ownership\nOwns globs: `docs`'),
    ['docs/**'],
  );
}
