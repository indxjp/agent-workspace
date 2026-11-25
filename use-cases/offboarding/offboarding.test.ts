/**
 * The offboarding use case (archetype AC): the contract, moment and flow tiers from the kit; the
 * access removal waits for approval and the read does not; the agent holds no tool that deletes an
 * account or data; and the typed proposal its eval runs ask for has only removals, each shaped like
 * the stand-in's access record (ADR-0169), and no field in which the leaver could be assessed.
 */
import { readFile } from 'node:fs/promises';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/offboarding.ts';
import surface from './surfaces/main.ts';

describeUseCase('offboarding', {
  definitions: { 'agents/offboarding.ts': agent, 'surfaces/main.ts': surface },
});

describe('offboarding', () => {
  it('waits for approval before each access removal, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__offboarding-access__change_access')).toBe(true);
    expect(needsApproval(rules, 'mcp__offboarding-access__list_grants')).toBe(false);
  });

  it('holds only the access connector and the reference folder read-only', () => {
    expect(agent.tools).toEqual([expect.objectContaining({ connector: 'offboarding-access' })]);
    expect(agent.files).toEqual([expect.objectContaining({ path: 'offboarding', access: 'read' })]);
  });

  it('asks its typed eval runs for removals only, with no field to assess the leaver', async () => {
    const text = await readFile(new URL('evals/offboarding.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/offboarding.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        additionalProperties: false,
        properties: {
          removals: {
            items: {
              required: ['system', 'level', 'change', 'until', 'item'],
              properties: { change: { enum: ['revoke'] } },
            },
          },
        },
      });
      expect(JSON.stringify(schema)).not.toMatch(/reason|score|rank|rating|assess|rehire/iu);
    }
  });
});
