import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { expect, it } from 'vitest';

import {
  RESEARCHER,
  drain,
  request,
  scriptedGateway,
  text,
  tool,
  workspace,
} from './boundary.test-support.js';
import { createMastraEngine } from './engine.js';

it('delegates to a subagent that holds its own narrower tool set and its own instructions', async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'agent-researcher', { prompt: 'Read a.md and report.' }),
    text('Found: hello doc.'),
    text('Done.'),
  ];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          subagents: [
            {
              name: 'researcher',
              description: 'Reads files and reports.',
              instructions: 'You only research.',
              model: null,
              permissions: {
                readFiles: true,
                writeFiles: false,
                runCommands: false,
                unrestrictedNetwork: false,
              },
            },
          ],
        },
      }),
    ).frames,
  );
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  expect(scriptedGateway.seen).toHaveLength(3);
  const toolsOf = (index: number): string[] =>
    (scriptedGateway.seen[index]?.body as { tools?: { name: string }[] }).tools?.map(
      (entry) => entry.name,
    ) ?? [];
  expect(toolsOf(0)).toEqual(
    expect.arrayContaining(['agent-researcher', 'mastra_workspace_execute_command']),
  );
  expect(toolsOf(1).sort()).toEqual([
    'mastra_workspace_file_stat',
    'mastra_workspace_grep',
    'mastra_workspace_list_files',
    'mastra_workspace_read_file',
  ]);
  expect(JSON.stringify((scriptedGateway.seen[1]?.body as { system?: unknown }).system)).toContain(
    'You only research.',
  );
  expect(JSON.stringify((scriptedGateway.seen[0]?.body as { tools: unknown }).tools)).toContain(
    'Reads files and reports.',
  );
});

it("adds a subagent step to the usage without counting it as one of the run's own turns", async () => {
  const cwd = workspace();
  scriptedGateway.script = [
    tool('t1', 'agent-researcher', { prompt: 'Read a.md.' }),
    text('Found.'),
    text('Done.'),
  ];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          subagents: [
            {
              name: 'researcher',
              description: 'Reads files and reports.',
              instructions: 'You only research.',
              model: null,
              permissions: {
                ...base.portable.permissions,
                writeFiles: false,
                runCommands: false,
              },
            },
          ],
        },
      }),
    ).frames,
  );
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    stopReason: 'end_turn',
    turns: 2,
  });
  // Three model calls of 100 input tokens each: two the parent's, one the subagent's.
  expect(frames.filter((frame) => frame.frame === 'agent.usage').at(-1)).toMatchObject({
    inputTokens: 300,
  });
});

it('resumes a session whose first run delegated to a subagent', async () => {
  const cwd = workspace();
  const store = createFakeSessionStore('accept');
  scriptedGateway.script = [
    tool('t1', 'agent-researcher', { prompt: 'Read a.md.' }),
    text('Found: hello doc.'),
    text('Done.'),
  ];
  const base = request(cwd);
  const first = createMastraEngine().start(
    request(cwd, { portable: { ...base.portable, subagents: [RESEARCHER] } }),
    { sessionStore: store },
  );
  await drain(first.frames);
  const threadId = await first.engineSessionId;

  scriptedGateway.script = [text('heron')];
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        prompt: 'And now?',
        portable: { ...base.portable, subagents: [RESEARCHER] },
        session: { mode: 'resume', engineSessionId: threadId },
      }),
      { sessionStore: store },
    ).frames,
  );
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  // The subagent's own thread stays out of the session's stream.
  const entries = store.appended().flatMap((batch) => batch.entries) as {
    thread?: { id: string };
    message?: { threadId: string };
  }[];
  expect(entries.map((entry) => entry.thread?.id ?? entry.message?.threadId)).toEqual(
    entries.map(() => threadId),
  );
});

it("clamps the steps a delegating model asks a subagent for to the run's maxTurns", async () => {
  const cwd = workspace();
  const read = (id: string): Response => tool(id, 'mastra_workspace_read_file', { path: 'a.md' });
  scriptedGateway.script = [
    tool('t1', 'agent-researcher', { prompt: 'Read a.md.', maxSteps: 99 }),
    read('s1'),
    read('s2'),
    read('s3'),
    text('Done.'),
  ];
  const base = request(cwd);
  const frames = await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          limits: { maxTurns: 3, maxBudgetUsd: null },
          subagents: [RESEARCHER],
        },
      }),
    ).frames,
  );
  // The subagent stopped after three steps, so the parent's second step got `Done.`.
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  expect(scriptedGateway.seen).toHaveLength(5);
});

it("releases a subagent's workspace, killing its background process, when the run fails", async () => {
  const cwd = workspace();
  const refused = (): Response =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'x' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  scriptedGateway.script = [
    tool('t1', 'agent-runner', { prompt: 'Start the job.' }),
    tool('s1', 'mastra_workspace_execute_command', {
      command: 'echo $$ > job.pid; exec sleep 60',
      background: true,
    }),
    refused(),
    refused(),
  ];
  const base = request(cwd);
  await drain(
    createMastraEngine().start(
      request(cwd, {
        portable: {
          ...base.portable,
          subagents: [
            {
              ...RESEARCHER,
              name: 'runner',
              permissions: { ...base.portable.permissions, writeFiles: false },
            },
          ],
        },
      }),
    ).frames,
  ).catch(() => undefined);
  const pid = Number(readFileSync(path.join(cwd, 'job.pid'), 'utf8'));
  // The release is asynchronous; under a loaded full-suite run it can outlast the 1 s default.
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return 'running';
        } catch {
          return 'gone';
        }
      },
      { timeout: 15_000 },
    )
    .toBe('gone');
}, 30_000);
