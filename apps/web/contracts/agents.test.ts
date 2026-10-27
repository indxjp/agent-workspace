import { describe, expect, it } from 'vitest';

import {
  AGENT_PERMISSION_KEYS,
  AgentListResponseSchema,
  AgentPermissionsSchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceSchema,
} from './agents';

const agent = {
  id: 'agent-1',
  workspaceId: 'workspace-1',
  name: 'Support',
  instructions: 'Answer carefully.',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  createdBy: 'user-1',
  ownerPrincipalId: 'principal-1',
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

describe('agent API contracts', () => {
  it('keeps the permission vocabulary and strict schema aligned', () => {
    expect(AGENT_PERMISSION_KEYS).toEqual([
      'readFiles',
      'writeFiles',
      'runCommands',
      'unrestrictedNetwork',
    ]);
    expect(
      AgentPermissionsSchema.safeParse({ ...agent.permissions, becomeRoot: true }).success,
    ).toBe(false);
  });

  it('accepts complete agent resources and list responses', () => {
    expect(AgentResourceSchema.parse(agent)).toEqual(agent);
    expect(AgentListResponseSchema.parse({ agents: [agent] })).toEqual({ agents: [agent] });
  });

  it('rejects malformed or additional agent fields', () => {
    expect(AgentResourceSchema.safeParse({ ...agent, createdAt: 'today' }).success).toBe(false);
    expect(AgentResourceSchema.safeParse({ ...agent, unexpected: true }).success).toBe(false);
  });

  it('validates the resource-assignment response independently of persistence types', () => {
    const response = {
      assignments: {
        files: [{ fileId: 'file-1', access: 'read-write' }],
        skillIds: ['skill-1'],
        connectorIds: ['connector-1'],
        storageGrants: [],
      },
    };
    expect(AgentResourceAssignmentsResponseSchema.parse(response)).toEqual(response);
    expect(
      AgentResourceAssignmentsResponseSchema.safeParse({
        assignments: { ...response.assignments, files: [{ fileId: 'file-1', access: 'admin' }] },
      }).success,
    ).toBe(false);
  });
});
