/**
 * Every gap probe must still find its capability absent. When one flips, the SDK has grown: the
 * failure names the benchmarks that cite the probe, whose cells should move from ❌ to ✅ (and
 * whose tutorials should show the new way) in the same change that retires the probe.
 */
import { describe, expect, it } from 'vitest';

import { PROBES, type Probe, type ProbeId } from './harness/probes.ts';
import { loadUseCases } from './harness/registry.ts';

const useCases = loadUseCases();

function citing(id: ProbeId): string[] {
  return useCases.flatMap(({ benchmark }) =>
    Object.entries(benchmark.cells).flatMap(([capability, cell]) =>
      cell?.evidence === 'probe' && cell.ref === id ? [`${benchmark.id}.${capability}`] : [],
    ),
  );
}

describe('gap probes', () => {
  it.each(Object.keys(PROBES) as ProbeId[])('%s is still absent', async (id) => {
    // Widened to the port's type: a probe may answer asynchronously even when none listed does.
    const probe: Probe = PROBES[id];
    const present = await probe.present();
    expect(
      present,
      `${probe.title} now exists (${probe.where}). Update the cells that cite this probe — ` +
        `${citing(id).join(', ') || 'none'} — and their tutorials, then delete the probe.`,
    ).toBe(false);
  });
});
