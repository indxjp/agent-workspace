#!/usr/bin/env node
// PR size soft gate (engineering audit W4-5, F-17). A diff above LIMIT changed lines, generated
// files excluded, must carry a `Large PR justification: <why>` line in the PR body.
// "Generated" is whatever .gitattributes marks `linguist-generated`, so there is one list.
//
//   node scripts/ci/check-pr-size.mjs --base <sha> --head <sha>   (PR body from $PR_BODY)
//
// Node built-ins only. The PR body is untrusted: it arrives through the environment and is only
// ever matched against a regular expression.

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { parseArgs } from 'node:util';

export const LIMIT = 3000;

/**
 * Sum added + deleted lines of `git diff --numstat -z --no-renames`, skipping excluded paths.
 * Binary files (`-`) count as zero.
 * @param {string} numstat
 * @param {(path: string) => boolean} isGenerated
 * @returns {number}
 */
export function countChangedLines(numstat, isGenerated) {
  let total = 0;
  for (const record of numstat.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/su.exec(record);
    if (!match || isGenerated(match[3] ?? '')) continue;
    total += Number(match[1] === '-' ? 0 : match[1]) + Number(match[2] === '-' ? 0 : match[2]);
  }
  return total;
}

/**
 * The justification text, or null when the body has none (a placeholder is not a reason).
 * @param {string} body
 * @returns {string | null}
 */
export function findJustification(body) {
  const match = /^[ \t]*Large PR justification:[ \t]*(\S[^\r\n]*)$/mu.exec(body);
  const text = match?.[1]?.trim() ?? '';
  return text.length >= 10 && !/^<.*>$/u.test(text) ? text : null;
}

/**
 * @param {number} lines
 * @param {string} body
 * @returns {{ok: boolean, message: string}}
 */
export function evaluate(lines, body) {
  if (lines <= LIMIT) return { ok: true, message: `${lines} changed lines (limit ${LIMIT}).` };
  if (findJustification(body)) {
    return { ok: true, message: `${lines} changed lines exceed ${LIMIT}; justification present.` };
  }
  return {
    ok: false,
    message:
      `${lines} changed lines (generated files excluded) exceed ${LIMIT}. Split the PR, or add a ` +
      'line "Large PR justification: <why it cannot be split>" to the PR body.',
  };
}

/**
 * Paths among `paths` that .gitattributes marks linguist-generated at HEAD.
 * @param {string[]} paths
 * @returns {Set<string>}
 */
function generatedPaths(paths) {
  const generated = new Set();
  if (paths.length === 0) return generated;
  const out = execFileSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated'], {
    input: paths.join('\0'),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).split('\0');
  for (let i = 0; i + 2 < out.length; i += 3) {
    if (out[i + 2] === 'set' || out[i + 2] === 'true') generated.add(out[i] ?? '');
  }
  return generated;
}

function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base || !values.head) throw new Error('--base and --head are required');
  const numstat = execFileSync(
    'git',
    ['diff', '--numstat', '-z', '--no-renames', `${values.base}...${values.head}`],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const paths = numstat
    .split('\0')
    .map((r) => /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/su.exec(r)?.[1])
    .filter((p) => p !== undefined);
  const generated = generatedPaths(paths);
  const result = evaluate(
    countChangedLines(numstat, (p) => generated.has(p)),
    process.env['PR_BODY'] ?? '',
  );
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-pr-size.mjs')) main();
