/**
 * @typedef {import('./extract.mjs').Claim} Claim
 * @typedef {import('./run.d.mts').PagePlan} PagePlan
 * @typedef {import('./run.d.mts').Row} Row
 */
import { shellCommands } from './extract.mjs';
import { galleryProblems, installProblems, stackFlagProblems } from './static.mjs';
import { STACK_BUILDER } from './run-config.mjs';
import { readRepositoryFile, whereOf, firstLine } from './run-locations.mjs';
export { parseArguments } from './run-arguments.mjs';
export { readRepositoryFile, lineOf, whereOf } from './run-locations.mjs';

/** @param {string} page */
const slugOf = (page) => page.replace(/[^a-z0-9]+/giu, '-').replace(/^-+|-+$/gu, '');

/**
 * The run claims by page, in page order. A block whose commands an earlier block of its page already
 * ran is not run again, and a page whose distinct blocks are those of an earlier page runs once.
 *
 * @param {readonly Claim[]} claims
 * @returns {PagePlan[]}
 */
export function runPlans(claims) {
  /** @type {PagePlan[]} */
  const plans = [];
  /** @type {Map<string, string>} */
  const seenPages = new Map();
  for (const claim of claims) {
    if (claim.state !== 'run') continue;
    let plan = plans.find((candidate) => candidate.page === claim.page);
    if (plan === undefined) {
      plan = { page: claim.page, slug: slugOf(claim.page), blocks: [] };
      plans.push(plan);
    }
    const commands = shellCommands(claim.body);
    const same = plan.blocks.find((block) => block.commands.join('\n') === commands.join('\n'));
    // A block that creates a project is another way to start, not a step after the blocks above it.
    const fresh = commands[0]?.startsWith('npm create ') === true ? { fresh: true } : {};
    plan.blocks.push(
      same === undefined
        ? { claim, commands, ...fresh }
        : { claim, commands, ...fresh, sameAsLine: same.claim.line },
    );
  }
  for (const plan of plans) {
    const key = plan.blocks
      .filter((block) => block.sameAsLine === undefined)
      .map((block) => block.commands.join('\n'))
      .join('\n--\n');
    const earlier = seenPages.get(key);
    if (earlier === undefined) seenPages.set(key, plan.page);
    else plan.sameAsPage = earlier;
  }
  return plans;
}

/**
 * Each compile claim as a file of the scratch project; the trailing `export {}` makes it a module
 * of its own, so two samples never share a global name.
 *
 * @param {readonly Claim[]} claims
 * @returns {{ claim: Claim, name: string, text: string }[]}
 */
export function compileSources(claims) {
  return claims
    .filter((claim) => claim.state === 'compile')
    .map((claim, index) => ({
      claim,
      name: `src/c${String(index)}.${claim.lang === 'tsx' ? 'tsx' : 'ts'}`,
      text: `${claim.body}\nexport {};\n`,
    }));
}

/**
 * `tsc --pretty false` output by file: the line of each `error TSnnnn`, and its message.
 *
 * @param {string} output
 * @returns {Map<string, { line: number, message: string }[]>}
 */
export function tscDiagnostics(output) {
  /** @type {Map<string, { line: number, message: string }[]>} */
  const byFile = new Map();
  for (const match of output.matchAll(/^(src\/c\d+\.tsx?)\((\d+),\d+\): (error TS\d+: .*)$/gmu)) {
    const [, file = '', line = '0', message = ''] = match;
    byFile.set(file, [...(byFile.get(file) ?? []), { line: Number(line), message }]);
  }
  return byFile;
}

/**
 * The claims that need no container: file copies, the stack builder's flags, the install block;
 * plus a row for every illustrative and generated claim.
 *
 * @param {readonly Claim[]} claims @param {readonly string[]} questionFlags
 * @returns {Row[]}
 */
export function staticRows(claims, questionFlags) {
  /** @type {Row[]} */
  const rows = [];
  for (const claim of claims) {
    if (claim.state === 'file') {
      const problems = galleryProblems([claim], readRepositoryFile);
      rows.push({
        where: whereOf(claim),
        state: 'file',
        what: claim.file ?? '',
        result: problems.length === 0 ? 'pass' : 'FAIL: differs from the file',
        detail: problems.join('\n'),
      });
    } else if (claim.state === 'illustrative') {
      rows.push({
        where: whereOf(claim),
        state: 'illustrative',
        what: firstLine(claim.body),
        result: 'labelled on the page',
      });
    } else if (claim.state === 'generated') {
      rows.push({
        where: whereOf(claim),
        state: 'generated',
        what: firstLine(claim.body),
        result: 'checked by pnpm docs:check',
      });
    }
  }
  const flags = stackFlagProblems(readRepositoryFile(STACK_BUILDER) ?? '', questionFlags);
  rows.push({
    where: STACK_BUILDER,
    state: 'file',
    what: 'CREATE_FLAGS against SETUP_QUESTIONS',
    result: flags.length === 0 ? 'pass' : 'FAIL: a flag npm create does not have',
    detail: flags.join('\n'),
  });
  const installs = installProblems(claims);
  rows.push({
    where: 'README.md, quickstart.mdx, index.html',
    state: 'file',
    what: 'one non-interactive install block',
    result: installs.length === 0 ? 'pass' : 'FAIL: the install blocks differ',
    detail: installs.join('\n'),
  });
  return rows;
}
