import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { SessionListResponseSchema } from '@indx-workspace/contracts/sessions';
import { describe, expect, it } from 'vitest';
import { installTestDomains } from '../application-context-fixtures';
import { encodeListCursor } from '../pagination/list-cursor';
import { sessionPageOf } from '../pagination/testing';
import { listSessions } from './api';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { errorCode, get, OTHER_WORKSPACE, WORKSPACE } from './session-api.test-support';
import { createRepositorySessionsStoreProvider } from './store';

export function registerPaginationTests() {
  describe('GET /api/sessions cursor pages (S-5)', () => {
    it(
      'walks limit=1 pages over every row exactly once, newest created first, and terminates',
      walksLimit1PagesOverEveryRowExactly,
    );

    it(
      'pages only the rows a Builder may see, with every page full',
      pagesOnlyRowsBuilderMaySeeEveryPage,
    );

    it(
      'answers every row and nextCursor null when no limit is given',
      answersEveryRowNextCursorNullWhenNoLimit,
    );

    const position = {
      createdAt: '2026-09-01T00:00:01.000Z',
      id: '00000000-0000-4000-8000-000000000004',
    };
    it.each([
      ['another workspace', encodeListCursor('sessions', OTHER_WORKSPACE, position)],
      ['the audit list', encodeListCursor('audit-events', WORKSPACE, position)],
      ['a truncated value', encodeListCursor('sessions', WORKSPACE, position).slice(0, -2)],
      ['not base64url', '%%%'],
    ])(
      'refuses a cursor from %s with 400 invalid_cursor before reading a row',
      async (_, cursor) => {
        const listed = installRows(caller('owner'));
        const response = await listSessions(
          get(`/api/sessions?limit=1&cursor=${encodeURIComponent(cursor)}`),
        );
        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe('invalid_cursor');
        expect(listed).toEqual([]);
      },
    );

    it.each(['0', '201', '1.5', 'ten', ''])(
      'refuses limit=%j with 400 invalid_limit',
      async (limit) => {
        installRows(caller('owner'));
        const response = await listSessions(get(`/api/sessions?limit=${limit}`));
        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe('invalid_limit');
      },
    );

    it(
      'ignores a projectKey the caller puts in the query string',
      ignoresProjectKeyCallerPutsQueryString,
    );
  });
}

const OWNER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const OWNER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const rowAt = (id: string, owner: string, createdAt: string): SessionRecord => ({
  engine: null,
  agentVersionId: null,
  id,
  workspaceId: WORKSPACE,
  ownerPrincipalId: owner,
  userId: null,
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: null,
  engineSessionId: null,
  title: null,
  status: 'active',
  createdAt: new Date(createdAt),
  // `updated_at` runs the other way on purpose: the page order must not follow it.
  updatedAt: new Date(Date.parse('2027-01-01T00:00:00Z') - Date.parse(createdAt)),
});

const ROWS = [
  rowAt('00000000-0000-4000-8000-000000000001', OWNER_A, '2026-09-01T00:00:00.000Z'),
  rowAt('00000000-0000-4000-8000-000000000002', OWNER_B, '2026-09-01T00:00:01.000Z'),
  rowAt('00000000-0000-4000-8000-000000000003', OWNER_A, '2026-09-01T00:00:01.000Z'),
  rowAt('00000000-0000-4000-8000-000000000004', OWNER_A, '2026-09-01T00:00:01.000Z'),
  rowAt('00000000-0000-4000-8000-000000000005', OWNER_B, '2026-09-01T00:00:02.000Z'),
];

const caller = (role: 'owner' | 'builder', principalId = OWNER_A): SessionApiPrincipal => ({
  kind: 'user',
  principalId,
  ownerPrincipalId: principalId,
  userId: null,
  workspaceId: WORKSPACE,
  role,
});

function installRows(principal: SessionApiPrincipal): string[] {
  const listed: string[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error('not used by session listing'));
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(principal),
      canAccessSession: () => Promise.resolve(true),
      store: new InMemoryTranscriptStore(),
      sessions: createRepositorySessionsStoreProvider({
        repositories: {
          forScope: (scope) => ({
            ensure: unused,
            get: unused,
            getByEngineSessionId: unused,
            list: (input) => {
              listed.push(scope.workspaceId);
              return Promise.resolve(sessionPageOf(ROWS, input));
            },
            update: unused,
            archive: unused,
            restore: unused,
            discardIfUnused: () => Promise.resolve(false),
          }),
        } satisfies SessionRepositoryProvider,
        scopes: createInMemoryWorkspaceScopeResolver([
          { id: WORKSPACE, slug: 'workspace' },
          { id: OTHER_WORKSPACE, slug: 'other' },
        ]),
      }),
    },
  });
  return listed;
}

async function walk(search: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await listSessions(get(`/api/sessions?${search}${suffix}`));
    expect(response.status).toBe(200);
    // Every page is pinned to the published contract, not just to the fields read here.
    const body = SessionListResponseSchema.parse(await response.json());
    expect(body.sessions.length).toBeLessThanOrEqual(1);
    ids.push(...body.sessions.map(({ id }) => id));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor !== null && pages <= ROWS.length);
  return { ids, pages };
}

async function walksLimit1PagesOverEveryRowExactly() {
  installRows(caller('owner'));
  const { ids, pages } = await walk('limit=1');
  expect(ids).toEqual([
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ]);
  expect(pages).toBe(5);
}

async function pagesOnlyRowsBuilderMaySeeEveryPage() {
  installRows(caller('builder', OWNER_B));
  expect((await walk('limit=1')).ids).toEqual([
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000002',
  ]);
}

async function answersEveryRowNextCursorNullWhenNoLimit() {
  installRows(caller('owner'));
  const body = (await (await listSessions(get('/api/sessions'))).json()) as {
    sessions: unknown[];
    nextCursor: unknown;
  };
  expect(body.sessions).toHaveLength(5);
  expect(body.nextCursor).toBeNull();
}

async function ignoresProjectKeyCallerPutsQueryString() {
  const listed = installRows(caller('owner'));
  // The tenant comes from the principal. A query parameter naming another tenant changes
  // nothing, which is why the listing route reads none.
  const response = await listSessions(get(`/api/sessions?projectKey=${OTHER_WORKSPACE}`));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { projectKey: string }).projectKey).toBe(WORKSPACE);
  expect(listed).toEqual([WORKSPACE]);
}
