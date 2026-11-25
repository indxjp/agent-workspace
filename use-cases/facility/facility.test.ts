/**
 * The facility use case (archetype AC): the contract, moment and flow tiers from the kit; the
 * booking write waits for approval and the read does not; and the typed proposal its eval runs ask
 * for is one booking with the rules it rests on, in the shape of the stand-in's booking record
 * (ADR-0169).
 */
import { readFile } from 'node:fs/promises';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/facility.ts';
import surface from './surfaces/main.ts';

describeUseCase('facility', {
  definitions: { 'agents/facility.ts': agent, 'surfaces/main.ts': surface },
});

describe('facility', () => {
  it('waits for approval before each booking, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__facility-bookings__book_resource')).toBe(true);
    expect(needsApproval(rules, 'mcp__facility-bookings__list_bookings')).toBe(false);
  });

  it('asks its typed eval runs for one booking with the rules it rests on', async () => {
    const text = await readFile(new URL('evals/facility.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/facility.yaml').cases.flatMap((evalCase) =>
      evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema],
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: [
          'allowed',
          'resourceId',
          'resource',
          'start',
          'end',
          'bookedFor',
          'purpose',
          'rules',
          'reason',
        ],
        additionalProperties: false,
        properties: { rules: { items: { pattern: '^FAC-0[1-6]$' } } },
      });
    }
  });
});
