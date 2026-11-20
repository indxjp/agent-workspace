// The repository side of the duplicate-vocabulary rule (F-12): the tracked files it reads, and the
// comparison with the allowlist. The scan itself is ./vocabulary-scan.ts. Used by the rule's unit
// cases (tests/duplicate-vocabulary.test.ts) and by its run over the tracked tree
// (tests/duplicate-vocabulary.policy-check.ts, `pnpm policy:check`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { contractVocabularies, type Vocabularies } from './vocabulary-scan.js';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const ALLOWLIST = 'tests/fitness/duplicate-vocabulary-allowlist.json';

export function tracked(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
}

export function read(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, readFileSync(root + file, 'utf8')]));
}

/** The closed vocabularies packages/contracts declares. */
export function trackedContractVocabularies(): Vocabularies {
  return contractVocabularies(
    read(tracked('packages/contracts/src/*.ts', 'packages/contracts/src/**/*.ts')),
  );
}

/** Shared by the real scan and the fixtures: (new re-declarations, stale allowlist entries). */
export function compare(found: readonly string[], allowed: readonly string[]) {
  return {
    added: found.filter((key) => !allowed.includes(key)),
    stale: allowed.filter((key) => !found.includes(key)),
  };
}
