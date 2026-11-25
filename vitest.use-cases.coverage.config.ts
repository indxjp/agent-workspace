import { defineConfig } from 'vitest/config';

import { useCasesCoverage } from './use-cases/kit/coverage.ts';

// SSOT §5.2: every handwritten file of every use case at 100% per file. The gallery is measured by
// vitest.gallery.coverage.config.ts, whose floors start at its measured totals and only go up.
export default defineConfig({
  test: {
    projects: ['use-cases'],
    coverage: useCasesCoverage('use-cases', 'coverage/use-cases'),
  },
});
