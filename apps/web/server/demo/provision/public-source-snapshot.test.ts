/**
 * ADR-0170 D4: in a visitor's demo the public-source tool's read answers from the entry's dated
 * snapshot, filed as that read's sample record set (`publicSourceRecords`), by the records
 * stand-in, which runs the SDK's own selection script on it. These tests pin that the demo's answer
 * is the installed tool's snapshot answer for the same arguments: the same items in the same
 * order, the same `asOf`, notice and limits, and the same refusal.
 */
import { spawn } from 'node:child_process';

import {
  PublicSourceError,
  definePublicSource,
  publicSourceRecords,
  publicSourceRun,
  type PublicSourceSnapshot,
} from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { readRecordsServerState, recordsServerCommand, recordsServerState } from './records-server';

/**
 * The longest one exchange with the stand-in may take before the test kills it and fails, and the
 * longest a test may take. A child Node process can start slowly on a loaded machine, so both are
 * well above the few hundred milliseconds an exchange takes.
 */
const STAND_IN_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

const SNAPSHOT: PublicSourceSnapshot = {
  asOf: '2026-11-20',
  items: [
    {
      source: 'Sample Agency',
      url: 'https://agency.example.org/notice/101',
      title: 'Sample labelling guideline revised',
      summary: 'A fictional agency revised its fictional labelling guideline.',
      publishedAt: '2026-10-01',
      retrievedAt: '2026-11-01',
    },
    {
      id: 'SP-7',
      source: 'Sample List',
      url: 'https://lists.example.org/restricted.csv',
      title: 'Sample Trading Co.',
      summary: 'Listed party (fictional).',
      publishedAt: '2026-11-15T09:00:00+09:00',
      retrievedAt: '2026-11-20',
      fields: { country: 'XA', program: 'Sample sanctions' },
    },
    {
      source: 'Sample Journal',
      url: 'https://journal.example.org/2026/11/market',
      title: 'Sample market grows',
      summary: 'Fictional figures for a fictional market.',
      publishedAt: '2026-11-14T23:30:00Z',
      retrievedAt: '2026-11-20',
    },
    {
      source: 'Sample Journal',
      url: 'https://journal.example.org/undated',
      title: 'Undated sample note',
      summary: 'No date given.',
      publishedAt: null,
      retrievedAt: '2026-11-20',
    },
  ],
};

const TOOL = 'read_public_source';

/** The parts of a stand-in's JSON-RPC result these tests read. */
interface Reply {
  readonly result: {
    readonly structuredContent?: unknown;
    readonly content?: unknown;
    readonly isError?: boolean;
    readonly tools?: readonly { readonly name: string }[];
  };
}

/** What the stand-in answers a `tools/call`, or `tools/list`, as one parsed JSON-RPC reply. */
async function ask(
  command: ReturnType<typeof recordsServerCommand>,
  method: string,
  params: unknown,
): Promise<Reply> {
  // No proxy and no secret in its environment, as in the demo's no-network sandbox.
  const child = spawn(process.execPath, [...command.args], {
    stdio: 'pipe',
    env: { NODE_ENV: 'test' },
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the stand-in did not answer in time'));
      }, STAND_IN_TIMEOUT_MS);
      let buffered = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end >= 0) {
          clearTimeout(timer);
          resolve(buffered.slice(0, end));
        }
      });
      child.on('error', reject);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    return JSON.parse(line) as Reply;
  } finally {
    child.kill();
  }
}

const standIn = recordsServerCommand({
  reads: [TOOL, 'contact_list'],
  writes: ['contact_update'],
  sets: [
    publicSourceRecords({ connector: 'public', tool: TOOL, lang: 'en', snapshot: SNAPSHOT }),
    { lang: 'en', tools: ['contact_list'], data: [{ id: 'c1' }] },
  ],
});
const installed = publicSourceRun(definePublicSource({ mode: 'snapshot', snapshot: SNAPSHOT }));
const signal = new AbortController().signal;

describe(
  'the demo serves a public-source snapshot as the installed tool does',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it.each([
      {},
      { query: 'labelling' },
      { query: 'xa' },
      { source: 'Sample Journal' },
      { since: '2026-11-15' },
      { since: '2026-11-15T08:00:00+09:00' },
      { limit: 2 },
    ])('answers %o with the snapshot answer, item for item', async (args) => {
      const { result } = await ask(standIn, 'tools/call', { name: TOOL, arguments: args });
      const expected = await installed(args, { signal });
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
    });

    it('answers newest first with undated last, as of the snapshot date', async () => {
      const { result } = await ask(standIn, 'tools/call', { name: TOOL, arguments: {} });
      expect(result.structuredContent).toMatchObject({ mode: 'snapshot', asOf: '2026-11-20' });
      const { records } = result.structuredContent as { records: { url: string }[] };
      expect(records.map((record) => record.url)).toEqual([
        'https://lists.example.org/restricted.csv',
        'https://journal.example.org/2026/11/market',
        'https://agency.example.org/notice/101',
        'https://journal.example.org/undated',
      ]);
    });

    it('refuses arguments that are not a query, with the tool’s own refusal', async () => {
      const { result } = await ask(standIn, 'tools/call', { name: TOOL, arguments: { limit: 0 } });
      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: new PublicSourceError('query_invalid').message }],
      });
      await expect(installed({ limit: 0 }, { signal })).rejects.toMatchObject({
        code: 'query_invalid',
      });
    });

    it('lists the snapshot read beside the other reads and the writes', async () => {
      const { result } = await ask(standIn, 'tools/list', {});
      const names = (result.tools ?? []).map((tool) => tool.name);
      expect(names.sort()).toEqual(['contact_list', 'contact_update', TOOL].sort());
    });

    it('keeps the snapshot when the platform reads the stand-in\u2019s state back', () => {
      const state = readRecordsServerState(standIn);
      expect(state?.snapshots).toEqual({ [TOOL]: SNAPSHOT });
      expect(state?.reads).toEqual({ contact_list: [{ id: 'c1', lang: 'en' }] });
    });

    it.each([
      ['two snapshots for one read', [SNAPSHOT, SNAPSHOT], ['en', 'en']],
      ['a set that is no snapshot', [{ asOf: '2026-11-20', items: [] }], ['en']],
      [
        'two languages holding different snapshots',
        [SNAPSHOT, { ...SNAPSHOT, asOf: '2026-11-21' }],
        ['ja', 'en'],
      ],
    ] as const)('refuses to build a stand-in from %s', (_label, snapshots, langs) => {
      expect(() =>
        recordsServerState({
          reads: [TOOL],
          writes: [],
          sets: snapshots.map((data, at) => ({
            resource: 'public-source-snapshot',
            lang: langs[at] ?? 'en',
            tools: [TOOL],
            data,
          })),
        }),
      ).toThrow(/public-source snapshot for read_public_source/u);
    });

    it('answers from the one snapshot the seed files once per language', () => {
      const state = recordsServerState({
        reads: [TOOL],
        writes: [],
        sets: (['ja', 'en'] as const).map((lang) => ({
          resource: 'public-source-snapshot',
          lang,
          tools: [TOOL],
          data: SNAPSHOT,
        })),
      });
      expect(state.snapshots).toEqual({ [TOOL]: SNAPSHOT });
    });
  },
);
