import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { expect, it } from 'vitest';

import {
  ECHO_MCP_SERVER,
  drain,
  request,
  scriptedGateway,
  text,
  tool,
  workspace,
} from './boundary.test-support.js';
import { createMastraEngine } from './engine.js';

it('recalls the first run on a resume, from the platform store and nothing else', async () => {
  const cwd = workspace();
  const store = createFakeSessionStore('accept');
  scriptedGateway.script = [text('Noted: the code word is heron.')];
  const first = createMastraEngine().start(request(cwd, { prompt: 'The code word is heron.' }), {
    sessionStore: store,
  });
  await drain(first.frames);
  expect(first.sessionDurability()).toMatchObject({ durable: true });
  const threadId = await first.engineSessionId;

  scriptedGateway.script = [text('heron')];
  const second = createMastraEngine().start(
    request(cwd, {
      prompt: 'What was the code word?',
      session: { mode: 'resume', engineSessionId: threadId },
    }),
    { sessionStore: store },
  );
  await drain(second.frames);
  const history = JSON.stringify(
    (scriptedGateway.seen[1]?.body as { messages: unknown[] }).messages,
  );
  expect(history).toContain('The code word is heron.');
  expect(history).toContain('Noted: the code word is heron.');
  expect(history).toContain('What was the code word?');
  expect(store.appended().every((batch) => batch.key.sessionId === threadId)).toBe(true);
});

it('refuses to resume a thread the store does not hold, rather than starting afresh', async () => {
  const cwd = workspace();
  const connection = createMastraEngine().start(
    request(cwd, { session: { mode: 'resume', engineSessionId: 'never-written' } }),
    { sessionStore: createFakeSessionStore('accept') },
  );
  await expect(drain(connection.frames)).rejects.toThrow(/holds no Mastra thread/u);
  expect(scriptedGateway.seen).toEqual([]);
});

it('calls an assigned MCP connector tool, reported as kind mcp', async () => {
  const cwd = workspace();
  const server = path.join(cwd, 'echo-mcp.mjs');
  writeFileSync(server, ECHO_MCP_SERVER);
  chmodSync(server, 0o755);
  scriptedGateway.script = [tool('t1', 'docs_echo', { text: 'ping' }), text('done')];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          mcpServers: { docs: { command: process.execPath, args: [server] } },
        },
      }),
    ).frames,
  );
  expect(frames.find((frame) => frame.frame === 'agent.tool.call')).toMatchObject({
    name: 'docs_echo',
    kind: 'mcp',
  });
  expect(frames.find((frame) => frame.frame === 'agent.tool.result')).toMatchObject({
    isError: false,
    output: expect.stringContaining('echo: ping') as unknown,
  });
}, 30_000);

it('stops at maxTurns with max_turns, having sent no request past the limit', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'mastra_workspace_read_file', { path: 'a.md' }),
    text('never sent'),
  ];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: { ...base.portable, limits: { maxTurns: 1, maxBudgetUsd: null } },
      }),
    ).frames,
  );
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    stopReason: 'max_turns',
    turns: 1,
  });
  expect(scriptedGateway.seen).toHaveLength(1);
});

// ADR-0162 (#342): the spend ceiling is the gateway's, so a cap every step overspends stops
// nothing in the adapter: each scripted call is sent and the run ends on its own.
it('has no budget stop of its own: a spent cap runs on to end_turn', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'mastra_workspace_read_file', { path: 'a.md' }),
    tool('t2', 'mastra_workspace_read_file', { path: 'a.md' }),
    text('Done.'),
  ];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: { ...base.portable, limits: { maxTurns: null, maxBudgetUsd: 0.0001 } },
      }),
    ).frames,
  );
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  expect(scriptedGateway.seen).toHaveLength(3);
});
