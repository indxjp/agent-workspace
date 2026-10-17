import { describe, expect, it } from 'vitest';

import { assistantText, parseSseFrames, terminalStatus } from './stack-api.mjs';

/** A run's event stream as `apps/web/server/runs/sse.ts` writes it. */
const STREAM = [
  'retry: 2000',
  '',
  ': keep-alive',
  '',
  'event: run.status',
  'id: 1',
  'data: {"status":"running","error":null}',
  '',
  'event: agent.message',
  'id: 2',
  'data: {"frame":"agent.message","role":"user","messageId":"u1","blocks":[{"type":"text","text":"hi e2e-nonce-a"}]}',
  '',
  'event: agent.message',
  'id: 3',
  'data: {"frame":"agent.message","role":"assistant","messageId":"m1","blocks":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"Fake Anthropic reply."}]}',
  '',
  'event: run.status',
  'id: 4',
  'data: {"status":"completed","error":null}',
  '',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n');

describe('the generated-project E2E reads a run’s event stream', () => {
  it('splits frames and skips retry and comment lines', () => {
    expect(parseSseFrames(STREAM).map(({ event, id }) => [event, id])).toEqual([
      ['run.status', '1'],
      ['agent.message', '2'],
      ['agent.message', '3'],
      ['run.status', '4'],
      ['done', null],
    ]);
  });

  it('keeps only the assistant’s text blocks', () => {
    expect(assistantText(parseSseFrames(STREAM))).toBe('Fake Anthropic reply.');
  });

  it('reports the terminal status, including a run-failed frame', () => {
    expect(terminalStatus(parseSseFrames(STREAM))).toBe('completed');
    const failed = `${STREAM}event: run-failed\ndata: {"status":"failed","message":"x"}\n\n`;
    expect(terminalStatus(parseSseFrames(failed))).toBe('failed');
    expect(terminalStatus([])).toBeNull();
  });
});
