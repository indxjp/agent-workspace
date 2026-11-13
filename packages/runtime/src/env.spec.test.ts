import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { A11_CONDITIONAL_ENV_VARS, A11_UNCONDITIONAL_ENV_VARS } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(HERE, '../../..');

const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

type A11Row =
  | {
      readonly kind: 'single';
      readonly name: string;
      readonly value: string;
      readonly line: number;
    }
  | {
      readonly kind: 'double';
      readonly names: readonly [string, string];
      readonly value: string;
      readonly line: number;
    }
  | {
      readonly kind: 'prose';
      readonly text: string;
      readonly value: string;
      readonly line: number;
    };

const SINGLE_IDENTIFIER = /^`([A-Za-z0-9_]+)`$/;

const DOUBLE_IDENTIFIER = /^`([A-Za-z0-9_]+)`\s*\/\s*`([A-Za-z0-9_]+)`$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cell.trim());
}

function parseA11Row(lineText: string, lineNumber: number): A11Row {
  const [firstCell = '', value = ''] = splitRow(lineText);
  const doubleMatch = DOUBLE_IDENTIFIER.exec(firstCell);
  if (doubleMatch?.[1] !== undefined && doubleMatch[2] !== undefined) {
    return { kind: 'double', names: [doubleMatch[1], doubleMatch[2]], value, line: lineNumber };
  }
  const singleMatch = SINGLE_IDENTIFIER.exec(firstCell);
  if (singleMatch?.[1] !== undefined)
    return { kind: 'single', name: singleMatch[1], value, line: lineNumber };
  if (!firstCell.includes('`') && firstCell.length > 0)
    return { kind: 'prose', text: firstCell, value, line: lineNumber };
  throw new Error(
    `parseA11Table: docs/spec.md:${String(lineNumber)} does not parse as a single identifier, a pair of identifiers, or plain prose: ${JSON.stringify(firstCell)}.`,
  );
}

function parseA11Table(specText: string): A11Row[] {
  const lines = specText.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => line.trim() === '## A.11 Environment contract for every runtime',
  );
  if (headingIndex === -1) {
    throw new Error(
      `parseA11Table: docs/spec.md has no "## A.11 Environment contract for every runtime" heading; the section may have been renamed.`,
    );
  }
  // The table starts at the first line after the heading that begins with "|" and ends at the
  // first line after that which does not (a blank line closes every markdown table).
  let tableStart = -1;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim().startsWith('|')) {
      tableStart = i;
      break;
    }
  }
  if (tableStart === -1) {
    throw new Error(
      `parseA11Table: found the A.11 heading at docs/spec.md:${String(headingIndex + 1)} but no table under it.`,
    );
  }
  let tableEnd = lines.length;
  for (let i = tableStart; i < lines.length; i += 1) {
    if (!(lines[i] ?? '').trim().startsWith('|')) {
      tableEnd = i;
      break;
    }
  }
  // Row 0 is the header (`| Variable | Value |`), row 1 the `---` separator. Data starts at 2.
  const dataLines = lines.slice(tableStart + 2, tableEnd);
  return dataLines.map((line, offset) => parseA11Row(line, tableStart + offset + 3));
}

const specText = readFileSync(SPEC_PATH, 'utf8');

describe('A.11 table partition (docs/spec.md), derived — not a hand-typed list', () => {
  const rows = parseA11Table(specText);
  const singles = rows.filter((row) => row.kind === 'single');
  const doubles = rows.filter((row) => row.kind === 'double');
  const prose = rows.filter((row) => row.kind === 'prose');

  it('has exactly nine rows, partitioned seven / one / one by shape', () => {
    expect(rows).toHaveLength(9);
    expect(singles).toHaveLength(7);
    expect(doubles).toHaveLength(1);
    expect(prose).toHaveLength(1);
  });

  it('the double row is exactly HTTP_PROXY / HTTPS_PROXY', () => {
    expect(doubles[0]).toMatchObject({ names: ['HTTP_PROXY', 'HTTPS_PROXY'] });
  });

  it('the prose row is exactly "agent secrets", asserted separately and never as a key', () => {
    expect(prose[0]).toMatchObject({ text: 'agent secrets' });
  });

  // §23's row is prose, so it contributes zero identifiers to the derived set below — asserted
  // by construction (it is filtered out), not by a second, separate check.
  const derivedNames = [
    ...singles.map((row) => (row.kind === 'single' ? row.name : '')),
    ...doubles.flatMap((row) => (row.kind === 'double' ? row.names : [])),
  ];

  it('derives nine distinct variable names from the eight identifier-bearing rows', () => {
    expect(new Set(derivedNames).size).toBe(9);
    expect(derivedNames).toHaveLength(9);
  });

  // A row's condition is read off its own Value cell, never off which variable it happens to
  // name: "only when" / "on Node" / "optional" are A.11's own conditional phrasings, and a row
  // whose value carries none of them is unconditional. This is the "split the eight names by the
  // value cell" step the plan cell asks for, computed from the cell text rather than an
  // assumption about which names are which.
  function isConditional(value: string): boolean {
    return /only when|on Node|optional/i.test(value);
  }

  const derivedUnconditional = new Set<string>();
  const derivedConditional = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'single') {
      (isConditional(row.value) ? derivedConditional : derivedUnconditional).add(row.name);
    } else if (row.kind === 'double') {
      for (const name of row.names) {
        (isConditional(row.value) ? derivedConditional : derivedUnconditional).add(name);
      }
    }
  }

  it('derives exactly the five unconditional names the plan cell states', () => {
    expect(derivedUnconditional).toEqual(new Set(A11_UNCONDITIONAL_ENV_VARS));
  });

  it('derives exactly the four conditional names the plan cell states', () => {
    expect(derivedConditional).toEqual(new Set(A11_CONDITIONAL_ENV_VARS));
  });

  it('rejects a row that parses as neither shape, naming the line number (ADR-0015 else)', () => {
    const malformed = [
      '## A.11 Environment contract for every runtime',
      '',
      '| Variable | Value |',
      '| --- | --- |',
      '| `GOOD_ONE` | always set |',
      '| `A`, `B`, `C` | not a shape this parser accepts |',
      '',
    ].join('\n');
    expect(() => parseA11Table(malformed)).toThrow(/docs\/spec\.md:6/);
  });

  it('rejects a first cell that carries a stray backtick and is not the known prose row', () => {
    const malformed = [
      '## A.11 Environment contract for every runtime',
      '',
      '| Variable | Value |',
      '| --- | --- |',
      '| something with a lone ` backtick | x |',
      '',
    ].join('\n');
    expect(() => parseA11Table(malformed)).toThrow(/docs\/spec\.md:5/);
  });

  it('refuses to run at all if the A.11 heading has been renamed or removed', () => {
    expect(() => parseA11Table('# nothing relevant here')).toThrow(/no "## A\.11/);
  });
});
