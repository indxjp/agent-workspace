/**
 * Real Mastra (`@mastra/core` 1.71.0) against a scripted gateway (ENG-10, #309).
 *
 * The model is reached through the process's global `fetch`, which this file replaces with the
 * gateway, so every request Mastra, its providers or its telemetry could make is seen here: the
 * egress assertions are over **all** of them, not over the ones the adapter chose to route. The
 * gateway answers in each protocol's own streaming dialect, recorded from the providers' wire
 * format, and each scenario drives the adapter end to end — compile, the boundary, Mastra's agent
 * loop and workspace tools, and the frame mapper.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EngineFrame, EngineRunRequest } from '@agent-workspace/engine';
import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  grantedFilesystemForTests,
  mastraProcessEnvironmentHolds,
  preloadMastra,
} from './boundary.js';
import { compileMastraRun } from './compile.js';
import { createMastraEngine } from './engine.js';

const GATEWAY = 'http://gateway.invalid';
const TOKEN = 'run-token-for-mastra';

type Seen = {
  readonly url: string;
  readonly authorization: string | null;
  readonly apiKey: string | null;
  readonly body: unknown;
};

const seen: Seen[] = [];
let script: (Response | ((signal: AbortSignal | undefined) => Response))[] = [];
const realFetch = globalThis.fetch;

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicTurn(
  content: 'tool' | 'text',
  value: { id?: string; name?: string; input?: unknown; text?: string },
): Response {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${String(seen.length)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  };
  const block =
    content === 'tool'
      ? [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: value.id, name: value.name, input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(value.input) },
          },
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: value.text },
          },
        ];
  return sse([
    start,
    ...block,
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: content === 'tool' ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 10 },
    },
    { type: 'message_stop' },
  ]);
}

/**
 * A Messages stream that sends its first text delta and then holds the connection open until the
 * request is aborted: the shape of a model still answering when the caller interrupts.
 */
function slowText(first: string): (signal: AbortSignal | undefined) => Response {
  return (signal) => {
    const encoder = new TextEncoder();
    const frame = (event: Record<string, unknown>): Uint8Array =>
      encoder.encode(`event: ${String(event['type'])}
data: ${JSON.stringify(event)}

`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          frame({
            type: 'message_start',
            message: {
              id: 'msg_slow',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          }),
        );
        controller.enqueue(
          frame({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );
        controller.enqueue(
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: first },
          }),
        );
        const abort = (): void => {
          controller.error(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const tool = (id: string, name: string, input: unknown): Response =>
  anthropicTurn('tool', { id, name, input });
const text = (value: string): Response => anthropicTurn('text', { text: value });

function chatCompletion(value: string): Response {
  const chunks = [
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5',
      choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }],
    },
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One OpenAI Responses stream answering `value` as a single text message. */
function responsesText(value: string): Response {
  const message = {
    type: 'message',
    id: 'msg_r1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }],
  };
  const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7 };
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_1', created_at: 1, model: 'gpt-5', status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: value,
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: { id: 'resp_1', object: 'response', status: 'completed', output: [message], usage },
    },
  ]);
}

async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const raw = input instanceof Request ? await input.text() : init?.body;
  seen.push({
    url,
    authorization: headers.get('authorization'),
    apiKey: headers.get('x-api-key'),
    body: typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null,
  });
  const next = script.shift();
  if (next === undefined || !url.startsWith(GATEWAY)) {
    return new Response(JSON.stringify({ error: 'unscripted' }), { status: 500 });
  }
  return typeof next === 'function'
    ? next(input instanceof Request ? input.signal : (init?.signal ?? undefined))
    : next;
}

const roots: string[] = [];

function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mastra-boundary-')));
  roots.push(root);
  writeFileSync(path.join(root, 'a.md'), 'hello doc\n');
  mkdirSync(path.join(root, 'contracts'));
  writeFileSync(path.join(root, 'contracts/signed.pdf'), 'signed');
  mkdirSync(path.join(root, '.mastra/skills/greeter'), { recursive: true });
  writeFileSync(
    path.join(root, '.mastra/skills/greeter/SKILL.md'),
    '---\nname: greeter\ndescription: Greets people the house way.\n---\n# Greeter\nAlways greet with "Ahoy".\n',
  );
  return root;
}

function request(cwd: string, overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: '4c8f0a52-9a0e-4d1c-b8f5-1a2b3c4d5e6f',
    projectKey: 'tenant-a',
    cwd,
    prompt: 'Greet, read a.md, edit it and run a command.',
    engine: 'mastra',
    portable: {
      name: 'Helper',
      instructions: 'Be terse.',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: ['greeter'] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'anthropic-messages' },
    resources: { files: [], skills: [{ name: 'greeter', files: [] }] },
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
    ...overrides,
  };
}

async function drain(frames: AsyncIterable<EngineFrame>): Promise<EngineFrame[]> {
  const out: EngineFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

function neutral(frames: readonly EngineFrame[]): string[] {
  return frames.filter((frame) => frame.frame !== 'agent.native').map((frame) => frame.frame);
}

/** A read-only subagent on the parent's model. */
const RESEARCHER = {
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
};

// Importing Mastra (and the MCP client) is a one-off cost of seconds on a cold or loaded machine.
// Pay it here, under the hook's own limit, so no scenario's 5 s budget is spent on module loading
// and every test measures only its own run.
beforeAll(async () => {
  await preloadMastra();
}, 120_000);

beforeEach(() => {
  seen.length = 0;
  script = [];
  globalThis.fetch = gatewayFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('startMastraRun, against a scripted gateway', () => {
  it('uses a skill, reads and edits a file, runs a command, and reaches only the gateway', async () => {
    const cwd = workspace();
    script = [
      tool('t1', 'skill', { name: 'greeter' }),
      tool('t2', 'mastra_workspace_read_file', { path: 'a.md' }),
      tool('t3', 'mastra_workspace_edit_file', {
        path: 'a.md',
        old_string: 'hello',
        new_string: 'Ahoy',
      }),
      tool('t4', 'mastra_workspace_execute_command', { command: 'cat a.md' }),
      text('Ahoy, done.'),
    ];
    const frames = await drain(createMastraEngine().start(request(cwd)).frames);

    const calls = frames.filter((frame) => frame.frame === 'agent.tool.call');
    expect(calls.map((frame) => [frame.name, frame.kind])).toEqual([
      ['skill', 'read'],
      ['mastra_workspace_read_file', 'read'],
      ['mastra_workspace_edit_file', 'edit'],
      ['mastra_workspace_execute_command', 'execute'],
    ]);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results.map((frame) => frame.isError)).toEqual([false, false, false, false]);
    expect(results[0]?.output).toContain('Ahoy');
    expect(results[3]?.output).toContain('Ahoy doc');
    expect(readFileSync(path.join(cwd, 'a.md'), 'utf8')).toBe('Ahoy doc\n');
    expect(frames.at(-1)).toMatchObject({
      frame: 'agent.result',
      stopReason: 'end_turn',
      turns: 5,
    });
    expect(frames.filter((frame) => frame.frame === 'agent.message').at(-1)).toMatchObject({
      blocks: [{ type: 'text', text: 'Ahoy, done.' }],
    });
    expect(neutral(frames).slice(-2)).toEqual(['agent.usage', 'agent.result']);

    // Egress: five model calls, every one to the gateway's Messages route with the run token as
    // the bearer, and not a single other request — no telemetry, no catalogue, no exporter.
    expect(seen.map((request) => request.url)).toEqual(Array(5).fill(`${GATEWAY}/v1/messages`));
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.apiKey).toBeNull();
    }
    expect(mastraProcessEnvironmentHolds()).toBe(true);
    const offered = (seen[0]?.body as { tools: { name: string }[] }).tools.map(
      (entry) => entry.name,
    );
    expect(offered).toEqual(
      expect.arrayContaining([
        'skill',
        'mastra_workspace_read_file',
        'mastra_workspace_execute_command',
      ]),
    );
    expect(offered).not.toContain('mastra_workspace_ast_edit');
  });

  it('offers only the plan: no command tools without runCommands, no write tools without writeFiles', async () => {
    const cwd = workspace();
    script = [text('ok')];
    const base = request(cwd);
    await drain(
      createMastraEngine().start(
        request(cwd, {
          portable: {
            ...base.portable,
            permissions: {
              readFiles: true,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
            skills: { mode: 'allowlist', names: [] },
          },
          resources: { files: [], skills: [] },
        }),
      ).frames,
    );
    const offered = (seen[0]?.body as { tools: { name: string }[] }).tools
      .map((entry) => entry.name)
      .sort();
    expect(offered).toEqual([
      'mastra_workspace_file_stat',
      'mastra_workspace_grep',
      'mastra_workspace_list_files',
      'mastra_workspace_read_file',
    ]);
  });

  it('runs a skill script without a shell: offered beside the withheld command tool, read-only under the grant', async () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, '.mastra/skills/greeter/scripts'));
    writeFileSync(
      path.join(cwd, '.mastra/skills/greeter/scripts/hello.mjs'),
      `import fs from 'node:fs';
let write;
try { fs.writeFileSync('contracts/signed.pdf', 'forged'); write = 'OK'; } catch (error) { write = error.code; }
console.log(process.argv[2], fs.readFileSync('contracts/signed.pdf', 'utf8'), write);
`,
    );
    script = [
      tool('t1', 'run_skill_script', { skill: 'greeter', script: 'hello.mjs', args: ['Ahoy'] }),
      tool('t2', 'run_skill_script', { skill: 'greeter', script: '../SKILL.md' }),
      text('done'),
    ];
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          resources: {
            files: [{ kind: 'file', path: 'contracts/signed.pdf', access: 'read' }],
            skills: [
              {
                name: 'greeter',
                files: [{ path: 'scripts/hello.mjs', contentBase64: 'Y29uc29sZS5sb2coMSk=' }],
              },
            ],
          },
        }),
      ).frames,
    );

    const offered = (seen[0]?.body as { tools: { name: string }[] }).tools.map(
      (entry) => entry.name,
    );
    expect(offered).toContain('run_skill_script');
    expect(offered).not.toContain('mastra_workspace_execute_command');
    const calls = frames.filter((frame) => frame.frame === 'agent.tool.call');
    expect(calls.map((frame) => [frame.name, frame.kind])).toEqual([
      ['run_skill_script', 'execute'],
      ['run_skill_script', 'execute'],
    ]);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]?.output).toContain('Ahoy signed ERR_ACCESS_DENIED');
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[1]?.output).toContain('outside_skill_directory');
    expect(readFileSync(path.join(cwd, 'contracts/signed.pdf'), 'utf8')).toBe('signed');
  });

  it('offers no skill script tool without runCommands', async () => {
    const cwd = workspace();
    script = [text('ok')];
    const base = request(cwd);
    await drain(
      createMastraEngine().start(
        request(cwd, {
          portable: {
            ...base.portable,
            permissions: { ...base.portable.permissions, runCommands: false },
          },
          resources: {
            files: [],
            skills: [
              {
                name: 'greeter',
                files: [{ path: 'scripts/hello.mjs', contentBase64: 'Y29uc29sZS5sb2coMSk=' }],
              },
            ],
          },
        }),
      ).frames,
    );
    const offered = (seen[0]?.body as { tools: { name: string }[] }).tools.map(
      (entry) => entry.name,
    );
    expect(offered).not.toContain('run_skill_script');
  });

  it('refuses a write into a read-only grant as a failed tool call, and leaves the file alone', async () => {
    const cwd = workspace();
    script = [
      tool('t1', 'mastra_workspace_write_file', {
        path: 'contracts/signed.pdf',
        content: 'forged',
      }),
      text('could not'),
    ];
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          resources: {
            files: [{ kind: 'file', path: 'contracts/signed.pdf', access: 'read' }],
            skills: [{ name: 'greeter', files: [] }],
          },
        }),
      ).frames,
    );
    const result = frames.find((frame) => frame.frame === 'agent.tool.result');
    expect(result).toMatchObject({ isError: true, status: 'failed' });
    expect(readFileSync(path.join(cwd, 'contracts/signed.pdf'), 'utf8')).toBe('signed');
  });

  it('refuses a recursive delete of a directory that holds a read-only grant, however spelled', async () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
    writeFileSync(path.join(cwd, 'docs/readme.md'), 'readme');
    script = [
      tool('t1', 'mastra_workspace_delete', { path: 'docs', recursive: true }),
      tool('t2', 'mastra_workspace_delete', { path: 'x/../docs/', recursive: true }),
      tool('t3', 'mastra_workspace_delete', { path: 'docs/readme.md' }),
      text('done'),
    ];
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          resources: {
            files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
            skills: [{ name: 'greeter', files: [] }],
          },
        }),
      ).frames,
    );
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results.map((frame) => [frame.isError, frame.status])).toEqual([
      [true, 'failed'],
      [true, 'failed'],
      [false, 'completed'],
    ]);
    expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
    expect(existsSync(path.join(cwd, 'docs/readme.md'))).toBe(false);
  });

  it('refuses a recursive copy that would write under a read-only grant at the destination, and leaves the file alone', async () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, 'incoming/contracts'), { recursive: true });
    writeFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'forged');
    mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
    const compiled = compileMastraRun(
      request(cwd, {
        resources: {
          files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
          skills: [{ name: 'greeter', files: [] }],
        },
      }),
    );
    if (!compiled.ok) throw new Error(`expected the compile to succeed: ${compiled.reason}`);
    // `copyFile('incoming', 'docs', { recursive: true })` recurses through Mastra's own
    // `copyDirectory`, which writes each file with raw `fs.copyFile` and never calls back into this
    // wrapper's `copyFile` override, so only the guard on the top-level destination stands between
    // it and `docs/contracts/signed.pdf`.
    const filesystem = await grantedFilesystemForTests(compiled.compiled);
    await expect(filesystem.copyFile('incoming', 'docs', { recursive: true })).rejects.toThrow(
      /write refused/u,
    );
    expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
  });

  it('refuses a recursive move that would write under a read-only grant at the destination, and leaves the file alone', async () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, 'incoming/contracts'), { recursive: true });
    writeFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'forged');
    mkdirSync(path.join(cwd, 'docs/contracts'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'signed');
    const compiled = compileMastraRun(
      request(cwd, {
        resources: {
          files: [{ kind: 'directory', path: 'docs/contracts', access: 'read' }],
          skills: [{ name: 'greeter', files: [] }],
        },
      }),
    );
    if (!compiled.ok) throw new Error(`expected the compile to succeed: ${compiled.reason}`);
    const filesystem = await grantedFilesystemForTests(compiled.compiled);
    await expect(filesystem.moveFile('incoming', 'docs')).rejects.toThrow(/write refused/u);
    expect(readFileSync(path.join(cwd, 'docs/contracts/signed.pdf'), 'utf8')).toBe('signed');
    expect(readFileSync(path.join(cwd, 'incoming/contracts/signed.pdf'), 'utf8')).toBe('forged');
  });

  it('recalls the first run on a resume, from the platform store and nothing else', async () => {
    const cwd = workspace();
    const store = createFakeSessionStore('accept');
    script = [text('Noted: the code word is heron.')];
    const first = createMastraEngine().start(request(cwd, { prompt: 'The code word is heron.' }), {
      sessionStore: store,
    });
    await drain(first.frames);
    expect(first.sessionDurability()).toMatchObject({ durable: true });
    const threadId = await first.engineSessionId;

    script = [text('heron')];
    const second = createMastraEngine().start(
      request(cwd, {
        prompt: 'What was the code word?',
        session: { mode: 'resume', engineSessionId: threadId },
      }),
      { sessionStore: store },
    );
    await drain(second.frames);
    const history = JSON.stringify((seen[1]?.body as { messages: unknown[] }).messages);
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
    expect(seen).toEqual([]);
  });

  it('calls an assigned MCP connector tool, reported as kind mcp', async () => {
    const cwd = workspace();
    const server = path.join(cwd, 'echo-mcp.mjs');
    writeFileSync(server, ECHO_MCP_SERVER);
    chmodSync(server, 0o755);
    script = [tool('t1', 'docs_echo', { text: 'ping' }), text('done')];
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
    script = [tool('t1', 'mastra_workspace_read_file', { path: 'a.md' }), text('never sent')];
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
    expect(seen).toHaveLength(1);
  });

  it('stops at the budget cap with max_budget', async () => {
    const cwd = workspace();
    script = [
      tool('t1', 'mastra_workspace_read_file', { path: 'a.md' }),
      tool('t2', 'mastra_workspace_read_file', { path: 'a.md' }),
      text('never sent'),
    ];
    const base = request(cwd);
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          portable: { ...base.portable, limits: { maxTurns: null, maxBudgetUsd: 0.0001 } },
        }),
      ).frames,
    );
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'max_budget' });
    expect(seen.length).toBeLessThan(3);
  });

  it('delegates to a subagent that holds its own narrower tool set and its own instructions', async () => {
    const cwd = workspace();
    script = [
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
    expect(seen).toHaveLength(3);
    const toolsOf = (index: number): string[] =>
      (seen[index]?.body as { tools?: { name: string }[] }).tools?.map((entry) => entry.name) ?? [];
    expect(toolsOf(0)).toEqual(
      expect.arrayContaining(['agent-researcher', 'mastra_workspace_execute_command']),
    );
    expect(toolsOf(1).sort()).toEqual([
      'mastra_workspace_file_stat',
      'mastra_workspace_grep',
      'mastra_workspace_list_files',
      'mastra_workspace_read_file',
    ]);
    expect(JSON.stringify((seen[1]?.body as { system?: unknown }).system)).toContain(
      'You only research.',
    );
    expect(JSON.stringify((seen[0]?.body as { tools: unknown }).tools)).toContain(
      'Reads files and reports.',
    );
  });

  it('counts the steps a subagent takes against the parent budget cap', async () => {
    const cwd = workspace();
    script = [
      tool('t1', 'agent-researcher', { prompt: 'Read a.md.' }),
      text('Found.'),
      text('never sent'),
    ];
    const base = request(cwd);
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          portable: {
            ...base.portable,
            limits: { maxTurns: null, maxBudgetUsd: 0.0006 },
            subagents: [
              {
                name: 'researcher',
                description: 'Reads files and reports.',
                instructions: 'You only research.',
                model: 'claude-sonnet-4-5',
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
    // The parent's own first step is under the cap; the subagent's step takes it over.
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'max_budget' });
    const metered = frames.filter((frame) => frame.frame === 'agent.usage').at(-1);
    expect((metered as { inputTokens: number }).inputTokens).toBeGreaterThanOrEqual(200);
  });

  it("prices a subagent step into the usage without counting it as one of the run's own turns", async () => {
    const cwd = workspace();
    script = [
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
    script = [
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

    script = [text('heron')];
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
    script = [
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
    expect(seen).toHaveLength(5);
  });

  it("releases a subagent's workspace, killing its background process, when the run fails", async () => {
    const cwd = workspace();
    const refused = (): Response =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'x' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    script = [
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

  it('reaches an OpenAI-family connection through its own route, and nothing else', async () => {
    const cwd = workspace();
    script = [chatCompletion('hello from chat')];
    const frames = await drain(
      createMastraEngine().start(
        request(cwd, {
          gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-chat-completions' },
        }),
      ).frames,
    );
    expect(seen.map((entry) => [entry.url, entry.authorization])).toEqual([
      [`${GATEWAY}/v1/chat/completions`, `Bearer ${TOKEN}`],
    ]);
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });

    seen.length = 0;
    script = [
      new Response(JSON.stringify({ error: { message: 'scripted refusal' } }), { status: 400 }),
    ];
    await drain(
      createMastraEngine().start(
        request(cwd, { gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-responses' } }),
      ).frames,
    ).catch(() => undefined);
    expect(seen.map((entry) => [entry.url, entry.authorization])).toEqual([
      [`${GATEWAY}/v1/responses`, `Bearer ${TOKEN}`],
    ]);
  });

  it('forwards a finish that follows an error chunk as agent.native, after the error result', async () => {
    const cwd = workspace();
    script = [
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ];
    const frames = await drain(createMastraEngine().start(request(cwd)).frames);
    const results = frames.filter((frame) => frame.frame === 'agent.result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stopReason: 'error' });
    const errorAt = frames.indexOf(results[0] as EngineFrame);
    expect(
      frames
        .slice(errorAt + 1)
        .some((frame) => frame.frame === 'agent.native' && frame.type === 'finish'),
    ).toBe(true);
  });

  it.each([401, 403] as const)(
    'fails fast and clearly when the provider answers %i, after the error result',
    async (status) => {
      const cwd = workspace();
      script = [
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'bad' },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
      ];
      const frames: EngineFrame[] = [];
      const failure = await (async () => {
        for await (const frame of createMastraEngine().start(request(cwd)).frames) {
          frames.push(frame);
        }
      })().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        message: `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
      });
      expect(frames.filter((frame) => frame.frame === 'agent.result')).toHaveLength(1);
      expect(seen).toHaveLength(1);
    },
  );

  it("leaves the gateway's own token refusal as the plain error result", async () => {
    const cwd = workspace();
    script = [
      new Response(JSON.stringify({ error: { code: 'token_expired', message: 'expired' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const frames = await drain(createMastraEngine().start(request(cwd)).frames);
    expect(frames.filter((frame) => frame.frame === 'agent.result')).toMatchObject([
      { stopReason: 'error' },
    ]);
  });

  it('ends a run interrupted mid-answer cancelled, and sends no further request', async () => {
    const cwd = workspace();
    script = [slowText('Hel'), text('never sent')];
    const connection = createMastraEngine().start(request(cwd));
    const frames: EngineFrame[] = [];
    for await (const frame of connection.frames) {
      frames.push(frame);
      if (frame.frame === 'agent.message.delta') await connection.interrupt();
    }
    expect(frames.some((frame) => frame.frame === 'agent.message.delta')).toBe(true);
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'cancelled' });
    expect(seen).toHaveLength(1);
  });

  it('ends an interrupted run cancelled without calling the model', async () => {
    const cwd = workspace();
    const connection = createMastraEngine().start(request(cwd));
    await connection.interrupt();
    const frames = await drain(connection.frames);
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'cancelled' });
    expect(seen).toEqual([]);
  });

  describe('outputSchema (ADR-0143)', () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    };

    async function runWith(
      answer: string,
      outputSchema: Record<string, unknown> | undefined,
    ): Promise<{ frames: EngineFrame[]; failure: unknown }> {
      script = [text(answer)];
      const frames: EngineFrame[] = [];
      const failure = await (async () => {
        const connection = createMastraEngine().start(
          request(workspace(), outputSchema === undefined ? {} : { outputSchema }),
        );
        for await (const frame of connection.frames) frames.push(frame);
      })().then(
        () => null,
        (error: unknown) => error,
      );
      return { frames, failure };
    }

    it("sends the schema in the provider's response format", async () => {
      await runWith('{"verdict":"ok"}', schema);
      const format = (seen[0]?.body as { output_config?: { format?: Record<string, unknown> } })
        .output_config?.format;
      expect(format).toMatchObject({
        type: 'json_schema',
        schema: { type: 'object', properties: { verdict: { type: 'string' } } },
      });
    });

    it('reports the text and the parsed object on agent.result for a matching answer', async () => {
      const { frames, failure } = await runWith('{"verdict":"ok"}', schema);
      expect(failure).toBeNull();
      expect(frames.at(-1)).toMatchObject({
        frame: 'agent.result',
        stopReason: 'end_turn',
        output: { text: '{"verdict":"ok"}', structured: { verdict: 'ok' } },
      });
    });

    it.each([
      ['an answer that does not match the schema', '{"verdict":5}'],
      ['an answer that is not JSON', 'not json'],
      ['an empty answer', ''],
    ] as const)(
      'fails with output_schema_unsatisfied, leaking neither schema nor answer, for %s',
      async (_name, answer) => {
        const { frames, failure } = await runWith(answer, schema);
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toMatch(/^output_schema_unsatisfied: /u);
        expect(message).not.toContain('verdict');
        if (answer !== '') expect(message).not.toContain(answer);
        const results = frames.filter((frame) => frame.frame === 'agent.result');
        expect(results).toHaveLength(1);
        expect(results[0]).not.toHaveProperty('output');
        expect(seen).toHaveLength(1);
      },
    );

    it.each([
      [
        'openai-responses',
        responsesText,
        (body: unknown) => (body as { text?: { format?: unknown } }).text?.format,
      ],
      [
        'openai-chat-completions',
        chatCompletion,
        (body: unknown) => (body as { response_format?: unknown }).response_format,
      ],
    ] as const)(
      'sends the schema and refuses a mismatched answer by name on the %s route',
      async (protocol, answer, format) => {
        const gateway = { baseUrl: GATEWAY, token: TOKEN, protocol } as const;
        script = [answer('{"verdict":"ok"}')];
        const matched = await drain(
          createMastraEngine().start(request(workspace(), { gateway, outputSchema: schema }))
            .frames,
        );
        expect(JSON.stringify(format(seen[0]?.body))).toContain('"verdict"');
        expect(matched.at(-1)).toMatchObject({
          frame: 'agent.result',
          output: { structured: { verdict: 'ok' } },
        });

        seen.length = 0;
        script = [answer('{"verdict":5}')];
        const failure = await drain(
          createMastraEngine().start(request(workspace(), { gateway, outputSchema: schema }))
            .frames,
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toMatch(/^output_schema_unsatisfied: /u);
        expect(message).not.toContain('verdict');
        expect(message).not.toContain('{"verdict":5}');
        expect(seen).toHaveLength(1);
      },
    );

    it('leaves a malformed provider chunk as a plain failed run, not output_schema_unsatisfied', async () => {
      // The AI SDK raises `AI_TypeValidationError` for a chunk off its wire schema, as it does for
      // some answer failures; this one is the provider, so it must not be reported as the answer.
      script = [sse([{ type: 'response.created', response: { id: 'resp_1' } }])];
      const frames = await drain(
        createMastraEngine().start(
          request(workspace(), {
            gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-responses' },
            outputSchema: schema,
          }),
        ).frames,
      );
      expect(frames.filter((frame) => frame.frame === 'agent.result')).toMatchObject([
        { stopReason: 'error' },
      ]);
    });

    it('sends no response format and reports a null structured answer without a schema', async () => {
      const { frames, failure } = await runWith('plain words', undefined);
      expect(failure).toBeNull();
      expect(seen[0]?.body).not.toHaveProperty('output_config');
      expect(frames.at(-1)).toMatchObject({
        frame: 'agent.result',
        output: { text: 'plain words', structured: null },
      });
    });
  });

  it('turns Mastra telemetry and its catalogue refresh off in the process before Mastra loads', async () => {
    await preloadMastra();
    expect(process.env['MASTRA_TELEMETRY_DISABLED']).toBe('1');
    expect(process.env['MASTRA_OFFLINE']).toBe('1');
  });
});

/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC, one tool, `echo`. It answers the
 * protocol version the client asks for and refuses every method it does not implement by name.
 */
const ECHO_MCP_SERVER = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (message.method === 'tools/call') {
    send({ id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }] } });
  } else if (message.method === 'ping') {
    send({ id: message.id, result: {} });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
});
`;
