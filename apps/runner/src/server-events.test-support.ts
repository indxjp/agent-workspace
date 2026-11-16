import { type ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { describe, expect, it } from 'vitest';
import { fakeConnection, runOnce } from './server-fixture.test-support.js';

export function registerEventVocabularyTests(): void {
  /**
   * ENG-03 (#302): the runner streams one engine-neutral vocabulary.
   *
   * What is asserted is the *acceptance criterion* rather than the mapping — the mapping's own cases
   * live with it in `packages/core/src/agent-frames.test.ts`. Here: only `agent.*` names reach the
   * wire, none of the pre-ENG-03 relayed names does, one SDK message may become several frames, and
   * every frame gets its own monotonic `id` so a resume cursor can name any of them.
   */
  describe('the event vocabulary createRunnerServer streams', () => {
    const assistantWithTwoTools: ClassifiedSdkEvent = {
      kind: 'event',
      type: 'assistant',
      event: {
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/a' } },
            { type: 'tool_use', id: 'tool_2', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    };

    it('names every relayed frame `agent.*`, and none of the pre-ENG-03 names', async () => {
      const { names, body } = await runOnce(
        fakeConnection([
          {
            kind: 'system',
            subtype: 'init',
            event: { type: 'system', subtype: 'init', session_id: 's1' },
          },
          assistantWithTwoTools,
          {
            kind: 'result',
            subtype: 'success',
            carriesUsage: true,
            event: { type: 'result', subtype: 'success' },
          },
        ]),
      );
      expect(names).toEqual([
        'agent.session',
        'agent.message',
        'agent.tool.call',
        'agent.tool.call',
        'agent.result',
        'run-done',
      ]);
      // Stated as the grammar rather than as a list of the old names: every relayed frame is an
      // `agent.*` one, so no pre-ENG-03 name can reach the wire and nor can a future one nobody chose.
      for (const name of names.slice(0, -1)) expect(name).toMatch(/^agent\.[a-z.]+$/);
      // The neutral fields are on the wire, and the engine-native message travels with them.
      expect(body).toContain('"engineSessionId":"s1"');
      expect(body).toContain('"engine":"claude-agent-sdk"');
      expect(body).toContain('"raw":');
    });

    it('gives each frame of a multi-frame message its own monotonic id', async () => {
      const { body } = await runOnce(fakeConnection([assistantWithTwoTools]));
      const ids = [...body.matchAll(/^id: (.+)$/gm)].map((m) => Number(m[1] ?? ''));
      // Three frames from one message, then the terminal frame: ids are per frame, because `id` is
      // the resume cursor and a cursor naming a message could not resume in the middle of one.
      expect(ids).toEqual([1, 2, 3, 4]);
    });

    it('reports how many frames it wrote, which is what this server can honestly count', async () => {
      // Before ENG-04 this counted engine *messages*, because the one-to-many mapping happened in
      // this server. It happens in the adapter now, so one assistant turn with two tool calls
      // arrives here as three frames and is reported as three.
      const { body } = await runOnce(fakeConnection([assistantWithTwoTools]));
      expect(body).toContain('"events":3');
    });
  });
}
