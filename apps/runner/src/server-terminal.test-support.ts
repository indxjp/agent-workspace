import { describe, expect, it } from 'vitest';
import {
  fakeCleanlyCancellingConnection,
  fakeConnection,
  runOnce,
  runThenInterrupt,
} from './server-fixture.test-support.js';

export function registerTerminalFramesTests(): void {
  describe('the terminal frame createRunnerServer sends at the end of every run', () => {
    it('is named `run-done` on success — not `done`, which the control plane reserves', async () => {
      const { names, body } = await runOnce(
        fakeConnection([{ kind: 'malformed', reason: 'fixture event', event: {} }]),
      );
      expect(names).toEqual(['agent.malformed', 'run-done']);
      expect(names).not.toContain('done');
      // The summary object is still there for a direct §14.3 consumer to read.
      expect(body).toContain('"runId":"11111111-1111-4111-8111-111111111111"');
    });

    it('is named `run-error` on failure — not `run-failed`, which the control plane reserves', async () => {
      const { names, body } = await runOnce(fakeConnection([], { fails: true }));
      expect(names).toEqual(['run-error']);
      expect(names).not.toContain('run-failed');
      expect(body).toContain('the fixture SDK run failed');
    });

    // W1-RN-03: `run.interrupted` must be decided FIRST and unconditionally (ADR-0015) — from the
    // positive fact the run already holds — not nested under `failure === null ? … : …`, which only
    // reaches the interrupted check when the connection also threw. This reproduces the reviewer's
    // finding directly: an `AgentConnection` whose `events` iterable ends cleanly (no throw) on
    // cancel is a conformant shape per `packages/runtime/src/driver.ts`, and must still be reported
    // `run-interrupted`, not `run-done`.
    it(
      'is named `run-interrupted` — not `run-done` — for a run whose events end cleanly ' +
        '(no throw) after POST /interrupt',
      async () => {
        const { names, body } = await runThenInterrupt(fakeCleanlyCancellingConnection());
        expect(names).toEqual(['agent.malformed', 'run-interrupted']);
        expect(names).not.toContain('run-done');
        expect(body).toContain('"interrupted":true');
      },
    );
  });

  describe('a run that stopped for want of approval (ADR-0145 D5)', () => {
    const asked = {
      toolName: 'Write',
      toolUseId: 'toolu_9',
      canonicalCall: '{"input":{"path":"SECRET-ARGUMENT"},"name":"Write"}',
    };

    it('ends as run-error carrying awaiting_approval and the call, with a message that omits its arguments', async () => {
      const { names, body } = await runOnce({
        ...fakeConnection([]),
        approvalRequest: () => asked,
      });
      expect(names.at(-1)).toBe('run-error');
      const data = body.split('event: run-error')[1] ?? '';
      const frame = JSON.parse(data.slice(data.indexOf('data: ') + 6).split('\n')[0] ?? '{}') as {
        code: string;
        outcome: string;
        message: string;
        approvalRequest: unknown;
      };
      expect(frame).toMatchObject({
        code: 'awaiting_approval',
        outcome: 'awaiting_approval',
        approvalRequest: asked,
      });
      expect(frame.message).toMatch(/^awaiting_approval: /u);
      expect(frame.message).not.toContain('SECRET-ARGUMENT');
    });

    it('is still run-done when the connection reports no request', async () => {
      const { names } = await runOnce({ ...fakeConnection([]), approvalRequest: () => null });
      expect(names.at(-1)).toBe('run-done');
    });

    it('is still run-error without the approval code when the stream also failed', async () => {
      const { names, body } = await runOnce({
        ...fakeConnection([], { fails: true }),
        approvalRequest: () => asked,
      });
      expect(names.at(-1)).toBe('run-error');
      expect(body).not.toContain('awaiting_approval');
    });

    it('is still run-interrupted when the run was interrupted (W1-RN-03)', async () => {
      const { names, body } = await runThenInterrupt({
        ...fakeCleanlyCancellingConnection(),
        approvalRequest: () => asked,
      });
      expect(names.at(-1)).toBe('run-interrupted');
      expect(body).not.toContain('awaiting_approval');
    });
  });
}
