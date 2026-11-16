import { expect, it } from 'vitest';
import type { WritebackRun } from './run-storage-writeback.execution.test-support';
import { CSV } from './run-storage-writeback.fixture.test-support';
export function registerWritebackSavingTests(run: WritebackRun) {
  it('[US-STO-12][api][run] a write grant saves a file the agent created', async () => {
    const saved = await run({ after: { '2026/q3.csv': CSV, 'summary.md': '# Q3\n' } });
    expect(await saved.text('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][api][run] on a local-disk runtime, a write grant saves what the agent left in the extracted folder', async () => {
    const saved = await run({
      localDisk: true,
      after: { '2026/q3.csv': 'q3,43\n', 'summary.md': '# Q3\n' },
    });
    expect(await saved.text('reports/summary.md')).toBe('# Q3\n');
    expect(await saved.text('reports/2026/q3.csv')).toBe('q3,43\n');
    expect(await saved.text('reports/2026/q2.csv')).toBe('q2,40\n');
    expect(saved.uploads.sort()).toEqual(['reports/2026/q3.csv', 'reports/summary.md']);
  });

  it('[US-STO-12][api][run] a write grant replaces a changed file and deletes nothing', async () => {
    const saved = await run({ after: { '2026/q3.csv': 'q3,43\n' } });
    expect(await saved.text('reports/2026/q3.csv')).toBe('q3,43\n');
    expect(await saved.text('reports/2026/q2.csv')).toBe('q2,40\n');
  });

  it('[US-STO-12][api][run] uploads only the files that changed, never the unchanged ones', async () => {
    const saved = await run({
      after: { '2026/q3.csv': CSV, '2026/q2.csv': 'q2,41\n', 'summary.md': '# Q3\n' },
    });
    expect(saved.uploads.sort()).toEqual(['reports/2026/q2.csv', 'reports/summary.md']);
    expect(saved.labels).toEqual([
      expect.stringMatching(/ · 2 written · 1 unchanged · 0 conflicted · 0 refused · 0 failed · /u),
    ]);
  });

  it('[US-STO-12][api][run] saves the run even when a second message arrives during the write-back', async () => {
    const answers: number[] = [];
    const saved = await run({
      after: { '2026/q3.csv': 'q3,43\n', 'a.md': '# A\n' },
      duringWriteBack: async (post) => {
        // The run is still `running`, so its session refuses the next run until the save ends.
        answers.push((await post()).status);
      },
    });

    expect(answers).toEqual([409]);
    expect(await saved.text('reports/a.md')).toBe('# A\n');
    expect(await saved.text('reports/2026/q3.csv')).toBe('q3,43\n');
  });
}
