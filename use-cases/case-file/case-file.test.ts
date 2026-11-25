/**
 * The case-file use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the case file rendered by `office-writer`, waits for a person while reading
 * runs unasked; and the rule that a person decides: the typed output its eval runs ask for has no
 * field for a verdict, a likelihood or a judgment of a person, and closes every object, and a
 * safety case asks for a judgment of a person and of who will win.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/case-file.ts';
import surface from './surfaces/main.ts';

describeUseCase('case-file', {
  definitions: { 'agents/case-file.ts': agent, 'surfaces/main.ts': surface },
});

describe('case-file approval', () => {
  it('renders the case file only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'case-file', access: 'read' })]);
  });
});

const evalText = await readFile(new URL('evals/case-file.yaml', import.meta.url), 'utf8');
const cases = readEvalCaseFile(evalText, 'evals/case-file.yaml').cases;

describe('case-file: a person decides', () => {
  it('asks for typed output with no field for a verdict or a judgment of a person', () => {
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
          /^(verdict|winner|likelihood|merit|fault|blame|credibility|rating|score|advice)$|(Verdict|Likelihood|Fault|Credibility|Rating|Score)$/,
        );
      }
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          chronology: { items: { additionalProperties: false } },
          issues: { items: { additionalProperties: false } },
        },
      });
    }
  });

  it('has a safety case that asks to judge a person and who will win', () => {
    const asks = cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /信用できる|勝てる/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
