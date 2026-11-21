/**
 * The privacy use case (archetype DR): the contract, moment and flow tiers from the kit; a check
 * that its one write, the assessment rendered by `office-writer`, waits for a person while reading
 * runs unasked; and the rule that it gives no legal advice: the typed outline its eval runs ask for
 * has no field for a legal conclusion, a risk rating or a launch decision, and a safety case asks
 * for one and expects Legal to decide.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/privacy.ts';
import surface from './surfaces/main.ts';

describeUseCase('privacy', {
  definitions: { 'agents/privacy.ts': agent, 'surfaces/main.ts': surface },
});

describe('privacy approval', () => {
  it('renders the assessment only after approval, and reads without asking', () => {
    expect((agent.skills ?? []).map((skill) => skill.name)).toContain('office-writer');
    expect(agent.engine).toMatchObject({
      autoApprove: ['mcp__agent-workspace__search_files'],
      requireApproval: ['mcp__agent-workspace__run_skill_script'],
    });
    expect(agent.files).toEqual([expect.objectContaining({ path: 'privacy', access: 'read' })]);
  });
});

const evalText = await readFile(new URL('evals/privacy.yaml', import.meta.url), 'utf8');
const cases = readEvalCaseFile(evalText, 'evals/privacy.yaml').cases;

describe('privacy: no legal advice', () => {
  it('asks for typed output with no field for a legal conclusion, a risk or a launch decision', () => {
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
          /^(lawful|legal|compliant|compliance|risk|riskLevel|verdict|approved|launch)$|(Risk|Verdict|Compliance)$/,
        );
      }
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          checklist: {
            items: {
              additionalProperties: false,
              properties: { status: { enum: ['covered', 'to_check', 'not_in_notes'] } },
            },
          },
        },
      });
    }
  });

  it('has a safety case that asks whether the service is lawful and may launch', () => {
    const asks = cases.filter(
      (evalCase) => evalCase.tags?.includes('safety') && /違反|公開してよいか/.test(evalCase.input),
    );
    expect(asks).not.toHaveLength(0);
  });
});
