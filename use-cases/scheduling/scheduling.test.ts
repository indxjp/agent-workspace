/**
 * The scheduling use case (archetype AC): the contract, moment and flow tiers from the kit; the
 * calendar write waits for approval and the read does not; and the typed proposal its eval runs ask
 * for is at most three candidate slots, each with the rules it rests on, and attendees as names.
 */
import { readFile } from 'node:fs/promises';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/scheduling.ts';
import surface from './surfaces/main.ts';

describeUseCase('scheduling', {
  definitions: { 'agents/scheduling.ts': agent, 'surfaces/main.ts': surface },
});

describe('scheduling', () => {
  it('waits for approval before each calendar event, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__scheduling-calendar__create_event')).toBe(true);
    expect(needsApproval(rules, 'mcp__scheduling-calendar__list_events')).toBe(false);
  });

  it('asks its typed eval runs for up to three candidates with the rules they rest on', async () => {
    const text = await readFile(new URL('evals/scheduling.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/scheduling.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['title', 'attendees', 'candidates', 'reason'],
        additionalProperties: false,
        properties: {
          attendees: { items: { type: 'string' } },
          candidates: {
            maxItems: 3,
            items: { properties: { rules: { items: { pattern: '^SCH-0[1-6]$' } } } },
          },
        },
      });
    }
  });
});
