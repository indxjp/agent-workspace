import { expect, it } from 'vitest';
import type { WritebackRun } from './run-storage-writeback.execution.test-support';
import { CSV, gates } from './run-storage-writeback.fixture.test-support';
export function registerWritebackGrantsTests(run: WritebackRun) {
  it('[US-STO-12][api][run] a read grant never writes', async () => {
    const saved = await run({
      access: 'read',
      after: { '2026/q3.csv': 'tampered\n', 'summary.md': '# Q3\n' },
    });
    expect(await saved.text('reports/2026/q3.csv')).toBe(CSV);
    expect(await saved.text('reports/summary.md')).toBeNull();
    expect(saved.uploads).toEqual([]);
  });

  it.each(gates)(
    '[US-STO-12][api][run] writes nothing when %s during the run',
    async (_gate, close, reason) => {
      const saved = await run({
        after: { '2026/q3.csv': 'q3,43\n', 'summary.md': '# Q3\n' },
        duringRun: (world) => {
          close(world);
          return Promise.resolve();
        },
      });
      expect(saved.uploads).toEqual([]);
      expect(await saved.text('reports/2026/q3.csv')).toBe(CSV);
      expect(await saved.text('reports/summary.md')).toBeNull();
      expect(saved.labels).toEqual([expect.stringContaining(`refused: ${reason}`)]);
    },
  );

  it('[US-STO-12][api][run] keeps a folder read only whose read grant is removed during the run', async () => {
    const saved = await run({
      nestedReadOnly: true,
      after: { '2026/q3.csv': 'q3,43\n', 'top.md': '# Top\n' },
      duringRun: (world) => {
        world.nestedReadOnly = false;
        return Promise.resolve();
      },
    });
    expect(saved.uploads).toEqual(['reports/top.md']);
    expect(await saved.text('reports/2026/q3.csv')).toBe(CSV);
    expect(await saved.text('reports/top.md')).toBe('# Top\n');
    expect(saved.labels).toEqual([expect.stringMatching(/ · 1 written · .* · 1 refused · /u)]);
  });
}
