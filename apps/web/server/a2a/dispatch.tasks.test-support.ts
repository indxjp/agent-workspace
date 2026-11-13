import { A2A_ERROR_CODES } from '@indx-workspace/contracts/a2a';
import { describe, expect, it, vi } from 'vitest';
import { serveA2aRpc } from './dispatch';
import {
  WORKSPACE,
  OTHER_WORKSPACE,
  AGENT,
  OTHER_AGENT,
  SESSION,
  state,
  rpc,
  send,
  body,
  task,
} from './dispatch.fixture.test-support';
export function registerA2aTasksTests() {
  describe('tasks/get and tasks/cancel', () => {
    async function started(): Promise<string> {
      return (await task(await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot'))).id;
    }

    it('returns a finished task with its answer', async () => {
      const id = await started();
      await vi.waitFor(async () => {
        expect((await state.store.get(id))?.status).toBe('completed');
      });
      const result = await task(await serveA2aRpc(rpc('tasks/get', { id }), 'support-bot'));
      expect(result.status.state).toBe('completed');
      expect(result.artifacts?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
    });

    it('answers -32001 identically for a malformed, unknown, foreign-tenant, other-owner and other-agent task', async () => {
      const id = await started();
      state.foreignRuns.add(id);
      const elsewhere = await state.store.create({
        id: crypto.randomUUID(),
        workspaceId: OTHER_WORKSPACE,
        agentId: AGENT,
        sessionId: SESSION,
        engine: 'claude-agent-sdk',
      });
      const otherAgent = await state.store.create({
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE,
        agentId: OTHER_AGENT,
        sessionId: SESSION,
        engine: 'claude-agent-sdk',
      });
      const errors: unknown[] = [];
      for (const target of ['nope', crypto.randomUUID(), elsewhere.id, id, otherAgent.id]) {
        for (const method of ['tasks/get', 'tasks/cancel']) {
          const answer = await body(await serveA2aRpc(rpc(method, { id: target }), 'support-bot'));
          errors.push(answer.error);
        }
      }
      expect(errors).toHaveLength(10);
      for (const error of errors) {
        expect(error).toEqual({ code: A2A_ERROR_CODES.task_not_found, message: 'task not found' });
      }
    });

    it('cancels a live task and reports it canceled', async () => {
      state.scenario = { chunks: [], outcome: 'hang' };
      const id = await started();
      const result = await task(await serveA2aRpc(rpc('tasks/cancel', { id }), 'support-bot'));
      expect(result.status.state).toBe('canceled');
      expect((await state.store.get(id))?.status).toBe('cancelled');
    });

    it('answers -32002 for a task that has already finished', async () => {
      const id = await started();
      await vi.waitFor(async () => {
        expect((await state.store.get(id))?.status).toBe('completed');
      });
      const answer = await body(await serveA2aRpc(rpc('tasks/cancel', { id }), 'support-bot'));
      expect(answer.error?.code).toBe(A2A_ERROR_CODES.task_not_cancelable);
    });
  });
}
