import { expect, it } from 'vitest';
import type { WritebackRun } from './run-storage-writeback.execution.test-support';
import { escapes } from './run-storage-writeback.fixture.test-support';
export function registerWritebackConfinementTests(run: WritebackRun) {
  it.each(escapes)(
    '[US-STO-12][api][run] never writes %s that reaches outside the folder',
    async (_name, tar) => {
      const saved = await run({ tar });
      expect(saved.uploads.filter((key) => key !== 'reports/ok.md')).toEqual([]);
      expect(await saved.text('reports/x.md')).toBeNull();
      expect(await saved.text('x.md')).toBeNull();
      expect(await saved.text('archive/x.md')).toBeNull();
      expect(saved.labels).toEqual([expect.stringMatching(/ · [1-9]\d* refused · /u)]);
    },
  );
}
