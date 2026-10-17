import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_IMPACT_RUN_LIMIT,
  archiveImpactFromReads,
  buildCreateProjectInput,
  buildProjectPatch,
  canArchiveProject,
  describeArchivedOn,
  describeEmptyProjectList,
  describeLifecycleFailure,
  draftFromProject,
  isProjectArchived,
  isProjectDirty,
  isValidProjectName,
  parseProjectFilter,
  projectModelSaveTookEffect,
  projectsListQuery,
  readAgentOptions,
  readConnectorOptions,
  readFileOptions,
  readRunPage,
  readSessionProjectIds,
  resolveResourceNames,
  summariseArchiveImpact,
  type ProjectArchiveCapability,
  type ProjectDraft,
  type ProjectResource,
} from './model';

const PROJECT: ProjectResource = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Contract Review',
  instructions: 'Be thorough.',
  defaultAgentId: '33333333-3333-4333-8333-333333333333',
  visibility: 'workspace',
  // issue #129 added this pair to `projects`; `ProjectResource` derives from the full row, so
  // this fixture picked it up too. Neither field is exercised by anything in this file.
  defaultModelConnectionId: null,
  defaultModel: null,
  createdBy: '44444444-4444-4444-8444-444444444444',
  ownerPrincipalId: '55555555-5555-4555-8555-555555555555',
  // issue #183 published the project lifecycle state; this fixture is an active project.
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  fileIds: ['file-1', 'file-2'],
  mcpServerIds: ['mcp-1'],
};

describe('isValidProjectName', () => {
  it('accepts a non-blank name', () => {
    expect(isValidProjectName('Contract Review')).toBe(true);
  });

  it('rejects blank and whitespace-only names, the same rule the server applies', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('   ')).toBe(false);
    expect(isValidProjectName('\n\t')).toBe(false);
  });
});

describe('buildCreateProjectInput', () => {
  const draft: ProjectDraft = {
    name: '  Contract Review  ',
    instructions: 'Be thorough.',
    visibility: 'workspace',
    defaultAgentId: 'agent-1',
    defaultModel: null,
    fileIds: ['file-1'],
    mcpServerIds: ['mcp-1'],
  };

  it('trims the name and forwards exactly the fields POST /api/projects accepts', () => {
    const input = buildCreateProjectInput(draft);
    expect(input.name).toBe('Contract Review');
    expect(input.instructions).toBe('Be thorough.');
    expect(input.visibility).toBe('workspace');
    expect(input.defaultAgentId).toBe('agent-1');
    expect(input.fileIds).toEqual(['file-1']);
    expect(input.mcpServerIds).toEqual(['mcp-1']);
    expect(input).not.toHaveProperty('tools');
    expect(input).not.toHaveProperty('model');
    expect(input).not.toHaveProperty('runtime');
    expect(input).not.toHaveProperty('permissions');
    expect(input).not.toHaveProperty('budget');
  });

  it('copies the id arrays so a later mutation of the draft cannot reach the request body', () => {
    const input = buildCreateProjectInput(draft);
    expect(input.fileIds).not.toBe(draft.fileIds);
    expect(input.mcpServerIds).not.toBe(draft.mcpServerIds);
  });
});

describe('buildProjectPatch', () => {
  it('submits every editable field, never a bare diff', () => {
    const draft: ProjectDraft = draftFromProject(PROJECT);
    const patch = buildProjectPatch({ ...draft, name: 'Renamed' });
    expect(patch).toEqual({
      name: 'Renamed',
      instructions: 'Be thorough.',
      visibility: 'workspace',
      defaultAgentId: PROJECT.defaultAgentId,
      defaultModelConnectionId: null,
      defaultModel: null,
      fileIds: ['file-1', 'file-2'],
      mcpServerIds: ['mcp-1'],
    });
  });

  it('sends the connection and the model as one pair — issue #130, never one without the other', () => {
    const draft: ProjectDraft = {
      ...draftFromProject(PROJECT),
      defaultModel: { connectionId: 'c1', model: 'claude-sonnet-4-5' },
    };
    const patch = buildProjectPatch(draft);
    expect(patch.defaultModelConnectionId).toBe('c1');
    expect(patch.defaultModel).toBe('claude-sonnet-4-5');
  });
});

describe('draftFromProject', () => {
  it('reads null instructions as an empty editable string', () => {
    const draft = draftFromProject({ ...PROJECT, instructions: null });
    expect(draft.instructions).toBe('');
  });

  it('reads the saved (connection, model) pair into one draft field', () => {
    const draft = draftFromProject({
      ...PROJECT,
      defaultModelConnectionId: 'c1',
      defaultModel: 'claude-sonnet-4-5',
    });
    expect(draft.defaultModel).toEqual({ connectionId: 'c1', model: 'claude-sonnet-4-5' });
  });

  it('reads no default as null, not a half-formed pair', () => {
    expect(draftFromProject(PROJECT).defaultModel).toBeNull();
  });
});

describe('projectModelSaveTookEffect', () => {
  it('is true when the PATCH response echoes back the pair that was requested', () => {
    const requested = { connectionId: 'c1', model: 'claude-sonnet-4-5' };
    const saved: ProjectResource = {
      ...PROJECT,
      defaultModelConnectionId: 'c1',
      defaultModel: 'claude-sonnet-4-5',
    };
    expect(projectModelSaveTookEffect(requested, saved)).toBe(true);
  });

  it('is false when a stale server response does not contain the requested pair', () => {
    const requested = { connectionId: 'c1', model: 'claude-sonnet-4-5' };
    const saved: ProjectResource = {
      ...PROJECT,
      defaultModelConnectionId: null,
      defaultModel: null,
    };
    expect(projectModelSaveTookEffect(requested, saved)).toBe(false);
  });

  it('is true when clearing was requested and the response confirms both fields are null', () => {
    const saved: ProjectResource = {
      ...PROJECT,
      defaultModelConnectionId: null,
      defaultModel: null,
    };
    expect(projectModelSaveTookEffect(null, saved)).toBe(true);
  });
});

describe('isProjectDirty', () => {
  const saved = draftFromProject(PROJECT);

  it('is false for an unmodified draft', () => {
    expect(isProjectDirty(saved, saved)).toBe(false);
  });

  it('is false when the same association ids come back in a different order', () => {
    const reordered: ProjectDraft = { ...saved, fileIds: ['file-2', 'file-1'] };
    expect(isProjectDirty(saved, reordered)).toBe(false);
  });

  it('is true when the name changes', () => {
    expect(isProjectDirty(saved, { ...saved, name: 'Something else' })).toBe(true);
  });

  it('is true when instructions change', () => {
    expect(isProjectDirty(saved, { ...saved, instructions: 'Different.' })).toBe(true);
  });

  it('is true when the default agent changes', () => {
    expect(isProjectDirty(saved, { ...saved, defaultAgentId: null })).toBe(true);
  });

  it('is true when a file association is added or removed', () => {
    expect(isProjectDirty(saved, { ...saved, fileIds: ['file-1'] })).toBe(true);
    expect(isProjectDirty(saved, { ...saved, fileIds: ['file-1', 'file-2', 'file-3'] })).toBe(true);
  });

  it('is true when visibility changes', () => {
    expect(isProjectDirty(saved, { ...saved, visibility: 'private' })).toBe(true);
  });

  it('is true when the project default model changes', () => {
    expect(
      isProjectDirty(saved, {
        ...saved,
        defaultModel: { connectionId: 'c1', model: 'claude-sonnet-4-5' },
      }),
    ).toBe(true);
  });
});

describe('resolveResourceNames', () => {
  it('resolves an id present in the catalogue to its current label', () => {
    const resolved = resolveResourceNames(['file-1'], [{ id: 'file-1', label: '/contracts' }]);
    expect(resolved).toEqual([{ id: 'file-1', label: '/contracts' }]);
  });

  it('resolves an id the catalogue no longer carries to a null label — the missing/deleted state', () => {
    const resolved = resolveResourceNames(
      ['file-deleted'],
      [{ id: 'file-1', label: '/contracts' }],
    );
    expect(resolved).toEqual([{ id: 'file-deleted', label: null }]);
  });

  it('preserves order and duplicates from the association list', () => {
    const resolved = resolveResourceNames(
      ['a', 'b'],
      [
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A' },
      ],
    );
    expect(resolved).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
  });
});

describe('readAgentOptions / readFileOptions / readConnectorOptions', () => {
  it('reads a well-formed agents catalogue', () => {
    expect(readAgentOptions({ agents: [{ id: 'a1', name: 'Support' }] })).toEqual([
      { id: 'a1', label: 'Support' },
    ]);
  });

  it('reads a well-formed root files catalogue keyed by path', () => {
    expect(readFileOptions({ files: [{ id: 'f1', path: '/contracts' }] })).toEqual([
      { id: 'f1', label: '/contracts' },
    ]);
  });

  it('reads a well-formed connectors catalogue', () => {
    expect(readConnectorOptions({ connectors: [{ id: 'c1', name: 'Slack' }] })).toEqual([
      { id: 'c1', label: 'Slack' },
    ]);
  });

  it('throws a named error for a response with no list, rather than returning an empty catalogue', () => {
    expect(() => readAgentOptions({})).toThrow(/has no list/u);
  });

  it('throws a named error for a row with no stable id or label', () => {
    expect(() => readFileOptions({ files: [{ id: 'f1' }] })).toThrow(/has no stable id or label/u);
  });
});

// ── Project lifecycle — issue #184 ──────────────────────────────────────────────────────────────

const VIEWER_ID = PROJECT.ownerPrincipalId;
const OTHER_ID = '66666666-6666-4666-8666-666666666666';

const ARCHIVED: ProjectResource = { ...PROJECT, archivedAt: '2026-09-13T08:30:00.000Z' };

describe('parseProjectFilter', () => {
  it('reads each value the server accepts', () => {
    expect(parseProjectFilter('active')).toBe('active');
    expect(parseProjectFilter('archived')).toBe('archived');
    expect(parseProjectFilter('all')).toBe('all');
  });

  it('reads an absent parameter as the active view, the same default the list route applies', () => {
    expect(parseProjectFilter(null)).toBe('active');
  });

  it('reads an unrecognised value as the active view rather than passing it to the server', () => {
    expect(parseProjectFilter('ARCHIVED')).toBe('active');
    expect(parseProjectFilter('everything')).toBe('active');
    expect(parseProjectFilter('')).toBe('active');
  });
});

describe('projectsListQuery', () => {
  it('always sends an explicit archived filter, never relying on the route default', () => {
    expect(projectsListQuery('active')).toBe('/api/projects?archived=active');
    expect(projectsListQuery('archived')).toBe('/api/projects?archived=archived');
    expect(projectsListQuery('all')).toBe('/api/projects?archived=all');
  });

  it('produces a value the server would accept for every filter it parses', () => {
    for (const raw of ['active', 'archived', 'all', 'nonsense', null]) {
      const url = new URL(projectsListQuery(parseProjectFilter(raw)), 'https://example.invalid');
      expect(['active', 'archived', 'all']).toContain(url.searchParams.get('archived'));
    }
  });
});

describe('describeEmptyProjectList', () => {
  it('does not offer the create form as the answer to an empty archived view', () => {
    expect(describeEmptyProjectList('archived')).toBe('No archived projects.');
  });

  it('keeps the original copy for the views a new project would land in', () => {
    expect(describeEmptyProjectList('active')).toBe('No projects yet. Create one above.');
    expect(describeEmptyProjectList('all')).toBe('No projects yet. Create one above.');
  });
});

describe('isProjectArchived / describeArchivedOn', () => {
  it('reads the published lifecycle state rather than inferring one', () => {
    expect(isProjectArchived(PROJECT)).toBe(false);
    expect(isProjectArchived(ARCHIVED)).toBe(true);
  });

  it('names the UTC day a project was archived, and nothing for an active one', () => {
    expect(describeArchivedOn(ARCHIVED)).toBe('2026-09-13');
    expect(describeArchivedOn(PROJECT)).toBeNull();
  });

  it('answers null rather than an unreadable date for a timestamp it cannot parse', () => {
    expect(describeArchivedOn({ ...PROJECT, archivedAt: 'not-a-date' })).toBeNull();
  });
});

describe('canArchiveProject', () => {
  const capability = (
    canArchiveOwn: boolean,
    canArchiveOther: boolean,
    viewerPrincipalId: string | null,
  ): ProjectArchiveCapability => ({ canArchiveOwn, canArchiveOther, viewerPrincipalId });

  it('allows a caller the server grants "own" on a project their principal owns', () => {
    expect(canArchiveProject(capability(true, false, VIEWER_ID), PROJECT)).toBe(true);
  });

  it('refuses that same caller on a project owned by another principal', () => {
    expect(canArchiveProject(capability(true, false, OTHER_ID), PROJECT)).toBe(false);
  });

  it('allows a caller the server grants "other" on any project in the workspace', () => {
    expect(canArchiveProject(capability(true, true, OTHER_ID), PROJECT)).toBe(true);
  });

  it('refuses a caller the server grants neither ownership answer', () => {
    expect(canArchiveProject(capability(false, false, VIEWER_ID), PROJECT)).toBe(false);
    expect(canArchiveProject(capability(false, false, OTHER_ID), PROJECT)).toBe(false);
  });

  it('refuses when the viewer is unknown, because ownership then has no answer (ADR-0015)', () => {
    expect(canArchiveProject(capability(true, true, null), PROJECT)).toBe(false);
  });

  it('decides restore the same way as archive, since the state does not change the grant', () => {
    expect(canArchiveProject(capability(true, false, VIEWER_ID), ARCHIVED)).toBe(true);
    expect(canArchiveProject(capability(false, false, VIEWER_ID), ARCHIVED)).toBe(false);
  });
});

describe('summariseArchiveImpact', () => {
  it('says plainly that nothing visible is affected rather than printing two zeroes', () => {
    const sentence = summariseArchiveImpact({ sessions: 0, runs: 0, runsTruncated: false });
    expect(sentence).toContain('No sessions or runs that you can see');
    expect(sentence).not.toContain('0 sessions');
  });

  it('uses the singular for exactly one of each', () => {
    expect(summariseArchiveImpact({ sessions: 1, runs: 1, runsTruncated: false })).toContain(
      '1 session and 1 run that you can see',
    );
  });

  it('uses the plural for several', () => {
    expect(summariseArchiveImpact({ sessions: 3, runs: 12, runsTruncated: false })).toContain(
      '3 sessions and 12 runs that you can see',
    );
  });

  it('counts a zero on one side while the other has rows', () => {
    expect(summariseArchiveImpact({ sessions: 0, runs: 4, runsTruncated: false })).toContain(
      '0 sessions and 4 runs',
    );
  });

  it('says "200+" rather than a total it never verified, when the run page was cut short', () => {
    const sentence = summariseArchiveImpact({
      sessions: 2,
      runs: ARCHIVE_IMPACT_RUN_LIMIT,
      runsTruncated: true,
    });
    expect(sentence).toContain('200+ runs');
    expect(sentence).not.toContain('200 runs that');
  });

  it('names the scope of the count, because both reads narrow to the caller', () => {
    expect(summariseArchiveImpact({ sessions: 3, runs: 1, runsTruncated: false })).toContain(
      'that you can see',
    );
  });
});

describe('describeLifecycleFailure', () => {
  it('does not pretend to tell a concealed refusal apart from a deleted project', () => {
    expect(
      describeLifecycleFailure({
        kind: 'api',
        status: 404,
        code: 'project_not_found',
        message: 'Project not found.',
      }),
    ).toEqual({
      kind: 'api',
      status: 404,
      code: 'project_not_found',
      message: 'This project is no longer available.',
    });
  });

  it("keeps the server's own wording for every other status", () => {
    const conflict = {
      kind: 'api',
      status: 409,
      code: 'project_archived',
      message: 'This project is archived.',
    } as const;
    expect(describeLifecycleFailure(conflict)).toEqual(conflict);
  });

  it('passes a transport failure through untouched', () => {
    const transport = { kind: 'transport', reason: 'The connection was reset.' } as const;
    expect(describeLifecycleFailure(transport)).toEqual(transport);
  });
});

describe('readSessionProjectIds', () => {
  it("reads each visible session's project", () => {
    expect(
      readSessionProjectIds({
        sessions: [{ id: 's1', projectId: 'p1' }, { id: 's2', projectId: 'p2' }, { id: 's3' }],
        projectKey: 'ws',
      }),
    ).toEqual(['p1', 'p2', null]);
  });

  it('reads a row with a null project as belonging to no project, not as malformed', () => {
    expect(readSessionProjectIds({ sessions: [{ id: 's1', projectId: null }] })).toEqual([null]);
  });

  it('throws a named error for a response with no session list', () => {
    expect(() => readSessionProjectIds({})).toThrow(/has no list/u);
    expect(() => readSessionProjectIds([])).toThrow(/was not an object/u);
    expect(() => readSessionProjectIds({ sessions: ['nope'] })).toThrow(/was not an object/u);
  });
});

describe('readRunPage', () => {
  it('counts the runs on the page and reports a complete page as untruncated', () => {
    expect(readRunPage({ runs: [{ id: 'r1' }, { id: 'r2' }], nextCursor: null })).toEqual({
      runs: 2,
      truncated: false,
    });
  });

  it('reports a page with a next cursor as truncated, so the summary can say "+"', () => {
    expect(readRunPage({ runs: [{ id: 'r1' }], nextCursor: 'b2Zmc2V0' })).toEqual({
      runs: 1,
      truncated: true,
    });
  });

  it('throws a named error rather than counting zero for a malformed response', () => {
    expect(() => readRunPage({ nextCursor: null })).toThrow(/has no list/u);
    expect(() => readRunPage({ runs: [] })).toThrow(/no nextCursor/u);
  });
});

describe('archiveImpactFromReads', () => {
  it('combines two answered reads into the counts the confirmation renders', () => {
    expect(archiveImpactFromReads(['p1', 'p1'], { runs: 4, truncated: true })).toEqual({
      sessions: 2,
      runs: 4,
      runsTruncated: true,
    });
  });

  it('answers null when the sessions read failed, rather than reporting it as zero sessions', () => {
    expect(archiveImpactFromReads(null, { runs: 4, truncated: false })).toBeNull();
  });

  it('answers null when the runs read failed, rather than reporting it as zero runs', () => {
    expect(archiveImpactFromReads(['p1'], null)).toBeNull();
  });

  it('answers null when neither read succeeded', () => {
    expect(archiveImpactFromReads(null, null)).toBeNull();
  });

  it('keeps a genuine zero on a read that did answer', () => {
    expect(archiveImpactFromReads([], { runs: 0, truncated: false })).toEqual({
      sessions: 0,
      runs: 0,
      runsTruncated: false,
    });
  });
});
