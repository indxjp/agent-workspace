import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderValueList } from './schema/one-of.js';
import { storageAreas } from '../storage/storage-areas.js';

const MIGRATIONS = new URL('../../../../migrations/', import.meta.url);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
}

describe('storage areas', () => {
  // @story US-STO-02
  it('[US-STO-02][unit][sdk] lists the five areas of the storage design', () => {
    expect([...storageAreas]).toEqual(['files', 'skills', 'session-state', 'artifacts', 'staging']);
  });

  // @story US-STO-02
  it('[US-STO-02][unit][sdk] matches the files_area_valid check in the latest migration snapshot', () => {
    const journal = readJson('meta/_journal.json') as { entries: readonly { idx: number }[] };
    const last = journal.entries.reduce((a, b) => (b.idx > a.idx ? b : a));
    const snapshot = readJson(`meta/${String(last.idx).padStart(4, '0')}_snapshot.json`) as {
      tables: Record<string, { checkConstraints: Record<string, { value: string }> }>;
    };
    expect(
      snapshot.tables['public.files']?.checkConstraints['files_area_valid']?.value,
      'run `pnpm db:generate` to add a migration for the area list',
    ).toBe(`"files"."area" in ${renderValueList(storageAreas)}`);
  });
});
