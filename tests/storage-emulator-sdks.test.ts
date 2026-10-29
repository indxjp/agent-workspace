/**
 * The Azure and Google Cloud storage SDKs belong to `packages/core` (the storage design, §07
 * rule 1). Root tests open an emulator store through `@agent-workspace/core/storage/backends`, so
 * the root manifest declares neither SDK and no root test imports one (#1746). A root declaration
 * also made the web build stage `@azure/storage-blob` from the root, which `packages/embedded` had
 * to pin in turn.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REPO_ROOT, trackedFilesMatching } from './tracked-grep.js';

const STORAGE_SDKS = ['@azure/storage-blob', '@google-cloud/storage'] as const;

const manifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function declared(manifestPath: string): readonly string[] {
  const parsed = manifest.parse(JSON.parse(readFileSync(`${REPO_ROOT}/${manifestPath}`, 'utf8')));
  return Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
}

describe('root tests reach the cloud storage SDKs only through core (#1746)', () => {
  it('the root manifest declares neither SDK', () => {
    const sdks: readonly string[] = STORAGE_SDKS;
    expect(declared('package.json').filter((name) => sdks.includes(name))).toEqual([]);
  });

  it('packages/embedded no longer pins @azure/storage-blob for the root', () => {
    expect(declared('packages/embedded/package.json')).not.toContain('@azure/storage-blob');
  });

  it('no root test or script imports either SDK', () => {
    const importers = STORAGE_SDKS.flatMap((sdk) =>
      trackedFilesMatching(['-l', '-F', `from '${sdk}'`, '--', 'tests', 'scripts']),
    );
    expect(importers).toEqual([]);
  });
});
