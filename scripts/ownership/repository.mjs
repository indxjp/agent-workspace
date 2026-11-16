import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// ── Repository tree ─────────────────────────────────────────────────────────────────────

/** @param {string} output */
export function nulSeparatedPaths(output) {
  return output.split('\0').filter(Boolean);
}

export function trackedFiles() {
  try {
    return nulSeparatedPaths(
      execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    );
  } catch {
    return [];
  }
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** @param {string|undefined} base
 * @param {string|undefined} head */
export function gitDiffFiles(base, head) {
  const range = base && head ? `${base}...${head}` : base ? `${base}...HEAD` : 'HEAD~1...HEAD';
  return nulSeparatedPaths(
    execFileSync('git', ['diff', '--name-only', '-z', range], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }),
  );
}

/** `git`, with stderr surfaced in the thrown message rather than swallowed. */
/** @param {...string} argv */
export function git(...argv) {
  return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** @param {...string} argv */
function gitLines(...argv) {
  return git(...argv)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every merge on this branch's first-parent path, with the commits it merged in.
 *
 * `--first-parent` on purpose: those are the merges this branch performed. A merge that arrived
 * *inside* one of the merged branches is that branch's own history, and its files are already
 * attributed to it by the diff below — counting it here as well would let an integration branch
 * inherit a declaration nobody wrote on this PR.
 *
 * @returns {{merge: string, parents: string[]}[]}
 */
/** @param {string} base
 * @param {string} head
 * @returns {{merge:string,parents:string[]}[]} */
export function mergeParents(base, head) {
  const merges = gitLines('rev-list', '--merges', '--first-parent', `${base}..${head}`);
  return merges.map((merge) => {
    const line = git('rev-list', '--parents', '-n', '1', merge).trim().split(/\s+/);
    return { merge, parents: line.slice(1) };
  });
}
