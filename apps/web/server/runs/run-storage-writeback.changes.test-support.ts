import { randomUUID } from 'node:crypto';
import { type ObjectStore } from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';
import type { WritebackRun } from './run-storage-writeback.execution.test-support';
import { text } from './run-storage-writeback.fixture.test-support';
export function registerWritebackChangesTests(run: WritebackRun) {
  it('[US-STO-12][api][run] keeps a file changed in the bucket during the run, as conflicted', async () => {
    const saved = await run({
      after: { '2026/q3.csv': 'q3,43\n' },
      duringRun: async (world) => {
        const [backend] = world.backends.values();
        const store = await backend?.open(true);
        await store?.write('reports/2026/q3.csv', new Blob(['edited elsewhere\n']).stream(), {});
      },
    });
    expect(await saved.text('reports/2026/q3.csv')).toBe('edited elsewhere\n');
    expect(saved.labels).toEqual([expect.stringContaining(' · 1 conflicted · ')]);
  });

  it('[US-STO-12][api][run] still writes to a connection renamed during the run', async () => {
    const saved = await run({
      after: { 'summary.md': '# Q3\n' },
      duringRun: (world) => {
        for (const row of world.rows.values()) row.name = 'acme-renamed';
        return Promise.resolve();
      },
    });
    expect(await saved.text('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][api][run] a connection deleted and recreated under the same name receives nothing', async () => {
    const recreated: { store?: ObjectStore } = {};
    const saved = await run({
      after: { 'summary.md': '# Q3\n' },
      duringRun: async (world) => {
        const row = [...world.rows.values()][0];
        world.rows.clear();
        const id = randomUUID();
        const backend = await world.makeBackend();
        world.rows.set(id, { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true });
        world.backends.set(id, backend);
        recreated.store = await backend.open(true);
        expect(row?.name).toBe('acme-data');
      },
    });
    expect(saved.uploads).toEqual([]);
    expect(await saved.text('reports/summary.md')).toBeNull();
    expect(recreated.store).toBeDefined();
    expect(
      recreated.store === undefined ? 'missing' : await text(recreated.store, 'reports/summary.md'),
    ).toBeNull();
    expect(saved.labels).toEqual([expect.stringContaining('refused: connection_missing')]);
  });
}
