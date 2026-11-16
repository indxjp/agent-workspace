import { A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it } from 'vitest';
import { serveA2aRpc } from './dispatch';
import {
  OTHER_AGENT,
  SECRET,
  URL_BASE,
  state,
  body,
  frames,
} from './dispatch.fixture.test-support';
export function registerA2aStreamTests() {
  describe('message/stream', () => {
    it('streams the task, the working status, the answer and a final completed status', async () => {
      state.scenario = { chunks: ['one', 'two'], outcome: 'completed' };
      const request = new Request(`${URL_BASE}/support-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-identity': 'owner',
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-9',
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'go' }],
            },
          },
        }),
      });
      const response = await serveA2aRpc(request, 'support-bot');
      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      const sent = await frames(response);
      expect(sent.map((f) => f.result?.['kind'])).toEqual([
        'task',
        'status-update',
        'artifact-update',
        'artifact-update',
        'status-update',
      ]);
      const [, working, first, second, last] = sent.map((f) => f.result);
      expect((working?.['status'] as { state: string }).state).toBe('working');
      expect(first?.['append']).toBe(false);
      expect(second?.['append']).toBe(true);
      expect((second?.['artifact'] as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
        '\n\ntwo',
      );
      expect(last?.['final']).toBe(true);
      expect((last?.['status'] as { state: string }).state).toBe('completed');
    });

    it('ends a failed run with a final failed status carrying the run error', async () => {
      state.scenario = { chunks: [], outcome: 'failed' };
      const request = new Request(`${URL_BASE}/support-bot`, {
        method: 'POST',
        headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'go' }],
            },
          },
        }),
      });
      const sent = await frames(await serveA2aRpc(request, 'support-bot'));
      const last = sent[sent.length - 1]?.result;
      expect(last?.['final']).toBe(true);
      expect(
        (last?.['status'] as { state: string; message: { parts: Array<{ text: string }> } }).state,
      ).toBe('failed');
    });

    it('stops following when the client aborts, leaving the run running and uninterrupted', async () => {
      state.scenario = { chunks: ['partial'], outcome: 'hang' };
      const client = new AbortController();
      const request = new Request(`${URL_BASE}/support-bot`, {
        method: 'POST',
        headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
        signal: client.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'go' }],
            },
          },
        }),
      });
      const response = await serveA2aRpc(request, 'support-bot');
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('no stream body');
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('artifact-update')) {
        const next = await reader.read();
        if (next.done) throw new Error('the stream ended before the answer');
        text += decoder.decode(next.value);
      }
      client.abort();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value);
      }
      const runId = state.launched[0]?.run.id ?? '';
      expect((await state.store.get(runId))?.status).toBe('running');
      expect(state.interrupted).toEqual([]);
      expect(text).not.toContain('"final":true');
    });

    it('answers a refused start as an ordinary JSON-RPC error, not a stream', async () => {
      const request = new Request(`${URL_BASE}/support-bot`, {
        method: 'POST',
        headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'm',
              role: 'user',
              parts: [{ kind: 'text', text: 'go' }],
              contextId: OTHER_AGENT,
            },
          },
        }),
      });
      const response = await serveA2aRpc(request, 'support-bot');
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.invalid_params);
    });
  });
}
