import { readFileSync } from 'node:fs';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/customer-inquiry.ts';
import surface from './surfaces/main.ts';

describeUseCase('customer-inquiry', {
  definitions: { 'agents/customer-inquiry.ts': agent, 'surfaces/main.ts': surface },
});

describe('customer enquiry intake', () => {
  it('declares a webhook trigger the platform accepts, whose runs answer in a typed output', () => {
    const file = new URL('triggers/customer-inquiry.json', import.meta.url);
    const trigger = CreateTriggerRequestSchema.parse({
      ...(JSON.parse(readFileSync(file, 'utf8')) as object),
      agentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(trigger).toMatchObject({ kind: 'webhook', name: 'customer-inquiry' });
    expect(trigger.prompt).toContain('{{body}}');
    expect(trigger.outputSchema).toMatchObject({ type: 'object' });
  });

  it('waits for approval before the hand-over write, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__tracker__create_task')).toBe(true);
    expect(needsApproval(rules, 'mcp__tracker__list_tasks')).toBe(false);
  });
});
