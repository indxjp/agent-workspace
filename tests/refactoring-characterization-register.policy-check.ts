// Every tracked expected failure (`it.fails`, `test.fails`) names exactly one owning RF unit, none
// is made non-evidence by a skip, and the owners equal the expiry ids of the RF-001
// characterization register. A static check of the `policy-check` lane (`pnpm policy:check`); the
// reader's fixture cases are tests/refactoring-characterization-register.test.ts.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  decisionLedger,
  expectedFailureCalls,
  registeredExpiryIds,
  skippedExpectedFailureDiagnostics,
  trackedSourceFiles,
} from './fitness/characterization-register.js';

describe('RF-001 expected-failure register', () => {
  it('matches every tracked fails-call owner to the register expiry ids', () => {
    const calls = trackedSourceFiles().flatMap(expectedFailureCalls);
    const skippedCalls = skippedExpectedFailureDiagnostics(calls);
    const malformedTitles = calls
      .filter((call) => call.rfIds.length !== 1)
      .map(
        (call) => `${call.file}:${String(call.line)} -> ${call.rfIds.join(', ') || '(no RF id)'}`,
      );
    const sourceIds = [...new Set(calls.flatMap((call) => call.rfIds))].sort();
    const registerIds = registeredExpiryIds(readFileSync(decisionLedger, 'utf8'));

    expect(
      calls.length,
      'No tracked `it`/`test` call with a `fails` modifier was found; the gate inspected nothing.',
    ).toBeGreaterThan(0);
    expect(
      malformedTitles,
      'Every `it.fails` title must identify exactly one owning RF unit.',
    ).toEqual([]);
    expect(
      skippedCalls,
      'A `skip`/`todo` modifier or unconditional `skipIf(true)`/`runIf(false)` makes an expected failure non-evidence; remove it.',
    ).toEqual([]);
    expect(registerIds.length, 'The characterization register has no expiry ids.').toBeGreaterThan(
      0,
    );
    expect(sourceIds).toEqual(registerIds);
    // Parses every tracked source file: well past 5 s on a 2-vCPU CI runner.
  }, 60_000);
});
