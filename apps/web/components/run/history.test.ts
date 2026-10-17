/**
 * The pure half of the Runs history screen (issue #136) — everything `history.ts` exports, driven
 * without a browser or a network. `history-screen.test.tsx` and `run-detail-panel.test.tsx` cover
 * the two components this module feeds.
 */
import { RunCostSchema, RunResourceSchema, RunUsageSchema } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { renderRun } from '../../server/runs/api';
import type { RunRecord } from '../../server/runs/store';
import { accountingStates } from '../../server/runs/store';
import { runStatuses } from '../../server/runs/store';
import {
  ACCOUNTING_STATE_NAMES,
  COST_KEYS,
  MalformedRunError,
  PROJECT_CATALOG_URL,
  RUN_KEYS,
  USAGE_KEYS,
  USER_FILTER_PROBE_ID,
  classifyUserFilterProbe,
  cursorFromSearchParams,
  describeCost,
  filtersFromSearchParams,
  formatDuration,
  formatCostDisplay,
  formatProviderModel,
  formatSettledAmount,
  formatTimestamp,
  formatTokenCount,
  parseCatalog,
  parseRunDetailResponse,
  parseRunListPage,
  parseRunResource,
  reconcileDurableRun,
  resolveResourceReference,
  runMatchesSearch,
  runDetailPath,
  runIdFromSearchParams,
  runsListQuery,
  shouldPollDurableRun,
  timestampAccessibilityLabel,
  withScreenState,
  type CatalogState,
  type RunListItem,
} from './history';

// ── A run, as `renderRun` would answer it ───────────────────────────────────────────────────────

function run(patch: Partial<RunListItem> = {}): unknown {
  const accountingState = patch.accountingState ?? 'complete';
  const cost =
    patch.cost ??
    (accountingState === 'complete' || accountingState === 'partial'
      ? { amount: '0.080000', currency: 'USD', priceTableVersion: '2026-09-01' }
      : { amount: '0.000000', currency: 'USD', priceTableVersion: null });
  const accountingError =
    'accountingError' in patch
      ? patch.accountingError
      : accountingState === 'failed'
        ? 'settlement failed'
        : null;
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    workspaceId: 'b1111111-1111-4111-8111-111111111111',
    agentId: 'c1111111-1111-4111-8111-111111111111',
    projectId: null,
    initiatingUserId: null,
    sessionId: 'd1111111-1111-4111-8111-111111111111',
    status: 'completed',
    createdAt: '2026-09-12T10:00:00.000Z',
    startedAt: '2026-09-12T10:00:01.000Z',
    endedAt: '2026-09-12T10:00:24.000Z',
    durationMs: 23000,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    modelConnectionId: 'e1111111-1111-4111-8111-111111111111',
    engine: 'claude-agent-sdk',
    engineVersion: null,
    usage: {
      inputTokens: 11940,
      outputTokens: 2264,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 14204,
      toolCalls: 5,
    },
    cost,
    error: null,
    accountingState,
    accountingError,
    ...patch,
  };
}

describe('ACCOUNTING_STATE_NAMES', () => {
  it('agrees with the server schema this screen cannot import', () => {
    expect([...ACCOUNTING_STATE_NAMES].sort()).toEqual([...accountingStates].sort());
  });
});

describe('RUN_KEYS / USAGE_KEYS / COST_KEYS', () => {
  // Issue #1130: a field added to the contract must fail here, not in every row in the browser.
  it.each([
    ['RUN_KEYS', RUN_KEYS, RunResourceSchema],
    ['USAGE_KEYS', USAGE_KEYS, RunUsageSchema],
    ['COST_KEYS', COST_KEYS, RunCostSchema],
  ] as const)('%s equals the contract schema key set', (_name, keys, schema) => {
    expect([...keys].sort()).toEqual(Object.keys(schema.unwrap().shape).sort());
  });
});

describe('a run rendered by the server', () => {
  const record: RunRecord = {
    id: 'a1111111-1111-4111-8111-111111111111',
    workspaceId: 'b1111111-1111-4111-8111-111111111111',
    agentId: 'c1111111-1111-4111-8111-111111111111',
    sessionId: 'd1111111-1111-4111-8111-111111111111',
    status: 'completed',
    createdAt: new Date('2026-09-12T10:00:00.000Z'),
    startedAt: new Date('2026-09-12T10:00:01.000Z'),
    endedAt: new Date('2026-09-12T10:00:24.000Z'),
    costUsd: '0.080000',
    priceTableVersion: '2026-09-01',
    accountingState: 'complete',
    error: null,
  };

  it.each([
    [
      'a current run',
      { engine: 'claude-agent-sdk', engineVersion: '1.2.3' },
      { engine: 'claude-agent-sdk', engineVersion: '1.2.3' },
    ],
    [
      'a run with null engine fields',
      { engine: null, engineVersion: null },
      { engine: null, engineVersion: null },
    ],
    ['a historic run without engine fields', {}, { engine: null, engineVersion: null }],
  ] as const)('parses %s from list and detail', (_name, engineFields, expected) => {
    const row = renderRun({ ...record, ...engineFields });
    const [listed] = parseRunListPage({ runs: [row], nextCursor: null }).runs;
    expect(listed).toMatchObject(expected);
    expect(parseRunDetailResponse({ run: row })).toMatchObject(expected);
  });
});

describe('parseRunResource', () => {
  it('parses a well-formed run', () => {
    const parsed = parseRunResource(run());
    expect(parsed.id).toBe('a1111111-1111-4111-8111-111111111111');
    expect(parsed.usage.totalTokens).toBe(14204);
    expect(parsed.cost.amount).toBe('0.080000');
  });

  it('carries every recognised run status without rejecting it', () => {
    for (const status of runStatuses) {
      expect(parseRunResource(run({ status })).status).toBe(status);
    }
  });

  it.each([
    ['run', () => ({ ...(run() as object), extra: true })],
    [
      'usage',
      () =>
        run({
          usage: {
            inputTokens: 11940,
            outputTokens: 2264,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 14204,
            toolCalls: 5,
            extra: true,
          } as never,
        }),
    ],
    [
      'cost',
      () =>
        run({
          cost: {
            amount: '0.080000',
            currency: 'USD',
            priceTableVersion: '2026-09-01',
            extra: true,
          } as never,
        }),
    ],
  ] as const)('rejects an unknown key on the %s object', (_where, value) => {
    expect(() => parseRunResource(value())).toThrow(MalformedRunError);
  });

  it.each([
    ['a bare string', 'not an object'],
    ['an array', []],
    ['null', null],
  ])('refuses %s as a run', (_name, value) => {
    expect(() => parseRunResource(value)).toThrow(MalformedRunError);
  });

  it.each(['id', 'workspaceId', 'agentId', 'sessionId', 'status', 'createdAt'] as const)(
    'refuses a run missing "%s"',
    (key) => {
      const value = run() as Record<string, unknown>;
      delete value[key];
      expect(() => parseRunResource(value)).toThrow(MalformedRunError);
    },
  );

  it.each(['id', 'workspaceId', 'agentId', 'sessionId'] as const)(
    'refuses a non-UUID "%s" returned by the run API',
    (key) => {
      expect(() => parseRunResource(run({ [key]: '../other' }))).toThrow(MalformedRunError);
    },
  );

  it.each(['projectId', 'initiatingUserId'] as const)(
    'refuses a non-UUID nullable "%s" returned by the run API',
    (key) => {
      expect(() => parseRunResource(run({ [key]: '../other' }))).toThrow(MalformedRunError);
    },
  );

  it('refuses a non-UUID nullable model connection id returned by the run API', () => {
    expect(() => parseRunResource(run({ modelConnectionId: '../other' }))).toThrow(
      MalformedRunError,
    );
  });

  it('refuses a run whose "usage" is not an object', () => {
    expect(() => parseRunResource(run({ usage: 'nope' as never }))).toThrow(MalformedRunError);
  });

  it('refuses a run whose "cost" is not an object', () => {
    expect(() => parseRunResource(run({ cost: null as never }))).toThrow(MalformedRunError);
  });

  it('refuses a run whose "durationMs" is neither a number nor null', () => {
    expect(() => parseRunResource(run({ durationMs: '23000' as never }))).toThrow(
      MalformedRunError,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses an unsafe duration number: %s',
    (value) => {
      expect(() => parseRunResource(run({ durationMs: value }))).toThrow(MalformedRunError);
    },
  );

  it('refuses a totalTokens value that contradicts the persisted counters', () => {
    expect(() =>
      parseRunResource(
        run({
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            totalTokens: 11,
            toolCalls: 0,
          },
        }),
      ),
    ).toThrow(MalformedRunError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses an unsafe token count: %s',
    (value) => {
      expect(() =>
        parseRunResource(
          run({
            usage: {
              inputTokens: value,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: 0,
              toolCalls: 0,
            },
          }),
        ),
      ).toThrow(MalformedRunError);
    },
  );

  it.each(['yesterday', '2026-09-12T10:00:00Z', '2026-02-31T10:00:00.000Z'])(
    'refuses a timestamp that renderRun could not have produced: %s',
    (createdAt) => {
      expect(() => parseRunResource(run({ createdAt }))).toThrow(MalformedRunError);
    },
  );

  it('requires exact Date.toISOString grammar, not merely a parseable instant', () => {
    expect(() => parseRunResource(run({ createdAt: '2026-09-12T10:00:00+00:00' }))).toThrow(
      MalformedRunError,
    );
  });

  it.each([
    ['startedAt', '2026-09-12T10:00:00Z'],
    ['startedAt', '2026-02-31T10:00:00.000Z'],
    ['startedAt', '2026-09-12T10:00:00+00:00'],
    ['endedAt', '2026-09-12T10:00:00Z'],
    ['endedAt', '2026-02-31T10:00:00.000Z'],
    ['endedAt', '2026-09-12T10:00:00+00:00'],
  ] as const)(
    'refuses a nullable %s timestamp that renderRun could not have produced: %s',
    (field, value) => {
      expect(() => parseRunResource(run({ [field]: value }))).toThrow(MalformedRunError);
    },
  );

  it.each(['', 'not-a-number', 'Infinity', '-1.000000', '1e3', '100000000.000000', '0.0000000'])(
    'refuses a cost amount outside the durable USD decimal contract: %s',
    (amount) => {
      expect(() =>
        parseRunResource(
          run({ cost: { amount, currency: 'USD', priceTableVersion: '2026-09-01' } }),
        ),
      ).toThrow(MalformedRunError);
    },
  );

  it("refuses a cost currency other than the durable API's USD", () => {
    expect(() =>
      parseRunResource(
        run({
          cost: { amount: '0.080000', currency: 'EUR', priceTableVersion: '2026-09-01' },
        }),
      ),
    ).toThrow(MalformedRunError);
  });

  it.each([
    [
      'complete without a price version',
      {
        accountingState: 'complete',
        cost: { amount: '0.080000', currency: 'USD', priceTableVersion: null },
      },
    ],
    [
      'partial without a price version',
      {
        accountingState: 'partial',
        cost: { amount: '0.080000', currency: 'USD', priceTableVersion: null },
      },
    ],
    [
      'pending with a price version',
      {
        accountingState: 'pending',
        cost: { amount: '0.000000', currency: 'USD', priceTableVersion: '2026-09-01' },
      },
    ],
    [
      'unavailable with a nonzero amount',
      {
        accountingState: 'unavailable',
        cost: { amount: '0.010000', currency: 'USD', priceTableVersion: null },
      },
    ],
    ['failed without an error', { accountingState: 'failed', accountingError: null }],
    [
      'complete with an accounting error',
      { accountingState: 'complete', accountingError: 'wrong' },
    ],
    ['an unknown accounting state', { accountingState: 'from-the-future' }],
  ] as const)('refuses inconsistent accounting: %s', (_name, patch) => {
    expect(() => parseRunResource(run(patch))).toThrow(MalformedRunError);
  });

  it('accepts a null "durationMs", "projectId", "initiatingUserId", "model", "provider"', () => {
    const parsed = parseRunResource(
      run({
        durationMs: null,
        projectId: null,
        initiatingUserId: null,
        model: null,
        provider: null,
      }),
    );
    expect(parsed.durationMs).toBeNull();
    expect(parsed.model).toBeNull();
  });
});

describe('parseRunListPage', () => {
  it('parses the run list envelope', () => {
    const page = parseRunListPage({ runs: [run(), run()], nextCursor: 'abc' });
    expect(page.runs).toHaveLength(2);
    expect(page.nextCursor).toBe('abc');
  });

  it('accepts a null nextCursor', () => {
    expect(parseRunListPage({ runs: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it('refuses an unknown key on the list envelope', () => {
    expect(() => parseRunListPage({ runs: [], nextCursor: null, extra: true })).toThrow(
      MalformedRunError,
    );
  });

  it('refuses a response with no "runs" array', () => {
    expect(() => parseRunListPage({ nextCursor: null })).toThrow(MalformedRunError);
  });

  it('refuses one malformed run inside an otherwise well-formed page', () => {
    expect(() => parseRunListPage({ runs: [run(), { not: 'a run' }], nextCursor: null })).toThrow(
      MalformedRunError,
    );
  });
});

describe('parseRunDetailResponse', () => {
  it('parses the { run } envelope', () => {
    expect(parseRunDetailResponse({ run: run() }).id).toBe('a1111111-1111-4111-8111-111111111111');
  });

  it('refuses a response with no "run"', () => {
    expect(() => parseRunDetailResponse({})).toThrow(MalformedRunError);
  });

  it('refuses an unknown key on the detail envelope', () => {
    expect(() => parseRunDetailResponse({ run: run(), extra: true })).toThrow(MalformedRunError);
  });
});

// ── Filters and pagination in the URL ───────────────────────────────────────────────────────────

describe('filtersFromSearchParams / runsListQuery round-trip', () => {
  it('reads back exactly the filters a URL carries', () => {
    const params = new URLSearchParams(
      'q=sonnet&status=running&agent=ag1&project=pr1&user=us1&cursor=cur1&run=rn1',
    );
    expect(filtersFromSearchParams(params)).toEqual({
      query: 'sonnet',
      status: 'running',
      agentId: 'ag1',
      projectId: 'pr1',
      userId: 'us1',
    });
    expect(cursorFromSearchParams(params)).toBe('cur1');
    expect(runIdFromSearchParams(params)).toBeNull();
  });

  it('omits a filter the URL does not carry, rather than an empty string', () => {
    expect(filtersFromSearchParams(new URLSearchParams(''))).toEqual({});
    expect(cursorFromSearchParams(new URLSearchParams(''))).toBeNull();
    expect(runIdFromSearchParams(new URLSearchParams(''))).toBeNull();
  });

  it('treats an explicitly empty value the same as an absent one', () => {
    expect(filtersFromSearchParams(new URLSearchParams('status=&agent='))).toEqual({});
  });

  it('builds only the query parameters GET /api/runs recognises for a given filter set', () => {
    const query = runsListQuery({ query: 'sonnet', status: 'running', agentId: 'ag1' }, 'cur1');
    const params = new URLSearchParams(query);
    expect([...params.keys()].sort()).toEqual(['agent', 'cursor', 'status']);
    expect(params.get('status')).toBe('running');
    expect(params.get('agent')).toBe('ag1');
    expect(params.get('cursor')).toBe('cur1');
  });

  it('sends no cursor when none is held', () => {
    expect(new URLSearchParams(runsListQuery({}, null)).has('cursor')).toBe(false);
  });

  it.each(['../users', '../../api/workspaces', '%2e%2e/users'])(
    'refuses a selected run that could retarget a path: %s',
    (runId) => {
      const parsed = runIdFromSearchParams(new URLSearchParams(`run=${runId}`));
      expect(parsed).toBeNull();
      expect(runDetailPath(runId)).toBeNull();
    },
  );

  it('constructs a detail path only for a canonical UUID', () => {
    const id = 'a1111111-1111-4111-8111-111111111111';
    expect(runIdFromSearchParams(new URLSearchParams(`run=${id}`))).toBe(id);
    expect(runDetailPath(id)).toBe(`/api/runs/${id}`);
  });
});

describe('withScreenState', () => {
  it('adds a field to an empty set of params', () => {
    const next = withScreenState(new URLSearchParams(''), { run: 'rn1' });
    expect(next.toString()).toBe('run=rn1');
  });

  it('preserves every other field already in the URL', () => {
    const current = new URLSearchParams('q=sonnet&status=running&agent=ag1');
    const next = withScreenState(current, { run: 'rn1' });
    expect(next.get('status')).toBe('running');
    expect(next.get('agent')).toBe('ag1');
    expect(next.get('q')).toBe('sonnet');
    expect(next.get('run')).toBe('rn1');
  });

  it('removes a field set to null, e.g. clearing the selected run', () => {
    const current = new URLSearchParams('status=running&run=rn1');
    const next = withScreenState(current, { run: null });
    expect(next.has('run')).toBe(false);
    expect(next.get('status')).toBe('running');
  });

  it('does not touch a field the patch never names', () => {
    const current = new URLSearchParams('status=running&cursor=cur1');
    const next = withScreenState(current, { status: 'failed' });
    expect(next.get('cursor')).toBe('cur1');
  });
});

// ── The user filter's availability — never a client-side role table ────────────────────────────

describe('classifyUserFilterProbe', () => {
  it('is available when the probe answers 200', () => {
    expect(classifyUserFilterProbe(200, { runs: [], nextCursor: null })).toBe('available');
  });

  it('fails closed when a 200 probe body is not a run-list response', () => {
    expect(classifyUserFilterProbe(200, { accepted: true })).toBe('unavailable');
  });

  it('keeps a 200 probe with an unknown envelope key unavailable', () => {
    expect(classifyUserFilterProbe(200, { runs: [], nextCursor: null, extra: true })).toBe(
      'unavailable',
    );
  });

  it('keeps a 200 probe with an unknown run key unavailable', () => {
    expect(
      classifyUserFilterProbe(200, {
        runs: [{ ...(run() as object), extra: true }],
        nextCursor: null,
      }),
    ).toBe('unavailable');
  });

  it('is unavailable when the probe is refused by name', () => {
    expect(
      classifyUserFilterProbe(403, { error: { code: 'user_filter_forbidden', message: 'no' } }),
    ).toBe('unavailable');
  });

  it(
    'is unavailable — fail-closed — for a 403 whose body does not name user_filter_forbidden, ' +
      'proving this function reads the code, not just the status',
    () => {
      expect(classifyUserFilterProbe(403, { error: { code: 'forbidden', message: 'no' } })).toBe(
        'unavailable',
      );
    },
  );

  it('is unavailable for any other status, including a transient 500', () => {
    expect(classifyUserFilterProbe(500, { error: { code: 'oops', message: 'x' } })).toBe(
      'unavailable',
    );
  });

  it('the probe id is a syntactically valid UUID that names nobody real', () => {
    expect(USER_FILTER_PROBE_ID).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── Rendering fields as words, never as an invented number ──────────────────────────────────────

describe('formatTokenCount', () => {
  it('thousands-separates', () => {
    expect(formatTokenCount(14204)).toBe('14,204');
  });

  it('renders a real zero as "0", not as an absence', () => {
    expect(formatTokenCount(0)).toBe('0');
  });
});

describe('describeCost', () => {
  it.each(['complete', 'partial'] as const)(
    'renders %s as a settled amount, never a bare word',
    (accountingState) => {
      const display = describeCost(parseRunResource(run({ accountingState })));
      expect(display.kind).toBe('settled');
      if (display.kind === 'settled') {
        expect(display.partial).toBe(accountingState === 'partial');
        expect(display.amount).toBe('0.080000');
      }
    },
  );

  it('renders pending as a word, never as $0.00', () => {
    expect(describeCost(parseRunResource(run({ accountingState: 'pending' })))).toEqual({
      kind: 'pending',
    });
  });

  it('renders unavailable as a word, never as $0.00', () => {
    expect(describeCost(parseRunResource(run({ accountingState: 'unavailable' })))).toEqual({
      kind: 'unavailable',
    });
  });

  it('renders failed with its redacted reason', () => {
    expect(
      describeCost(
        parseRunResource(run({ accountingState: 'failed', accountingError: 'no usable usage' })),
      ),
    ).toEqual({ kind: 'failed', reason: 'no usable usage' });
  });
});

describe('formatSettledAmount', () => {
  it('formats a USD amount as currency', () => {
    expect(formatSettledAmount('0.080000', 'USD')).toBe('$0.08');
  });

  it('refuses an invalid amount or non-USD currency even when called outside the parser', () => {
    expect(() => formatSettledAmount('Infinity', 'USD')).toThrow(MalformedRunError);
    expect(() => formatSettledAmount('4.000000', 'EUR')).toThrow(MalformedRunError);
  });
});

describe('formatCostDisplay', () => {
  it('labels a fully settled durable cost as actual, never estimated', () => {
    const label = formatCostDisplay(parseRunResource(run()));
    expect(label).toBe('$0.08 · Actual');
    expect(label).not.toContain('Estimated');
  });

  it('labels the priced part of partial accounting as actual and partial', () => {
    expect(formatCostDisplay(parseRunResource(run({ accountingState: 'partial' })))).toBe(
      '$0.08 · Actual · Partial',
    );
  });
});

describe('formatDuration', () => {
  it('names an absent duration by the run\'s own status, never as "0 s"', () => {
    expect(formatDuration(null, 'queued')).toBe('Not started');
    expect(formatDuration(null, 'running')).toBe('In progress');
  });

  it('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(400, 'completed')).toBe('400 ms');
  });

  it('renders whole seconds', () => {
    expect(formatDuration(23000, 'completed')).toBe('23 s');
  });

  it('renders minutes and seconds, matching the mockup\'s "1 m 04 s"', () => {
    expect(formatDuration(64000, 'completed')).toBe('1 m 04 s');
  });

  it('renders hours, minutes and seconds', () => {
    expect(formatDuration(3661000, 'completed')).toBe('1 h 01 m 01 s');
  });
});

describe('formatTimestamp', () => {
  it('names a null timestamp rather than rendering a blank cell', () => {
    expect(formatTimestamp(null)).toBe('—');
  });

  it('renders a real timestamp', () => {
    expect(formatTimestamp('2026-09-12T10:00:00.000Z')).toContain('2026');
  });

  it('keeps the exact UTC value in the accessible label', () => {
    const iso = '2026-09-12T10:00:00.000Z';
    expect(timestampAccessibilityLabel(iso)).toContain(iso);
  });
});

describe('formatProviderModel', () => {
  it('joins provider and model', () => {
    expect(formatProviderModel('anthropic', 'claude-sonnet-5')).toBe('anthropic · claude-sonnet-5');
  });

  it('names an unresolved provider/model, never a blank cell', () => {
    expect(formatProviderModel(null, null)).toBe('Not yet resolved');
  });
});

// ── Resolving an id against a catalogue: resolved / deleted / unknown ───────────────────────────

describe('PROJECT_CATALOG_URL', () => {
  it('asks for archived projects too, so an archived project keeps its name in run history', () => {
    // Regression for issue #184: `GET /api/projects` answers only active projects without this
    // filter, so reverting it to the bare path makes every run of an archived project render its
    // project as "deleted" — the acceptance criterion "completed run/session history remains
    // navigable with project attribution", broken silently.
    const url = new URL(PROJECT_CATALOG_URL, 'https://example.invalid');
    expect(url.pathname).toBe('/api/projects');
    expect(url.searchParams.get('archived')).toBe('all');
  });
});

describe('parseCatalog', () => {
  const id = 'c1111111-1111-4111-8111-111111111111';
  const workspaceId = 'b1111111-1111-4111-8111-111111111111';
  const createdBy = 'f1111111-1111-4111-8111-111111111111';
  const ownerPrincipalId = '91111111-1111-4111-8111-111111111111';
  const createdAt = '2026-09-12T10:00:00.000Z';
  const rows = {
    agents: {
      id,
      workspaceId,
      name: 'Customer Support Agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      createdBy,
      ownerPrincipalId,
      createdAt,
      updatedAt: createdAt,
    },
    projects: {
      id,
      workspaceId,
      name: 'Customer Support Project',
      instructions: null,
      defaultAgentId: null,
      defaultModelConnectionId: null,
      defaultModel: null,
      visibility: 'workspace',
      createdBy,
      ownerPrincipalId,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
      fileIds: [],
      mcpServerIds: [],
    },
    users: { id, email: 'owner@example.test', name: 'Owner', createdAt },
    workspaces: {
      id,
      slug: 'example',
      name: 'Example Workspace',
      archivedAt: null,
      publicSharingEnabled: false,
      createdAt,
      updatedAt: createdAt,
      role: 'owner',
    },
  } as const;

  it('reads an id→label map out of a list response', () => {
    const catalog = parseCatalog({ agents: [rows.agents] }, 'agents');
    expect(catalog.byId.get(id)).toBe('Customer Support Agent');
  });

  it('refuses a response with no list', () => {
    expect(() => parseCatalog({}, 'agents')).toThrow(MalformedRunError);
  });

  it('refuses a non-UUID catalogue id at the sibling identifier boundary', () => {
    expect(() => parseCatalog({ agents: [{ ...rows.agents, id: '../other' }] }, 'agents')).toThrow(
      MalformedRunError,
    );
  });

  it.each(['agents', 'projects', 'users', 'workspaces'] as const)(
    'refuses an unknown key on the %s catalogue envelope',
    (kind) => {
      expect(() => parseCatalog({ [kind]: [rows[kind]], extra: true }, kind)).toThrow(
        MalformedRunError,
      );
    },
  );

  it.each(['agents', 'projects', 'users', 'workspaces'] as const)(
    'refuses an unknown key on the %s catalogue row',
    (kind) => {
      expect(() => parseCatalog({ [kind]: [{ ...rows[kind], extra: true }] }, kind)).toThrow(
        MalformedRunError,
      );
    },
  );

  it.each(['agents', 'projects', 'users', 'workspaces'] as const)(
    'parses the exact %s catalogue contract',
    (kind) => {
      expect(parseCatalog({ [kind]: [rows[kind]] }, kind).byId.get(id)).toBe(rows[kind].name);
    },
  );
});

describe('resolveResourceReference', () => {
  const ready: CatalogState = {
    kind: 'ready',
    catalog: { byId: new Map([['ag1', 'Customer Support Agent']]) },
  };

  it('is absent when the run carries no id for this reference', () => {
    expect(resolveResourceReference(null, ready)).toEqual({ kind: 'absent' });
  });

  it('is resolved when the catalogue holds the id', () => {
    expect(resolveResourceReference('ag1', ready)).toEqual({
      kind: 'resolved',
      id: 'ag1',
      label: 'Customer Support Agent',
    });
  });

  it('is deleted when the catalogue was read and does not hold the id — never silently blank', () => {
    expect(resolveResourceReference('gone', ready)).toEqual({ kind: 'deleted', id: 'gone' });
  });

  it('is unknown, not deleted, when the catalogue itself could not be read', () => {
    expect(resolveResourceReference('ag1', { kind: 'unavailable' })).toEqual({
      kind: 'unknown',
      id: 'ag1',
    });
    expect(resolveResourceReference('ag1', { kind: 'loading' })).toEqual({
      kind: 'unknown',
      id: 'ag1',
    });
  });
});

describe('runMatchesSearch', () => {
  const parsed = parseRunResource(run());

  it('matches ids, status, provider/model and resolved names case-insensitively', () => {
    expect(runMatchesSearch(parsed, 'SONNET', [])).toBe(true);
    expect(runMatchesSearch(parsed, 'completed', [])).toBe(true);
    expect(runMatchesSearch(parsed, 'support agent', ['Customer Support Agent'])).toBe(true);
  });

  it('does not invent a match outside the current page', () => {
    expect(runMatchesSearch(parsed, 'a different run', ['Customer Support Agent'])).toBe(false);
  });
});

describe('reconcileDurableRun', () => {
  it('replaces the previous snapshot instead of adding live and ledger totals', () => {
    const previous = parseRunResource(
      run({
        status: 'running',
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          totalTokens: 10,
          toolCalls: 1,
        },
        cost: { amount: '0.030000', currency: 'USD', priceTableVersion: '2026-09-01' },
      }),
    );
    const next = parseRunResource(
      run({
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 3,
          totalTokens: 24,
          toolCalls: 2,
        },
        cost: { amount: '0.080000', currency: 'USD', priceTableVersion: '2026-09-01' },
      }),
    );

    const reconciled = reconcileDurableRun(previous, next);
    expect(reconciled.usage.totalTokens).toBe(24);
    expect(reconciled.cost.amount).toBe('0.080000');
  });
});

describe('shouldPollDurableRun', () => {
  it.each(['queued', 'running'])('polls the active state %s', (status) => {
    expect(shouldPollDurableRun({ status })).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled', 'future-state'])(
    'does not loop after terminal or unknown state %s',
    (status) => {
      expect(shouldPollDurableRun({ status })).toBe(false);
    },
  );
});
