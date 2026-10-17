import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from './harness.js';
import { renderCompatibilityMatrix } from './renderer.js';
import { OPTIONAL_PROVIDER_SCENARIOS, REQUIRED_PROVIDER_SCENARIOS } from './scenarios.js';
import { readProviderScenarioInventoryFromSpec } from './spec-scenarios.js';
import { stubProvider } from './stub-provider.js';
import type { CompatibilityReport } from './types.js';

describe('spec §41 provider compatibility harness', () => {
  it('derives exactly the required and optional scenario ids from docs/spec.md', async () => {
    const inventory = await readProviderScenarioInventoryFromSpec();
    expect(inventory.required).toEqual(REQUIRED_PROVIDER_SCENARIOS);
    expect(inventory.optional).toEqual(OPTIONAL_PROVIDER_SCENARIOS);
  });

  it('runs all required and optional scenarios against the stub provider', async () => {
    const report = await runCompatibilitySuite(stubProvider);
    expect(report.ok).toBe(true);
    expect(report.outcomes).toHaveLength(14);
    expect(report.outcomes.every((outcome) => outcome.verdict === 'native')).toBe(true);
  });

  it('renders a thrown scenario as the dedicated failure state and legend entry', async () => {
    const clean = await runCompatibilitySuite(stubProvider);
    const failed: CompatibilityReport = {
      ...clean,
      ok: false,
      outcomes: clean.outcomes.map((outcome) =>
        outcome.id === 'basic-response'
          ? { ...outcome, verdict: 'failed', detail: 'fixture threw' }
          : outcome,
      ),
    };
    const rendered = renderCompatibilityMatrix([failed]);
    const failedSymbol = String.fromCodePoint(0x2717);
    const otherSymbols = [String.fromCodePoint(0x2713), '~', '-'];

    expect(rendered).toContain(`| stub | ${failedSymbol} |`);
    expect(rendered).toContain(`${failedSymbol} conformance test failed`);
    for (const symbol of otherSymbols) {
      expect(failedSymbol).not.toBe(symbol);
    }
  });

  it('omits providers with no run and refuses an incomplete recorded run', () => {
    expect(renderCompatibilityMatrix([])).toBe('');
    expect(() =>
      renderCompatibilityMatrix([{ providerId: 'partial', outcomes: [], ok: false }]),
    ).toThrow(/omitted scenario basic-response/);
  });

  it('has no literal native symbol in the renderer source', async () => {
    const source = await readFile(new URL('./renderer.ts', import.meta.url), 'utf8');
    expect(source).not.toContain(String.fromCodePoint(0x2713));
  });
});
