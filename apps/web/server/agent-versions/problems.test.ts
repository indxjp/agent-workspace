import { describe, expect, it } from 'vitest';
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import {
  agentNameConflict,
  agentVersionNotFound,
  surfaceNameTaken,
  withReferenceRetry,
} from './problems';
import type { ResolvedReferences } from './store';

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

describe('withReferenceRetry', () => {
  const resolved = (storageGrants?: ResolvedReferences['storageGrants']): ResolvedReferences => ({
    modelConnectionId: null,
    runtimeProfileId: null,
    skillIds: [],
    connectorIds: [],
    files: [],
    ...(storageGrants === undefined ? {} : { storageGrants }),
  });

  // @story US-STO-12
  it('[US-STO-12][contract][sdk] writes the resolved storage grants again after a reference vanished', async () => {
    const grants = [
      { connectionId: '11111111-1111-4111-8111-111111111111', prefix: 'reports', access: 'read' },
    ] as const;
    const written: (readonly unknown[] | undefined)[] = [];
    const outcome = await withReferenceRetry(
      resolved(grants),
      () => Promise.resolve({ kind: 'resolved', references: resolved() }),
      (references) => {
        written.push(references.storageGrants);
        return Promise.resolve({ kind: written.length === 1 ? 'reference-gone' : 'applied' });
      },
    );
    expect(outcome).toEqual({ kind: 'applied' });
    expect(written).toEqual([grants, grants]);
  });
});
