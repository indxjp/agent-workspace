import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

describe('release workflow engineering metrics (W4-2)', () => {
  it('measures at the tagged commit, never fails on drift, and attaches the JSON to the release', () => {
    expect(workflow).toContain(
      'node scripts/metrics/baseline.mjs --out "$RUNNER_TEMP/metrics-$version.json"',
    );
    expect(workflow).toContain('node scripts/metrics/baseline.mjs --check');
    expect(workflow).toMatch(/gh release create .*"\$RUNNER_TEMP\/metrics-\$version\.json"/);
    expect(workflow.indexOf('Record engineering metrics')).toBeLessThan(
      workflow.indexOf('Publish immutable release notes'),
    );
  });
});
