// A demo turn as its run's events arrive (spec "How Try it works"): a tool call shows when it
// starts and gets its output when it answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunEventFrame } from '@indx-workspace/sdk/events';

import { applyFrame, beginTurn } from '../app/agents/[slug]/try/transcript.ts';

const runtime = (name: string, data: object): RunEventFrame => ({
  kind: 'runtime',
  id: null,
  name,
  data: { frame: name, engine: 'claude-agent-sdk', raw: {}, ...data },
});

test('a tool call shows as it starts and fills its output when it answers', () => {
  const started = applyFrame(
    beginTurn('r1', 'hi'),
    runtime('agent.tool.call', {
      toolCallId: 't1',
      name: 'search_deals',
      kind: 'read',
      input: { q: 'acme' },
    }),
  );
  assert.equal(started.tools[0]?.output, null);
  const answered = applyFrame(
    started,
    runtime('agent.tool.result', {
      toolCallId: 't1',
      status: 'completed',
      output: '3 deals',
      isError: false,
    }),
  );
  assert.equal(answered.tools[0]?.output, '3 deals');
});
