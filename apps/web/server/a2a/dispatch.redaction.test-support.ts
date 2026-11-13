import { captureLog } from '../telemetry/capture-log';
import { A2aJsonRpcResponseSchema, A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it } from 'vitest';
import { serveA2aRpc } from './dispatch';
import { SECRET, state, rpc, send } from './dispatch.fixture.test-support';
export function registerA2aRedactionTests() {
  describe('what the endpoint never says', () => {
    it('turns an infrastructure failure into -32603 with a fixed message and logs no credential', async () => {
      const logged = captureLog();
      state.openSessionFails = true;
      const response = await serveA2aRpc(send('hi'), 'support-bot');
      const text = await response.text();
      expect(response.status).toBe(200);
      const failure = A2aJsonRpcResponseSchema.parse(JSON.parse(text));
      expect('error' in failure && failure.error.code).toBe(A2A_ERROR_CODES.internal_error);
      expect('error' in failure && failure.error.message).toBe(
        'The agent endpoint could not complete the request.',
      );
      for (const output of [text, logged.text()]) {
        expect(output).not.toContain('hunter2');
        expect(output).not.toContain('postgres://');
        expect(output).not.toContain(SECRET);
      }
    });

    it('never echoes the bearer secret in any refusal', async () => {
      const outputs: string[] = [];
      for (const request of [
        rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
        rpc('tasks/get', { id: 'x' }, { identity: 'session' }),
        rpc('tasks/get', { id: 'x' }, { agent: 'missing' }),
        rpc('tasks/get', { id: 'x' }, { headers: { 'A2A-Version': '9' } }),
        rpc('nope', {}),
      ]) {
        outputs.push(await (await serveA2aRpc(request, 'support-bot')).text());
      }
      for (const output of outputs) expect(output).not.toContain(SECRET);
    });
  });
}
