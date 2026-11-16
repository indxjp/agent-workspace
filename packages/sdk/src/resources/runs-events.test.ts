import { describe, expect, it } from 'vitest';

import { ContractViolationError, TransportError } from '../errors.js';
import { toAgentEvent } from '../events/agent-event.js';

import {
  drain,
  droppedEventStreamResponse as dropped,
  eventStreamResponse as stream,
  openEventStreamResponse as open,
} from '../testing.js';

import { RUN, client } from './runs.fixture.test-support.js';

describe('RunsClient.events', () => {
  it('classifies platform frames, passes runtime frames through, and ends on done', async () => {
    const { runs, calls } = client(() =>
      stream(
        'retry: 3000\n\n' +
          'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n' +
          'event: sdk-event\nid: 2\ndata: {"kind":"event","type":"assistant"}\n\n' +
          'event: run-failed\ndata: {"status":"failed","message":"The runtime exited."}\n\n' +
          'event: done\ndata: null\n\n',
      ),
    );
    const frames = [];
    const iterator = runs.events(RUN, { after: null });
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        expect(next.value).toEqual({ lastEventId: '2' });
        break;
      }
      frames.push(next.value);
    }
    expect(frames).toEqual([
      { kind: 'run-status', id: '1', data: { status: 'running', error: null } },
      { kind: 'runtime', id: '2', name: 'sdk-event', data: { kind: 'event', type: 'assistant' } },
      { kind: 'run-failed', data: { status: 'failed', message: 'The runtime exited.' } },
    ]);
    expect(calls[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(calls[0]?.headers.has('last-event-id')).toBe(false);
  });

  it('classifies run.warning before the first agent frame as a platform notice, never an agent event (ADR-0146)', async () => {
    const { runs } = client(() =>
      stream(
        'event: run.status\nid: 1\ndata: {"status":"running","error":null}\n\n' +
          'event: run.warning\nid: 2\ndata: {"code":"attachments_removed_shell"}\n\n' +
          'event: agent.message\nid: 3\ndata: {"frame":"agent.message","engine":"claude-agent-sdk","raw":null,"messageId":"m1","role":"assistant","blocks":[{"type":"text","text":"hi"}]}\n\n' +
          'event: done\ndata: null\n\n',
      ),
    );
    const frames = [];
    const iterator = runs.events(RUN);
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        expect(next.value).toEqual({ lastEventId: '3' });
        break;
      }
      frames.push(next.value);
    }
    expect(frames[1]).toEqual({
      kind: 'run-warning',
      id: '2',
      data: { code: 'attachments_removed_shell' },
    });
    expect(frames.map((frame) => toAgentEvent(frame)?.frame ?? null)).toEqual([
      null,
      null,
      'agent.message',
    ]);
  });

  it('refuses a run.warning without a code as a contract violation', async () => {
    const { runs } = client(() => stream('event: run.warning\nid: 1\ndata: {}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('sends Last-Event-ID when resuming', async () => {
    const { runs, calls } = client(() => stream('event: done\n\n'));
    await drain(runs.events(RUN, { after: '41' }));
    expect(calls[0]?.headers.get('last-event-id')).toBe('41');
  });

  it('refuses a malformed platform frame as a contract violation', async () => {
    const { runs } = client(() => stream('event: run.status\nid: 1\ndata: {"status":"lost"}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a stream that ends without done as a transport failure, not a success', async () => {
    const { runs } = client(() => stream('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n'));
    const failure = await drain(runs.events(RUN)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(false);
  });

  it('reports a body that errors mid-stream as a transport failure, not a raw TypeError', async () => {
    const { runs } = client(() => dropped('event: sdk-event\nid: 5\ndata: {"kind":"event"}\n\n'));
    const frames: string[] = [];
    const failure = await (async () => {
      for await (const frame of runs.events(RUN)) frames.push(frame.kind);
    })().catch((e: unknown) => e);
    expect(frames).toEqual(['runtime']);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(false);
    expect((failure as TransportError).cause).toBeInstanceOf(TypeError);
  });

  it('refuses a 200 that is not an event stream as a contract violation and releases the body', async () => {
    let cancelled = false;
    const html = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>oops</html>'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { runs } = client(
      () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const failure = await runs
      .events(RUN)
      .next()
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues[0]).toContain('text/html');
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the consumer stops iterating early', async () => {
    const body = open('event: sdk-event\nid: 1\ndata: {}\n\n');
    const { runs } = client(() => body.response);
    for await (const frame of runs.events(RUN)) {
      expect(frame.kind).toBe('runtime');
      break;
    }
    expect(body.cancelled()).toBe(true);
  });
});
