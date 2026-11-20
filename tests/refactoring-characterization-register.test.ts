// The RF-001 expected-failure register's reader (tests/fitness/characterization-register.ts) on
// fixtures. The comparison over the tracked tree is
// tests/refactoring-characterization-register.policy-check.ts, in `pnpm policy:check`.
import { describe, expect, it } from 'vitest';

import {
  expectedFailureCallsInSource,
  skippedExpectedFailureDiagnostics,
  registeredExpiryIds,
} from './fitness/characterization-register.js';

describe('RF-001 expected-failure register', () => {
  it('recognizes supported fails modifier and parameterization chains', () => {
    const calls = expectedFailureCallsInSource(
      'modifier-chain-fixture.ts',
      [
        "test.fails('RF-101 direct', () => {});",
        "it.fails.only('RF-102 only', () => {});",
        "it.fails.skip('RF-103 skip', () => {});",
        "it.concurrent.fails('RF-104 concurrent', () => {});",
        "it.fails.each([[1]])('RF-201 each', () => {});",
        "test.concurrent.fails.each`value\\n${1}`('RF-202 tagged each', () => {});",
        "it.each([[1]]).fails('RF-303 each before fails', () => {});",
        "test.fails.todo('RF-301 todo', () => {});",
        "it.skip.fails('RF-302 skip before fails', () => {});",
        "test.todo.fails('RF-304 todo before fails', () => {});",
        "it.fails.for([[1]])('RF-105 for', () => {});",
        "it.fails.skipIf(true)('RF-106 skipIf true', () => {});",
        "it.fails.skipIf(false)('RF-107 skipIf false', () => {});",
        "it.fails.runIf(true)('RF-108 runIf true', () => {});",
        "it.fails.runIf(false)('RF-109 runIf false', () => {});",
        "it.fails.skipIf(condition)('RF-110 conditional skipIf', () => {});",
        "it.fails.runIf(condition)('RF-111 conditional runIf', () => {});",
      ].join('\n'),
    );

    expect(calls.map((call) => call.rfIds)).toEqual([
      ['RF-101'],
      ['RF-102'],
      ['RF-103'],
      ['RF-104'],
      ['RF-201'],
      ['RF-202'],
      ['RF-303'],
      ['RF-301'],
      ['RF-302'],
      ['RF-304'],
      ['RF-105'],
      ['RF-106'],
      ['RF-107'],
      ['RF-108'],
      ['RF-109'],
      ['RF-110'],
      ['RF-111'],
    ]);
    expect(skippedExpectedFailureDiagnostics(calls)).toEqual([
      'modifier-chain-fixture.ts:3 -> skip',
      'modifier-chain-fixture.ts:8 -> todo',
      'modifier-chain-fixture.ts:9 -> skip',
      'modifier-chain-fixture.ts:10 -> todo',
      'modifier-chain-fixture.ts:12 -> skipIf(true)',
      'modifier-chain-fixture.ts:15 -> runIf(false)',
    ]);
  });

  it('reads only the named expiry column from the characterization table', () => {
    const markdown = [
      '# Decisions',
      '',
      '## RF-001 characterization register',
      '',
      '| Current gap | Expires in | Note |',
      '| --- | --- | --- |',
      '| A gap | RF-101 | remains expected to fail |',
      '',
      '| Later accounting | Owner |',
      '| --- | --- |',
      '| Not a characterization | RF-999 |',
      '',
      '## Next section',
    ].join('\n');

    expect(registeredExpiryIds(markdown)).toEqual(['RF-101']);
    expect(() =>
      registeredExpiryIds(
        markdown.replace('| A gap | RF-101 | remains expected to fail |', '| A gap | RF-101 |'),
      ),
    ).toThrow('RF-001 characterization register data row has the wrong column count.');
  });
});
