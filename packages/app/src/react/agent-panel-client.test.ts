import type { RunEventFrame } from '@indx-workspace/sdk/events';
import {
  eventStreamResponse,
  fetchDouble,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import { agentPanelClient } from './agent-panel-client.js';
import { MAX_RECONNECTS } from './agent-panel-model.js';
import { ResourceProblemError } from './client.js';

const ID = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const RUN = '33333333-3333-4333-8333-333333333333';
const PANEL = `/api/agent-panel/ticket/${ID}/runs`;
const run = { id: RUN, status: 'queued', pendingApproval: null, error: null };

const STATUS = (id: string) =>
  `event: run.status\nid: ${id}\ndata: {"status":"running","error":null}\n\n`;
const LOST =
  'event: run-failed\ndata: {"status":"unknown","message":"The event stream ended unexpectedly."}\n\n';
const DONE = 'event: done\ndata: {}\n\n';

async function followAll(
  streams: readonly (string | Response)[],
): Promise<{ frames: RunEventFrame[]; calls: RecordedRequest[]; error: unknown }> {
  let at = 0;
  const double = fetchDouble(() => {
    const next = streams[Math.min(at, streams.length - 1)] ?? DONE;
    at += 1;
    return typeof next === 'string' ? eventStreamResponse(next) : next;
  });
  const client = agentPanelClient('ticket', ID, {
    fetch: double.fetch,
    baseUrl: 'https://app.test',
    reconnectDelayMs: 0,
  });
  const frames: RunEventFrame[] = [];
  let error: unknown = null;
  await client
    .follow(RUN, {
      after: '4',
      signal: new AbortController().signal,
      onFrame: (f) => frames.push(f),
    })
    .catch((caught: unknown) => {
      error = caught;
    });
  return { frames, calls: double.calls, error };
}

describe('agentPanelClient', () => {
  it('posts a start and parses the answer; a refusal is a ResourceProblemError by its code', async () => {
    const double = fetchDouble((request) =>
      request.json !== undefined && (request.json as { prompt: string }).prompt === 'busy'
        ? jsonResponse(409, { error: { code: 'session_busy', message: 'still working' } })
        : jsonResponse(202, { run, events: `${PANEL}/${RUN}/events` }),
    );
    const client = agentPanelClient('ticket', ID, {
      fetch: double.fetch,
      baseUrl: 'https://app.test/',
    });
    const started = await client.start('triage', 'classify');
    expect(started.run.id).toBe(RUN);
    expect(double.calls[0]?.url.href).toBe(`https://app.test${PANEL}`);
    expect(double.calls[0]?.json).toEqual({ agent: 'triage', prompt: 'classify' });
    const refused = await client.start('triage', 'busy').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResourceProblemError);
    expect((refused as ResourceProblemError).code).toBe('session_busy');
  });

  it('decides with or without a comment, and reads a run', async () => {
    const double = fetchDouble((request) =>
      request.method === 'GET'
        ? jsonResponse(200, { run: { ...run, status: 'completed' } })
        : jsonResponse(202, { run, events: 'x' }),
    );
    const client = agentPanelClient('ticket', ID, {
      fetch: double.fetch,
      baseUrl: 'https://app.test',
    });
    await client.decide(RUN, 'approve', undefined);
    await client.decide(RUN, 'reject', 'not Net');
    expect(double.calls.map((call) => call.json)).toEqual([
      { decision: 'approve' },
      { decision: 'reject', comment: 'not Net' },
    ]);
    expect(double.calls[0]?.url.pathname).toBe(`${PANEL}/${RUN}/approval`);
    expect((await client.get(RUN)).status).toBe('completed');
  });

  it('follows to done, sending Last-Event-ID, and reconnects from the last id after a drop', async () => {
    const { frames, calls, error } = await followAll([STATUS('5') + LOST, STATUS('6') + DONE]);
    expect(error).toBeNull();
    expect(calls.map((call) => call.headers.get('last-event-id'))).toEqual(['4', '5']);
    // The route's "connection broke" frame is held back: the run did not fail.
    expect(frames.map((frame) => frame.kind)).toEqual(['run-status', 'run-status']);
  });

  it(`gives up with stream_lost after ${String(MAX_RECONNECTS)} reconnects that deliver nothing`, async () => {
    const { frames, calls, error } = await followAll([LOST]);
    expect(calls).toHaveLength(MAX_RECONNECTS + 1);
    expect((error as ResourceProblemError).code).toBe('stream_lost');
    expect(frames.map((frame) => frame.kind)).toEqual(['run-failed']);
  });

  it('stops on a refusal of the events route, by its code', async () => {
    const { error } = await followAll([
      jsonResponse(404, { error: { code: 'run_not_found', message: 'No such run.' } }),
    ]);
    expect((error as ResourceProblemError).code).toBe('run_not_found');
  });
});
