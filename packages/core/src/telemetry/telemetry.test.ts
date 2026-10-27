import { describe, expect, it } from 'vitest';

import { createJsonLogger, parseTraceparent, traceHeaders, type LogLevel } from './index.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('reads a valid version-00 header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentId: PARENT_ID,
      flags: '01',
    });
  });

  it('accepts trailing fields only from a future version', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-extra`)?.traceId).toBe(TRACE_ID);
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01-extra`)).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['uppercase hex', `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`],
    ['version ff', `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT_ID}-01`],
    ['all-zero parent id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`],
    ['injected newline', `00-${TRACE_ID}-${PARENT_ID}-01\n{"level":"error"}`],
    ['oversized', `01-${TRACE_ID}-${PARENT_ID}-01-${'a'.repeat(600)}`],
  ])('refuses %s', (_name, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe('traceHeaders', () => {
  const header = `00-${TRACE_ID}-${PARENT_ID}-01`;

  it('forwards a valid traceparent with its tracestate', () => {
    expect(traceHeaders(header, 'vendor=abc')).toEqual({
      traceparent: header,
      tracestate: 'vendor=abc',
    });
  });

  it('rebuilds a future-version header as version 00 without its trailing fields', () => {
    expect(traceHeaders(`01-${TRACE_ID}-${PARENT_ID}-01-extra`)).toEqual({ traceparent: header });
  });

  it.each([
    ['newline', 'vendor=abc\ninjected: 1'],
    ['oversized', `vendor=${'a'.repeat(600)}`],
    ['empty', ''],
  ])('drops a %s tracestate', (_name, tracestate) => {
    expect(traceHeaders(header, tracestate)).toEqual({ traceparent: header });
  });

  it('forwards nothing, not even tracestate, for an invalid traceparent', () => {
    expect(traceHeaders('not-a-traceparent', 'vendor=abc')).toEqual({});
  });
});

function capture(): {
  lines: { level: LogLevel; record: Record<string, unknown> }[];
  write: (level: LogLevel, line: string) => void;
} {
  const lines: { level: LogLevel; record: Record<string, unknown> }[] = [];
  return {
    lines,
    write: (level, line) => {
      expect(line).not.toContain('\n');
      lines.push({ level, record: JSON.parse(line) as Record<string, unknown> });
    },
  };
}

describe('createJsonLogger', () => {
  const now = (): Date => new Date('2026-10-18T00:00:00.000Z');

  it('writes one JSON line with the fixed fields first and bound fields from child()', () => {
    const sink = capture();
    const logger = createJsonLogger({ service: 'runner', write: sink.write, now }).child({
      runId: 'run-1',
      traceId: TRACE_ID,
    });
    logger.warn('run admitted', { attempt: 2, ok: true });
    expect(sink.lines).toEqual([
      {
        level: 'warn',
        record: {
          time: '2026-10-18T00:00:00.000Z',
          level: 'warn',
          service: 'runner',
          msg: 'run admitted',
          runId: 'run-1',
          traceId: TRACE_ID,
          attempt: 2,
          ok: true,
        },
      },
    ]);
    expect(Object.keys(sink.lines[0]?.record ?? {}).slice(0, 4)).toEqual([
      'time',
      'level',
      'service',
      'msg',
    ]);
  });

  it('redacts tokens and URLs in fields and errors, and a field cannot spoof the level', () => {
    const sink = capture();
    const token = 'sk-ant-' + 'x'.repeat(40);
    createJsonLogger({ service: 'web', write: sink.write, now }).error('failed', {
      level: 'info',
      detail: { header: `Bearer ${token}` },
      error: new Error(`POST https://user:pw@example.test/v1 failed with ${token}`, {
        cause: new TypeError(token),
      }),
    });
    const [line] = sink.lines;
    expect(line?.level).toBe('error');
    expect(line?.record['level']).toBe('error');
    const text = JSON.stringify(line?.record);
    expect(text).not.toContain(token);
    expect(text).not.toContain('example.test');
    expect(line?.record['error']).toEqual({
      name: 'Error',
      message: 'POST [url] failed with [redacted]',
      cause: { name: 'TypeError', message: '[redacted]' },
    });
  });

  it('masks a traceId field that is not a trace id', () => {
    const sink = capture();
    createJsonLogger({ service: 'web', write: sink.write, now }).info('x', {
      traceId: 'A'.repeat(40),
    });
    expect(sink.lines[0]?.record['traceId']).toBe('[redacted]');
  });

  it('survives a sink that throws', () => {
    const logger = createJsonLogger({
      service: 'web',
      write: () => {
        throw new Error('stdout closed');
      },
    });
    expect(() => {
      logger.error('x');
    }).not.toThrow();
  });
});
