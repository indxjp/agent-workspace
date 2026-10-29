/**
 * The `STORAGE_CONNECTION_` prefix decides which secret is a storage connection's credential, and
 * every check that keeps that credential out of a tool sandbox, a connector identity or the generic
 * secrets routes reads it. A second copy of the literal could drift from the first and reopen one
 * of those paths, so it is spelled once, in `@indx-workspace/contracts/secret-reference`, and every
 * shipping file in the contracts, core, the gateway and the web server takes it from there.
 */
// @story US-STO-12
import {
  isStorageConnectionSecretName,
  STORAGE_CONNECTION_SECRET_PREFIX,
} from '@indx-workspace/contracts/secret-reference';
import { describe, expect, it } from 'vitest';

import { trackedFilesMatching } from '../../../../tests/tracked-grep';

import { storageConnectionIdOf } from './contract';

const DEFINITION = 'packages/contracts/src/secret-reference.ts';
const SCANNED = [
  'packages/contracts/src',
  'packages/core/src',
  'packages/gateway/src',
  'apps/web/server',
];

describe('the storage connection secret prefix', () => {
  it('is spelled once, in the contracts, in every shipping file that checks it', () => {
    const literal = ['STORAGE', 'CONNECTION', ''].join('_');
    // The prefix as code: closed by a quote, followed by a regex group or by an interpolation. A
    // longer constant name (`…_PROBLEM_CODES`) and a doc comment's `…_` are not copies of it. One
    // `git grep` process reads the files, so the scan stays one bounded call under coverage.
    const files = trackedFilesMatching([
      '-lE',
      `${literal}(['"(]|\\$\\{)`,
      '--',
      ...SCANNED.flatMap((root) => [`${root}/*.ts`, `${root}/*.tsx`]),
      ':!*.test.ts',
      ':!*.test.tsx',
    ]);
    // The definition always matches, so an empty answer means the scan itself is broken; it fails
    // here, on the comparison, rather than as a git exit status.
    expect(files).toEqual([DEFINITION]);
  });

  it('names a connection credential by its id, and nothing else', () => {
    const id = '77777777-7777-4777-8777-777777777777';
    const name = `${STORAGE_CONNECTION_SECRET_PREFIX}${id.replaceAll('-', '').toUpperCase()}`;
    expect(isStorageConnectionSecretName(name)).toBe(true);
    expect(storageConnectionIdOf(name)).toBe(id);
    expect(isStorageConnectionSecretName('STORAGE_CONNECTIONS')).toBe(false);
    expect(storageConnectionIdOf(`${STORAGE_CONNECTION_SECRET_PREFIX}ANYTHING`)).toBeNull();
  });
});
