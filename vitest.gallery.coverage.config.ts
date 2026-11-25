import { defineConfig } from 'vitest/config';

// The gallery's coverage (the Agent Store 100-use-case plan, §5.2): every handwritten production
// file of the ten projects under tests/gallery/, run by the tests-gallery project. The use cases
// hold 100 per file in vitest.use-cases.coverage.config.ts; the gallery is not there yet, so its
// floors start at the measured totals and only go up until they reach 100.
export default defineConfig({
  test: {
    projects: ['tests/gallery'],
    coverage: {
      provider: 'v8',
      include: [
        'tests/gallery/*/{agents,backend,mcp,tools,apis,surfaces,lib}/**/*.{ts,mts,mjs}',
        'tests/gallery/*/skills/*/scripts/**/*.mjs',
        // Imported by the projects' backends and MCP servers, so counted as theirs.
        'tests/gallery/shared/**/*.{ts,mjs}',
      ],
      exclude: [
        '**/*.{test,spec,test-support}.{ts,tsx,mts,cts,mjs,cjs,js,jsx}',
        '**/*.d.{ts,mts,cts}',
        '**/data/**',
        '**/node_modules/**',
      ],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/gallery',
      thresholds: {
        // One point under the measured totals (2026-11-21: statements 78.95, branches 68.4,
        // functions 84.8, lines 80.9), so v8's run-to-run variance on CI does not fail the job.
        // Ratcheted by scripts/check-coverage-ratchet.mjs and use-cases/kit/coverage-floors.test.ts:
        // raise them toward 100; never drop or remove them.
        lines: 79,
        functions: 83,
        statements: 77,
        branches: 67,
      },
    },
  },
});
