import { describe, expect, it } from 'vitest';

import {
  PROJECT_LIST_FILTERS,
  PROJECT_VISIBILITIES,
  ProjectListResponseSchema,
  ProjectResourceSchema,
  ProjectSessionMoveResponseSchema,
  ProjectSessionResponseSchema,
} from './projects.js';

const PROJECT = '66666666-6666-4666-8666-666666666666';
const AGENT = '11111111-1111-4111-8111-111111111111';
const SESSION = '55555555-5555-4555-8555-555555555555';

const project = {
  id: PROJECT,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Ops',
  instructions: null,
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'private',
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  archivedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
};

describe('ProjectResourceSchema', () => {
  it('accepts an empty project and a configured, archived one', () => {
    expect(ProjectResourceSchema.safeParse(project).success).toBe(true);
    expect(
      ProjectResourceSchema.safeParse({
        ...project,
        instructions: 'Be terse.',
        defaultAgentId: AGENT,
        defaultModelConnectionId: '22222222-2222-4222-8222-222222222222',
        defaultModel: 'claude-sonnet-5',
        visibility: 'workspace',
        createdBy: '77777777-7777-4777-8777-777777777777',
        archivedAt: '2026-09-21T11:00:00.000Z',
        fileIds: ['docs%2Fplan.md'],
        mcpServerIds: ['88888888-8888-4888-8888-888888888888'],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown visibility, an unknown key, a wrong type, and a missing field', () => {
    expect(ProjectResourceSchema.safeParse({ ...project, visibility: 'team' }).success).toBe(false);
    expect(ProjectResourceSchema.safeParse({ ...project, tools: [] }).success).toBe(false);
    expect(ProjectResourceSchema.safeParse({ ...project, fileIds: [1] }).success).toBe(false);
    expect(ProjectResourceSchema.safeParse({ ...project, archivedAt: 1_700_000_000 }).success).toBe(
      false,
    );
    const withoutName = Object.fromEntries(
      Object.entries(project).filter(([key]) => key !== 'name'),
    );
    expect(ProjectResourceSchema.safeParse(withoutName).success).toBe(false);
    expect(ProjectResourceSchema.safeParse({ ...project, name: '' }).success).toBe(false);
  });

  it('publishes the visibility and list-filter vocabularies', () => {
    expect([...PROJECT_VISIBILITIES]).toEqual(['private', 'workspace', 'public']);
    expect([...PROJECT_LIST_FILTERS]).toEqual(['active', 'archived', 'all']);
  });
});

describe('ProjectListResponseSchema', () => {
  it('reads an empty list and a populated one, and refuses a bare array', () => {
    expect(ProjectListResponseSchema.safeParse({ projects: [] }).success).toBe(true);
    expect(ProjectListResponseSchema.safeParse({ projects: [project] }).success).toBe(true);
    expect(ProjectListResponseSchema.safeParse([project]).success).toBe(false);
    expect(ProjectListResponseSchema.safeParse({ projects: [project], total: 1 }).success).toBe(
      false,
    );
  });
});

describe('ProjectSessionResponseSchema', () => {
  it('reads a started session and refuses one missing its agent or carrying more', () => {
    const started = { id: SESSION, projectId: PROJECT, agentId: AGENT };
    expect(ProjectSessionResponseSchema.safeParse(started).success).toBe(true);
    expect(
      ProjectSessionResponseSchema.safeParse({ id: SESSION, projectId: PROJECT }).success,
    ).toBe(false);
    expect(ProjectSessionResponseSchema.safeParse({ ...started, title: null }).success).toBe(false);
    expect(ProjectSessionResponseSchema.safeParse({ ...started, agentId: 1 }).success).toBe(false);
  });
});

describe('ProjectSessionMoveResponseSchema', () => {
  it('reads a moved session', () => {
    expect(
      ProjectSessionMoveResponseSchema.safeParse({ projectId: PROJECT, sessionId: SESSION })
        .success,
    ).toBe(true);
  });

  it('rejects a missing field, a wrong type, an empty id, and an unknown key', () => {
    expect(ProjectSessionMoveResponseSchema.safeParse({ projectId: PROJECT }).success).toBe(false);
    expect(
      ProjectSessionMoveResponseSchema.safeParse({ projectId: PROJECT, sessionId: 7 }).success,
    ).toBe(false);
    expect(
      ProjectSessionMoveResponseSchema.safeParse({ projectId: '', sessionId: SESSION }).success,
    ).toBe(false);
    expect(
      ProjectSessionMoveResponseSchema.safeParse({
        projectId: PROJECT,
        sessionId: SESSION,
        agentId: AGENT,
      }).success,
    ).toBe(false);
    // The started-session envelope is not the moved-session envelope: the two share a route and
    // nothing else.
    expect(
      ProjectSessionMoveResponseSchema.safeParse({
        id: SESSION,
        projectId: PROJECT,
        agentId: AGENT,
      }).success,
    ).toBe(false);
  });
});
