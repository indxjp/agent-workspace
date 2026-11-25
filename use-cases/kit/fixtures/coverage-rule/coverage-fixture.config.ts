import path from 'node:path';

import { defineConfig } from 'vitest/config';

import { useCasesCoverage } from '../../coverage.ts';

// The use cases' coverage rule over this fixture tree, run by ../../coverage.test.ts.
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const dir = path
  .relative(repositoryRoot, import.meta.dirname)
  .split(path.sep)
  .join('/');

export default defineConfig({
  root: repositoryRoot,
  test: {
    projects: [{ test: { name: 'coverage-fixture', root: import.meta.dirname } }],
    coverage: useCasesCoverage(dir, 'coverage/use-cases-fixture'),
  },
});
