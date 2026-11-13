import {
  AgentPolicySchema,
  CreateAgentWithAssignmentsResponseSchema,
} from '@indx-workspace/contracts/agents';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { FIXTURES, IDS, json, runCli, stdoutJson } from '../testing.js';

import { body } from './agents.scenarios.test-support.js';
describe('aw agents', () => {
  describe('policy (S-13, issue #234)', () => {
    it('get --json round-trips and the table shows something', async () => {
      const structured = await runCli(['agents', 'policy', 'get', IDS.agent, '--json'], {
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(structured.calls[0]?.method).toBe('GET');
      expect(structured.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/policy`);
      expect(AgentPolicySchema.parse(stdoutJson(structured))).toEqual(FIXTURES.policy);

      const human = await runCli(['agents', 'policy', 'get', IDS.agent], {
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(human.code).toBe(EXIT_CODE.ok);
      expect(human.stdout.length).toBeGreaterThan(0);
    });

    it('set --file - puts the body parsed against AgentPolicySchema and reads what was stored', async () => {
      const set = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-', '--json'], {
        stdin: JSON.stringify(FIXTURES.policy),
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(set.code).toBe(EXIT_CODE.ok);
      expect(set.calls[0]?.method).toBe('PUT');
      expect(set.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/policy`);
      expect(set.calls[0]?.json).toEqual(FIXTURES.policy);
      expect(AgentPolicySchema.parse(stdoutJson(set))).toEqual(FIXTURES.policy);
    });

    it('set refuses a body that does not match AgentPolicySchema before any request is sent', async () => {
      const bad = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-'], {
        stdin: JSON.stringify({ engine: 'other-sdk' }),
      });
      expect(bad.code).toBe(EXIT_CODE.usage);
      expect(bad.calls).toHaveLength(0);
    });

    it('surfaces skill_not_assigned by exit code and message', async () => {
      const conflict = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-'], {
        stdin: JSON.stringify(FIXTURES.policy),
        route: () =>
          json(409, {
            error: {
              code: 'skill_not_assigned',
              message: 'The policy allowlists an unassigned skill.',
            },
          }),
      });
      expect(conflict.code).toBe(EXIT_CODE.problem);
      expect(conflict.stderr).toContain('skill_not_assigned');
    });
  });
  describe('create with assignment flags (K-2, issue #234)', () => {
    it('without any assignment flag, posts the bare agent body as always (one request)', async () => {
      const create = await runCli(['agents', 'create', '--file', '-'], {
        stdin: JSON.stringify(body),
        route: () => json(201, FIXTURES.agent),
      });
      expect(create.code).toBe(EXIT_CODE.ok);
      expect(create.calls).toHaveLength(1);
      expect(create.calls[0]?.json).toEqual(body);
    });

    it('--skill/--connector/--grant-file compose one POST body of { agent, assignments }', async () => {
      const create = await runCli(
        [
          'agents',
          'create',
          '--file',
          '-',
          '--skill',
          'release-notes',
          '--connector',
          'c-1',
          '--grant-file',
          'f-1',
          '--grant-file',
          'f-2:read-write',
          '--json',
        ],
        {
          stdin: JSON.stringify(body),
          route: () => json(201, { agent: FIXTURES.agent, assignments: FIXTURES.assignments }),
        },
      );
      expect(create.code).toBe(EXIT_CODE.ok);
      expect(create.calls).toHaveLength(1);
      expect(create.calls[0]?.method).toBe('POST');
      expect(create.calls[0]?.url.pathname).toBe('/api/agents');
      expect(create.calls[0]?.json).toEqual({
        agent: body,
        assignments: {
          files: [
            { fileId: 'f-1', access: 'read' },
            { fileId: 'f-2', access: 'read-write' },
          ],
          skillIds: ['release-notes'],
          connectorIds: ['c-1'],
        },
      });
      expect(CreateAgentWithAssignmentsResponseSchema.parse(stdoutJson(create))).toEqual({
        agent: FIXTURES.agent,
        assignments: FIXTURES.assignments,
      });
    });

    it('refuses a malformed --grant-file access before any request is sent', async () => {
      const bad = await runCli(['agents', 'create', '--file', '-', '--grant-file', 'f-1:execute'], {
        stdin: JSON.stringify(body),
      });
      expect(bad.code).toBe(EXIT_CODE.usage);
      expect(bad.calls).toHaveLength(0);
    });
  });
});
