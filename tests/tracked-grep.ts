/**
 * One `git grep -l` over the tracked tree, for the gates that assert a literal occurs only where it
 * should. The answer is the matching repo-relative paths.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs `git grep <args>` at the repository root; `args` must ask for file names (`-l`). `git grep`
 * exits 1 when nothing matches, which is an answer (no files), not a failure: the gate then fails
 * on its own readable assertion. Any other exit still throws.
 */
export function trackedFilesMatching(args: readonly string[]): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['grep', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (error) {
    if (isNoMatch(error)) return [];
    throw error;
  }
  return output.split('\n').filter((file) => file !== '');
}

function isNoMatch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 1 &&
    'stderr' in error &&
    String(error.stderr) === ''
  );
}
