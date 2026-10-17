/**
 * The claims that need no container (issue #880): a doc copy of a repository file still equals it,
 * the landing page's stack builder only writes flags `npm create` has, and the README, the landing
 * page and the quickstart show one and the same install block. Each check returns the problems it
 * found, each starting with `page:line`, and reads files only through the arguments it is given.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { extractRepositoryClaims, shellCommands } from './extract.mjs';

/** The non-interactive install block, as commands: the one every page shows. */
export const INSTALL_COMMANDS = Object.freeze([
  'npm create @indx-workspace@latest my-agent -- --yes',
  'cd my-agent',
  'npm run dev',
]);

/** The pages that each show it. */
export const INSTALL_PAGES = Object.freeze([
  'README.md',
  'docs/sdk/site/getting-started/quickstart.mdx',
  'sites/lp/index.html',
]);

const STACK_BUILDER = 'sites/lp/assets/site.js';
const ELISION = /…|\.\.\./u;

/** @param {string} text */
const lines = (text) =>
  text
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd());

/** @param {string} text */
const trimmed = (text) =>
  lines(text)
    .join('\n')
    .replace(/^\n+|\n+$/gu, '');

/**
 * Whether every line of an excerpt is in the file, in order. A line may elide with `…` (the text
 * between two pieces is skipped); a line that is only an elision, or a comment of one, is skipped.
 *
 * @param {string} excerpt @param {string} file
 * @returns {string | null} the first piece of the excerpt the file does not have, or null
 */
function missingFromFile(excerpt, file) {
  let at = 0;
  for (const line of lines(excerpt)) {
    for (const piece of line.split(ELISION)) {
      const wanted = piece.trim();
      if (wanted === '' || /^(\/\/|#)$/u.test(wanted)) continue;
      const found = file.indexOf(wanted, at);
      if (found < 0) return wanted;
      at = found + wanted.length;
    }
  }
  return null;
}

/** @param {string} copy @param {string} file */
function firstDifference(copy, file) {
  const have = lines(copy);
  const want = lines(file);
  for (let index = 0; index < Math.max(have.length, want.length); index += 1) {
    if (have[index] !== want[index]) {
      return `line ${String(index + 1)}: the page has ${JSON.stringify(have[index] ?? '(nothing)')}, the file ${JSON.stringify(want[index] ?? '(nothing)')}`;
    }
  }
  return 'no difference';
}

/**
 * Every `file=` claim against the file it names. `file=<path>` is a whole file; `file=<path>#excerpt`
 * is lines of it, in order.
 *
 * @param {readonly import('./extract.mjs').Claim[]} claims
 * @param {(file: string) => string | undefined} read repository-relative path to its text
 * @returns {string[]}
 */
export function galleryProblems(claims, read) {
  /** @type {string[]} */
  const problems = [];
  for (const claim of claims) {
    if (claim.state !== 'file' || claim.file === undefined) continue;
    const [file = '', mode] = claim.file.split('#');
    const where = `${claim.page}:${String(claim.line)}`;
    const text = read(file);
    if (text === undefined) {
      problems.push(`${where}: names ${file}, which does not exist`);
    } else if (mode === 'excerpt') {
      const missing = missingFromFile(claim.body, text);
      if (missing !== null) {
        problems.push(
          `${where}: ${file} no longer has ${JSON.stringify(missing)}; update the page`,
        );
      }
    } else if (mode !== undefined) {
      problems.push(`${where}: unknown file= mode "#${mode}"; the only one is #excerpt`);
    } else if (trimmed(claim.body) !== trimmed(text)) {
      problems.push(
        `${where}: differs from ${file} (${firstDifference(trimmed(claim.body), trimmed(text))}); update the page or the file`,
      );
    }
  }
  return problems;
}

/**
 * The flags the stack builder writes (`CREATE_FLAGS` in `site.js`) against the flags of the setup
 * questions.
 *
 * @param {string} siteJs @param {readonly string[]} questionFlags flags without the dashes
 * @returns {string[]}
 */
export function stackFlagProblems(siteJs, questionFlags) {
  const declared = /var CREATE_FLAGS = \{([^}]*)\}/u.exec(siteJs)?.[1];
  if (declared === undefined) return [`${STACK_BUILDER}: has no CREATE_FLAGS to check`];
  const written = [...declared.matchAll(/"--([a-z][a-z-]*)"/gu)].map((match) => match[1] ?? '');
  if (written.length === 0) return [`${STACK_BUILDER}: CREATE_FLAGS names no flag`];
  return written
    .filter((flag) => !questionFlags.includes(flag))
    .map(
      (flag) =>
        `${STACK_BUILDER}: the stack builder writes --${flag}, which no setup question has (SETUP_QUESTIONS)`,
    );
}

/**
 * The install block on each page that shows it: the same commands, in the same order.
 *
 * @param {readonly import('./extract.mjs').Claim[]} claims
 * @returns {string[]}
 */
export function installProblems(claims) {
  /** @type {string[]} */
  const problems = [];
  for (const page of INSTALL_PAGES) {
    const blocks = claims.filter((claim) => {
      if (claim.page !== page || claim.state !== 'run') return false;
      const commands = shellCommands(claim.body);
      return commands.includes(INSTALL_COMMANDS[0] ?? '') && commands.includes('npm run dev');
    });
    if (blocks.length === 0) {
      problems.push(`${page}: shows no run install block (${INSTALL_COMMANDS.join(', ')})`);
    }
    for (const block of blocks) {
      const commands = shellCommands(block.body);
      if (commands.join('\n') !== INSTALL_COMMANDS.join('\n')) {
        problems.push(
          `${page}:${String(block.line)}: the install block runs ${JSON.stringify(commands)}, not ${JSON.stringify(INSTALL_COMMANDS)}`,
        );
      }
    }
  }
  return problems;
}

/**
 * All three checks on a checkout.
 *
 * @param {string} root repository root @param {readonly string[]} questionFlags
 * @returns {string[]}
 */
export function staticProblems(root, questionFlags) {
  const claims = extractRepositoryClaims(root);
  /** @param {string} file */
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  return [
    ...galleryProblems(claims, read),
    ...stackFlagProblems(read(STACK_BUILDER) ?? '', questionFlags),
    ...installProblems(claims),
  ];
}
