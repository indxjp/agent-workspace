import { afterEach, describe, expect, it } from 'vitest';

import { ApiProblemSchema } from '@indx-workspace/contracts';
import { AuditEventListResponseSchema } from '@indx-workspace/contracts/observability';
import {
  createInMemoryWorkspaceScopeResolver,
  type AuditEventRepository,
} from '@agent-workspace/core/db';

import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import { GET } from '../../app/api/audit-events/route';
import { encodeListCursor } from '../pagination/list-cursor';
import { keysetPageOf } from '../pagination/testing';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const OTHER_WORKSPACE_ID = 'other-workspace-under-test';
const CALLER = { email: 'caller@audit.example.test' };

type AuditRow = Awaited<ReturnType<AuditEventRepository['list']>>['items'][number];

function row(id: string, workspaceId: string, createdAt = '2026-09-21T10:00:00.000Z'): AuditRow {
  return {
    id,
    workspaceId,
    actorUserId: null,
    actorPrincipalId: null,
    actorLabel: 'system',
    action: 'agent-changed',
    subjectId: null,
    subjectLabel: 'An agent',
    details: null,
    createdAt: new Date(createdAt),
  };
}

const ROWS: Readonly<Record<string, readonly AuditRow[]>> = {
  [TEST_WORKSPACE_ID]: [row('11111111-1111-4111-8111-111111111111', TEST_WORKSPACE_ID)],
  [OTHER_WORKSPACE_ID]: [row('22222222-2222-4222-8222-222222222222', OTHER_WORKSPACE_ID)],
};

/** Five rows of the caller's workspace, two of them sharing one instant so only `id` orders them. */
const PAGED_ROWS: readonly AuditRow[] = [
  row('aaaaaaaa-0000-4000-8000-000000000001', TEST_WORKSPACE_ID, '2026-09-21T10:00:00.000Z'),
  row('aaaaaaaa-0000-4000-8000-000000000002', TEST_WORKSPACE_ID, '2026-09-21T10:00:01.000Z'),
  row('aaaaaaaa-0000-4000-8000-000000000003', TEST_WORKSPACE_ID, '2026-09-21T10:00:01.000Z'),
  row('aaaaaaaa-0000-4000-8000-000000000004', TEST_WORKSPACE_ID, '2026-09-21T10:00:02.000Z'),
  row('aaaaaaaa-0000-4000-8000-000000000005', TEST_WORKSPACE_ID, '2026-09-21T10:00:03.000Z'),
];

function rawCursor(fields: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

let harness: RbacHarness | null = null;

afterEach(() => {
  harness?.teardown();
  harness = null;
  clearApplicationContext();
});

function install(
  role: 'owner' | 'admin' | 'builder' | 'viewer' | null,
  options: {
    readonly scopeKnowsCallerWorkspace?: boolean;
    readonly rows?: Readonly<Record<string, readonly AuditRow[]>>;
  } = {},
): {
  readonly limits: number[];
  readonly actions: (string | null)[];
  readonly repositoryCalls: string[];
  readonly call: (search?: string) => Promise<{ status: number; body: unknown }>;
} {
  const limits: number[] = [];
  const actions: (string | null)[] = [];
  const repositoryCalls: string[] = [];
  const knownWorkspaces = [
    ...(options.scopeKnowsCallerWorkspace === false
      ? []
      : [{ id: TEST_WORKSPACE_ID, slug: 'audit' }]),
    { id: OTHER_WORKSPACE_ID, slug: 'other-audit' },
  ];
  harness = installRbacHarness(
    role === null
      ? []
      : [{ email: CALLER.email, name: 'Caller', workspaceId: TEST_WORKSPACE_ID, role }],
  );
  const installed = harness;
  installTestDomains({
    audit: {
      scopes: createInMemoryWorkspaceScopeResolver(knownWorkspaces),
      repositories: {
        forScope: (scope) => {
          repositoryCalls.push(scope.workspaceId);
          return {
            write: () => Promise.resolve(),
            count: () => Promise.resolve(0),
            list: (input = {}) => {
              const limit = input.limit ?? 100;
              limits.push(limit);
              actions.push(input.action ?? null);
              const rows = ((options.rows ?? ROWS)[scope.workspaceId] ?? []).filter(
                (candidate) => input.action === undefined || candidate.action === input.action,
              );
              return Promise.resolve(keysetPageOf(rows, { limit, cursor: input.cursor ?? null }));
            },
          };
        },
      },
    },
  });
  return {
    limits,
    actions,
    repositoryCalls,
    call: async (search = '') => {
      const response = await installed.call(GET, {
        method: 'GET',
        path: `/api/audit-events${search}`,
        as: role === null ? null : CALLER,
      });
      return { status: response.status, body: response.body };
    },
  };
}

describe('GET /api/audit-events', () => {
  it('answers an Owner with the caller’s workspace rows and nobody else’s', async () => {
    const { call, limits } = install('owner');
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      events: [{ id: '11111111-1111-4111-8111-111111111111' }],
      nextCursor: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(OTHER_WORKSPACE_ID);
    expect(limits).toEqual([100]);
  });

  describe('builderRunId', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const builderRow: AuditRow = {
      ...row(id, TEST_WORKSPACE_ID),
      action: 'agent-created',
      details: {
        agentId: id,
        version: 1,
        via: 'builder',
        builderRunId: 'run-1',
        createdByAgentId: 'agent-x',
      },
    };

    it('names the Builder run on an agent-created row a Builder save wrote, and renders no details', async () => {
      const { call } = install('owner', { rows: { [TEST_WORKSPACE_ID]: [builderRow] } });
      const response = await call();
      const [event] = AuditEventListResponseSchema.parse(response.body).events;
      expect(event?.builderRunId).toBe('run-1');
      expect(event).not.toHaveProperty('createdByAgentId');
      expect(JSON.stringify(response.body)).not.toContain('details');
      expect(JSON.stringify(response.body)).not.toContain('createdByAgentId');
    });

    it('leaves it off an agent-created row with no run, and off every row of another action', async () => {
      const { call } = install('owner', {
        rows: {
          [TEST_WORKSPACE_ID]: [
            {
              ...builderRow,
              id: '44444444-4444-4444-8444-444444444444',
              details: { agentId: id, version: 1, via: 'api' },
            },
            { ...builderRow, id: '55555555-5555-4555-8555-555555555555', action: 'agent-changed' },
            row('66666666-6666-4666-8666-666666666666', TEST_WORKSPACE_ID),
            { ...builderRow, id: '77777777-7777-4777-8777-777777777777', details: null },
          ],
        },
      });
      const response = await call();
      expect(AuditEventListResponseSchema.parse(response.body).events).toHaveLength(4);
      expect(JSON.stringify(response.body)).not.toContain('builderRunId');
    });

    it('leaves it off an agent-created row whose stored details are not the strict shape', async () => {
      const { call } = install('owner', {
        rows: {
          [TEST_WORKSPACE_ID]: [
            {
              ...builderRow,
              details: {
                agentId: id,
                version: 1,
                via: 'builder',
                builderRunId: 'run-1',
                createdByAgentId: '',
              },
            },
          ],
        },
      });
      const response = await call();
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('builderRunId');
    });
  });

  it('returns builderRunId on an agent-created row written by a Builder save, and never on other rows', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const otherId = '44444444-4444-4444-8444-444444444444';
    const { call } = install('owner', {
      rows: {
        [TEST_WORKSPACE_ID]: [
          {
            ...row(id, TEST_WORKSPACE_ID),
            action: 'agent-created',
            details: { agentId: id, version: 1, via: 'builder', builderRunId: 'run-1' },
          },
          row(otherId, TEST_WORKSPACE_ID),
        ],
      },
    });
    const response = await call();
    const { events } = AuditEventListResponseSchema.parse(response.body);
    expect(events.find((event) => event.id === id)?.builderRunId).toBe('run-1');
    expect(events.find((event) => event.id === otherId)).not.toHaveProperty('builderRunId');
  });

  it.each(['admin', 'builder', 'viewer'] as const)(
    'refuses a %s with 403 forbidden in the standard envelope, before reading a row',
    async (role) => {
      const { call, limits } = install(role);
      const response = await call();
      expect(response.status).toBe(403);
      expect(ApiProblemSchema.parse(response.body).error.code).toBe('forbidden');
      expect(limits).toEqual([]);
    },
  );

  it('refuses an Owner with 403 forbidden in the standard envelope when the scope resolver does not know the workspace', async () => {
    const { call, limits, repositoryCalls } = install('owner', {
      scopeKnowsCallerWorkspace: false,
    });
    const response = await call();
    expect(response.status).toBe(403);
    expect(ApiProblemSchema.parse(response.body).error.code).toBe('forbidden');
    expect(repositoryCalls).toEqual([]);
    expect(limits).toEqual([]);
  });

  it('answers 401 unauthenticated in the standard envelope when no credential is presented', async () => {
    const { call } = install(null);
    const response = await call();
    expect(response.status).toBe(401);
    expect(ApiProblemSchema.parse(response.body).error.code).toBe('unauthenticated');
  });

  it('answers 503 rbac_runtime_not_configured in the standard envelope when no context is installed', async () => {
    // The audit domain and the RBAC gate live in one application context, so with none installed
    // the gate answers first.
    const { call } = install('owner');
    clearApplicationContext();
    const response = await call();
    expect(response.status).toBe(503);
    expect(ApiProblemSchema.parse(response.body).error.code).toBe('rbac_runtime_not_configured');
  });

  it.each(['0', '501', '1.5', 'ten', ''])(
    'answers 400 invalid_limit in the standard envelope for limit=%j',
    async (limit) => {
      const { call, limits } = install('owner');
      const response = await call(`?limit=${limit}`);
      expect(response.status).toBe(400);
      expect(ApiProblemSchema.parse(response.body).error.code).toBe('invalid_limit');
      expect(limits).toEqual([]);
    },
  );

  it('passes an explicit in-range limit to the repository, up to the ceiling', async () => {
    const { call, limits } = install('owner');
    expect((await call('?limit=1')).status).toBe(200);
    expect((await call('?limit=500')).status).toBe(200);
    expect(limits).toEqual([1, 500]);
  });

  it('walks limit=1 pages over every row exactly once, newest first, and terminates (S-5)', async () => {
    const { call } = install('owner', { rows: { [TEST_WORKSPACE_ID]: PAGED_ROWS } });
    const seen: string[] = [];
    let search = '?limit=1';
    for (let pages = 0; pages <= PAGED_ROWS.length; pages += 1) {
      const response = await call(search);
      expect(response.status).toBe(200);
      const page = AuditEventListResponseSchema.parse(response.body);
      expect(page.events.length).toBeLessThanOrEqual(1);
      seen.push(...page.events.map((event) => event.id));
      if (page.nextCursor === null) break;
      search = `?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    expect(seen).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000005',
      'aaaaaaaa-0000-4000-8000-000000000004',
      'aaaaaaaa-0000-4000-8000-000000000003',
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
  });

  describe('?action= filter', () => {
    const MIXED: readonly AuditRow[] = PAGED_ROWS.map((paged, index) => ({
      ...paged,
      action: index % 2 === 0 ? 'file-deleted' : 'agent-changed',
    }));

    it('lists only the rows of the named action, paged with the same cursor', async () => {
      const { call, actions } = install('owner', { rows: { [TEST_WORKSPACE_ID]: MIXED } });
      const seen: string[] = [];
      let search = '?action=file-deleted&limit=1';
      for (let pages = 0; pages <= MIXED.length; pages += 1) {
        const page = AuditEventListResponseSchema.parse((await call(search)).body);
        seen.push(...page.events.map((event) => event.id));
        if (page.nextCursor === null) break;
        search = `?action=file-deleted&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`;
      }
      expect(seen).toEqual([
        'aaaaaaaa-0000-4000-8000-000000000005',
        'aaaaaaaa-0000-4000-8000-000000000003',
        'aaaaaaaa-0000-4000-8000-000000000001',
      ]);
      expect(new Set(actions)).toEqual(new Set(['file-deleted']));
    });

    it.each(['no-such-action', '', 'File-Deleted'])(
      'answers 400 invalid_action in the standard envelope for action=%j',
      async (action) => {
        const { call, limits } = install('owner');
        const response = await call(`?action=${action}`);
        expect(response.status).toBe(400);
        expect(ApiProblemSchema.parse(response.body).error.code).toBe('invalid_action');
        expect(limits).toEqual([]);
      },
    );
  });

  it('answers nextCursor null when one page holds every row', async () => {
    const { call } = install('owner', { rows: { [TEST_WORKSPACE_ID]: PAGED_ROWS } });
    const page = AuditEventListResponseSchema.parse((await call('?limit=5')).body);
    expect(page.events).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  const position = {
    createdAt: '2026-09-21T10:00:02.000Z',
    id: 'aaaaaaaa-0000-4000-8000-000000000004',
  };
  const minted = encodeListCursor('audit-events', TEST_WORKSPACE_ID, position);
  const fields = { v: 1, k: 'audit-events', w: TEST_WORKSPACE_ID, t: position.createdAt };
  it.each([
    ['another workspace', encodeListCursor('audit-events', OTHER_WORKSPACE_ID, position)],
    ['the sessions list', encodeListCursor('sessions', TEST_WORKSPACE_ID, position)],
    [
      'a flipped byte',
      `${minted.slice(0, 10)}${minted[10] === 'A' ? 'B' : 'A'}${minted.slice(11)}`,
    ],
    ['a truncated value', minted.slice(0, -3)],
    ['padding', `${minted}=`],
    ['not base64url', 'not a cursor!'],
    ['an empty object', rawCursor({})],
    ['an unknown key', rawCursor({ ...fields, i: position.id, x: 1 })],
    [
      'an impossible timestamp',
      rawCursor({ ...fields, t: '2026-02-30T00:00:00.000Z', i: position.id }),
    ],
    ['a non-UUID id', rawCursor({ ...fields, i: '1' })],
    ['a later version', rawCursor({ ...fields, v: 2, i: position.id })],
  ])('answers 400 invalid_cursor in the standard envelope for %s', async (_, cursor) => {
    const { call, limits } = install('owner', { rows: { [TEST_WORKSPACE_ID]: PAGED_ROWS } });
    const response = await call(`?cursor=${encodeURIComponent(cursor)}`);
    expect(response.status).toBe(400);
    expect(ApiProblemSchema.parse(response.body).error.code).toBe('invalid_cursor');
    expect(limits).toEqual([]);
  });

  it('refuses a Builder with 403 before it reads a cursor, however well-formed', async () => {
    const { call, limits } = install('builder');
    const response = await call(`?limit=1&cursor=${encodeURIComponent(minted)}`);
    expect(response.status).toBe(403);
    expect(ApiProblemSchema.parse(response.body).error.code).toBe('forbidden');
    expect(limits).toEqual([]);
  });
});
