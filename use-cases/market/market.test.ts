/**
 * The market use case (archetype QA): the contract, moment and flow tiers from the kit. Its one
 * piece of code beyond the definitions is the public-statistics tool (ADR-0170), so the flow runs
 * that tool's run file over the shipped snapshot: offline, as of the snapshot's date, newest
 * release first, and refusing an argument the tool does not take.
 */
import { expect } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/market.ts';
import surface from './surfaces/main.ts';
import run from './tools/stats.run.ts';
import marketStats from './tools/stats.ts';

const signal = new AbortController().signal;

describeUseCase('market', {
  definitions: { 'agents/market.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the statistics tool answers from the dated snapshot, newest first, with no network',
      run: async () => {
        expect(marketStats).toMatchObject({ name: 'read_market_stats' });
        expect(marketStats).not.toHaveProperty('allowedDomains');

        const shipments = await run({ query: 'domestic shipments' }, { signal });
        expect(shipments).toMatchObject({ mode: 'snapshot', asOf: '2026-11-14', truncated: false });
        expect(shipments.records.map((record) => record.id)).toEqual([
          'SRA-2026-07',
          'SRA-2025-07',
          'SRA-2024-07',
        ]);

        const bureau = await run({ source: 'Fictional Statistics Bureau' }, { signal });
        expect(bureau.records.map((record) => record.id)).toEqual(['FSB-2026-Q2', 'FSB-2026-LS']);

        await expect(run({ query: 'x', forecast: true }, { signal })).rejects.toThrow();
      },
    },
  ],
});
