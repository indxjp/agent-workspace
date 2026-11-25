/**
 * Run Vitest in a child process from a kit test: the coverage rule's fixture run and the
 * scoreboard's contract run. The child gets none of the parent's `VITEST*` variables, so it neither
 * thinks it is a worker of the parent run nor writes the parent's reports, except the worker cap
 * `VITEST_MAX_WORKERS`, which it keeps so a nested run shares the runner as the parent does.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');

export interface VitestRun {
  readonly status: number | null;
  readonly output: string;
}

/** `extraEnv` adds variables to the child's environment, after the parent's are filtered. */
export function runVitest(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): VitestRun {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('VITEST') || key === 'VITEST_MAX_WORKERS',
    ),
  );
  const run = spawnSync(
    process.execPath,
    [path.join(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...args],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', env: { ...env, ...extraEnv, NO_COLOR: '1' } },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}
