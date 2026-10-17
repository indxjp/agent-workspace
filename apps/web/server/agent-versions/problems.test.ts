import { describe, expect, it } from 'vitest';
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import { agentNameConflict, agentVersionNotFound, surfaceNameTaken } from './problems';

describe('agent-version refusals read their status from the contract (issue #489)', () => {
  it('answers 409 agent_name_conflict with the legacy message', () => {
    const result = agentNameConflict('x');

    expect(result.status).toBe(409);
    expect(result.status).toBe(AGENT_VERSION_PROBLEM_CODES.agent_name_conflict);
    expect(result.body).toEqual({
      error: {
        code: 'agent_name_conflict',
        message: 'This workspace already has an agent named "x".',
      },
    });
  });

  it('answers 409 surface_name_taken naming the surface', () => {
    const result = surfaceNameTaken('s');

    expect(result.status).toBe(409);
    expect(result.status).toBe(AGENT_VERSION_PROBLEM_CODES.surface_name_taken);
    expect(result.body).toEqual({
      error: {
        code: 'surface_name_taken',
        message:
          'Another agent in this workspace already serves a surface of that name in this environment.',
        details: ['surface:s'],
      },
    });
  });

  it('answers 404 agent_version_not_found naming the version', () => {
    const result = agentVersionNotFound(3);

    expect(result.status).toBe(404);
    expect(result.status).toBe(AGENT_VERSION_PROBLEM_CODES.agent_version_not_found);
    expect(result.body).toEqual({
      error: {
        code: 'agent_version_not_found',
        message: 'The agent has no version with that number.',
        details: ['version:3'],
      },
    });
  });
});
