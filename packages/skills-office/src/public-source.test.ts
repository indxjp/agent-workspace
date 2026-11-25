/**
 * The public-source records reader (ADR-0176): a script reads the answer `run_skill_script` handed
 * it, and anything that is not a whole public-source answer is refused, never guessed at.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TOOL_ANSWER_ENV,
  publicSourceRecords,
  readPublicSource,
  readToolAnswer,
} from '../office-reader/scripts/lib/public-source.mjs';
import { TableError } from '../office-reader/scripts/lib/table.mjs';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'JP-001',
    source: 'Fictional filings',
    url: 'https://example.test/filings/1',
    title: 'Sample Co. annual report',
    summary: '',
    publishedAt: '2026-06-30',
    retrievedAt: '2026-11-01T09:00:00+09:00',
    fields: { revenue: 1200, segment: 'retail', listed: true, note: null },
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'snapshot',
    asOf: '2026-11-01',
    notice: 'A dated snapshot.',
    truncated: false,
    records: [item(), item({ id: 'JP-002', publishedAt: null, fields: undefined })],
    ...overrides,
  });
}

function refusal(run: () => unknown): TableError {
  try {
    run();
  } catch (error) {
    if (error instanceof TableError) return error;
    throw error;
  }
  throw new Error('expected a TableError');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publicSourceRecords', () => {
  it('returns asOf and each record as its id and fields', () => {
    expect(publicSourceRecords(answer())).toEqual({
      asOf: '2026-11-01',
      truncated: false,
      records: [
        { id: 'JP-001', revenue: 1200, segment: 'retail', listed: true, note: null },
        { id: 'JP-002' },
      ],
    });
  });

  it('reads a live answer with a date and time', () => {
    expect(
      publicSourceRecords(answer({ mode: 'live', asOf: '2026-11-01T09:30:00.5Z', records: [] })),
    ).toEqual({ asOf: '2026-11-01T09:30:00.5Z', truncated: false, records: [] });
  });

  it('refuses a cut answer as truncated_answer, so no record is silently left out', () => {
    const error = refusal(() => publicSourceRecords(answer({ truncated: true })));
    expect(error.code).toBe('truncated_answer');
    expect(error.message).toContain('(2)');
  });

  it.each([
    ['text that is not JSON', 'Error: source_status', 'it is not JSON'],
    ['JSON that is not an object', '[]', 'it is not an object'],
    ['JSON null', 'null', 'it is not an object'],
    ['an unknown key', answer({ extra: 1 }), 'unknown key "extra"'],
    ['an unknown mode', answer({ mode: 'cached' }), 'lacks its mode'],
    ['a missing asOf', answer({ asOf: undefined }), 'lacks its mode'],
    ['an asOf that is not a date', answer({ asOf: 'yesterday' }), 'lacks its mode'],
    ['a notice that is not text', answer({ notice: 1 }), 'lacks its mode'],
    ['a truncated flag that is not a boolean', answer({ truncated: 'no' }), 'lacks its mode'],
    ['records that are not an array', answer({ records: {} }), 'lacks its mode'],
    ['a record that is not an object', answer({ records: ['x'] }), 'record 1 is not an object'],
    [
      'a record with an unknown key',
      answer({ records: [item({ rank: 1 })] }),
      'unknown key "rank"',
    ],
    ['a record without a title', answer({ records: [item({ title: 3 })] }), 'lacks its source'],
    [
      'a record without retrievedAt',
      answer({ records: [item({ retrievedAt: undefined })] }),
      'lacks its source',
    ],
    [
      'a publishedAt that is not a date',
      answer({ records: [item({ publishedAt: 'soon' })] }),
      'publishedAt',
    ],
    ['fields that are null', answer({ records: [item({ fields: null })] }), 'fields that are not'],
    [
      'a field name that is not a name',
      answer({ records: [item({ fields: { 'a b': 1 } })] }),
      'field "a b"',
    ],
    [
      'a field that is not a scalar',
      answer({ records: [item({ fields: { a: [1] } })] }),
      'field "a"',
    ],
    [
      'a field that is not a finite number',
      answer({ records: [item({ fields: { a: '1' } })] }).replace('"1"', '1e999'),
      'field "a"',
    ],
  ])('refuses %s as not_public_source', (_name, text, reason) => {
    const error = refusal(() => publicSourceRecords(text));
    expect(error.code).toBe('not_public_source');
    expect(error.message).toContain(reason);
  });

  it.each([
    ['without an id', item({ id: undefined })],
    ['with an empty id', item({ id: '' })],
  ])('refuses a record %s as record_without_id, naming it', (_name, record) => {
    const error = refusal(() => publicSourceRecords(answer({ records: [item(), record] })));
    expect(error.toJSON()).toMatchObject({ error: 'record_without_id', row: 2 });
    expect(error.message).toContain('Sample Co. annual report');
  });

  it('refuses a repeated id and a field named id', () => {
    expect(
      refusal(() => publicSourceRecords(answer({ records: [item(), item()] }))).toJSON(),
    ).toMatchObject({ error: 'duplicate_id', row: 2, value: 'JP-001' });
    expect(
      refusal(() =>
        publicSourceRecords(answer({ records: [item({ fields: { id: 'other' } })] })),
      ).toJSON(),
    ).toMatchObject({ error: 'duplicate_field', row: 1, column: 'id' });
  });
});

describe('readToolAnswer and readPublicSource', () => {
  it('reads the file the environment names, from the process by default', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'public-source-'));
    const file = path.join(directory, 'tool-answer.txt');
    await writeFile(file, answer());
    expect(TOOL_ANSWER_ENV).toBe('SKILL_SCRIPT_INPUT');
    expect(readToolAnswer({ SKILL_SCRIPT_INPUT: file })).toBe(answer());
    vi.stubEnv(TOOL_ANSWER_ENV, file);
    expect(process.env[TOOL_ANSWER_ENV]).toBe(file);
    expect(readPublicSource().records).toHaveLength(2);
    expect(readToolAnswer()).toBe(answer());
    expect(readPublicSource({ SKILL_SCRIPT_INPUT: file }).asOf).toBe('2026-11-01');
  });

  it('refuses a call that named no tool call, and a file it cannot read', () => {
    for (const env of [{}, { SKILL_SCRIPT_INPUT: '' }]) {
      const error = refusal(() => readToolAnswer(env));
      expect(error.code).toBe('no_tool_answer');
      expect(error.message).toContain('fromToolUse');
    }
    expect(
      refusal(() => readToolAnswer({ SKILL_SCRIPT_INPUT: path.join(tmpdir(), 'no-such-answer') }))
        .code,
    ).toBe('unreadable_file');
  });
});
