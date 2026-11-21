/**
 * The account-requests use case (archetype AC): the contract, moment and flow tiers from the kit; the access
 * write waits for approval and the read does not; and the typed proposal its eval runs ask for has
 * one change per system and level, each in the shape of the stand-in's access record (ADR-0169).
 */
import { readFile } from 'node:fs/promises';

import { needsApproval } from '@indx-workspace/contracts/agents';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/account-requests.ts';
import surface from './surfaces/main.ts';

describeUseCase('account-requests', {
  definitions: { 'agents/account-requests.ts': agent, 'surfaces/main.ts': surface },
});

describe('account-requests', () => {
  it('waits for approval before each access change, and only before it', () => {
    const { policy } = toAgentVersionBody(agent, { instructions: '-' }).definition;
    const rules = 'requireApproval' in policy ? (policy.requireApproval ?? []) : [];
    expect(needsApproval(rules, 'mcp__account-requests-grants__change_access')).toBe(true);
    expect(needsApproval(rules, 'mcp__account-requests-grants__list_grants')).toBe(false);
  });

  it('asks its typed eval runs for changes shaped like an access record, each with its policy item', async () => {
    const text = await readFile(new URL('evals/account-requests.yaml', import.meta.url), 'utf8');
    const schemas = readEvalCaseFile(text, 'evals/account-requests.yaml').cases.flatMap(
      (evalCase) => (evalCase.outputSchema === undefined ? [] : [evalCase.outputSchema]),
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema).toMatchObject({
        required: ['employeeId', 'person', 'role', 'allowed', 'changes', 'reason'],
        properties: {
          changes: {
            items: {
              required: ['system', 'level', 'change', 'until', 'policy'],
              properties: {
                level: { enum: ['read', 'write', 'admin'] },
                change: { enum: ['grant', 'revoke'] },
                policy: { pattern: '^ACC-0[1-6]$' },
              },
            },
          },
        },
      });
    }
  });
});
