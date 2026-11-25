/**
 * The patent-search use case (archetype QA): the contract, moment and flow tiers from the kit. Its
 * one piece of code beyond the definitions is the patent-publications tool (ADR-0170), so the flow
 * runs that tool's run file over the shipped snapshot: offline, as of the snapshot's date, newest
 * publication first, by a word of the abstract or the applicant, and refusing an argument the tool
 * does not take. The test also checks that both reads run unasked and that nothing writes.
 */
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/patent-search.ts';
import surface from './surfaces/main.ts';
import run from './tools/patents.run.ts';
import patents from './tools/patents.ts';

const signal = new AbortController().signal;

describeUseCase('patent-search', {
  definitions: { 'agents/patent-search.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the patents tool answers from the dated snapshot, newest first, with no network',
      run: async () => {
        expect(patents).toMatchObject({ name: 'search_patents' });
        expect(patents).not.toHaveProperty('allowedDomains');

        const flipping = await run({ query: '反転' }, { signal });
        expect(flipping).toMatchObject({ mode: 'snapshot', asOf: '2026-11-16', truncated: false });
        expect(flipping.records.map((record) => record.id)).toEqual([
          'FPO-2024-011873',
          'FPO-2023-104512',
          'FPO-2022-088301',
        ]);

        const applicant = await run({ query: 'Hakuseki' }, { signal });
        expect(applicant.records.map((record) => record.id)).toEqual([
          'FPO-2025-023640',
          'FPO-2023-104512',
        ]);

        await expect(run({ query: 'x', claims: true }, { signal })).rejects.toThrow();
      },
    },
  ],
});

describe('patent-search reads only', () => {
  it('reads the memo and the publications unasked, and has no write', () => {
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__search_patents'],
    });
    expect(agent.permissions).toEqual({ readFiles: true });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'patent-search', access: 'read' }),
    ]);
  });
});
