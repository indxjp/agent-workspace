/**
 * The coverage rule of the use cases (SSOT §5.2): every handwritten TypeScript or JavaScript file
 * of every use case at 100% lines, branches, functions and statements, per file, with no
 * suppression. `vitest.use-cases.coverage.config.ts` applies it to `use-cases/`; the kit's
 * regression test applies the same rule to a fixture tree, so what fails there fails for real.
 *
 * A script the gate cannot measure (`.py`, `.sh`, …) is refused by the budget (`./budget.ts`).
 *
 * `dir` is the `use-cases/` tree, relative to the repository root, which the config's `root` is.
 */
import type { CoverageOptions } from 'vitest/node';

export function useCasesCoverage(dir: string, reportsDirectory: string): CoverageOptions {
  return {
    provider: 'v8',
    include: [`${dir}/*/**/*.{ts,tsx,mts,cts,mjs,cjs,js,jsx}`],
    exclude: [
      '**/*.{test,spec,test-support}.{ts,tsx,mts,cts,mjs,cjs,js,jsx}',
      '**/*.d.{ts,mts,cts}',
      '**/data/**',
      '**/node_modules/**',
      `${dir}/kit/**`,
      `${dir}/templates/**`,
    ],
    reporter: ['text', 'json-summary'],
    reportsDirectory,
    thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 },
  };
}
