import { trackedAreaNames } from './body.mjs';
/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'>} context */
export function runAreaCoverageCases({ check, parses }) {
  // ...and it cannot be walked around by splitting one `**` into innocent-looking pieces.
  // Built from the tracked tree, not typed out: a hand-written list of directories here would
  // start passing — silently, as a fixture that no longer covers the repo — the day someone
  // adds a top-level directory. `areaGlobs` is one `<dir>/**` per tracked top-level directory.
  const areaGlobs = trackedAreaNames().map((d) => `${d}/**`);

  /** @param {string[]} gs */
  const ownsLine = (gs) => `## Ownership\nOwns globs: ${gs.map((g) => `\`${g}\``).join(', ')}`;

  check(
    'globs that only together cover the repo are refused',
    // Not one of these is a whole-repo claim on its own — `*.*` misses LICENSE, and each
    // directory glob misses every other directory. Together they leave nothing out.
    parses(ownsLine(['*.*', ...areaGlobs])),
    'REJECTED',
  );

  // THE ONE-DIRECTORY ESCAPE HATCH. This slot used to hold a single fixture asserting that
  // `*.*` plus every directory but the FIRST was accepted — it pinned the hole rather than
  // the guard, and it only ever exercised one directory. The shape is written out for every
  // tracked directory in turn instead, and derived, so a directory added tomorrow arrives
  // with its own case and nobody has to remember to add one. Gated at three directories
  // because below that "all but one" and "one" are the same claim, which is exactly why
  // question (a) also wants two areas reached.
  const areaNames = trackedAreaNames();

  /** @param {...string} omit */
  const without = (...omit) => ['*.*', ...areaGlobs.filter((g) => !omit.includes(g.slice(0, -3)))];

  if (areaNames.length >= 3) {
    for (const dir of areaNames) {
      check(`every area except ${dir} is refused too`, parses(ownsLine(without(dir))), 'REJECTED');
    }
  }

  // The other side of the same line, so the spread cannot silently widen from "all but one"
  // to "all but two": leaving two directories out is a scoped declaration and must parse.
  // Each directory appears in an omitted pair with its neighbour, so a widening fails here
  // for every directory rather than for whichever one someone happened to write down.
  for (let i = 0; i < areaNames.length; i++) {
    const pair = [
      requiredValue(areaNames[i], 'area index is in bounds'),
      requiredValue(areaNames[(i + 1) % areaNames.length], 'neighbor area index is in bounds'),
    ];
    const gs = without(...pair);
    check(
      `every area except ${[...new Set(pair)].join(' and ')} still parses`,
      parses(ownsLine(gs)),
      gs,
    );
  }

  // ...and the ordinary declaration — one area, with and without the shared root — must parse
  // for every directory, not just for the two that happen to be spelt out further down.
  for (const dir of areaNames) {
    check(`${dir}/** alone still parses`, parses(ownsLine([`${dir}/**`])), [`${dir}/**`]);
    check(`${dir}/** with the root files still parses`, parses(ownsLine(['*.*', `${dir}/**`])), [
      '*.*',
      `${dir}/**`,
    ]);
  }

  // The other half of the bargain: real, scoped declarations must still pass. If one of
  // these ever starts failing, the probe spread has been drawn too wide, not too narrow.
  check(
    'a whole top-level app is still allowed',
    parses('## Ownership\nOwns globs: `apps/web/**`'),
    ['apps/web/**'],
  );

  check(
    'a wildcard package glob is still allowed',
    parses('## Ownership\nOwns globs: `packages/*/src/**`'),
    ['packages/*/src/**'],
  );
  return { areaGlobs, ownsLine };
}
import { requiredValue } from './invariants.mjs';
