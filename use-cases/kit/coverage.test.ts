/**
 * The coverage rule fails a use case with an untested branch (SSOT §9 F2): Vitest runs the
 * fixture tree `fixtures/coverage-rule/` under `useCasesCoverage`, the same options the real config
 * uses, and must fail on `untested-branch` alone, while `covered` passes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import galleryConfig from '../../vitest.gallery.coverage.config.ts';
import rootConfig from '../../vitest.use-cases.coverage.config.ts';
import { useCasesCoverage } from './coverage.ts';
import { runVitest } from './nested-vitest.ts';

const reports = mkdtempSync(path.join(tmpdir(), 'use-cases-coverage-'));

afterAll(() => {
  rmSync(reports, { recursive: true, force: true });
});

describe('the use cases coverage rule', () => {
  it('is 100 per file on all four measures, over use cases only', () => {
    const options = useCasesCoverage('use-cases', 'coverage/use-cases');
    expect(options.thresholds).toEqual({
      perFile: true,
      lines: 100,
      branches: 100,
      functions: 100,
      statements: 100,
    });
    expect(options.include).toEqual(['use-cases/*/**/*.{ts,tsx,mts,cts,mjs,cjs,js,jsx}']);
    expect(options.exclude).toEqual(
      expect.arrayContaining(['use-cases/kit/**', 'use-cases/templates/**', '**/data/**']),
    );
  });

  // The CI suite has no floors-only-go-up ratchet (its floor is already 100), so this is what keeps
  // the real config from being loosened: it must apply exactly this rule to `use-cases/`.
  it('is what the root vitest.use-cases.coverage.config.ts applies, unchanged', () => {
    expect(rootConfig.test?.coverage).toEqual(useCasesCoverage('use-cases', 'coverage/use-cases'));
    expect(rootConfig.test?.projects).toEqual(['use-cases']);
  });

  // SSOT §5.2: the gallery has its own suite, so its floors can start below 100 without loosening
  // the use cases' rule; scripts/check-coverage-ratchet.mjs keeps them from going down.
  it('leaves the gallery to its own suite, which runs the gallery over every production file', () => {
    expect(rootConfig.test?.coverage?.include?.some((glob) => glob.includes('gallery'))).toBe(
      false,
    );
    expect(galleryConfig.test?.projects).toEqual(['tests/gallery']);
    const coverage = galleryConfig.test?.coverage;
    expect(coverage?.include).toEqual([
      'tests/gallery/*/{agents,backend,mcp,tools,apis,surfaces,lib}/**/*.{ts,mts,mjs}',
      'tests/gallery/*/skills/*/scripts/**/*.mjs',
      'tests/gallery/shared/**/*.{ts,mjs}',
    ]);
    expect(coverage?.exclude).toEqual(useCasesCoverage('use-cases', 'x').exclude?.slice(0, 4));
    const thresholds = coverage?.thresholds ?? {};
    expect(Object.keys(thresholds).sort()).toEqual([
      'branches',
      'functions',
      'lines',
      'statements',
    ]);
    for (const floor of Object.values(thresholds)) {
      expect(floor).toBeGreaterThan(0);
      expect(floor).toBeLessThanOrEqual(100);
    }
  });

  it('fails a fixture use case with an untested branch, and only that one', () => {
    const run = runVitest([
      '--config',
      'use-cases/kit/fixtures/coverage-rule/coverage-fixture.config.ts',
      '--coverage',
      `--coverage.reportsDirectory=${reports}`,
    ]);
    const { output } = run;
    expect(run.status, output).not.toBe(0);
    expect(output).toMatch(
      /Coverage for branches \(50%\) does not meet .*threshold \(100%\) for .*untested-branch\/skills\/calc\/scripts\/calc\.mjs/u,
    );
    // Scripts no test loads, in extensions the first include missed, are measured too, at 0%.
    expect(output).toMatch(
      /Coverage for functions \(0%\) does not meet .*threshold \(100%\) for .*untested-branch\/skills\/calc\/scripts\/unused\.mts/u,
    );
    expect(output).toMatch(
      /Coverage for lines \(0%\) does not meet .*threshold \(100%\) for .*untested-branch\/skills\/calc\/scripts\/unused2\.cjs/u,
    );
    expect(output).not.toMatch(/threshold \(100%\) for .*\/covered\//u);
    expect(output).toContain('2 passed');
  }, 120_000);
});
