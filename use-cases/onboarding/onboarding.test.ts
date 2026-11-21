/**
 * The onboarding use case (archetype AC, the 100-use-case plan's reference entry for it): the
 * contract, moment and flow tiers from the kit; the task write waits for approval and the read does
 * not; and the typed proposal its eval runs ask for has one task per checklist item and no field in
 * which a person could be assessed (the plan's rule that a person decides about people).
 */
import { readFile } from 'node:fs/promises';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/onboarding.ts';
import surface from './surfaces/main.ts';

describeUseCase('onboarding', {
  definitions: { 'agents/onboarding.ts': agent, 'surfaces/main.ts': surface },
});

const TASK_FIELDS = ['item', 'title', 'assignee', 'due', 'notes', 'source'];

describe('onboarding', () => {
  it('waits for approval before each task write, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__onboarding-tasks__create_task')).toBe(true);
    expect(needsApproval(rules, 'mcp__onboarding-tasks__list_tasks')).toBe(false);
  });

  it('asks its typed eval runs for one task per checklist item, with no field to assess a person', async () => {
    const text = await readFile(new URL('evals/onboarding.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/onboarding.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['employeeId', 'name', 'startDate', 'tasks'],
        additionalProperties: false,
        properties: {
          tasks: {
            items: {
              required: TASK_FIELDS,
              additionalProperties: false,
              properties: { item: { pattern: '^ONB-0[1-6]$' } },
            },
          },
        },
      });
      const fields = JSON.stringify(schema);
      expect(fields).not.toMatch(/score|rank|rating|grade|aptitude|assess/iu);
    }
  });
});
