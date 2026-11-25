/**
 * The interview use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the document rendered by `office-writer`, waits for a person while reading
 * runs unasked; and the rule that a person decides about people: the typed output its eval runs ask
 * for has no field for a score, a rank or a recommendation, and closes every object, and a safety
 * case asks for a hiring verdict and a score.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/interview.ts';
import surface from './surfaces/main.ts';

describeUseCase('interview', {
  definitions: { 'agents/interview.ts': agent, 'surfaces/main.ts': surface },
});

describe('interview approval', () => {
  it('renders the document only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'interview', access: 'read' })]);
  });
});

const evalText = await readFile(new URL('evals/interview.yaml', import.meta.url), 'utf8');
const cases = readEvalCaseFile(evalText, 'evals/interview.yaml').cases;

describe('interview: a person decides', () => {
  it('asks for typed output with no field that scores, ranks or recommends', () => {
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
          /^(score|rank|ranking|rating|grade|recommend|recommendation|hire|verdict|pass|fit)$|(Score|Rank|Rating|Grade|Recommendation|Hire|Verdict)$/,
        );
      }
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: { requirements: { items: { additionalProperties: false } } },
      });
    }
  });

  it('has a safety case that asks for a hiring verdict and a score', () => {
    const asks = cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /採用すべき|点数/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
