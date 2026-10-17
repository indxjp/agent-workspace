import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_PERMISSIONS,
  buildCreateAgentInput,
  describeHalf,
  describeModel,
  describeRequestFailure,
  describeTransportRejection,
  fetchFileCatalog,
  filterAgentsByName,
  formatCreatedAt,
  instructionsPreview,
  isApiErrorEnvelope,
  isValidAgentName,
  matchesQuery,
  projectProvidedGroups,
  readAgentResourceOptions,
  readNamedCatalog,
  readRuntimeProfileOptions,
  resolveFileGrants,
  resolveNamedAssignments,
  resolveSaveOutcome,
  type FileCatalog,
  type NamedCatalog,
  type RequestProblem,
} from './model';
import type { AgentResourceAssignments } from '../../contracts/agents';
import type { ProjectResource } from '../../contracts/projects';
import type { ModelSelectionValue } from '../models/catalog';

const RUNTIME_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
// #130's own regression case: a non-Azure connection's provider-side model id — the field the old
// `readModelOptions` could only ever populate from `config.deployment`, which Azure alone has.
const MODEL: NonNullable<ModelSelectionValue> = {
  connectionId: '22222222-2222-4222-8222-222222222222',
  model: 'gpt-4.1',
};

describe('isValidAgentName', () => {
  it('accepts a non-blank name', () => {
    expect(isValidAgentName('Customer Support Agent')).toBe(true);
  });

  it('rejects blank and whitespace-only names, the same rule the server applies', () => {
    expect(isValidAgentName('')).toBe(false);
    expect(isValidAgentName('   ')).toBe(false);
    expect(isValidAgentName('\n\t')).toBe(false);
  });
});

describe('buildCreateAgentInput', () => {
  it('trims the name and sends the mockup’s own step-4 permission defaults', () => {
    const input = buildCreateAgentInput(
      '  Support  ',
      'Answer handbook questions.',
      RUNTIME_PROFILE_ID,
      MODEL,
    );
    expect(input.name).toBe('Support');
    expect(input.instructions).toBe('Answer handbook questions.');
    expect(input.modelConnectionId).toBe(MODEL.connectionId);
    expect(input.model).toBe(MODEL.model);
    // The regression #130 names: a non-null, explicit provider-side model id, not `null`.
    expect(input.model).not.toBeNull();
    expect(input.runtimeProfileId).toBe(RUNTIME_PROFILE_ID);
    expect(input.permissions).toEqual(DEFAULT_AGENT_PERMISSIONS);
    expect(input).not.toHaveProperty('runtimeProfile');
  });

  it('never mutates the shared default permissions object', () => {
    const a = buildCreateAgentInput('A', '', RUNTIME_PROFILE_ID, MODEL);
    const b = buildCreateAgentInput('B', '', RUNTIME_PROFILE_ID, MODEL);
    expect(a.permissions).not.toBe(b.permissions);
  });
});

describe('readRuntimeProfileOptions', () => {
  it('returns exactly the profiles and order from the API without inventing an option', () => {
    const body = {
      runtimeProfiles: [
        { id: 'a', name: 'Local default', driver: 'local', cpu: 2 },
        { id: 'b', name: 'Docker locked', driver: 'docker', networkPolicy: 'none' },
      ],
    };
    expect(readRuntimeProfileOptions(body)).toEqual([
      { id: 'a', name: 'Local default', driver: 'local' },
      { id: 'b', name: 'Docker locked', driver: 'docker' },
    ]);
  });

  it('accepts the API empty state as an empty list', () => {
    expect(readRuntimeProfileOptions({ runtimeProfiles: [] })).toEqual([]);
  });
});

describe('readAgentResourceOptions', () => {
  it('keeps only stable ids and human-readable labels from the three catalogs', () => {
    expect(
      readAgentResourceOptions(
        { files: [{ id: 'f', path: 'handbook/', sizeBytes: 0 }] },
        { skills: [{ id: 's', name: 'reviewer', enabled: true }] },
        { connectors: [{ id: 'c', name: 'GitHub', hasCredential: true }] },
      ),
    ).toEqual({
      files: [{ id: 'f', label: 'handbook/' }],
      skills: [{ id: 's', label: 'reviewer' }],
      connectors: [{ id: 'c', label: 'GitHub' }],
    });
  });

  it('rejects a resource without a relational id', () => {
    expect(() =>
      readAgentResourceOptions(
        { files: [{ path: 'old-object-only' }] },
        { skills: [] },
        { connectors: [] },
      ),
    ).toThrow(/stable id/u);
  });
});

describe('matchesQuery / filterAgentsByName', () => {
  const agents = [{ name: 'Customer Support Agent' }, { name: 'Contract Review' }];

  it('matches case-insensitively, anywhere in the name', () => {
    expect(matchesQuery('Customer Support Agent', 'support')).toBe(true);
    expect(matchesQuery('Customer Support Agent', 'SUPPORT')).toBe(true);
    expect(matchesQuery('Customer Support Agent', 'zzz')).toBe(false);
  });

  it('an empty or whitespace-only query matches everything', () => {
    expect(matchesQuery('Anything', '')).toBe(true);
    expect(matchesQuery('Anything', '   ')).toBe(true);
  });

  it('filters the list by the same rule', () => {
    expect(filterAgentsByName(agents, 'contract')).toEqual([{ name: 'Contract Review' }]);
    expect(filterAgentsByName(agents, '')).toEqual(agents);
  });
});

describe('describeModel', () => {
  it('names the field’s own meaning for null rather than guessing a model name', () => {
    expect(describeModel(null)).toBe('Workspace default');
  });

  it('passes an explicit model id through unchanged', () => {
    expect(describeModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
});

describe('instructionsPreview', () => {
  it('collapses internal whitespace and passes a short string through', () => {
    expect(instructionsPreview('You help  employees\nanswer questions.')).toBe(
      'You help employees answer questions.',
    );
  });

  it('truncates a long string with an ellipsis at the bound', () => {
    const long = 'a'.repeat(200);
    const preview = instructionsPreview(long, 20);
    expect(preview).toBe(`${'a'.repeat(19)}…`);
    expect(preview.length).toBe(20);
  });

  it('is empty for an agent with no instructions', () => {
    expect(instructionsPreview('   ')).toBe('');
  });
});

describe('formatCreatedAt', () => {
  it('formats a valid ISO timestamp', () => {
    expect(formatCreatedAt('2026-01-15T10:00:00.000Z')).toContain('2026');
  });

  it('returns the raw string rather than "Invalid Date" for a malformed timestamp', () => {
    expect(formatCreatedAt('not-a-date')).toBe('not-a-date');
  });
});

describe('isApiErrorEnvelope', () => {
  it('accepts the real shape', () => {
    expect(isApiErrorEnvelope({ error: { code: 'agent_name_conflict', message: 'taken' } })).toBe(
      true,
    );
  });

  it('accepts the RBAC routes’ shape, which spells the prose "detail" (issue #185)', () => {
    // `server/rbac/http.ts`'s `problem()` is the second live producer of this envelope. Before
    // #185 this guard required `message`, so every membership refusal — including the last-Owner
    // 409 — reached the screen as "the server answered 409 without the usual error envelope".
    expect(
      isApiErrorEnvelope({ error: { code: 'last_owner', detail: 'This is the last Owner.' } }),
    ).toBe(true);
  });

  it('rejects anything else, by name rather than by accident', () => {
    for (const bad of [
      null,
      undefined,
      {},
      { error: null },
      { error: {} },
      { error: { code: 1 } },
      // A code with no prose at all is still not an envelope: neither spelling is present, so
      // there is no sentence to render and inventing one is what this guard exists to prevent.
      { error: { code: 'last_owner' } },
      { error: { code: 'last_owner', detail: 42 } },
    ]) {
      expect(isApiErrorEnvelope(bad)).toBe(false);
    }
  });
});

describe('describeRequestFailure', () => {
  it('reads the route’s own code and message when the body is the real envelope', async () => {
    const response = new Response(null, { status: 409 });
    const problem = await describeRequestFailure(response, () =>
      Promise.resolve({
        error: {
          code: 'agent_name_conflict',
          message: 'This workspace already has an agent named "Support".',
        },
      }),
    );
    expect(problem).toEqual({
      kind: 'api',
      status: 409,
      code: 'agent_name_conflict',
      message: 'This workspace already has an agent named "Support".',
    });
  });

  it('reads the RBAC routes’ "detail" prose into the same shape (issue #185)', async () => {
    const response = new Response(null, { status: 409 });
    const problem = await describeRequestFailure(response, () =>
      Promise.resolve({
        error: {
          code: 'last_owner',
          detail:
            'This is the workspace’s last Owner. Spec §21 gives Owner everything, so demoting ' +
            'the last one leaves a workspace nobody can administer. Promote another member first.',
        },
      }),
    );
    expect(problem).toEqual({
      kind: 'api',
      status: 409,
      code: 'last_owner',
      message:
        'This is the workspace’s last Owner. Spec §21 gives Owner everything, so demoting ' +
        'the last one leaves a workspace nobody can administer. Promote another member first.',
    });
  });

  it('reads "detail" past a non-string "message", so no object reaches a screen as prose', async () => {
    // The guard accepts a body where only one of the two spellings is a string, so this shape is an
    // envelope. Falling back with `??` would return `{ nested: 1 }` typed as `string` into
    // `RequestProblem.message`, which every consuming screen renders into JSX — React throws
    // "Objects are not valid as a React child" there and the screen goes down.
    const response = new Response(null, { status: 409 });
    const problem = await describeRequestFailure(response, () =>
      Promise.resolve({
        error: {
          code: 'last_owner',
          message: { nested: 1 },
          detail: 'This is the workspace’s last Owner.',
        },
      }),
    );
    expect(problem).toEqual({
      kind: 'api',
      status: 409,
      code: 'last_owner',
      message: 'This is the workspace’s last Owner.',
    });
  });

  it('names the transport failure when the body is not the envelope, rather than inventing a message', async () => {
    const response = new Response(null, { status: 502 });
    const problem = await describeRequestFailure(response, () => Promise.resolve({ oops: true }));
    expect(problem).toEqual({
      kind: 'transport',
      reason: 'The server answered 502 without the usual error envelope.',
    });
  });

  it('names a body that was not JSON at all', async () => {
    const response = new Response(null, { status: 500 });
    const problem = await describeRequestFailure(response, () =>
      Promise.reject(new Error('bad json')),
    );
    expect(problem).toEqual({
      kind: 'transport',
      reason: 'The server answered 500 with a body that was not JSON.',
    });
  });
});

/**
 * Verification round 2, finding 1: before this round, neither `fetch()` call in
 * `AgentDetailScreen.save()` was wrapped in a `try`/`catch`, so a *rejected* promise (a reset
 * connection, an abort, a client-side timeout — never a `Response` at all) was an uncaught
 * exception rather than a {@link RequestProblem}. `describeTransportRejection` is the conversion
 * `save()` now applies in a `catch` block for both requests, before handing the result to
 * `resolveSaveOutcome` via the same `'definition-failed'` / `'assignments-failed'` arms an
 * HTTP-level failure already uses.
 */
describe('describeTransportRejection', () => {
  it('names a rejected fetch’s own Error message, never a generic string', () => {
    expect(describeTransportRejection(new Error('Failed to fetch'))).toEqual({
      kind: 'transport',
      reason: 'The request failed before the server could answer: Failed to fetch',
    });
  });

  it('still names something when the rejection was not an Error', () => {
    expect(describeTransportRejection('connection reset')).toEqual({
      kind: 'transport',
      reason: 'The request failed before the server could answer: connection reset',
    });
  });
});

// ── Issue #133: rendering an agent's resource assignments by name ─────────────────────────────

describe('fetchFileCatalog', () => {
  it('walks nested folders and resolves every id to its path/kind, never revisiting a folder', async () => {
    const pages: Record<string, readonly { id: string; path: string; kind: 'file' | 'folder' }[]> =
      {
        '': [
          { id: 'root-file', path: 'readme.txt', kind: 'file' },
          { id: 'shared', path: 'shared', kind: 'folder' },
        ],
        shared: [
          { id: 'handbook', path: 'shared/handbook.md', kind: 'file' },
          { id: 'nested', path: 'shared/nested', kind: 'folder' },
        ],
        'shared/nested': [{ id: 'deep-file', path: 'shared/nested/deep.txt', kind: 'file' }],
      };
    const visited: string[] = [];
    const catalog = await fetchFileCatalog((path) => {
      visited.push(path);
      return Promise.resolve(pages[path] ?? []);
    });
    expect(catalog.get('root-file')).toEqual({ path: 'readme.txt', kind: 'file' });
    expect(catalog.get('handbook')).toEqual({ path: 'shared/handbook.md', kind: 'file' });
    expect(catalog.get('deep-file')).toEqual({ path: 'shared/nested/deep.txt', kind: 'file' });
    expect(catalog.size).toBe(5);
    // Each folder path is only ever queued once, however many rows reference it.
    expect(visited).toEqual(['', 'shared', 'shared/nested']);
  });

  it('is a no-op walk when the root page is empty', async () => {
    const catalog = await fetchFileCatalog(() => Promise.resolve([]));
    expect(catalog.size).toBe(0);
  });
});

describe('readNamedCatalog', () => {
  it('reads id/name/enabled rows into a map, keyed by id', () => {
    const catalog = readNamedCatalog(
      { skills: [{ id: 's1', name: 'reviewer', enabled: true }] },
      'skills',
    );
    expect(catalog.get('s1')).toEqual({ name: 'reviewer', enabled: true });
  });

  it('skips a row with no string id — the shape GET /api/skills answers for an unsyncable skill', () => {
    const catalog = readNamedCatalog(
      { skills: [{ name: 'broken', enabled: false, source: null }] },
      'skills',
    );
    expect(catalog.size).toBe(0);
  });

  it('treats a missing or malformed list as empty rather than throwing', () => {
    expect(readNamedCatalog({}, 'connectors').size).toBe(0);
    expect(readNamedCatalog(null, 'connectors').size).toBe(0);
    expect(readNamedCatalog({ connectors: 'not-an-array' }, 'connectors').size).toBe(0);
  });
});

describe('resolveFileGrants', () => {
  const catalog: FileCatalog = new Map([['known', { path: 'shared/handbook', kind: 'folder' }]]);

  it('resolves a known id to its path/kind and reports it as not missing', () => {
    const rows = resolveFileGrants([{ fileId: 'known', access: 'read-write' }], catalog);
    expect(rows).toEqual([
      {
        fileId: 'known',
        access: 'read-write',
        path: 'shared/handbook',
        kind: 'folder',
        missing: false,
      },
    ]);
  });

  it('reports an id absent from a loaded catalog as missing', () => {
    const rows = resolveFileGrants([{ fileId: 'gone', access: 'read' }], catalog);
    expect(rows).toEqual([
      { fileId: 'gone', access: 'read', path: null, kind: null, missing: true },
    ]);
  });

  it('never calls an id missing while the catalog is still loading (`null`)', () => {
    const rows = resolveFileGrants([{ fileId: 'unknown-yet', access: 'read' }], null);
    expect(rows).toEqual([
      { fileId: 'unknown-yet', access: 'read', path: null, kind: null, missing: false },
    ]);
  });
});

describe('resolveNamedAssignments', () => {
  const catalog: NamedCatalog = new Map([['known', { name: 'GitHub', enabled: false }]]);

  it('resolves a known id to its name/enabled state', () => {
    expect(resolveNamedAssignments(['known'], catalog)).toEqual([
      { id: 'known', name: 'GitHub', enabled: false, missing: false },
    ]);
  });

  it('reports an id absent from a loaded catalog as missing', () => {
    expect(resolveNamedAssignments(['gone'], catalog)).toEqual([
      { id: 'gone', name: null, enabled: null, missing: true },
    ]);
  });

  it('never calls an id missing while the catalog is still loading (`null`)', () => {
    expect(resolveNamedAssignments(['unknown-yet'], null)).toEqual([
      { id: 'unknown-yet', name: null, enabled: null, missing: false },
    ]);
  });
});

describe('projectProvidedGroups', () => {
  const AGENT_ID = 'agent-1';
  function project(overrides: Partial<ProjectResource>): ProjectResource {
    return {
      id: 'p1',
      workspaceId: 'w1',
      name: 'Support',
      instructions: null,
      defaultAgentId: AGENT_ID,
      defaultModelConnectionId: null,
      defaultModel: null,
      visibility: 'workspace',
      ownerPrincipalId: 'principal-1',
      createdBy: 'u1',
      archivedAt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      fileIds: [],
      mcpServerIds: [],
      ...overrides,
    };
  }

  it('surfaces only projects whose defaultAgentId is this agent, resolved by name', () => {
    const files: FileCatalog = new Map([['f1', { path: 'shared', kind: 'folder' }]]);
    const connectors: NamedCatalog = new Map([['c1', { name: 'GitHub', enabled: true }]]);
    const groups = projectProvidedGroups(
      [
        project({ id: 'p1', name: 'Support', fileIds: ['f1'], mcpServerIds: ['c1'] }),
        project({ id: 'p2', name: 'Other agent’s project', defaultAgentId: 'agent-2' }),
      ],
      AGENT_ID,
      files,
      connectors,
    );
    expect(groups).toEqual([
      {
        projectId: 'p1',
        projectName: 'Support',
        files: [{ id: 'f1', path: 'shared', missing: false }],
        connectors: [{ id: 'c1', name: 'GitHub', missing: false }],
      },
    ]);
  });

  it('reports a deleted project file/connector id as missing once the catalog is loaded', () => {
    const groups = projectProvidedGroups(
      [project({ fileIds: ['deleted-file'], mcpServerIds: ['deleted-connector'] })],
      AGENT_ID,
      new Map(),
      new Map(),
    );
    expect(groups[0]?.files).toEqual([{ id: 'deleted-file', path: null, missing: true }]);
    expect(groups[0]?.connectors).toEqual([{ id: 'deleted-connector', name: null, missing: true }]);
  });
});

// ── Verification round 1, finding 2: `AgentDetailScreen.save()`'s partial-outcome state machine ──
//
// Extracted to `describeHalf`/`resolveSaveOutcome` in `./model.ts` precisely so it can be driven
// here, without a browser — `agent-detail.tsx`'s own `save()` is an `async` event handler on a
// component this suite otherwise only ever renders with `renderToStaticMarkup` (no effects, no
// handlers). See both functions' own doc comments in `./model.ts` for why each shape below is what
// it is.

describe('describeHalf', () => {
  it('reports a saved half with no reason', () => {
    expect(describeHalf('Definition', 'saved', null)).toBe('Definition saved.');
  });

  it('reports a half that was never attempted', () => {
    expect(describeHalf('Resource assignments', 'not-attempted', null)).toBe(
      'Resource assignments was not attempted.',
    );
  });

  it("reports an API problem's own message for a failed half", () => {
    const problem: RequestProblem = {
      kind: 'api',
      status: 400,
      code: 'unknown_file',
      message: 'The assignment references an unavailable resource: deleted-file.',
    };
    expect(describeHalf('Resource assignments', 'failed', problem)).toBe(
      'Resource assignments was not saved: The assignment references an unavailable resource: deleted-file.',
    );
  });

  it('reports a transport problem’s reason for a failed half', () => {
    const problem: RequestProblem = { kind: 'transport', reason: 'Injected failure.' };
    expect(describeHalf('Resource assignments', 'failed', problem)).toBe(
      'Resource assignments was not saved: Injected failure.',
    );
  });
});

describe('resolveSaveOutcome', () => {
  const TRANSPORT_PROBLEM: RequestProblem = { kind: 'transport', reason: 'Injected failure.' };
  const PERSISTED: AgentResourceAssignments = {
    files: [{ fileId: 'file-a', access: 'read' }],
    skillIds: ['skill-a'],
    connectorIds: [],
  };

  it("reports the definition half failed and the assignments half not-attempted when the PATCH itself fails, and names no persisted assignments — a reload must show what it already showed, not this attempt's draft", () => {
    const resolution = resolveSaveOutcome({
      kind: 'definition-failed',
      problem: TRANSPORT_PROBLEM,
    });
    expect(resolution).toEqual({
      report: {
        definition: 'failed',
        assignments: 'not-attempted',
        definitionProblem: TRANSPORT_PROBLEM,
        assignmentsProblem: null,
      },
      persistedAssignments: null,
    });
  });

  /**
   * Verifier attack #3, the literal repro: "save definition fields and assignments where the
   * second request fails. Assert the screen says the definition saved and the assignments did
   * not, and assert reloading shows exactly that state — not an optimistic view of the
   * assignments." `persistedAssignments: null` is the reload-equivalence answer: `agent-
   * detail.tsx`'s `applySaveOutcome` treats `null` as "touch neither `loaded.assignments` nor
   * `assignmentsDraft`", which is exactly what leaves a reload (a fresh `GET`) showing the same
   * state a failed `PUT` never changed on the server.
   */
  it('reports the definition half saved and the assignments half failed when the PUT fails after a successful PATCH, with no persisted assignments (the reload-equivalence rule)', () => {
    const resolution = resolveSaveOutcome({
      kind: 'assignments-failed',
      problem: TRANSPORT_PROBLEM,
    });
    expect(resolution).toEqual({
      report: {
        definition: 'saved',
        assignments: 'failed',
        definitionProblem: null,
        assignmentsProblem: TRANSPORT_PROBLEM,
      },
      persistedAssignments: null,
    });
  });

  it('reports both halves saved and names the server-persisted assignments — not merely the requested draft — as what a reload would show', () => {
    const resolution = resolveSaveOutcome({ kind: 'both-saved', persistedAssignments: PERSISTED });
    expect(resolution).toEqual({
      report: {
        definition: 'saved',
        assignments: 'saved',
        definitionProblem: null,
        assignmentsProblem: null,
      },
      persistedAssignments: PERSISTED,
    });
  });
});
