/**
 * `tests/conformance/scenario-names.test.ts` — proves the ten `name` strings in
 * `tests/conformance/scenarios.ts` equal A.12's ten lines, read out of `docs/spec.md` rather than
 * remembered.
 *
 * This is the wave plan's own words for this task: *"The ten scenario names equal A.12's ten
 * lines, asserted against `docs/spec.md` by the same read-the-spec technique as W3-RT-01's."*
 * W3-RT-01's technique (`packages/runtime/src/spec-transcription.test.ts`) is: parse the spec,
 * never hand-type the thing being compared *against*, and iterate the parsed result rather than a
 * separate array literal — the exact shape W3-RT-01 itself got wrong in round 1 (a hand-typed
 * comparison list beside a parser that had already produced the full one). This file is the same
 * shape applied to a list of strings instead of a list of type members: `readA12ScenarioNames`
 * parses `docs/spec.md` into an array with no fixed length assumed anywhere in `spec-scenarios.ts`,
 * and every assertion below iterates *that* array's length and order — never a re-typed `10`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { a12Scenarios } from './scenarios.js';
import { readA12ScenarioNames, SPEC_PATH } from './spec-scenarios.js';

const specText = readFileSync(SPEC_PATH, 'utf8');
const specNames = readA12ScenarioNames(specText);
// A generic instantiation only to read the (request/event-independent) `name` column — no
// `TRequest`/`TEvent` value is ever produced or consumed here.
const harnessScenarios = a12Scenarios<unknown, unknown>();

describe('the harness scenario table equals A.12, read out of docs/spec.md', () => {
  it('parses at least one scenario line, and does not silently accept zero', () => {
    expect(specNames.length).toBeGreaterThan(0);
  });

  it('has exactly as many harness scenarios as docs/spec.md has A.12 lines', () => {
    expect(harnessScenarios.length).toBe(specNames.length);
  });

  it.each(specNames.map((name, index) => [index, name] as const))(
    'scenario %i in docs/spec.md ("%s") equals the harness table entry at the same index, verbatim',
    (index, specName) => {
      const harnessScenario = harnessScenarios[index];
      expect(
        harnessScenario,
        `harness table has no scenario at index ${String(index)}`,
      ).toBeDefined();
      expect(harnessScenario?.name).toBe(specName);
    },
  );

  it('carries no scenario the spec does not (set equality, not just same length)', () => {
    const harnessNameSet = new Set(harnessScenarios.map((scenario) => scenario.name));
    const specNameSet = new Set(specNames);
    expect(harnessNameSet).toEqual(specNameSet);
  });

  it('every scenario id is unique — no two scenarios silently collapse into one report row', () => {
    const ids = harnessScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('proof: readA12ScenarioNames rejects what it cannot parse, rather than skip it (ADR-0015/0031)', () => {
  it('throws naming the heading when docs/spec.md has no A.12 heading', () => {
    expect(() => readA12ScenarioNames('# Nothing here\n')).toThrowError(/no heading exactly/);
  });

  it('throws naming the heading when the heading has no fenced ```text block', () => {
    const synthetic =
      '## A.12 Driver conformance tests\n\nNo fenced block follows.\n\n## A.13 Next\n';
    expect(() => readA12ScenarioNames(synthetic)).toThrowError(/No `{3}text fenced block found/);
  });

  it('throws naming the offending line when a fenced-block line is not a "✓ " scenario', () => {
    const synthetic = [
      '## A.12 Driver conformance tests',
      '',
      '```text',
      '✓ a real scenario',
      'not a checkmark line',
      '```',
      '',
      '## A.13 Next',
      '',
    ].join('\n');
    expect(() => readA12ScenarioNames(synthetic)).toThrowError(/not a checkmark line/);
  });

  it('accepts a well-formed synthetic block and returns its lines in order', () => {
    const synthetic = [
      '## A.12 Driver conformance tests',
      '',
      '```text',
      '✓ first scenario',
      '✓ second scenario',
      '```',
      '',
      '## A.13 Next',
      '',
    ].join('\n');
    expect(readA12ScenarioNames(synthetic)).toEqual(['first scenario', 'second scenario']);
  });
});
