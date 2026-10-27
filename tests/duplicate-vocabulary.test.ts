import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contractVocabularies, findRedeclarations } from './fitness/vocabulary-scan.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ALLOWLIST = 'tests/fitness/duplicate-vocabulary-allowlist.json';

function tracked(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
}

function read(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, readFileSync(root + file, 'utf8')]));
}

/** Shared by the real scan and the fixtures: (new re-declarations, stale allowlist entries). */
function compare(found: readonly string[], allowed: readonly string[]) {
  return {
    added: found.filter((key) => !allowed.includes(key)),
    stale: allowed.filter((key) => !found.includes(key)),
  };
}

describe('closed vocabularies owned by packages/contracts are not re-declared (F-12)', () => {
  const contractFiles = tracked('packages/contracts/src/*.ts', 'packages/contracts/src/**/*.ts');
  const vocabularies = contractVocabularies(read(contractFiles));

  it('finds the contracts tuples this rule is about', () => {
    for (const name of [
      'RUN_STATUSES',
      'TERMINAL_RUN_STATUSES',
      'SESSION_STATUSES',
      'MEMBERSHIP_ROLES',
      'EVALUATION_RUN_STATUSES',
    ]) {
      expect(vocabularies.has(name), name).toBe(true);
    }
  });

  it('flags a planted literal array and a planted union, and ignores subsets', () => {
    const planted = new Map([
      ['a.ts', "const X = ['owner', 'viewer', 'admin', 'builder'] as const;"],
      ['b.ts', "type S = 'archived' | 'active';"],
      ['c.ts', "const Y = ['completed', 'failed'];"],
    ]);
    expect(findRedeclarations(planted, vocabularies)).toEqual([
      'a.ts::MEMBERSHIP_ROLES',
      'b.ts::SESSION_STATUSES',
    ]);
  });

  it('fails on a new re-declaration and on a stale allowlist entry', () => {
    expect(compare(['a.ts::RUN_STATUSES'], [])).toEqual({
      added: ['a.ts::RUN_STATUSES'],
      stale: [],
    });
    expect(compare([], ['a.ts::RUN_STATUSES'])).toEqual({
      added: [],
      stale: ['a.ts::RUN_STATUSES'],
    });
  });

  it('has exactly the allowlisted re-declarations, so the list can only shrink', () => {
    const files = tracked('apps', 'packages', 'ui', 'scripts').filter(
      (file) =>
        /\.(?:ts|tsx|mts)$/u.test(file) &&
        !/\.(?:test|spec)\.tsx?$/u.test(file) &&
        !file.endsWith('.d.ts') &&
        !file.startsWith('packages/contracts/'),
    );
    const allowed = JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as string[];
    const { added, stale } = compare(findRedeclarations(read(files), vocabularies), allowed);
    expect(added, `re-declared contracts vocabulary: import it from contracts instead`).toEqual([]);
    expect(stale, `stale entries: delete them from ${ALLOWLIST}`).toEqual([]);
  });
});
