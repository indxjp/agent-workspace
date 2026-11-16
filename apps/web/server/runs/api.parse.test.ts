import { afterEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { parseStartRunBody, readRun, startRun, streamRunEvents } from './api';
import { AGENT, errorCode, get, post, SESSION } from './api.test-support';
import { MAX_PROMPT_CHARS } from './service';

afterEach(() => {
  resetTestRunApi();
});

describe('parseStartRunBody', () => {
  it('accepts a prompt on its own', () => {
    expect(parseStartRunBody({ prompt: 'hello' })).toEqual({
      kind: 'ok',
      body: { prompt: 'hello', sessionId: null, modelOverride: null },
    });
  });

  it('accepts an explicit null sessionId as "start a new session"', () => {
    expect(parseStartRunBody({ prompt: 'hello', sessionId: null })).toEqual({
      kind: 'ok',
      body: { prompt: 'hello', sessionId: null, modelOverride: null },
    });
  });

  it('accepts a per-run model connection paired with a model, without changing the agent route', () => {
    expect(
      parseStartRunBody({ prompt: 'hello', modelConnectionId: AGENT, model: 'claude-opus-4-5' }),
    ).toEqual({
      kind: 'ok',
      body: {
        prompt: 'hello',
        sessionId: null,
        modelOverride: { connectionId: AGENT, model: 'claude-opus-4-5' },
      },
    });
    expect(
      parseStartRunBody({
        prompt: 'hello',
        modelConnectionId: 'not-a-uuid',
        model: 'claude-opus-4-5',
      }).kind,
    ).toBe('rejected');
  });

  // issue #129: no layer of the resolution ladder may mix a connection from one level with a
  // model from another — the run override, being the top of that ladder, is no exception.
  it('rejects a connection without a model, and a model without a connection', () => {
    expect(parseStartRunBody({ prompt: 'hello', modelConnectionId: AGENT }).kind).toBe('rejected');
    expect(parseStartRunBody({ prompt: 'hello', model: 'claude-opus-4-5' }).kind).toBe('rejected');
  });

  it('rejects an unknown field rather than silently ignoring a caller instruction', () => {
    const verdict = parseStartRunBody({ prompt: 'hi', temperature: 0.5 });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind !== 'rejected') return;
    expect(verdict.reason).toContain('temperature');
  });

  it('rejects "limits": a run limit is set by a trusted in-process caller, never by a request', () => {
    for (const limits of [{ maxBudgetUsd: 0.01 }, { maxTurns: 1 }, {}, null]) {
      expect(parseStartRunBody({ prompt: 'hi', limits }).kind, JSON.stringify(limits)).toBe(
        'rejected',
      );
    }
  });
});

describe('parseStartRunBody', () => {
  it('accepts a "subject" of 1 to 256 characters and rejects any other (ADR-0142 D2)', () => {
    expect(parseStartRunBody({ prompt: 'hi', subject: 'user-1' })).toMatchObject({
      kind: 'ok',
      body: { subject: 'user-1' },
    });
    expect(parseStartRunBody({ prompt: 'hi', subject: 'a'.repeat(256) }).kind).toBe('ok');
    for (const subject of ['', 'a'.repeat(257), 7, null]) {
      expect(parseStartRunBody({ prompt: 'hi', subject }).kind, String(subject)).toBe('rejected');
    }
  });

  it('accepts a canonical "fileScope" of 1 to 100 distinct paths and rejects any other (issue #1539)', () => {
    expect(parseStartRunBody({ prompt: 'hi', fileScope: ['docs/alice'] })).toMatchObject({
      kind: 'ok',
      body: { fileScope: ['docs/alice'] },
    });
    const many = Array.from({ length: 100 }, (_, index) => `docs/${String(index)}`);
    expect(parseStartRunBody({ prompt: 'hi', fileScope: many }).kind).toBe('ok');
    const bad = [
      [],
      [...many, 'docs/x'],
      ['a', 'a'],
      ['/a'],
      ['a/'],
      ['a/../b'],
      ['a//b'],
      [''],
      [7],
      'a',
      null,
    ];
    for (const fileScope of bad) {
      expect(parseStartRunBody({ prompt: 'hi', fileScope }).kind, JSON.stringify(fileScope)).toBe(
        'rejected',
      );
    }
  });

  it('rejects a non-object, a missing prompt, an empty prompt and a non-string prompt', () => {
    for (const bad of [null, [], 'hi', 42, {}, { prompt: '' }, { prompt: '   ' }, { prompt: 7 }]) {
      expect(parseStartRunBody(bad).kind, JSON.stringify(bad)).toBe('rejected');
    }
  });

  it('rejects a prompt over the documented cap and accepts one exactly at it', () => {
    expect(parseStartRunBody({ prompt: 'a'.repeat(MAX_PROMPT_CHARS) }).kind).toBe('ok');
    expect(parseStartRunBody({ prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) }).kind).toBe('rejected');
  });

  it('rejects a sessionId that is not a UUID', () => {
    expect(parseStartRunBody({ prompt: 'hi', sessionId: 'not-a-uuid' }).kind).toBe('rejected');
  });
});

describe('parseStartRunBody > outputSchema (ADR-0143)', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

  it('carries a valid schema through, for a new session and for a follow-up', () => {
    expect(parseStartRunBody({ prompt: 'hi', outputSchema: schema })).toEqual({
      kind: 'ok',
      body: { prompt: 'hi', sessionId: null, modelOverride: null, outputSchema: schema },
    });
    const followUp = parseStartRunBody({
      prompt: 'hi',
      sessionId: SESSION,
      outputSchema: schema,
    });
    expect(followUp.kind === 'ok' && followUp.body.outputSchema).toEqual(schema);
  });

  it.each([
    ['root_type', { type: 'string' }],
    ['size', { type: 'object', description: 'x'.repeat(40_000) }],
    ['dialect', { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }],
    ['ref', { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }],
    [
      'depth',
      {
        type: 'object',
        properties: {
          a: Array.from({ length: 20 }).reduce<object>((inner) => ({ items: inner }), {}),
        },
      },
    ],
  ])('rejects a schema over the %s limit, naming the limit', (limit, outputSchema) => {
    const verdict = parseStartRunBody({ prompt: 'hi', outputSchema });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind !== 'rejected') return;
    expect(verdict.reason).toContain(limit);
  });

  it('rejects an outputSchema that is not an object', () => {
    for (const bad of [null, [], 'object', 7]) {
      expect(parseStartRunBody({ prompt: 'hi', outputSchema: bad }).kind).toBe('rejected');
    }
  });
});

describe('with no environment installed', () => {
  it('answers 503 and names what is missing, on all three routes', async () => {
    resetTestRunApi();
    const started = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(started.status).toBe(503);
    expect(await errorCode(started)).toBe('run_api_not_configured');

    const read = await readRun(get('http://web/api/runs/x'), SESSION);
    expect(read.status).toBe(503);

    const streamed = await streamRunEvents(get('http://web/api/runs/x/events'), SESSION);
    expect(streamed.status).toBe(503);
    // Not 200-with-an-empty-stream: an unconfigured server must not look like a run with no
    // output, and not 401 either, which would promise that credentials could fix it.
    expect(streamed.headers.get('content-type')).toContain('application/json');
  });
});
