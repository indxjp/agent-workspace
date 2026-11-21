/**
 * The screening use case (archetype RV): the contract, moment and flow tiers from the kit. Its one
 * piece of code beyond the definitions is the public-lists tool (ADR-0170), so the flow runs that
 * tool's run file over the shipped snapshot: offline, as of the snapshot's date, finding a listed
 * person by an alias and saying when a broad query answered more than it returned. The test also
 * checks that the report waits for a person while the reads run unasked, and that the typed
 * verdicts its eval runs ask for name a match for a person to review, never a decision about
 * the party.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/screening.ts';
import surface from './surfaces/main.ts';
import run from './tools/lists.run.ts';
import publicLists from './tools/lists.ts';

const signal = new AbortController().signal;

describeUseCase('screening', {
  definitions: { 'agents/screening.ts': agent, 'surfaces/main.ts': surface },
  flows: [
    {
      name: 'the public-lists tool answers from the dated snapshot, by alias, with no network',
      run: async () => {
        const vashkin = await run({ query: 'テオドール・ワシキン' }, { signal });
        expect(vashkin).toMatchObject({ mode: 'snapshot', asOf: '2026-11-16', truncated: false });
        expect(vashkin.records.map((record) => record.id)).toEqual(['FSL-2207']);

        const narrow = await run({ query: 'veloria', limit: 1 }, { signal });
        expect(narrow.records).toHaveLength(1);
        expect(narrow.truncated).toBe(true);

        await expect(run({ query: 'x', page: 2 }, { signal })).rejects.toThrow();
      },
    },
  ],
});

describe('screening tools and approval', () => {
  it('reads the lists and the folders unasked, and writes the report only after approval', () => {
    expect(publicLists).toMatchObject({ name: 'check_public_lists' });
    expect(publicLists).not.toHaveProperty('allowedDomains');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files', 'mcp__aw-dev-tools__check_public_lists'],
      requireApproval: ['Write', 'mcp__agent-workspace__run_skill_script'],
    });
  });
});

describe('screening: a person decides about the party', () => {
  it('asks for typed output that flags matches and has no field deciding about the party', async () => {
    const text = await readFile(new URL('evals/screening.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/screening.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        additionalProperties: false,
        required: ['request', 'asOf', 'items'],
        properties: {
          items: {
            items: {
              additionalProperties: false,
              properties: { verdict: { enum: ['no_match', 'possible_match', 'match'] } },
            },
          },
        },
      });
      const fields = [...JSON.stringify(schema).matchAll(/"([A-Za-z]+)":/g)].map(
        ([, name]) => name,
      );
      for (const field of fields) {
        expect(field).not.toMatch(
          /^(approve|approved|decision|reject|rejected|risk|score|proceed)$/,
        );
      }
    }
  });
});
