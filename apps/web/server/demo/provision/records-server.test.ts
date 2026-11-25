import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import { describe, expect, it } from 'vitest';

import { RECORDS_JSON_MAX_BYTES, RECORDS_PER_ANSWER } from './limits';
import {
  readRecordsServerState,
  RecordsTooLargeError,
  recordsServerCommand,
} from './records-server';
import { converse, toolCall as call, type StandInAnswer as Answer } from './stand-in.test-support';

const CONTACTS_EN = [
  { id: 'c1', name: 'Misaki Sato', email: 'sato@aoba.example', status: 'open' },
  { id: 'c2', name: 'Kenichi Tanaka', email: 'tanaka@aoba.example', status: 'closed' },
];
const CONTACTS_JA = [
  { id: 'c1', name: '佐藤 美咲', email: 'sato@aoba.example', status: 'open' },
  { id: 'c2', name: '田中 健一', email: 'tanaka@aoba.example', status: 'closed' },
];

const COMMAND = recordsServerCommand({
  reads: ['contact_list', 'contact_get', 'contact_search'],
  writes: ['contact_update'],
  sets: [
    { lang: 'en', tools: ['contact_list', 'contact_get', 'contact_search'], data: CONTACTS_EN },
    { lang: 'ja', tools: ['contact_list', 'contact_get', 'contact_search'], data: CONTACTS_JA },
  ],
});

async function records(name: string, args?: unknown): Promise<readonly Record<string, unknown>[]> {
  const [answer] = await converse(COMMAND, [call(1, name, args)]);
  const result = answer?.['result'] as {
    structuredContent: { records: Record<string, unknown>[] };
  };
  return result.structuredContent.records;
}

describe('the demo records stand-in', () => {
  it('offers the read tools and the write tools it was given, and no others', async () => {
    const [list] = await converse(COMMAND, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const tools = (list?.['result'] as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(tools).toEqual(['contact_list', 'contact_get', 'contact_search', 'contact_update']);
  });

  it('answers a read tool with its records in both languages, each tagged with its language', async () => {
    const answered = await records('contact_list');
    expect(answered).toHaveLength(4);
    expect(answered.filter((record) => record['lang'] === 'en').map((r) => r['name'])).toEqual([
      'Misaki Sato',
      'Kenichi Tanaka',
    ]);
    expect(answered.filter((record) => record['lang'] === 'ja').map((r) => r['name'])).toEqual([
      '佐藤 美咲',
      '田中 健一',
    ]);
  });

  it('puts the same records in the text a model reads as in the structured answer', async () => {
    const [answer] = await converse(COMMAND, [call(1, 'contact_list')]);
    const result = answer?.['result'] as {
      content: { text: string }[];
      structuredContent: { records: unknown[] };
    };
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent.records);
  });

  it('narrows by a string argument that names a field: an exact match, case ignored', async () => {
    const answered = await records('contact_get', { id: 'C2' });
    expect(answered.map((record) => record['id'])).toEqual(['c2', 'c2']);
    expect(answered.map((record) => record['lang'])).toEqual(['en', 'ja']);
  });

  it('narrows by a query argument: the records whose text holds it', async () => {
    const answered = await records('contact_search', { query: 'tanaka' });
    expect(answered.map((record) => record['id'])).toEqual(['c2', 'c2']);
    expect(await records('contact_search', { query: '佐藤' })).toHaveLength(1);
    expect(await records('contact_search', { query: 'nobody-by-this-name' })).toEqual([]);
  });

  it('ignores an argument that names no field of a record, and an empty one', async () => {
    expect(await records('contact_list', { cursor: 'abc', note: '' })).toHaveLength(4);
    expect(await records('contact_list', { status: 'open' })).toHaveLength(2);
  });

  it('cuts the answer at the limit the call gives, and never above its own cap', async () => {
    expect(await records('contact_list', { limit: 1 })).toHaveLength(1);
    const many = recordsServerCommand({
      reads: ['row_list'],
      writes: [],
      sets: [
        {
          lang: 'en',
          tools: ['row_list'],
          data: Array.from({ length: RECORDS_PER_ANSWER + 50 }, (_, n) => ({ n })),
        },
      ],
    });
    const [answer] = await converse(many, [call(1, 'row_list', { limit: 1_000_000 })]);
    const result = answer?.['result'] as { structuredContent: { records: unknown[] } };
    expect(result.structuredContent.records).toHaveLength(RECORDS_PER_ANSWER);
  });

  it('keeps each read tool to the sets that name it', async () => {
    const split = recordsServerCommand({
      reads: ['parts_search', 'rates_get'],
      writes: [],
      sets: [
        { lang: 'en', tools: ['parts_search'], data: [{ partNo: 'P-1' }] },
        {
          lang: 'en',
          tools: ['rates_get'],
          data: { SS400: { material: 'SS400', pricePerKg: 150 } },
        },
      ],
    });
    const [parts, rates] = await converse(split, [call(1, 'parts_search'), call(2, 'rates_get')]);
    const records = (answer: Answer | undefined): unknown =>
      (answer?.['result'] as { structuredContent: { records: unknown } }).structuredContent.records;
    expect(records(parts)).toEqual([{ partNo: 'P-1', lang: 'en' }]);
    expect(records(rates)).toEqual([{ material: 'SS400', pricePerKg: 150, lang: 'en' }]);
  });

  it('answers a write tool with the demo-only result and sends nothing', async () => {
    const [answer] = await converse(COMMAND, [call(1, 'contact_update', { id: 'c1', name: 'x' })]);
    expect(answer?.['result']).toMatchObject({
      content: [{ type: 'text', text: DEMO_SEND_RESULT.en }],
      structuredContent: { demoOnly: true, delivered: false, tool: 'contact_update' },
    });
  });

  it('answers a tool it does not offer as a demo-only write, never as records', async () => {
    const [answer] = await converse(COMMAND, [call(1, 'contact_delete')]);
    expect(answer?.['result']).toMatchObject({ structuredContent: { delivered: false } });
  });

  it('carries records of any size inside many small arguments, and refuses more than it can carry', () => {
    const big = recordsServerCommand({
      reads: ['row_list'],
      writes: [],
      sets: [{ lang: 'ja', tools: ['row_list'], data: [{ text: 'あ'.repeat(100_000) }] }],
    });
    expect(big.args.length).toBeGreaterThan(3);
    for (const arg of big.args.slice(2)) expect(arg.length).toBeLessThanOrEqual(30_000);
    expect(() =>
      recordsServerCommand({
        reads: ['row_list'],
        writes: [],
        sets: [
          {
            lang: 'ja',
            tools: ['row_list'],
            data: [{ text: 'x'.repeat(RECORDS_JSON_MAX_BYTES) }],
          },
        ],
      }),
    ).toThrow(RecordsTooLargeError);
  });

  it('serves multi-piece records with characters outside the BMP unchanged, whatever the cut', async () => {
    // Prefixes of one to three characters move the cut across every alignment of a surrogate pair.
    const texts = ['', 'a', 'ab', 'abc'].map((prefix) => `${prefix}${'𠮷😀'.repeat(9_000)}`);
    const command = recordsServerCommand({
      reads: ['row_list'],
      writes: [],
      sets: [{ lang: 'ja', tools: ['row_list'], data: texts.map((text, n) => ({ n, text })) }],
    });
    const pieces = command.args.slice(2);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(30_000);
      expect(piece.slice(-1)).not.toMatch(/[\ud800-\udbff]/u);
    }
    expect(pieces.join('')).not.toContain('\ufffd');
    const [answer] = await converse(command, [call(1, 'row_list')]);
    const served = (answer?.['result'] as { structuredContent: { records: { text: string }[] } })
      .structuredContent.records;
    expect(served.map((record) => record.text)).toEqual(texts);
  });

  it('bounds the records by their UTF-8 bytes, so Japanese text counts three bytes a character', () => {
    const characters = Math.ceil(RECORDS_JSON_MAX_BYTES / 3);
    expect(characters).toBeLessThan(RECORDS_JSON_MAX_BYTES);
    expect(() =>
      recordsServerCommand({
        reads: ['row_list'],
        writes: [],
        sets: [{ lang: 'ja', tools: ['row_list'], data: [{ text: '日'.repeat(characters) }] }],
      }),
    ).toThrow(RecordsTooLargeError);
  });

  it('carries for a stand-in with no recorded write exactly what it carried before (ADR-0169)', () => {
    const reads = {
      contact_list: [{ id: 'c1', lang: 'en' }],
    };
    const command = recordsServerCommand({
      reads: ['contact_list'],
      writes: ['contact_update'],
      sets: [{ lang: 'en', tools: ['contact_list'], data: [{ id: 'c1' }] }],
    });
    const carried = command.args.slice(2).join('');
    expect(carried).toBe(JSON.stringify({ reads, writes: ['contact_update'] }));
    expect(carried).not.toContain('schemas');
    expect(readRecordsServerState(command)).toEqual({
      reads,
      writes: ['contact_update'],
      recorded: [],
      written: [],
    });
  });

  it('has no code that could reach anything outside its own standard input and output', () => {
    const source = COMMAND.args[1] ?? '';
    for (const reach of [
      'require',
      'import',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'child_process',
      'process.env',
      'process.binding',
      'eval',
      'Function(',
      'http',
      'net.',
      'dgram',
      'fs',
    ]) {
      expect(source, `the stand-in must not mention ${reach}`).not.toContain(reach);
    }
  });
});
