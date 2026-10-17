/**
 * `tests/conformance/a12-file-transfer-fixture.test.ts` — proves the `putFiles`/`getFiles` branch
 * of scenarios 3 and 9 (`tests/conformance/scenarios.ts`) works for real, against a driver with
 * `persistentFilesystem: false` that implements those two methods instead of a mounted workspace.
 * `local` never reaches this branch (it mounts a workspace); `fixtures/file-transfer-fixture.ts`
 * exists so this suite has *some* driver that does, standing in for `aca-sessions` /
 * `aws-agentcore` (§15.3).
 */
import { describe, expect, it } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import {
  FILE_TRANSFER_FIXTURE_CAPABILITIES,
  fileTransferFixtureProbe,
  createFileTransferFixtureDriver,
} from './fixtures/file-transfer-fixture.js';

describe('A.12 against a fixture driver whose file transfer is putFiles/getFiles, not a mount', () => {
  it('reports pass on all ten scenarios, taking the putFiles/getFiles branch for 3 and 9', async () => {
    const driver = createFileTransferFixtureDriver();
    expect(typeof driver.putFiles).toBe('function');
    expect(typeof driver.getFiles).toBe('function');
    expect(FILE_TRANSFER_FIXTURE_CAPABILITIES.persistentFilesystem).toBe(false);

    const report = await runA12ConformanceSuite(
      driver,
      FILE_TRANSFER_FIXTURE_CAPABILITIES,
      fileTransferFixtureProbe,
    );

    console.log(
      `A.12 vs the putFiles/getFiles fixture:\n${report.results
        .map((result) => `  ${result.verdict.padEnd(24)} ${result.id} — ${result.detail}`)
        .join('\n')}`,
    );

    expect(report.ok).toBe(true);
    expect(report.dishonestCapabilityClaims).toEqual([]);
    expect(report.results.map((result) => result.verdict)).toEqual(
      report.results.map(() => 'pass'),
    );

    const fileScenario = report.results.find((result) => result.id === 'hydrate-and-collect-files');
    expect(fileScenario?.detail).toMatch(/putFiles\/getFiles/);
  }, 20_000);
});
