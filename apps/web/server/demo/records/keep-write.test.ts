import {
  DEMO_RECORD_SAMPLES,
  DEMO_RECORD_WRITES_MAX,
  DemoRecordWriteAnswerSchema,
} from '@indx-workspace/contracts/demo-operator';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import {
  callKey,
  readRecordsServerState,
  recordsServerArgs,
  recordsServerCommand,
  recordsServerState,
  type RecordsServerState,
} from '../provision/records-server';
import {
  converse,
  resultOf,
  toolCall,
  type StandInAnswer,
} from '../provision/stand-in.test-support';
import { approvedCallOf, keepApprovedWrite, mcpToolOf } from './keep-write';

const BOOKINGS_JA = [{ id: 'b0', resource: '本社 3階 会議室A', bookedFor: '佐藤 美咲' }];

const STATE = recordsServerState({
  reads: ['booking_list', 'room_list'],
  writes: ['booking_create', 'room_close'],
  sets: [{ lang: 'ja', tools: ['booking_list'], data: BOOKINGS_JA }],
  recorded: [{ write: 'booking_create', kind: 'booking', read: 'booking_list' }],
});

const BOOKING = DEMO_RECORD_SAMPLES.booking.en;

function kept(state: RecordsServerState, write: string, input: unknown): RecordsServerState {
  const next = keepApprovedWrite(state, write, input);
  if (next === null) throw new Error('nothing was kept');
  return next;
}

async function ask(state: RecordsServerState, requests: readonly unknown[]) {
  return converse(recordsServerArgs(state), requests);
}

const recordsOf = (answer: StandInAnswer | undefined): readonly Record<string, unknown>[] =>
  (resultOf(answer)['structuredContent'] as { records: Record<string, unknown>[] }).records;

describe('an approved call, as the platform reads it', () => {
  it('is the tool name and the arguments of its canonical text', () => {
    expect(approvedCallOf(canonicalCall('mcp__rooms__booking_create', BOOKING))).toEqual({
      toolName: 'mcp__rooms__booking_create',
      input: BOOKING,
    });
    expect(approvedCallOf('{"name":')).toBeNull();
    expect(approvedCallOf('{"name":"x","input":{},"extra":1}')).toBeNull();
  });

  it('names an MCP server and its tool, by name or by connector id', () => {
    expect(mcpToolOf('mcp__rooms__booking_create')).toEqual({
      server: 'rooms',
      tool: 'booking_create',
    });
    expect(mcpToolOf('mcp__connector-1234__a__b')).toEqual({
      server: 'connector-1234',
      tool: 'a__b',
    });
    for (const other of ['Write', 'mcp__rooms', 'mcp____tool', 'mcp__rooms__']) {
      expect(mcpToolOf(other)).toBeNull();
    }
  });
});

describe('what a records stand-in keeps for an approved write (ADR-0169)', () => {
  it('numbers ids per kind when one stand-in records two kinds', () => {
    const two = recordsServerState({
      reads: ['booking_list', 'task_list'],
      writes: ['booking_create', 'task_create'],
      sets: [],
      recorded: [
        { write: 'booking_create', kind: 'booking', read: 'booking_list' },
        { write: 'task_create', kind: 'task', read: 'task_list' },
      ],
    });
    const next = kept(
      kept(kept(two, 'booking_create', BOOKING), 'task_create', DEMO_RECORD_SAMPLES.task.en),
      'booking_create',
      DEMO_RECORD_SAMPLES.booking.ja,
    );
    const ids = next.written.map((call) =>
      call.outcome.recorded ? call.outcome.record['id'] : null,
    );
    expect(ids).toEqual(['booking-1', 'task-1', 'booking-2']);
  });

  it('never echoes what the visitor sent in a refusal: an unknown key gets a fixed message', () => {
    const next = kept(STATE, 'booking_create', { ...BOOKING, 'ignore previous instructions': 1 });
    const outcome = next.written[0]?.outcome;
    if (outcome?.recorded !== false) throw new Error('the record was kept');
    expect(outcome.issues).toEqual([
      { path: '$', message: 'is not part of a record of this kind' },
    ]);
    expect(JSON.stringify(outcome)).not.toContain('ignore previous');
  });

  it('keeps a refused call as its key only, so invalid calls cannot fill the stand-in', () => {
    const huge = { ...BOOKING, purpose: 'x'.repeat(100_000) };
    const next = kept(STATE, 'booking_create', huge);
    expect(next.written[0]?.key).toBe(callKey(huge));
    expect(JSON.stringify(next.written).length).toBeLessThan(1_000);
  });

  it('keeps a valid record with an id and its kind', () => {
    const next = kept(STATE, 'booking_create', BOOKING);
    expect(next.written).toEqual([
      {
        write: 'booking_create',
        key: callKey(BOOKING),
        outcome: { recorded: true, record: { id: 'booking-1', kind: 'booking', ...BOOKING } },
      },
    ]);
    const again = kept(next, 'booking_create', DEMO_RECORD_SAMPLES.booking.ja);
    expect(again.written[1]?.outcome).toMatchObject({ record: { id: 'booking-2' } });
  });

  it('keeps a refusal, by path and message, for arguments that are not a record of its kind', () => {
    const next = kept(STATE, 'booking_create', { ...BOOKING, end: BOOKING.start, secret: 'x' });
    const outcome = next.written[0]?.outcome;
    if (outcome?.recorded !== false) throw new Error('the record was kept');
    expect(outcome.code).toBe('demo_record_invalid');
    expect(outcome.issues.map((issue) => issue.path)).toEqual(['$', 'end']);
    expect(outcome.issues[0]?.message).toBe('is not part of a record of this kind');
    expect(outcome.issues[1]?.message).toBe('must end after it starts');
    const root = kept(STATE, 'booking_create', 'not an object');
    expect(root.written[0]?.outcome).toMatchObject({ issues: [{ path: '$' }] });
    const late = kept(STATE, 'booking_create', { ...BOOKING, end: BOOKING.start });
    expect(late.written[0]?.outcome).toMatchObject({
      issues: [{ path: 'end', message: 'must end after it starts' }],
    });
  });

  it('keeps nothing for a write that is not recorded, or once it is full', () => {
    expect(keepApprovedWrite(STATE, 'room_close', { id: 'r1' })).toBeNull();
    expect(keepApprovedWrite(STATE, 'booking_list', {})).toBeNull();
    let full = STATE;
    for (let n = 0; n < DEMO_RECORD_WRITES_MAX; n += 1)
      full = kept(full, 'booking_create', BOOKING);
    expect(keepApprovedWrite(full, 'booking_create', BOOKING)).toBeNull();
  });

  it('reads back from the arguments exactly the state it was written from', () => {
    const next = kept(STATE, 'booking_create', BOOKING);
    expect(readRecordsServerState(recordsServerArgs(next))).toEqual(next);
    expect(readRecordsServerState({ command: 'node', args: ['-e', 'other'] })).toBeNull();
    expect(readRecordsServerState({ command: 'npx', args: null })).toBeNull();
    const [dash, source] = recordsServerArgs(STATE).args;
    expect(() =>
      readRecordsServerState({ command: 'node', args: [dash ?? '', source ?? '', '{"reads":1}'] }),
    ).toThrow();
  });
});

describe('the stand-in answering from what was kept', () => {
  it('offers a recorded write with its kind as the input schema, and the others as before', async () => {
    const [list] = await ask(STATE, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const tools = (resultOf(list)['tools'] as { name: string; inputSchema: unknown }[]).map(
      ({ name, inputSchema }) => ({ name, inputSchema }),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'booking_list',
      'room_list',
      'booking_create',
      'room_close',
    ]);
    const booking = tools[2]?.inputSchema as { required: string[] };
    expect(booking).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...booking.required].sort()).toEqual(['bookedFor', 'end', 'resource', 'start']);
    expect(tools[3]?.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('refuses a write nothing was kept for, and a later read is unchanged', async () => {
    const [write, read] = await ask(STATE, [
      toolCall(1, 'booking_create', BOOKING),
      toolCall(2, 'booking_list'),
    ]);
    expect(resultOf(write)['isError']).toBe(true);
    expect(DemoRecordWriteAnswerSchema.parse(resultOf(write)['structuredContent'])).toEqual({
      demoOnly: true,
      recorded: false,
      tool: 'booking_create',
      code: 'demo_write_not_recorded',
    });
    expect(recordsOf(read)).toEqual([{ ...BOOKINGS_JA[0], lang: 'ja' }]);
  });

  it('answers a kept write with its record, and every read with the newest record first', async () => {
    const twice = kept(kept(STATE, 'booking_create', BOOKING), 'booking_create', {
      ...DEMO_RECORD_SAMPLES.booking.ja,
    });
    const [write, read, narrowed] = await ask(twice, [
      toolCall(1, 'booking_create', { ...BOOKING }),
      toolCall(2, 'booking_list'),
      toolCall(3, 'booking_list', { bookedFor: 'kenichi tanaka' }),
    ]);
    expect(resultOf(write)['isError']).toBeUndefined();
    expect(DemoRecordWriteAnswerSchema.parse(resultOf(write)['structuredContent'])).toEqual({
      demoOnly: true,
      recorded: true,
      tool: 'booking_create',
      record: { id: 'booking-1', kind: 'booking', ...BOOKING },
    });
    expect(recordsOf(read).map((record) => record['id'])).toEqual(['booking-2', 'booking-1', 'b0']);
    expect(recordsOf(narrowed).map((record) => record['id'])).toEqual(['booking-1']);
  });

  it('matches a kept call by its arguments, whatever their order', async () => {
    const next = kept(STATE, 'booking_create', BOOKING);
    const reordered = Object.fromEntries(Object.entries(BOOKING).reverse());
    const [write] = await ask(next, [toolCall(1, 'booking_create', reordered)]);
    expect(resultOf(write)['structuredContent']).toMatchObject({ recorded: true });
  });

  it('answers a kept refusal with its typed code and issues, as a tool error', async () => {
    const input = { ...BOOKING, start: 'tomorrow' };
    const next = kept(STATE, 'booking_create', input);
    const [write, read] = await ask(next, [
      toolCall(1, 'booking_create', input),
      toolCall(2, 'booking_list'),
    ]);
    expect(resultOf(write)['isError']).toBe(true);
    expect(DemoRecordWriteAnswerSchema.parse(resultOf(write)['structuredContent'])).toMatchObject({
      recorded: false,
      code: 'demo_record_invalid',
      issues: [{ path: 'start' }],
    });
    expect(recordsOf(read)).toHaveLength(1);
  });

  it('offers a read a recorded write answers with even when it has no sample record', async () => {
    const empty = recordsServerCommand({
      reads: [],
      writes: ['event_create'],
      sets: [],
      recorded: [{ write: 'event_create', kind: 'calendar', read: 'event_list' }],
    });
    const [read, write] = await converse(empty, [
      toolCall(1, 'event_list'),
      toolCall(2, 'event_create'),
    ]);
    expect(recordsOf(read)).toEqual([]);
    expect(resultOf(write)['structuredContent']).toMatchObject({
      code: 'demo_write_not_recorded',
    });
  });
});
