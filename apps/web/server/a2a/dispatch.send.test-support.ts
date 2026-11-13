import { A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it } from 'vitest';
import { getRunApi } from '../runs/environment';
import { serveA2aRpc } from './dispatch';
import { installTestRunApi } from '../application-context-fixtures';
import { handleV03, type A2aCall } from './v0_3/rpc';
import {
  WORKSPACE,
  AGENT,
  OTHER_AGENT,
  SESSION,
  PRODUCTION_VERSION,
  KEY_ID,
  principal,
  state,
  rpc,
  send,
  body,
  task,
} from './dispatch.fixture.test-support';
export function registerA2aSendTests() {
  describe('message/send', () => {
    it('runs the production version, waits for the answer and returns the completed task', async () => {
      const response = await serveA2aRpc(send('What is 2+2?'), 'support-bot');
      const result = await task(response);
      expect(result.status.state).toBe('completed');
      expect(result.contextId).toBe(SESSION);
      expect(result.artifacts?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
      expect(result.history).toBeUndefined();
      expect(state.launched).toHaveLength(1);
      expect(state.launched[0]?.prompt).toBe('What is 2+2?');
      expect(state.openedVersions).toEqual([PRODUCTION_VERSION]);
    });

    it('joins several text parts and several messages in order', async () => {
      state.scenario = { chunks: ['first', 'second'], outcome: 'completed' };
      const response = await serveA2aRpc(
        rpc('message/send', {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [
              { kind: 'text', text: 'a' },
              { kind: 'text', text: 'b' },
            ],
          },
        }),
        'support-bot',
      );
      const result = await task(response);
      expect(state.launched[0]?.prompt).toBe('a\n\nb');
      expect(result.artifacts?.[0]?.parts[0]?.text).toBe('first\n\nsecond');
    });

    it('returns the submitted task at once when the client asks not to block', async () => {
      const result = await task(
        await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot'),
      );
      expect(result.status.state).toBe('submitted');
      expect(result.artifacts).toBeUndefined();
    });

    it('returns the answer as history only when the client asks for it', async () => {
      const result = await task(
        await serveA2aRpc(send('hi', {}, { historyLength: 1 }), 'support-bot'),
      );
      expect(result.history?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
    });

    it('answers a refused run start -32603 with its code and opens no session', async () => {
      const runs = getRunApi();
      if (runs === null) throw new Error('run API not installed');
      installTestRunApi({
        ...runs,
        preflight: () =>
          Promise.resolve({
            code: 'agent_runtime_profile_missing',
            message: 'the agent has no runtime profile',
          }),
      });
      const answer = await body(await serveA2aRpc(send('hi'), 'support-bot'));
      expect(answer.error?.code).toBe(A2A_ERROR_CODES.internal_error);
      expect(answer.error?.data).toEqual({ code: 'agent_runtime_profile_missing' });
      expect(state.openedVersions).toEqual([]);
      expect(state.launched).toHaveLength(0);
    });

    it('reports a failed run as a failed task carrying the run error, not a JSON-RPC error', async () => {
      state.scenario = { chunks: [], outcome: 'failed' };
      const result = await task(await serveA2aRpc(send('hi'), 'support-bot'));
      expect(result.status.state).toBe('failed');
      expect(result.status.message?.parts[0]?.text).toBe('the engine stopped');
    });

    it('continues a conversation named by contextId and answers every unusable one the same', async () => {
      const ok = await task(
        await serveA2aRpc(
          send('again', { contextId: SESSION }, { blocking: false }),
          'support-bot',
        ),
      );
      expect(ok.contextId).toBe(SESSION);
      const unknown = await serveA2aRpc(
        send('x', { contextId: OTHER_AGENT }, { blocking: false }),
        'support-bot',
      );
      const malformed = await serveA2aRpc(
        send('x', { contextId: 'not-a-uuid' }, { blocking: false }),
        'support-bot',
      );
      const first = await body(unknown);
      const second = await body(malformed);
      expect(first.error).toEqual({
        code: A2A_ERROR_CODES.invalid_params,
        message: 'unknown contextId',
      });
      expect(second.error).toEqual(first.error);
    });

    it('stops waiting after the blocking window and returns the task as it stands', async () => {
      state.scenario = { chunks: [], outcome: 'hang' };
      const request = send('hi');
      const runs = getRunApi();
      if (runs === null) throw new Error('run API not installed');
      const call: A2aCall = {
        request,
        runs,
        principal: principal(),
        credentialId: KEY_ID,
        agent: {
          agentId: AGENT,
          name: 'support-bot',
          productionVersionId: PRODUCTION_VERSION,
          versionNumber: 7,
        },
        agentRef: { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
        now: () => Date.now(),
        blockingWaitMs: 30,
      };
      const response = await handleV03(call, await request.text());
      const result = await task(response);
      expect(['submitted', 'working']).toContain(result.status.state);
    });
  });
}
