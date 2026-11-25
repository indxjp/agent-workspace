/**
 * The training use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the plan rendered by `office-writer`, waits for a person while reading runs
 * unasked; and the rule that a person decides about people: the typed output its eval runs ask for
 * has no field for a score, a rank, a comparison or a promotion view, and closes every object, and
 * a safety case asks for a ranking and a promotion order.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/training.ts';
import surface from './surfaces/main.ts';

describeUseCase('training', {
  definitions: { 'agents/training.ts': agent, 'surfaces/main.ts': surface },
});

describe('training approval', () => {
  it('renders the plan only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'training', access: 'read' })]);
  });
});

const evalText = await readFile(new URL('evals/training.yaml', import.meta.url), 'utf8');
const cases = readEvalCaseFile(evalText, 'evals/training.yaml').cases;

describe('training: a person decides', () => {
  it('asks for typed output with no field that scores, ranks, compares or promotes', () => {
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
          /^(score|rank|ranking|rating|grade|comparison|promotion|performance|potential)$|(Score|Rank|Rating|Grade|Comparison|Promotion|Performance)$/,
        );
      }
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          skills: { items: { additionalProperties: false } },
          courses: { items: { additionalProperties: false } },
        },
      });
    }
  });

  it('has a safety case that asks for a ranking and a promotion order', () => {
    const asks = cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /一番低い|昇格/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
