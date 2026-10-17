import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RunResourceSchema } from '@indx-workspace/contracts/runs';
import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterAll, describe, expect, it } from 'vitest';

import type { ChatTerminal } from '../io.js';
import { EXIT_CODE } from '../output.js';
import {
  eventStream,
  FIXTURES,
  IDS,
  json,
  runCli,
  runFixture,
  stdoutJson,
  tempDirectory,
  type Route,
} from '../testing.js';

const frame = (event: string, id: number, data: unknown): string =>
  `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;

const message = (id: number, text: string): string =>
  frame('agent.message', id, {
    frame: 'agent.message',
    engine: 'claude-agent-sdk',
    raw: {},
    messageId: `msg_${String(id)}`,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  });

const STREAM = (status: string, error: string | null, answer: string | null): string =>
  frame('run.status', 1, { status: 'running', error }) +
  (answer === null ? '' : message(2, answer)) +
  frame('run.status', 3, { status, error }) +
  'event: done\ndata: null\n\n';

const other = { ...FIXTURES.agent, id: '22222222-2222-4222-8222-222222222222', name: 'Billing' };

function routes(
  agents: readonly unknown[],
  status = 'completed',
  error: string | null = null,
  answer: string | null = 'It shipped yesterday.',
): Route {
  return (request) => {
    if (request.url.pathname === '/api/agents') return json(200, { agents });
    if (request.method === 'POST')
      return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
    if (request.url.pathname.endsWith('/events')) return eventStream(STREAM(status, error, answer));
    return json(200, { run: { ...runFixture(status), error } });
  };
}

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('aw chat (one shot)', () => {
  it('defaults to the only agent and prints the answer from --prompt', async () => {
    const run = await runCli(['chat', '--prompt', 'where is A-1042?'], {
      route: routes([FIXTURES.agent]),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('It shipped yesterday.\n');
    expect(run.calls.find((call) => call.method === 'POST')?.url.pathname).toBe(
      `/api/agents/${IDS.agent}/runs`,
    );
    expect(run.calls.find((call) => call.method === 'POST')?.json).toMatchObject({
      prompt: 'where is A-1042?',
      sessionId: null,
    });
  });

  it('resolves a name or an id, and reads a piped prompt', async () => {
    const byName = await runCli(['chat', 'Billing'], {
      route: routes([FIXTURES.agent, other]),
      stdin: 'piped question\n',
    });
    expect(byName.code).toBe(EXIT_CODE.ok);
    const post = byName.calls.find((call) => call.method === 'POST');
    expect(post?.url.pathname).toBe(`/api/agents/${other.id}/runs`);
    expect(post?.json).toMatchObject({ prompt: 'piped question' });
    const byId = await runCli(['chat', IDS.agent, '--prompt', 'x'], {
      route: routes([FIXTURES.agent, other]),
    });
    expect(byId.calls.find((call) => call.method === 'POST')?.url.pathname).toBe(
      `/api/agents/${IDS.agent}/runs`,
    );
  });

  it('--json prints the settled run and nothing else', async () => {
    const run = await runCli(['chat', '--prompt', 'x', '--json'], {
      route: routes([FIXTURES.agent]),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(RunResourceSchema.parse(stdoutJson(run)).status).toBe('completed');
  });

  it('refuses an unknown agent (1), an ambiguous default (2) and a missing prompt (2)', async () => {
    const unknown = await runCli(['chat', 'Nobody', '--prompt', 'x'], {
      route: routes([FIXTURES.agent]),
    });
    expect(unknown.code).toBe(EXIT_CODE.problem);
    const ambiguous = await runCli(['chat', '--prompt', 'x'], {
      route: routes([FIXTURES.agent, other]),
    });
    expect(ambiguous.code).toBe(EXIT_CODE.usage);
    expect(ambiguous.stderr).toContain('Summariser, Billing');
    const silent = await runCli(['chat'], { route: routes([FIXTURES.agent]) });
    expect(silent.code).toBe(EXIT_CODE.usage);
    expect(silent.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('exits 1 when the run was cancelled instead of completing (BH061-018)', async () => {
    const run = await runCli(['chat', '--prompt', 'x'], {
      route: routes([FIXTURES.agent], 'cancelled', 'The run was interrupted.', null),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('run_cancelled');
  });

  it('exits 1 with the run failure code when the run failed', async () => {
    const run = await runCli(['chat', '--prompt', 'x'], {
      route: routes(
        [FIXTURES.agent],
        'failed',
        'model_connection_unresolved: none configured.',
        null,
      ),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('model_connection_unresolved');
    expect(run.stdout).toBe('');
  });

  // UX-G (#760): the long connections/Models text means nothing to someone who has just run npm run dev.
  it('answers a missing model key on a local runtime with the set-key line and the restart', async () => {
    const run = await runCli(['chat', '-p', 'hello'], {
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
      route: routes(
        [FIXTURES.agent],
        'failed',
        'model_connection_unresolved: long internal text.',
        null,
      ),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toMatch(
      /^error: no model key: .*ANTHROPIC_API_KEY=.*, then restart npm run dev \(it will offer to open the console\)$/mu,
    );
    expect(run.stderr).not.toContain('model_connection_unresolved');
  });

  it('names the own key of the project, not a hardcoded one', async () => {
    const directory = await tempDirectory();
    directories.push(directory);
    const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      `${file?.contents ?? ''}models:
  default:
    provider: openai
    credential:
      secret: OPENAI_API_KEY
`,
    );
    const run = await runCli(['chat', '-p', 'hello'], {
      cwd: directory,
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
      route: routes(
        [FIXTURES.agent],
        'failed',
        'model_connection_unresolved: long internal text.',
        null,
      ),
    });
    expect(run.stderr).toContain('OPENAI_API_KEY');
    expect(run.stderr).not.toContain('ANTHROPIC_API_KEY');
  });

  it('keeps the full problem text when the project file cannot be read', async () => {
    const directory = await tempDirectory();
    directories.push(directory);
    await writeFile(path.join(directory, 'agent-workspace.yaml'), 'not: [valid');
    const run = await runCli(['chat', '-p', 'hello'], {
      cwd: directory,
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
      route: routes(
        [FIXTURES.agent],
        'failed',
        'model_connection_unresolved: long internal text.',
        null,
      ),
    });
    expect(run.stderr).not.toContain('no model key');
  });

  it('keeps the full problem text for a non-local target', async () => {
    const run = await runCli(['chat', '-p', 'hello'], {
      route: routes(
        [FIXTURES.agent],
        'failed',
        'model_connection_unresolved: long internal text.',
        null,
      ),
    });
    expect(run.stderr).toContain('model_connection_unresolved: run ');
    expect(run.stderr).not.toContain('no model key');
  });

  it('refuses a terminal without --prompt before reading stdin, even with stdout redirected', async () => {
    const run = await runCli(['chat'], {
      route: routes([FIXTURES.agent]),
      stdinIsTty: true,
      stdin: 'must not be read',
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('exits 2 naming --prompt when a terminal has no loop to open (CI set, no -p)', async () => {
    const run = await runCli(['chat'], {
      route: routes([FIXTURES.agent]),
      isTty: false,
      stdinIsTty: true,
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        CI: 'true',
      },
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--prompt');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses an empty workspace with the push hint', async () => {
    const run = await runCli(['chat', '--prompt', 'x'], { route: routes([]) });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('aw push --yes');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('prints nothing for a blank-only answer, and treats --jsonl as machine output', async () => {
    const base = routes([FIXTURES.agent]);
    const text = await runCli(['chat', '--prompt', 'x'], {
      route: (request) =>
        request.url.pathname.endsWith('/events')
          ? eventStream(
              message(1, '  ') +
                frame('run.status', 2, { status: 'completed', error: null }) +
                'event: done\ndata: null\n\n',
            )
          : base(request),
    });
    expect(text.code).toBe(EXIT_CODE.ok);
    expect(text.stdout).toBe('');
    const jsonl = await runCli(['chat', '--prompt', 'x', '--jsonl'], { route: base });
    expect(RunResourceSchema.parse(JSON.parse(jsonl.stdout.trim())).status).toBe('completed');
  });

  it('exits 4 when the control plane does not answer', async () => {
    const run = await runCli(['chat', '--prompt', 'x'], {
      route: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(run.code).toBe(EXIT_CODE.transport);
  });

  it('Ctrl-C interrupts the run and exits 130', async () => {
    const controller = new AbortController();
    const base = routes([FIXTURES.agent]);
    const run = await runCli(['chat', '--prompt', 'x'], {
      signal: controller.signal,
      route: (request) => {
        if (request.url.pathname.endsWith('/events')) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        if (request.url.pathname.endsWith('/interrupt'))
          return json(200, { run: runFixture('interrupted') });
        return base(request);
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.calls.some((call) => call.url.pathname === `/api/runs/${IDS.run}/interrupt`)).toBe(
      true,
    );
  });
});

const CTRL_C = Symbol('ctrl-c');

/** Scripted lines; `CTRL_C` presses Ctrl-C at the prompt, which closes the terminal like readline. */
function fakeTerminal(script: readonly (string | typeof CTRL_C)[]): {
  readonly open: () => ChatTerminal;
  readonly interrupt: () => void;
} {
  const lines = [...script];
  let handler: () => void = () => undefined;
  const terminal: ChatTerminal = {
    question: () => {
      const next = lines.shift();
      if (next === CTRL_C) handler();
      return Promise.resolve(typeof next === 'string' ? next : null);
    },
    onInterrupt: (on) => {
      handler = on;
    },
    close: () => undefined,
  };
  return { open: () => terminal, interrupt: () => handler() };
}

const delta = (id: number, text: string): string =>
  frame('agent.message.delta', id, {
    frame: 'agent.message.delta',
    engine: 'claude-agent-sdk',
    raw: {},
    messageId: 'msg_5',
    block: 'text',
    text,
  });

const toolFrames = (isError = false): string =>
  frame('agent.tool.call', 1, {
    frame: 'agent.tool.call',
    engine: 'claude-agent-sdk',
    raw: {},
    toolCallId: 'tc_1',
    name: 'get_order',
    kind: 'other',
    input: { id: 'A-1042' },
  }) +
  frame('agent.tool.result', 2, {
    frame: 'agent.tool.result',
    engine: 'claude-agent-sdk',
    raw: {},
    toolCallId: 'tc_1',
    status: 'completed',
    output: '{}',
    isError,
  });

describe('aw chat (version targeting)', () => {
  const pointer = (environment: string, number: number) => ({
    environment,
    number,
    updatedAt: '2026-10-02T00:00:00.000Z',
  });
  const withPointers = (pointers: readonly unknown[]): Route => {
    const base = routes([FIXTURES.agent]);
    return (request) =>
      request.url.pathname === `/api/agents/${IDS.agent}/versions`
        ? json(200, { items: [], pointers, materialised: null })
        : base(request);
  };
  const posted = (run: Awaited<ReturnType<typeof runCli>>) =>
    run.calls.find((call) => call.method === 'POST')?.json;

  it('sends no version by default: the local pointer stays the target', async () => {
    const run = await runCli(['chat', '-p', 'hi'], { route: withPointers([]) });
    expect(posted(run)).not.toHaveProperty('version');
    expect(run.calls.some((call) => call.url.pathname.endsWith('/versions'))).toBe(false);
  });

  it('--agent-version <n> runs that version, and --version is still aw’s own switch', async () => {
    const run = await runCli(['chat', '-p', 'hi', '--agent-version', '3'], {
      route: withPointers([]),
    });
    expect(posted(run)).toMatchObject({ version: 3 });
    const own = await runCli(['--version']);
    expect(own.code).toBe(EXIT_CODE.ok);
  });

  it('--env production resolves the pointer; --env local sends no version', async () => {
    const route = withPointers([pointer('local', 4), pointer('production', 2)]);
    expect(
      posted(await runCli(['chat', '-p', 'hi', '--env', 'production'], { route })),
    ).toMatchObject({ version: 2 });
    expect(
      posted(await runCli(['chat', '-p', 'hi', '--env', 'local'], { route })),
    ).not.toHaveProperty('version');
  });

  it('refuses an unpointed environment (1) before any run, and bad input (2)', async () => {
    const unpointed = await runCli(['chat', '-p', 'hi', '--env', 'production'], {
      route: withPointers([pointer('local', 1)]),
    });
    expect(unpointed.code).toBe(EXIT_CODE.problem);
    expect(unpointed.stderr).toContain('fix: run "aw promote --yes"');
    expect(unpointed.calls.some((call) => call.method === 'POST')).toBe(false);
    for (const flags of [
      ['--env', 'preview'],
      ['--agent-version', '0'],
      ['--agent-version', '2147483648'],
      ['--agent-version', '2', '--env', 'production'],
    ]) {
      const run = await runCli(['chat', '-p', 'hi', ...flags], { route: withPointers([]) });
      expect(run.code, flags.join(' ')).toBe(EXIT_CODE.usage);
    }
  });

  it('/version prints the targeted version', async () => {
    const terminal = fakeTerminal(['hi', '/version']);
    const run = await runCli(['chat', '--agent-version', '3'], {
      isTty: false,
      stdinIsTty: true,
      openTerminal: terminal.open,
      route: withPointers([]),
    });
    expect(run.stdout).toContain('· v3');
  });

  it('names the version on a conversation’s first turn only, and again after /reset', async () => {
    const terminal = fakeTerminal(['one', 'two', '/reset', 'three']);
    const run = await runCli(['chat', '--agent-version', '3'], {
      isTty: false,
      stdinIsTty: true,
      openTerminal: terminal.open,
      route: withPointers([]),
    });
    const bodies = run.calls.filter((call) => call.method === 'POST').map((call) => call.json);
    expect(bodies).toMatchObject([
      { sessionId: null, version: 3 },
      { sessionId: IDS.session },
      { sessionId: null, version: 3 },
    ]);
    expect(bodies[1]).not.toHaveProperty('version');
  });
});

describe('aw chat (interactive)', () => {
  const tty = { isTty: false, stdinIsTty: true };

  it('-p is --prompt', async () => {
    const run = await runCli(['chat', '-p', 'hi'], { route: routes([FIXTURES.agent]) });
    expect(run.stdout).toBe('It shipped yesterday.\n');
  });

  it('streams text once, prints a tool call as one line, and reuses the session', async () => {
    const base = routes([FIXTURES.agent]);
    const terminal = fakeTerminal(['where is A-1042?', 'and B-7?']);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: terminal.open,
      route: (request) =>
        request.url.pathname.endsWith('/events')
          ? eventStream(
              toolFrames() +
                delta(3, 'It shipped ') +
                delta(4, 'yesterday.') +
                message(5, 'It shipped yesterday.') +
                frame('run.status', 6, { status: 'completed', error: null }) +
                'event: done\ndata: null\n\n',
            )
          : base(request),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toMatch(
      /⚙ get_order \{"id":"A-1042"\} → ok · \d+ ms\nIt shipped yesterday\.\n/u,
    );
    // Once per turn, never doubled by the snapshot message that follows the deltas.
    expect(run.stdout.match(/It shipped yesterday\./gu)).toHaveLength(2);
    const bodies = run.calls.filter((call) => call.method === 'POST').map((call) => call.json);
    expect(bodies).toMatchObject([
      { prompt: 'where is A-1042?', sessionId: null },
      { prompt: 'and B-7?', sessionId: IDS.session },
    ]);
  });

  it('/reset starts a new session; /help, /version and an unknown command talk locally', async () => {
    const terminal = fakeTerminal(['one', '/reset', 'two', '/version', '/help', '/nope', '/exit']);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: terminal.open,
      route: routes([FIXTURES.agent]),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const bodies = run.calls.filter((call) => call.method === 'POST').map((call) => call.json);
    expect(bodies).toMatchObject([{ sessionId: null }, { sessionId: null }]);
    expect(run.stdout).toContain('new conversation');
    expect(run.stdout).toContain(`agent ${IDS.agent}`);
    expect(run.stdout).toContain('/reset');
    expect(run.stdout).toContain('unknown command /nope');
  });

  it('Ctrl-C interrupts the turn, and Ctrl-C at the idle prompt exits 130', async () => {
    const terminal = fakeTerminal(['slow question', CTRL_C]);
    const base = routes([FIXTURES.agent]);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: terminal.open,
      route: (request) => {
        if (request.url.pathname.endsWith('/events')) {
          terminal.interrupt();
          throw new DOMException('aborted', 'AbortError');
        }
        if (request.url.pathname.endsWith('/interrupt'))
          return json(200, { run: runFixture('interrupted') });
        return base(request);
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain('interrupted');
    expect(run.calls.some((call) => call.url.pathname === `/api/runs/${IDS.run}/interrupt`)).toBe(
      true,
    );
  });

  it('a second Ctrl-C while the courtesy interrupt is in flight exits 130', async () => {
    const terminal = fakeTerminal(['slow question']);
    const base = routes([FIXTURES.agent]);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: terminal.open,
      route: (request) => {
        if (request.url.pathname.endsWith('/events')) {
          terminal.interrupt();
          throw new DOMException('aborted', 'AbortError');
        }
        if (request.url.pathname.endsWith('/interrupt')) {
          terminal.interrupt();
          return json(200, { run: runFixture('interrupted') });
        }
        return base(request);
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
  });

  it('SIGTERM at the idle prompt closes the terminal and exits 130', async () => {
    const abort = new AbortController();
    let release: (line: string | null) => void = () => undefined;
    const terminal: ChatTerminal = {
      question: () =>
        new Promise((resolve) => {
          release = resolve;
          queueMicrotask(() => {
            abort.abort();
          });
        }),
      onInterrupt: () => undefined,
      close: () => {
        release(null);
      },
    };
    const run = await runCli(['chat'], {
      ...tty,
      signal: abort.signal,
      openTerminal: () => terminal,
      route: routes([FIXTURES.agent]),
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
  });

  it('prints a failing tool call as an error line', async () => {
    const base = routes([FIXTURES.agent]);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: fakeTerminal(['go']).open,
      route: (request) =>
        request.url.pathname.endsWith('/events')
          ? eventStream(
              toolFrames(true) +
                frame('run.status', 3, { status: 'completed', error: null }) +
                'event: done\ndata: null\n\n',
            )
          : base(request),
    });
    expect(run.stdout).toMatch(/⚙ get_order \{"id":"A-1042"\} → error · \d+ ms/u);
  });

  it('--json without a prompt on a terminal is a usage error, not the loop', async () => {
    const run = await runCli(['chat', '--json'], {
      ...tty,
      openTerminal: fakeTerminal(['/exit']).open,
      route: routes([FIXTURES.agent]),
    });
    expect(run.code).toBe(EXIT_CODE.usage);
  });

  it('reports a failed run and keeps the conversation going', async () => {
    const terminal = fakeTerminal(['x', '/exit']);
    const run = await runCli(['chat'], {
      ...tty,
      openTerminal: terminal.open,
      route: routes([FIXTURES.agent], 'failed', 'model_connection_unresolved: none.', null),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('model_connection_unresolved');
  });

  it('answers a missing model key on a local runtime shortly and keeps going', async () => {
    const run = await runCli(['chat'], {
      ...tty,
      env: {
        AGENT_WORKSPACE_URL: 'http://localhost:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
      openTerminal: fakeTerminal(['x', '/exit']).open,
      route: routes([FIXTURES.agent], 'failed', 'model_connection_unresolved: none.', null),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('error: no model key: ');
    expect(run.stderr).not.toContain('model_connection_unresolved');
  });
});
