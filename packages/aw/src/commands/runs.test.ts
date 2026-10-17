import { rm } from 'node:fs/promises';

import { RunListResponseSchema, RunResourceSchema } from '@indx-workspace/contracts/runs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import {
  eventStream,
  IDS,
  json,
  runCli,
  runFixture,
  stdoutJson,
  tempDirectory,
  tempFile,
  type Route,
} from '../testing.js';

// These tests start a real child process (the project loader or the tool host): a second or more
// each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

let directory: string;

beforeAll(async () => {
  directory = await tempDirectory();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const frame = (event: string, id: number | null, data: unknown): string =>
  `event: ${event}\n${id === null ? '' : `id: ${String(id)}\n`}data: ${JSON.stringify(data)}\n\n`;

const ENGINE = 'claude-agent-sdk';

/** One neutral `agent.*` frame as the control plane serves it (ENG-03): the name, and the frame. */
const agentFrame = (id: number, name: string, fields: Record<string, unknown>): string =>
  frame(name, id, { frame: name, engine: ENGINE, raw: { type: 'relayed' }, ...fields });

const STREAM =
  'retry: 3000\n\n' +
  frame('run.status', 1, { status: 'running', error: null }) +
  agentFrame(2, 'agent.session', { engineSessionId: 'ses_abc', model: 'claude-opus-5' }) +
  agentFrame(3, 'agent.message', {
    messageId: 'msg_1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Reading the incidents.' }],
  }) +
  agentFrame(4, 'agent.tool.call', {
    toolCallId: 'toolu_1',
    name: 'Read',
    kind: 'read',
    input: { path: 'incidents.md' },
  }) +
  agentFrame(5, 'agent.tool.result', {
    toolCallId: 'toolu_1',
    status: 'completed',
    output: 'two open',
    isError: false,
  }) +
  agentFrame(6, 'agent.usage', {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: null,
  }) +
  agentFrame(7, 'agent.result', { stopReason: 'end_turn', turns: 1, engineCostUsd: 0.0125 }) +
  frame('run.status', 8, { status: 'completed', error: null }) +
  'event: done\ndata: null\n\n';

const HUMAN_LINES = [
  'run: running',
  'session ses_abc model=claude-opus-5',
  'Reading the incidents.',
  'tool Read (read) {"path":"incidents.md"}',
  'tool result toolu_1 completed: two open',
  'tokens=100/20',
  'result: end_turn engine-cost=$0.0125 (estimate)',
  'run: completed',
];

/** Start answers 202, the stream answers the canned frames, and the settled run answers its record. */
const runRoutes: Route = (request) => {
  if (request.method === 'POST')
    return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
  if (request.url.pathname.endsWith('/events')) return eventStream(STREAM);
  return json(200, { run: runFixture('completed') });
};

describe('aw runs start', () => {
  it('posts the wire body and prints the queued run', async () => {
    const run = await runCli(
      [
        'runs',
        'start',
        IDS.agent,
        '--prompt',
        'Summarise',
        '--session',
        IDS.session,
        '--model',
        `${IDS.connection}:claude-x`,
        '--json',
      ],
      { route: runRoutes },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/runs`);
    expect(run.calls[0]?.json).toEqual({
      prompt: 'Summarise',
      sessionId: IDS.session,
      modelConnectionId: IDS.connection,
      model: 'claude-x',
    });
    expect(RunResourceSchema.parse(stdoutJson(run)).status).toBe('queued');
  });

  it('reads the prompt from --prompt-file and refuses both prompt sources, a bad --model and --wait with --follow', async () => {
    const promptFile = await tempFile(directory, 'prompt.txt', 'From a file');
    const run = await runCli(['runs', 'start', IDS.agent, '--prompt-file', promptFile], {
      route: runRoutes,
    });
    expect(run.calls[0]?.json).toMatchObject({
      prompt: 'From a file',
      sessionId: null,
      modelConnectionId: null,
      model: null,
    });
    for (const argv of [
      ['runs', 'start', IDS.agent],
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--prompt-file', promptFile],
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--model', 'no-colon'],
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--wait', '--follow'],
    ]) {
      const refused = await runCli(argv);
      expect(refused.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(refused.calls).toHaveLength(0);
    }
  });

  it('--wait follows the stream and prints the settled record', async () => {
    const run = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--wait', '--json'], {
      route: runRoutes,
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      `POST /api/agents/${IDS.agent}/runs`,
      `GET /api/runs/${IDS.run}/events`,
      `GET /api/runs/${IDS.run}`,
    ]);
    expect(RunResourceSchema.parse(stdoutJson(run)).status).toBe('completed');
    expect(run.stderr).toBe(`run ${IDS.run} started\n`);
  });

  it('--follow renders AgentEvents for a human, or as JSON lines, or the raw frames', async () => {
    const human = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--follow', '--quiet'],
      { route: runRoutes },
    );
    expect(human.code).toBe(EXIT_CODE.ok);
    expect(human.stderr).toBe('');
    expect(human.stdout).toBe(`${HUMAN_LINES.join('\n')}\n`);

    const jsonl = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--follow', '--jsonl'],
      { route: runRoutes },
    );
    const lines = jsonl.stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line['frame'] ?? line['kind'])).toEqual([
      'run-status',
      'agent.session',
      'agent.message',
      'agent.tool.call',
      'agent.tool.result',
      'agent.usage',
      'agent.result',
      'run-status',
    ]);
    expect(lines[1]).toMatchObject({ engine: ENGINE, engineSessionId: 'ses_abc' });

    const raw = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--follow', '--raw'], {
      route: runRoutes,
    });
    const frames = raw.stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // A platform frame prints as itself — it has no engine behind it — and every agent frame
    // prints the engine-native payload its `raw` carried.
    expect(frames.map((one) => one['kind'] ?? one['type'])).toEqual([
      'run-status',
      'relayed',
      'relayed',
      'relayed',
      'relayed',
      'relayed',
      'relayed',
      'run-status',
    ]);
  });
});

describe('aw runs start: typed refusals and --fail-on-error (issue #393)', () => {
  const FAILED_ERROR = 'model_connection_unresolved: no workspace default is configured.';
  const FAILED_STREAM =
    'retry: 3000\n\n' +
    frame('run.status', 1, { status: 'running', error: null }) +
    frame('run.status', 2, { status: 'failed', error: FAILED_ERROR }) +
    'event: done\ndata: null\n\n';
  const failedRoutes: Route = (request) => {
    if (request.method === 'POST')
      return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
    if (request.url.pathname.endsWith('/events')) return eventStream(FAILED_STREAM);
    return json(200, { run: { ...runFixture('failed'), error: FAILED_ERROR } });
  };

  it('prints the refusal code of a run start the server refused before queueing', async () => {
    const run = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--follow'], {
      route: () =>
        json(422, {
          error: {
            code: 'agent_runtime_profile_missing',
            message: 'agent "General" has no runtime profile.',
          },
        }),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: agent_runtime_profile_missing: agent "General" has no runtime profile.\n',
    );
  });

  it('exits 0 on a failed run by default, and 1 with its code under --fail-on-error', async () => {
    const tolerant = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--follow'], {
      route: failedRoutes,
    });
    expect(tolerant.code).toBe(EXIT_CODE.ok);

    const strict = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--follow', '--fail-on-error', '--quiet'],
      { route: failedRoutes },
    );
    expect(strict.code).toBe(EXIT_CODE.problem);
    expect(strict.stderr).toBe(
      `error: model_connection_unresolved: run ${IDS.run} failed: no workspace default is configured.\n` +
        'fix: on aw dev, set ANTHROPIC_API_KEY to a valid Anthropic key and restart aw dev; ' +
        "elsewhere, set the model connection's key under Models\n",
    );

    const waited = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--wait', '--fail-on-error', '--quiet'],
      { route: failedRoutes },
    );
    expect(waited.code).toBe(EXIT_CODE.problem);
    expect(waited.stderr).toContain('error: model_connection_unresolved: ');
  });

  it('refuses --fail-on-error without --wait or --follow', async () => {
    const refused = await runCli(['runs', 'start', IDS.agent, '--prompt', 'x', '--fail-on-error']);
    expect(refused.code).toBe(EXIT_CODE.usage);
    expect(refused.calls).toHaveLength(0);
  });

  it('passes a completed run under --fail-on-error', async () => {
    const run = await runCli(
      ['runs', 'start', IDS.agent, '--prompt', 'x', '--follow', '--fail-on-error', '--quiet'],
      { route: runRoutes },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
  });
});

describe('aw runs get / list / events / follow / wait', () => {
  it('shows settled usage with no price as unpriced, not as a zero cost (BH061-074)', async () => {
    const unpriced = { ...runFixture('completed'), accountingState: 'complete' };
    const human = await runCli(['runs', 'get', IDS.run], {
      route: () => json(200, { run: unpriced }),
    });
    expect(human.stdout).toMatch(/cost\s+unpriced \(no price for this model\)/u);
    const raw = await runCli(['runs', 'get', IDS.run, '--json'], {
      route: () => json(200, { run: unpriced }),
    });
    expect(RunResourceSchema.parse(stdoutJson(raw)).cost.amount).toBe('0.000000');
  });

  it('get and list round-trip; list renders the page for a human with a next-page hint', async () => {
    const get = await runCli(['runs', 'get', IDS.run, '--json'], { route: runRoutes });
    expect(RunResourceSchema.parse(stdoutJson(get))).toEqual(runFixture('completed'));
    const page = { runs: [runFixture('completed')], nextCursor: 'abc' };
    const list = await runCli(
      ['runs', 'list', '--status', 'completed', '--agent', IDS.agent, '--limit', '1', '--json'],
      {
        route: () => json(200, page),
      },
    );
    expect(list.calls[0]?.url.search).toBe(`?status=completed&agent=${IDS.agent}&limit=1`);
    expect(RunListResponseSchema.parse(stdoutJson(list))).toEqual(page);
    const human = await runCli(['runs', 'list'], { route: () => json(200, page) });
    expect(human.stdout).toContain('completed');
    expect(human.stderr).toBe('next page: --cursor abc\n');
    // BH061-042: --jsonl prints one run per line, as `agents list --jsonl` does; the cursor is a notice.
    const jsonl = await runCli(['runs', 'list', '--jsonl'], { route: () => json(200, page) });
    expect(jsonl.stdout).toBe(`${JSON.stringify(runFixture('completed'))}\n`);
    expect(jsonl.stderr).toBe('next page: --cursor abc\n');
  });

  it('events and follow stream an existing run; --after resumes with Last-Event-ID', async () => {
    const events = await runCli(['runs', 'events', IDS.run, '--after', '3'], { route: runRoutes });
    expect(events.code).toBe(EXIT_CODE.ok);
    expect(events.calls[0]?.headers.get('last-event-id')).toBe('3');
    expect(events.stdout).toBe(`${HUMAN_LINES.join('\n')}\n`);
    const follow = await runCli(['runs', 'follow', IDS.run], { route: runRoutes });
    expect(follow.calls[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(follow.stdout).toBe(`${HUMAN_LINES.join('\n')}\n`);
  });

  it('a run-failed frame is rendered and the stream still ends cleanly', async () => {
    const run = await runCli(['runs', 'events', IDS.run], {
      route: () =>
        eventStream(
          frame('run.status', 1, { status: 'running', error: null }) +
            frame('run-failed', null, { status: 'failed', message: 'The runtime exited.' }) +
            'event: done\ndata: null\n\n',
        ),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('run: running\nrun failed: The runtime exited. (status failed)\n');
  });

  it('wait prints the settled record', async () => {
    const run = await runCli(['runs', 'wait', IDS.run], { route: runRoutes });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toMatch(/^status\s+completed$/mu);
  });
});

describe('aw runs interrupt (issue #235, S-14)', () => {
  it('prints the run and exits 0', async () => {
    const response = await runCli(['runs', 'interrupt', IDS.run, '--json'], {
      route: (request) => {
        expect(request.method).toBe('POST');
        expect(request.url.pathname).toBe(`/api/runs/${IDS.run}/interrupt`);
        return json(200, { run: runFixture('cancelled') });
      },
    });
    expect(response.code).toBe(EXIT_CODE.ok);
    expect(RunResourceSchema.parse(stdoutJson(response))).toEqual(runFixture('cancelled'));
  });

  it('exits 1 naming the problem code for an already-terminal run', async () => {
    const response = await runCli(['runs', 'interrupt', IDS.run], {
      route: () =>
        json(409, {
          error: { code: 'run_not_interruptible', message: 'run is already completed.' },
        }),
    });
    expect(response.code).toBe(EXIT_CODE.problem);
    expect(response.stderr).toContain('error: run_not_interruptible: run is already completed.');
  });
});

describe('aw runs rate (issue #665)', () => {
  it('posts a thumbs-down with its comment and exits 0', async () => {
    const bodies: unknown[] = [];
    const response = await runCli(['runs', 'rate', IDS.run, '--down', '--comment', 'wrong'], {
      route: (request) => {
        expect(request.method).toBe('POST');
        expect(request.url.pathname).toBe(`/api/runs/${IDS.run}/feedback`);
        bodies.push(request.json);
        return new Response(null, { status: 204 });
      },
    });
    expect(response.code).toBe(EXIT_CODE.ok);
    expect(bodies).toEqual([{ rating: 'down', comment: 'wrong' }]);
    expect(response.stderr).toContain(`run ${IDS.run} rated down`);
  });

  it('posts a thumbs-up without a comment', async () => {
    const bodies: unknown[] = [];
    const response = await runCli(['runs', 'rate', IDS.run, '--up'], {
      route: (request) => {
        bodies.push(request.json);
        return new Response(null, { status: 204 });
      },
    });
    expect(response.code).toBe(EXIT_CODE.ok);
    expect(bodies).toEqual([{ rating: 'up' }]);
  });

  it.each([[[]], [['--up', '--down']]])('refuses %j as a usage error', async (flags) => {
    const response = await runCli(['runs', 'rate', IDS.run, ...flags], {
      route: () => {
        throw new Error('no request expected');
      },
    });
    expect(response.code).toBe(EXIT_CODE.usage);
    expect(response.stderr).toContain('pass one of --up or --down');
  });
});

describe('aw runs follow --interrupt-on-cancel (issue #235, S-14, spec §7.3)', () => {
  /** A stream that stays open until `close()` is called — the fetch double's route holds it. */
  function openStream(): {
    readonly response: Response;
    push(text: string): void;
    close(): void;
  } {
    const encoder = new TextEncoder();
    let live: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        live = controller;
      },
    });
    return {
      response: new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      }),
      push: (text) => live.enqueue(encoder.encode(text)),
      close: () => live.close(),
    };
  }

  it('interrupts on a fresh signal and exits 130, making exactly one interrupt call', async () => {
    const stream = openStream();
    let interrupts = 0;
    const controller = new AbortController();
    const promise = runCli(['runs', 'follow', IDS.run, '--interrupt-on-cancel'], {
      signal: controller.signal,
      route: (request) => {
        if (request.url.pathname.endsWith('/interrupt')) {
          interrupts += 1;
          // The interrupt call must not itself be pre-aborted by the follow's own signal.
          expect(request.signal?.aborted).toBe(false);
          return json(200, { run: runFixture('cancelled') });
        }
        return stream.response;
      },
    });
    stream.push(frame('run.status', 1, { status: 'running', error: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await promise;
    expect(result.code).toBe(EXIT_CODE.interrupted);
    expect(interrupts).toBe(1);
  });

  it('bounds the interrupt, so a control plane that never answers still exits 130', async () => {
    const stream = openStream();
    const attached: { signal?: AbortSignal | null } = {};
    const controller = new AbortController();
    const promise = runCli(['runs', 'follow', IDS.run, '--interrupt-on-cancel'], {
      signal: controller.signal,
      route: (request) => {
        if (!request.url.pathname.endsWith('/interrupt')) return stream.response;
        // Accepted and never answered — a stalled control plane, in one fixture. Nothing but the
        // interrupt call's own deadline can end it, and SIGINT's handler is already gone.
        attached.signal = request.signal;
        return new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('the interrupt call was aborted'));
          });
        });
      },
    });
    stream.push(frame('run.status', 1, { status: 'running', error: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await promise;
    expect(result.code).toBe(EXIT_CODE.interrupted);
    expect(attached.signal?.aborted).toBe(true);
    // The deadline is real time, so this case outlives the default per-test budget.
  }, 15_000);

  it('without the flag, a cancelled follow still exits 130 but calls no interrupt', async () => {
    const stream = openStream();
    let interrupts = 0;
    const controller = new AbortController();
    const promise = runCli(['runs', 'follow', IDS.run], {
      signal: controller.signal,
      route: (request) => {
        if (request.url.pathname.endsWith('/interrupt')) interrupts += 1;
        return stream.response;
      },
    });
    stream.push(frame('run.status', 1, { status: 'running', error: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await promise;
    expect(result.code).toBe(EXIT_CODE.interrupted);
    expect(interrupts).toBe(0);
  });
});
