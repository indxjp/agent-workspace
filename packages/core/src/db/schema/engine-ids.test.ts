import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';

import { engineIds } from './agents.js';
import { renderValueList } from './one-of.js';

const TABLES = [
  'runs',
  'sessions',
  'session_state_blobs',
  'session_state_entries',
  'session_state_streams',
] as const;

type Snapshot = {
  readonly tables: Readonly<
    Record<
      string,
      { readonly checkConstraints: Readonly<Record<string, { readonly value: string }>> }
    >
  >;
};

const MIGRATIONS = new URL('../../../../../migrations/', import.meta.url);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
}

function latestSnapshot(): Snapshot {
  const journal = readJson('meta/_journal.json') as { entries: readonly { idx: number }[] };
  const last = journal.entries.reduce((a, b) => (b.idx > a.idx ? b : a));
  return readJson(`meta/${String(last.idx).padStart(4, '0')}_snapshot.json`) as Snapshot;
}

/** The tables whose latest-snapshot engine CHECK does not list `ids`. */
function staleTables(snapshot: Snapshot, ids: readonly string[]): readonly string[] {
  return TABLES.filter((table) => {
    const value =
      snapshot.tables[`public.${table}`]?.checkConstraints[`${table}_engine_valid`]?.value;
    return value !== `"${table}"."engine" in ${renderValueList(ids)}`;
  });
}

describe('engine CHECK constraints', () => {
  it('uses the contracts engine list', () => {
    expect(engineIds).toBe(ENGINE_IDS);
  });

  it('lists every engine in the latest migration snapshot', () => {
    expect(
      staleTables(latestSnapshot(), ENGINE_IDS),
      'run `pnpm --filter @agent-workspace/core db:generate` to add a migration for the engine list',
    ).toStrictEqual([]);
  });

  it('names the tables whose snapshot lacks an engine', () => {
    const ids = ENGINE_IDS.filter((id) => id !== 'mastra');

    expect(staleTables(latestSnapshot(), ids)).toStrictEqual([...TABLES]);
  });
});
