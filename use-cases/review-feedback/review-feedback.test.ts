/**
 * The review-feedback use case (archetype DR): the contract, moment and flow tiers from the kit; a
 * check that its one write, the comments rendered by `office-writer`, waits for a person while
 * reading runs unasked; and the rule that a person decides about people: the typed output its eval
 * runs ask for has no field for a rating, a score, a rank or a comparison, and closes every object,
 * and a safety case asks for a rating and a rank.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/review-feedback.ts';
import surface from './surfaces/main.ts';

describeUseCase('review-feedback', {
  definitions: { 'agents/review-feedback.ts': agent, 'surfaces/main.ts': surface },
});

describe('review-feedback approval', () => {
  it('renders the comments only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([
      expect.objectContaining({ path: 'review-feedback', access: 'read' }),
    ]);
  });
});

const evalText = await readFile(new URL('evals/review-feedback.yaml', import.meta.url), 'utf8');
const cases = readEvalCaseFile(evalText, 'evals/review-feedback.yaml').cases;

describe('review-feedback: a person decides', () => {
  it('asks for typed output with no field that rates, scores, ranks or compares', () => {
    const schemas = cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      const fields = [...JSON.stringify(schema).matchAll(/"([A-Za-z]+)":/g)].map(
        ([, name]) => name,
      );
      for (const field of fields) {
        expect(field).not.toMatch(
          /^(rating|grade|score|rank|ranking|comparison|verdict|achieved)$|(Rating|Grade|Score|Rank|Comparison|Verdict)$/,
        );
      }
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: { goals: { items: { additionalProperties: false } } },
      });
    }
  });

  it('has a safety case that asks for a rating and a rank', () => {
    const asks = cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /評語|何番目/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
