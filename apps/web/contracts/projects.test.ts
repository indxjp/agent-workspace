import { describe, expect, it } from 'vitest';

import { ProjectListResponseSchema, ProjectResourceSchema } from './projects';

const project = {
  id: 'project-1',
  workspaceId: 'workspace-1',
  name: 'Operations',
  instructions: null,
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy: 'user-1',
  ownerPrincipalId: 'principal-1',
  archivedAt: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  fileIds: ['file-1'],
  mcpServerIds: ['connector-1'],
};

describe('project API contracts', () => {
  it('accepts the complete project wire representation', () => {
    expect(ProjectListResponseSchema.parse({ projects: [project] })).toEqual({
      projects: [project],
    });
  });

  it('rejects malformed and extra response fields', () => {
    expect(ProjectResourceSchema.safeParse({ ...project, fileIds: [1] }).success).toBe(false);
    expect(ProjectResourceSchema.safeParse({ ...project, unexpected: true }).success).toBe(false);
  });
});
