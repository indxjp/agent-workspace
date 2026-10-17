/**
 * The §15.2 spec-transcription gate for `network-policy.ts`.
 *
 * Two tests, matching this task's Accept line exactly:
 *
 *   1. A test reads §15.2's markdown table out of `docs/spec.md` and asserts the stored mapping
 *      has one row per driver × one cell per policy, with the cell text equal to the spec's.
 *   2. A test asserts §15.2's rule directly: for every driver, the `none` mapping's recorded
 *      meaning is "the gateway and nothing else" and never "no network at all", and any cell whose
 *      spec text contradicts that rule must carry a non-empty divergence or fail.
 *
 * Both read `docs/spec.md` at test time and never transcribe a value by hand (ADR-0016): the
 * driver list, the cell text, the rule's own wording, and the set of drivers §15.2 itself names as
 * "a single all-or-nothing switch" are all parsed out of the tracked file. `docker`'s membership
 * in the divergence set is the one addition this file does not find in that sentence — it is
 * asserted as a named, exact extension (`derivedFromSpec.add('docker')`), never grown silently
 * (ADR-0031), and the accompanying comment says why (the specification defect
 * the Wave 3 plan records).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NONE_MEANING,
  networkPolicyIds,
  networkPolicyMapping,
  restrictedUnenforceableReason,
  type NetworkPolicyId,
} from './network-policy';

const SPEC_PATH = path.resolve(import.meta.dirname, '../../../../docs/spec.md');
const specText = readFileSync(SPEC_PATH, 'utf8');

/** The §15.2 section's own text, from its heading to the next `## ` heading. */
function section15_2(): string {
  const start = specText.indexOf('## 15.2 How the network policy maps to each driver');
  if (start === -1) {
    throw new Error('docs/spec.md has no "## 15.2" heading; this gate cannot run.');
  }
  const rest = specText.slice(start + 1);
  const nextHeading = rest.search(/\n## /u);
  const end = nextHeading === -1 ? specText.length : start + 1 + nextHeading;
  return specText.slice(start, end);
}

/** One markdown table row, with a leading and trailing pipe, split into trimmed cells. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    throw new Error(`not a table row: ${trimmed}`);
  }
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map((c) => c.trim());
}

interface ParsedTable {
  readonly policyColumns: readonly NetworkPolicyId[];
  readonly rows: ReadonlyMap<string, Readonly<Record<NetworkPolicyId, string>>>;
}

/** Strip every backtick from a header cell and take the first bare word — its policy id. */
function headerPolicyId(cellText: string): NetworkPolicyId {
  const match = /^`([a-z]+)`/u.exec(cellText);
  const candidate = match?.[1] ?? cellText.trim().toLowerCase();
  if ((networkPolicyIds as readonly string[]).includes(candidate)) {
    return candidate as NetworkPolicyId;
  }
  throw new Error(`the table header cell ${JSON.stringify(cellText)} does not name a known policy`);
}

/**
 * Parse §15.2's table: the header row (`| Driver | ... |`), its separator, and every data row up
 * to the first line that is not itself a table row.
 */
function parseSpecTable(): ParsedTable {
  const lines = section15_2().split('\n');
  const headerIndex = lines.findIndex((line) => line.trim().startsWith('| Driver'));
  if (headerIndex === -1) {
    throw new Error(
      '§15.2 has no table whose header starts with "| Driver"; this gate cannot run.',
    );
  }
  const headerCells = splitRow(lines[headerIndex] ?? '');
  const policyColumns = headerCells.slice(1).map(headerPolicyId);

  const separatorIndex = headerIndex + 1;
  if (!(lines[separatorIndex] ?? '').trim().startsWith('|')) {
    throw new Error("§15.2's table has no separator row after its header; this gate cannot run.");
  }

  const rows = new Map<string, Record<NetworkPolicyId, string>>();
  for (let i = separatorIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    const driverCell = cells[0];
    if (driverCell === undefined) throw new Error(`table row has no driver cell: ${line}`);
    const driver = driverCell.replaceAll('`', '').trim();
    const record: Partial<Record<NetworkPolicyId, string>> = {};
    policyColumns.forEach((policy, index) => {
      const text = cells[index + 1];
      if (text === undefined) {
        throw new Error(`row for ${driver} has no cell for policy ${policy}`);
      }
      record[policy] = text;
    });
    rows.set(driver, record as Record<NetworkPolicyId, string>);
  }
  if (rows.size === 0) throw new Error("§15.2's table has no data rows; this gate cannot run.");
  return { policyColumns, rows };
}

/**
 * The exact quoted phrase in §15.2's rule sentence: `` `none` must always mean "X", never "Y" ``.
 * Returns X. Throws if the sentence is not found — a check that cannot run must fail (ADR-0015).
 */
function extractNoneMeaning(): string {
  const match = /`none` must always mean "([^"]+)", never "([^"]+)"/u.exec(section15_2());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(
      '§15.2 has no sentence of the form `none` must always mean "...", never "..."; this gate ' +
        'cannot derive the rule it is meant to check.',
    );
  }
  return match[1];
}

/** The forbidden meaning from the same sentence — used to assert no row's data recites it. */
function extractForbiddenMeaning(): string {
  const match = /`none` must always mean "([^"]+)", never "([^"]+)"/u.exec(section15_2());
  if (match?.[2] === undefined) {
    throw new Error('§15.2\'s rule sentence has no "never ..." clause; this gate cannot run.');
  }
  return match[2];
}

/**
 * The drivers §15.2's remedy paragraph names as having "a single all-or-nothing switch" —
 * extracted from the parenthesised list right after that phrase, not retyped.
 */
function extractAllOrNothingDrivers(): readonly string[] {
  const match = /single all-or-nothing switch\s*\(([^)]*)\)/u.exec(section15_2());
  if (match?.[1] === undefined) {
    throw new Error(
      '§15.2 has no "single all-or-nothing switch (...)" parenthetical; this gate cannot derive ' +
        'the driver list its remedy paragraph names.',
    );
  }
  // A driver id, not `--allow-egress` (present in the same parenthetical as "without
  // `--allow-egress`") — a driver id never begins with a hyphen, so anchoring on a leading letter
  // excludes it without a hand-picked exclusion list.
  const drivers = [...match[1].matchAll(/`([a-z][a-z0-9-]*)`/gu)].map((m) => m[1] as string);
  if (drivers.length === 0) {
    throw new Error('the "single all-or-nothing switch (...)" parenthetical named no driver.');
  }
  return drivers;
}

describe('the §15.2 table equals the stored mapping, cell for cell', () => {
  const table = parseSpecTable();

  it('has at least one row and one policy column to compare (the gate itself is not vacuous)', () => {
    expect(table.rows.size).toBeGreaterThan(0);
    expect(table.policyColumns.length).toBeGreaterThan(0);
  });

  it('lists exactly the drivers the spec table lists — none missing, none invented', () => {
    const specDrivers = [...table.rows.keys()].sort();
    const storedDrivers = networkPolicyMapping.map((row) => row.driver).sort();
    expect(storedDrivers).toEqual(specDrivers);
  });

  it.each([...table.rows.keys()])(
    "driver %s: every policy cell equals §15.2's own text",
    (driver) => {
      const specRow = table.rows.get(driver);
      const storedRow = networkPolicyMapping.find((row) => row.driver === driver);
      expect(storedRow, `${driver} is in §15.2 but not in the stored mapping`).toBeDefined();
      if (specRow === undefined || storedRow === undefined) return;
      for (const policy of table.policyColumns) {
        expect(
          storedRow.cells[policy].specCellText,
          `${driver} × ${policy}: stored cell text must equal §15.2's`,
        ).toBe(specRow[policy]);
      }
    },
  );

  it('carries one cell per policy column for every stored row — no policy silently missing', () => {
    for (const row of networkPolicyMapping) {
      for (const policy of table.policyColumns) {
        expect(row.cells[policy], `${row.driver} has no cell for ${policy}`).toBeDefined();
      }
    }
  });
});

describe('§15.2\'s rule: `none` always means "the gateway and nothing else"', () => {
  const meaning = extractNoneMeaning();
  const forbidden = extractForbiddenMeaning();

  it("the rule's own wording is what this file's NONE_MEANING constant carries", () => {
    expect(meaning).toBe(NONE_MEANING);
    expect(forbidden).toBe('no network at all');
  });

  it.each(networkPolicyMapping.map((row) => row.driver))(
    "%s records `none` as meaning the rule's phrase, never the forbidden one",
    (driver) => {
      const row = networkPolicyMapping.find((r) => r.driver === driver);
      expect(row?.noneMeaning).toBe(meaning);
      expect(row?.noneMeaning).not.toBe(forbidden);
    },
  );

  it("the exact set of drivers needing a `none` divergence is the spec's own list plus the declared docker addition", () => {
    // Derived from §15.2's remedy paragraph, not retyped (ADR-0016) — plus exactly one named,
    // declared addition (ADR-0031): docker, whose --network none is a measured all-or-nothing
    // switch that paragraph's own criteria describe but does not list (the specification defect
    // the Wave 3 plan "What this plan corrects" item 6 records).
    const derived = new Set(extractAllOrNothingDrivers());
    derived.add('docker');

    const actualDiverging = networkPolicyMapping
      .filter((row) => row.cells.none.divergence !== null)
      .map((row) => row.driver)
      .sort();

    expect(actualDiverging).toEqual([...derived].sort());
  });

  it('every divergence for `none` is non-empty: an actual behaviour, an enforcement point and a citation', () => {
    for (const row of networkPolicyMapping) {
      const divergence = row.cells.none.divergence;
      if (divergence === null) continue;
      expect(divergence.actual.length, `${row.driver}: divergence.actual is empty`).toBeGreaterThan(
        0,
      );
      expect(
        divergence.specCitation.length,
        `${row.driver}: divergence.specCitation is empty`,
      ).toBeGreaterThan(0);
      expect(['platform', 'network', 'proxy']).toContain(divergence.enforcementPoint);
    }
  });

  it('a row with no divergence never recites the forbidden meaning in its own cell text either', () => {
    // Guards the classification itself: a row this file marks compliant (divergence: null) must
    // not be one whose §15.2 cell text is itself the literal forbidden phrase.
    for (const row of networkPolicyMapping) {
      if (row.cells.none.divergence !== null) continue;
      expect(row.cells.none.specCellText.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('restrictedUnenforceableReason: whether a driver enforces allowed domains (#1018)', () => {
  it('is null only for docker and kubernetes with the egress proxy', () => {
    expect(restrictedUnenforceableReason('docker', true)).toBeNull();
    expect(restrictedUnenforceableReason('kubernetes', true)).toBeNull();
    expect(restrictedUnenforceableReason('docker', false)).toContain(
      'AGENT_WORKSPACE_EGRESS_PROXY_IMAGE',
    );
  });

  it('refuses external (E2B) with or without the proxy, until the E7 live lane proves the ranges', () => {
    expect(restrictedUnenforceableReason('external', true)).not.toBeNull();
    expect(restrictedUnenforceableReason('external', false)).not.toBeNull();
  });
});
