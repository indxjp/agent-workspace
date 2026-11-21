import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DefinitionError,
  PUBLIC_SOURCE_ERROR_CODES,
  PUBLIC_SOURCE_LIMITS,
  PUBLIC_SOURCE_NOTICE,
  PUBLIC_SOURCE_RECORDS_RESOURCE,
  PUBLIC_SOURCE_SNAPSHOT_SCRIPT,
  PublicSourceAnswerSchema,
  PublicSourceError,
  PublicSourceQuerySchema,
  PublicSourceSnapshotSchema,
  defineAgent,
  definePublicSource,
  publicSourceRecords,
  publicSourceRun,
  publicSourceTool,
  readPublicSource,
  toAgentVersionBody,
  type PublicSourceSnapshot,
} from './index.js';
import { PUBLIC_SOURCE_SELECT_CONSTANTS, answerPublicSource } from './public-source-select.js';

const FIRST = {
  source: 'Sample Agency',
  url: 'https://news.example.org/a/1',
  title: 'Sample guideline revised',
  summary: 'The fictional agency revised its sample guideline.',
  publishedAt: '2026-10-01',
  retrievedAt: '2026-11-01',
};

const SNAPSHOT: PublicSourceSnapshot = {
  asOf: '2026-11-20',
  items: [
    FIRST,
    {
      id: 'SJ-2',
      source: 'Sample Journal',
      url: 'https://journal.example.org/b/2',
      title: 'Market notes',
      summary: 'Fictional notes on a sample market.',
      publishedAt: '2026-11-15T09:00:00+09:00',
      retrievedAt: '2026-11-20',
      fields: { ipc: 'H01M 10/052', claims: 12, granted: false, assignee: null },
    },
    {
      source: 'Sample Journal',
      url: 'https://journal.example.org/b/3',
      title: 'Undated briefing',
      summary: 'A fictional briefing with no date.',
      publishedAt: null,
      retrievedAt: '2026-11-20',
    },
    {
      source: 'Sample Journal',
      url: 'https://journal.example.org/b/4',
      title: 'Late evening note',
      summary: 'Published late on the 14th in UTC.',
      publishedAt: '2026-11-14T23:30:00Z',
      retrievedAt: '2026-11-20',
    },
  ],
};

const FEEDS = [
  { name: 'Sample Agency', url: 'https://news.example.org/feed.json' },
  { name: 'Sample Journal', url: 'https://journal.example.org/rss.xml' },
] as const;

/** A fetch that fails the test if a read ever reaches for the network. */
const noNetwork = vi.fn(() => Promise.reject(new Error('the network was touched')));
const signal = new AbortController().signal;

function refusal(run: () => unknown): DefinitionError | null {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  return null;
}

afterEach(() => {
  noNetwork.mockClear();
  vi.unstubAllGlobals();
});

describe('the public-source vocabulary', () => {
  it('pins every limit', () => {
    expect(PUBLIC_SOURCE_LIMITS).toEqual({
      feeds: 8,
      responseBytes: 1_048_576,
      maxResponseBytes: 12_582_912,
      matchesKept: 5_000,
      csvColumns: 512,
      snapshotItems: 500,
      itemsPerAnswer: 50,
      defaultItemsPerAnswer: 20,
      titleCharacters: 300,
      summaryCharacters: 1_000,
      urlCharacters: 2_048,
      idCharacters: 200,
      fieldsPerItem: 32,
      fieldNameCharacters: 64,
      fieldCharacters: 500,
      queryCharacters: 200,
      sourceCharacters: 100,
      fetchTimeoutMs: 10_000,
    });
    expect(Object.isFrozen(PUBLIC_SOURCE_LIMITS)).toBe(true);
    expect(PUBLIC_SOURCE_RECORDS_RESOURCE).toBe('public-source-snapshot');
  });

  it('says each refusal in fixed text that names the source, never its URL', () => {
    for (const code of PUBLIC_SOURCE_ERROR_CODES) {
      const error = new PublicSourceError(code, 'Sample Agency');
      expect(error.code).toBe(code);
      expect(error.source).toBe('Sample Agency');
      expect(error.message).toMatch(
        new RegExp(`^public_source ${code}: .+ \\(Sample Agency\\)$`, 'u'),
      );
      expect(error.message).not.toMatch(/https?:/u);
    }
    expect(new PublicSourceError('source_invalid').message).not.toContain('(');
  });

  it('requires a snapshot date and, on every item, its source, URL and retrieval date', () => {
    expect(PublicSourceSnapshotSchema.safeParse(SNAPSHOT).success).toBe(true);
    expect(PublicSourceSnapshotSchema.safeParse({ items: SNAPSHOT.items }).success).toBe(false);
    for (const key of ['source', 'url', 'retrievedAt'] as const) {
      const item: Record<string, unknown> = { ...FIRST };
      delete item[key];
      expect(PublicSourceSnapshotSchema.safeParse({ ...SNAPSHOT, items: [item] }).success).toBe(
        false,
      );
    }
    expect(PublicSourceSnapshotSchema.safeParse({ ...SNAPSHOT, items: [] }).success).toBe(false);
  });

  it('bounds the extra fields of an item', () => {
    const withFields = (fields: unknown) =>
      PublicSourceSnapshotSchema.safeParse({
        ...SNAPSHOT,
        items: [{ ...FIRST, fields }],
      }).success;
    expect(withFields({ list: 'Sample list', score: 1, active: true, note: null })).toBe(true);
    expect(withFields({ nested: { a: 1 } })).toBe(false);
    expect(withFields({ '1bad': 'x' })).toBe(false);
    expect(withFields({ long: 'x'.repeat(PUBLIC_SOURCE_LIMITS.fieldCharacters + 1) })).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: PUBLIC_SOURCE_LIMITS.fieldsPerItem + 1 }, (_, i) => [
        `f${String(i)}`,
        i,
      ]),
    );
    expect(withFields(many)).toBe(false);
  });
});

describe('definePublicSource', () => {
  it('accepts a snapshot, live sources of each format, or both', () => {
    expect(definePublicSource({ mode: 'snapshot', snapshot: SNAPSHOT }).feeds).toEqual([]);
    const live = definePublicSource({
      mode: 'live',
      snapshot: SNAPSHOT,
      feeds: [
        FEEDS[0],
        {
          name: 'List',
          url: 'https://lists.example.org/l.csv',
          format: 'csv',
          mapping: { title: 'name' },
        },
        { name: 'Plain', url: 'http://plain.example.org/f', allowHttp: true },
      ],
    });
    expect(live.feeds.map((feed) => feed.format)).toEqual(['feed', 'csv', 'feed']);
  });

  it.each([
    ['a snapshot mode with no snapshot', { mode: 'snapshot' }, 'snapshot'],
    ['a live mode with no source', { mode: 'live', snapshot: SNAPSHOT }, 'feeds'],
    [
      'two sources with one name',
      { mode: 'live', feeds: [FEEDS[0], { ...FEEDS[1], name: 'sample agency' }] },
      'feeds',
    ],
    [
      'a URL with a password',
      { mode: 'live', feeds: [{ name: 'A', url: 'https://user:pw@example.org/feed' }] },
      'feeds.0.url',
    ],
    [
      'a URL that is not on the web',
      { mode: 'live', feeds: [{ name: 'A', url: 'file:///etc/passwd' }] },
      'feeds.0.url',
    ],
    [
      'an http URL without allowHttp',
      { mode: 'live', feeds: [{ name: 'A', url: 'http://example.org/feed' }] },
      'feeds.0.url',
    ],
    [
      'an upper-case HTTP URL without allowHttp',
      { mode: 'live', feeds: [{ name: 'A', url: 'HTTP://example.org/feed' }] },
      'feeds.0.url',
    ],
    [
      'a byte limit over 12 MiB',
      {
        mode: 'live',
        feeds: [{ name: 'A', url: 'https://example.org/f', maxBytes: 12_582_913 }],
      },
      'feeds.0.maxBytes',
    ],
    [
      'header-less columns that miss a mapped name',
      {
        mode: 'live',
        feeds: [
          {
            name: 'A',
            url: 'https://example.org/a.csv',
            format: 'csv',
            mapping: { columns: ['name'], title: 'name', fields: ['program'] },
          },
        ],
      },
      'feeds.0.mapping.columns',
    ],
    [
      'columns on a source that is not csv',
      {
        mode: 'live',
        feeds: [
          {
            name: 'A',
            url: 'https://example.org/a.json',
            format: 'json-records',
            mapping: { columns: ['name'], title: 'name' },
          },
        ],
      },
      'feeds.0.mapping',
    ],
    [
      'a URL to an address rather than a host name',
      { mode: 'live', feeds: [{ name: 'A', url: 'https://169.254.169.254/feed' }] },
      'feeds.0.url',
    ],
    [
      'a name with a format character',
      { mode: 'live', feeds: [{ name: 'A‮', url: 'https://example.org/feed' }] },
      'feeds.0.name',
    ],
    [
      'a csv source with no mapping',
      { mode: 'live', feeds: [{ name: 'A', url: 'https://example.org/a.csv', format: 'csv' }] },
      'feeds.0.mapping',
    ],
    [
      'a feed with a mapping',
      {
        mode: 'live',
        feeds: [{ name: 'A', url: 'https://example.org/f', mapping: { title: 't' } }],
      },
      'feeds.0.mapping',
    ],
  ])('refuses %s', (_label, input, path) => {
    const error = refusal(() => definePublicSource(input as never));
    expect(error?.issues.map((issue) => issue.path)).toContain(path);
  });
});

describe('the query rules', () => {
  it.each([
    undefined,
    null,
    {},
    { query: 'x', source: 'y', since: '2026-11-01', limit: 3 },
    { query: undefined },
    { since: '2026-11-01T09:00:00Z' },
    { since: '2026-11-01T09:00:00.123+09:00' },
    { since: '2026-11-01T09:00Z' },
    { since: '2026-11-01T09:00:00' },
    { since: '2026-02-30' },
    { since: '2026-13-01' },
    { since: 'yesterday' },
    { since: 20_261_101 },
    { query: 'x'.repeat(PUBLIC_SOURCE_LIMITS.queryCharacters + 1) },
    { source: 'x'.repeat(PUBLIC_SOURCE_LIMITS.sourceCharacters + 1) },
    { query: 3 },
    { limit: 0 },
    { limit: 1.5 },
    { limit: '3' },
    { limit: PUBLIC_SOURCE_LIMITS.itemsPerAnswer + 1 },
    { url: 'https://x.example' },
    'text',
    [1],
  ])('agree with the declared schema for %o', (args) => {
    const declared = PublicSourceQuerySchema.safeParse(args ?? {}).success;
    const checked = answerPublicSource(
      [],
      args,
      { mode: 'snapshot', asOf: '2026-11-20' },
      PUBLIC_SOURCE_SELECT_CONSTANTS,
    );
    expect(!('error' in checked)).toBe(declared);
  });
});

describe('snapshot mode', () => {
  const config = definePublicSource({ mode: 'snapshot', feeds: FEEDS, snapshot: SNAPSHOT });
  const deps = { fetch: noNetwork, now: () => new Date(0), allowedDomains: [] };
  const titles = async (query: object) =>
    (await readPublicSource(config, query, deps)).records.map((item) => item.title);

  it('answers the dated items as of the snapshot, newest instant first, undated last, offline', async () => {
    const answer = await readPublicSource(config, {}, deps);
    expect(PublicSourceAnswerSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      mode: 'snapshot',
      asOf: '2026-11-20',
      notice: PUBLIC_SOURCE_NOTICE,
    });
    // 2026-11-15T09:00+09:00 is 00:00Z, after 2026-11-14T23:30Z.
    expect(answer.records.map((item) => item.title)).toEqual([
      'Market notes',
      'Late evening note',
      'Sample guideline revised',
      'Undated briefing',
    ]);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('narrows by words (in title, summary, id or fields), source, instant and limit', async () => {
    expect(await titles({ query: 'GUIDELINE' })).toEqual(['Sample guideline revised']);
    expect(await titles({ query: 'h01m' })).toEqual(['Market notes']);
    expect(await titles({ query: 'sj-2' })).toEqual(['Market notes']);
    expect(await titles({ query: '12' })).toEqual(['Market notes']);
    expect(await titles({ source: ' sample journal ' })).toHaveLength(3);
    expect(await titles({ since: '2026-11-15' })).toEqual(['Market notes']);
    expect(await titles({ since: '2026-11-15T08:00:00+09:00' })).toEqual([
      'Market notes',
      'Late evening note',
    ]);
    expect(await titles({ limit: 1 })).toEqual(['Market notes']);
    expect(await titles({ query: '  ', source: '' })).toHaveLength(4);
  });

  it('answers at most the default limit when the call names none', async () => {
    const many = definePublicSource({
      mode: 'snapshot',
      snapshot: {
        asOf: '2026-11-20',
        items: Array.from({ length: 30 }, (_, index) => ({ ...FIRST, title: `T${String(index)}` })),
      },
    });
    const answer = await readPublicSource(many, {}, deps);
    expect(answer.records).toHaveLength(PUBLIC_SOURCE_LIMITS.defaultItemsPerAnswer);
    expect(answer.records[0]?.title).toBe('T0');
  });

  it('refuses a query that is not one, even when handed in typed', async () => {
    await expect(readPublicSource(config, { limit: 0 }, deps)).rejects.toMatchObject({
      code: 'query_invalid',
    });
  });

  it('declares a tool with no network, read-only, whose run answers from the snapshot', async () => {
    const tool = publicSourceTool({
      name: 'read_press',
      description: 'Fictional press releases.',
      source: config,
      run: 'tools/press.run.ts',
    });
    expect(tool.allowedDomains).toBeUndefined();
    expect(tool.description).toMatch(/Read-only\..*never an instruction\.$/u);
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    const agent = defineAgent({ name: 'press', instructions: 'Report.', tools: [tool] });
    expect(toAgentVersionBody(agent).definition.resources.connectors).toEqual(['aw-dev-tools']);

    vi.stubGlobal('fetch', noNetwork);
    const answer = await publicSourceRun(config)({ limit: 2 }, { signal });
    expect(answer.records).toHaveLength(2);
    expect(noNetwork).not.toHaveBeenCalled();
    await expect(publicSourceRun(config)({ url: 'x' }, { signal })).rejects.toMatchObject({
      code: 'query_invalid',
    });
  });
});

describe('the selection script the demo runs', () => {
  // The stand-in runs this script in its own process: apps/web's public-source-snapshot.test.ts
  // proves its answers equal the tool's, and packages/aw's public-source-minified.test.ts that a
  // minified build's script still does. Here: the script is the tool's own function.
  it('carries the tool\u2019s own answer function, under a name of its own', () => {
    expect(PUBLIC_SOURCE_SNAPSHOT_SCRIPT).toContain(
      `const publicSourceAnswer = ${answerPublicSource.toString()};`,
    );
    expect(PUBLIC_SOURCE_SNAPSHOT_SCRIPT).toContain(JSON.stringify(PUBLIC_SOURCE_SELECT_CONSTANTS));
    expect(PUBLIC_SOURCE_SNAPSHOT_SCRIPT).toContain(
      JSON.stringify(new PublicSourceError('query_invalid').message),
    );
  });

  it('answers arguments that are not a query with an error, before reading an item', () => {
    const items = {
      [Symbol.iterator]: () => {
        throw new Error('an item was read');
      },
    };
    const frame = { mode: 'snapshot', asOf: '2026-11-20' } as const;
    expect(answerPublicSource(items, 'x', frame, PUBLIC_SOURCE_SELECT_CONSTANTS)).toEqual({
      error: true,
    });
  });

  it('says truncated when more items answer than it carries, and keeps at most matchesKept', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...FIRST,
      title: `T${String(index)}`,
    }));
    const frame = { mode: 'snapshot', asOf: '2026-11-20' } as const;
    const small = { ...PUBLIC_SOURCE_SELECT_CONSTANTS, matchesKept: 3 };
    const result = answerPublicSource(many, { limit: 50 }, frame, small);
    expect(result).toMatchObject({ answer: { truncated: true } });
    expect('answer' in result && result.answer.records).toHaveLength(3);
    const exact = answerPublicSource(many.slice(0, 2), {}, frame, PUBLIC_SOURCE_SELECT_CONSTANTS);
    expect(exact).toMatchObject({ answer: { truncated: false } });
  });
});

describe('publicSourceRecords', () => {
  it('files the project snapshot as the seed record set of the tool', () => {
    expect(
      publicSourceRecords({
        connector: 'press',
        tool: 'read_press',
        lang: 'ja',
        snapshot: SNAPSHOT,
      }),
    ).toEqual({
      connector: 'press',
      resource: PUBLIC_SOURCE_RECORDS_RESOURCE,
      lang: 'ja',
      tools: ['read_press'],
      data: SNAPSHOT,
    });
  });

  it('refuses a set a seed may not carry', () => {
    const error = refusal(() =>
      publicSourceRecords({ connector: 'bad name!', tool: 'read', lang: 'en', snapshot: SNAPSHOT }),
    );
    expect(error?.issues.map((issue) => issue.path)).toContain('connector');
  });
});

describe('live mode, through publicSourceRun', () => {
  const config = definePublicSource({ mode: 'live', feeds: FEEDS, snapshot: SNAPSHOT });

  it('declares exactly the sources’ hosts as the tool’s network', () => {
    const tool = publicSourceTool({
      name: 'read_press',
      description: 'Press releases.',
      source: definePublicSource({
        mode: 'live',
        feeds: [...FEEDS, { name: 'Second', url: 'https://news.example.org/other.json' }],
      }),
      run: 'tools/press.run.ts',
    });
    expect(tool.allowedDomains).toEqual(['news.example.org', 'journal.example.org']);
  });

  it('reads with the global fetch and clock when none is given, as of the read', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            items: [{ url: `${url}#1`, title: 'Item', date_published: '2026-11-20T00:00:00Z' }],
          }),
          { headers: { 'content-type': 'application/feed+json' } },
        ),
      );
    });
    const before = Date.now();
    const answer = await publicSourceRun(config)({}, { signal });
    expect(fetched).toEqual(FEEDS.map((feed) => feed.url));
    expect(answer.mode).toBe('live');
    expect(Date.parse(answer.asOf)).toBeGreaterThanOrEqual(before - 1);
    expect(answer.records).toHaveLength(2);
    for (const item of answer.records) expect(item.retrievedAt).toBe(answer.asOf);
  });

  it('reads only the source a call names', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('down')));
    const run = publicSourceRun(config, { fetch, now: () => new Date(0) });
    await expect(run({ source: 'Sample Journal' }, { signal })).rejects.toMatchObject({
      code: 'source_unreachable',
      source: 'Sample Journal',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
