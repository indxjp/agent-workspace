import { describe, expect, it } from 'vitest';

import { main, type CliIo } from '@indx-workspace/aw';

import { asRecord, asString, loadVectors } from './vectors.js';

const commandVectors = loadVectors('cli-runs', 'commands.json');
const startVectors = loadVectors('cli-runs', 'start.json');
const promptVectors = loadVectors('cli-runs', 'prompt.json');
const outputVectors = loadVectors('cli-runs', 'output.json');
const flagVectors = loadVectors('cli-runs', 'flags.json');
const waitVectors = loadVectors('cli-runs', 'wait.json');
const exitVectors = loadVectors('cli-runs', 'exits.json');
const stderrVectors = loadVectors('cli-runs', 'stderr.json');

const agent = '11111111-1111-4111-8111-111111111111';
const runId = '33333333-3333-4333-8333-333333333333';
const session = '55555555-5555-4555-8555-555555555555';
const workspace = '44444444-4444-4444-8444-444444444444';

const run = (status: string) => ({
  id: runId,
  workspaceId: workspace,
  agentId: agent,
  projectId: null,
  initiatingUserId: null,
  sessionId: session,
  agentVersion: null,
  status,
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  error: null,
  output: null,
  pendingApproval: null,
  accountingState: 'pending',
  accountingError: null,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const stream = (body = 'event: done\ndata: null\n\n') =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly signal: AbortSignal | null;
}

async function runMain(
  argv: readonly string[],
  route: (call: Call) => Response | Promise<Response>,
  options: { stdin?: string; signal?: AbortSignal; throwOnStdout?: boolean } = {},
) {
  const calls: Call[] = [];
  let stdout = '';
  let stderr = '';
  const fetchDouble: typeof fetch = async (input, init = {}) => {
    const call: Call = {
      url: input instanceof Request ? new URL(input.url) : new URL(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      headers: new Headers(init.headers),
      signal: init.signal ?? null,
    };
    calls.push(call);
    return route(call);
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(options.stdin ?? ''),
    stdout: (text) => {
      if (options.throwOnStdout) throw new Error('output failed');
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {
      AGENT_WORKSPACE_URL: 'https://aw.example.com',
      AGENT_WORKSPACE_API_KEY: 'ak_live_test',
    },
    homeDir: 'C:/nonexistent-home',
    fetch: fetchDouble,
    isTty: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, calls };
}

const successRoute = ({ url, method }: Call): Response => {
  if (method === 'POST' && url.pathname.endsWith('/runs'))
    return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
  if (url.pathname.endsWith('/events')) return stream();
  if (url.pathname.endsWith('/interrupt')) return json(200, { run: run('cancelled') });
  if (url.pathname === '/api/runs')
    return json(200, { runs: [run('completed')], nextCursor: 'next' });
  return json(200, { run: run('completed') });
};

describe('B-cli-runs through the public main/CliIo boundary', () => {
  it.each(commandVectors)('replays $id command dispatch', async ({ id, input, expected }) => {
    const command = asString(asRecord(input, id)['command'], 'command');
    const argv =
      command === 'start'
        ? ['runs', 'start', agent, '--prompt', 'go', '--json']
        : command === 'list'
          ? ['runs', 'list', '--json']
          : ['runs', command, runId, '--json'];
    const observed = await runMain(argv, successRoute);
    expect(observed.code).toBe(0);
    const sdkCall = asString(asRecord(expected, id)['sdkCall'], 'sdkCall');
    expect(observed.calls.length).toBeGreaterThan(0);
    const first = observed.calls[0];
    if (first === undefined) throw new Error('command made no request');
    if (sdkCall === 'start') expect(first.url.pathname).toBe(`/api/agents/${agent}/runs`);
    else if (sdkCall === 'list') expect(first.url.pathname).toBe('/api/runs');
    else if (sdkCall === 'events' || sdkCall === 'follow' || sdkCall === 'waitForOutcome')
      expect(first.url.pathname).toBe(`/api/runs/${runId}/events`);
    else if (sdkCall === 'interrupt')
      expect(first.url.pathname).toBe(`/api/runs/${runId}/interrupt`);
    else expect(first.url.pathname).toBe(`/api/runs/${runId}`);
  });

  it.each(startVectors)('replays $id start mode', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const mode = asString(asRecord(expected, id)['mode'], 'mode');
    const argv = ['runs', 'start', agent, '--prompt', 'go', '--json'];
    if (fields['wait'] === true) argv.push('--wait');
    if (fields['follow'] === true) argv.push('--follow');
    const observed = await runMain(argv, successRoute);
    expect(observed.code).toBe(mode === 'invalid' ? 2 : 0);
    expect(observed.calls.map((call) => call.url.pathname)).toEqual(
      mode === 'invalid'
        ? []
        : mode === 'plain'
          ? [`/api/agents/${agent}/runs`]
          : mode === 'follow'
            ? [`/api/agents/${agent}/runs`, `/api/runs/${runId}/events`]
            : [`/api/agents/${agent}/runs`, `/api/runs/${runId}/events`, `/api/runs/${runId}`],
    );
    const modeledCalls = asRecord(expected, id)['calls'];
    expect(modeledCalls).toEqual(
      mode === 'invalid'
        ? []
        : mode === 'plain'
          ? ['start']
          : mode === 'wait'
            ? ['start', 'waitForOutcome']
            : ['start', 'follow'],
    );
  });

  it.each(promptVectors)('replays $id prompt source', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const argv = ['runs', 'start', agent];
    if (fields['inline'] === true) argv.push('--prompt', 'inline');
    if (fields['file'] === true) argv.push('--prompt-file', asString(fields['path'], 'path'));
    const observed = await runMain(argv, successRoute, { stdin: 'from stdin' });
    const source = asString(modeled['source'], 'source');
    const refused =
      source === 'missing' || source === 'conflict' || modeled['fileFailure'] === true;
    expect(observed.code).toBe(refused ? 2 : 0);
    expect(observed.calls).toHaveLength(refused ? 0 : 1);
    if (source === 'stdin') expect(observed.calls[0]?.body).toMatchObject({ prompt: 'from stdin' });
  });

  it.each(outputVectors)('replays $id output mode', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    const modeled = asRecord(expected, id);
    const flags = [
      ...(fields['raw'] === true ? ['--raw'] : []),
      ...(fields['json'] === true ? ['--json'] : []),
      ...(fields['jsonl'] === true ? ['--jsonl'] : []),
      ...(fields['quiet'] === true ? ['--quiet'] : []),
    ];
    const frame =
      'event: agent.session\nid: 1\ndata: {"frame":"agent.session","engine":"claude-agent-sdk",' +
      '"raw":{"type":"system","subtype":"init"},"engineSessionId":"sid","model":null}' +
      '\n\nevent: done\ndata: null\n\n';
    const streamed = await runMain(['runs', 'events', runId, ...flags], () => stream(frame));
    const mode = asString(modeled['streamMode'], 'streamMode');
    if (mode === 'human') expect(streamed.stdout).toBe('session sid\n');
    // `--raw` is the engine's own words; `--json`/`--jsonl` are the neutral event (ENG-03, #302).
    else if (mode === 'raw') expect(streamed.stdout).toContain('"subtype":"init"');
    else expect(streamed.stdout).toContain('"frame":"agent.session"');
    const listed = await runMain(['runs', 'list', ...flags], successRoute);
    const recordMode = asString(modeled['recordMode'], 'recordMode');
    if (recordMode === 'human') expect(listed.stdout).toContain('agentId');
    else if (recordMode === 'jsonl') expect(JSON.parse(listed.stdout)).toHaveProperty('agentId');
    else expect(JSON.parse(listed.stdout)).toMatchObject({ nextCursor: 'next' });
    const modeledNotice = asRecord(expected, id)['notice'];
    expect(listed.stderr.trimEnd().split('\n').filter(Boolean)).toEqual(modeledNotice);
  });

  it.each(flagVectors)('replays $id run flags', async ({ id, input, expected }) => {
    const fields = asRecord(input, id);
    if (id === 'resume') {
      const observed = await runMain(
        ['runs', 'events', 'r', '--after', asString(fields['after'], 'after')],
        () => stream(),
      );
      const headers = [
        ['accept', observed.calls[0]?.headers.get('accept')],
        ['last-event-id', observed.calls[0]?.headers.get('last-event-id')],
      ];
      expect(headers).toEqual(expected);
    } else {
      const observed = await runMain(
        [
          'runs',
          'list',
          '--status',
          asString(fields['status'], 'status'),
          '--agent',
          asString(fields['agent'], 'agent'),
          '--project',
          asString(fields['project'], 'project'),
          '--limit',
          String(fields['limit']),
          '--cursor',
          asString(fields['cursor'], 'cursor'),
        ],
        successRoute,
      );
      expect(Array.from(observed.calls[0]?.url.searchParams.entries() ?? [])).toEqual(expected);
    }
  });

  it.each(waitVectors)(
    'replays $id settled wait exit divergence',
    async ({ id, input, expected }) => {
      const status = asString(asRecord(input, id)['status'], 'status');
      const current = asRecord(expected, id)['currentExit'];
      const observed = await runMain(['runs', 'wait', runId, '--json'], ({ url }) =>
        url.pathname.endsWith('/events') ? stream() : json(200, { run: run(status) }),
      );
      expect(observed.code).toBe(current);
      expect(JSON.parse(observed.stdout)).toMatchObject({ status });
    },
  );

  it.each(exitVectors)('replays $id failure exit', async ({ id, input, expected }) => {
    const failure = asString(asRecord(input, id)['failure'], 'failure');
    const modeledExit = asRecord(expected, id)['exit'];
    const observed =
      failure === 'usage'
        ? await runMain(['runs', 'start', agent], successRoute)
        : failure === 'unexpected'
          ? await runMain(['runs', 'get', runId], successRoute, { throwOnStdout: true })
          : await runMain(['runs', 'get', runId], () => {
              if (failure === 'transport') throw new TypeError('offline');
              if (failure === 'contractViolation') return json(200, { run: { status: 'bad' } });
              return json(409, { error: { code: 'refused', message: 'no' } });
            });
    expect(observed.code).toBe(modeledExit);
    expect(observed.stderr).not.toBe('');
  });

  it('prints API details after the headline and suppresses them on SIGINT', async () => {
    const route = () =>
      json(409, {
        error: { code: 'conflict', message: 'try later', details: ['field: bad'] },
      });
    const refused = await runMain(['runs', 'get', runId], route);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe('error: conflict: try later\n  field: bad\n');
    const controller = new AbortController();
    controller.abort();
    const interrupted = await runMain(['runs', 'get', runId], route, {
      signal: controller.signal,
    });
    expect(interrupted.code).toBe(130);
    expect(interrupted.stderr).toBe('interrupted\n');
  });

  it.each(stderrVectors)('replays $id failure lines', async ({ id, input, expected }) => {
    const interrupted = asRecord(input, id)['interrupted'] === true;
    const controller = new AbortController();
    if (interrupted) controller.abort();
    const observed = await runMain(
      ['runs', 'get', runId],
      () =>
        json(409, {
          error: { code: 'conflict', message: 'try later', details: ['field: bad'] },
        }),
      { signal: controller.signal },
    );
    expect(observed.stderr.trimEnd().split('\n')).toEqual(expected);
  });

  it('reads stdin prompt, preserves model suffix, and refuses conflicting prompt sources', async () => {
    const observed = await runMain(
      [
        'runs',
        'start',
        agent,
        '--prompt-file',
        '-',
        '--model',
        'connection:model:variant',
        '--json',
      ],
      successRoute,
      { stdin: 'from stdin' },
    );
    expect(observed.code).toBe(0);
    expect(observed.calls[0]?.body).toMatchObject({
      prompt: 'from stdin',
      modelConnectionId: 'connection',
      model: 'model:variant',
    });
    const conflict = await runMain(
      ['runs', 'start', agent, '--prompt', 'inline', '--prompt-file', '-'],
      successRoute,
    );
    expect(conflict.code).toBe(2);
    expect(conflict.calls).toHaveLength(0);
  });

  it('prints the whole list page for JSON and rows plus cursor notice for a human', async () => {
    const structured = await runMain(['runs', 'list', '--json'], successRoute);
    expect(JSON.parse(structured.stdout)).toMatchObject({ nextCursor: 'next' });
    const human = await runMain(['runs', 'list'], successRoute);
    expect(human.stdout).toContain('agentId');
    expect(human.stderr).toBe('next page: --cursor next\n');
    const jsonl = await runMain(['runs', 'list', '--jsonl', '--quiet'], successRoute);
    expect(jsonl.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonl.stdout)).toHaveProperty('agentId');
    expect(jsonl.stderr).toBe('');
  });

  it('forwards list filters and refuses a malformed status before fetch', async () => {
    const filtered = await runMain(
      [
        'runs',
        'list',
        '--status',
        'completed',
        '--agent',
        agent,
        '--project',
        'project',
        '--limit',
        '2',
        '--cursor',
        'next',
        '--json',
      ],
      successRoute,
    );
    expect(filtered.code).toBe(0);
    expect(filtered.calls[0]?.url.search).toBe(
      `?status=completed&agent=${agent}&project=project&limit=2&cursor=next`,
    );
    const refused = await runMain(['runs', 'list', '--status', 'unknown'], successRoute);
    expect(refused.code).toBe(2);
    expect(refused.calls).toHaveLength(0);
  });

  it('prioritizes interrupted exit over a transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const observed = await runMain(
      ['runs', 'get', runId],
      () => {
        throw new TypeError('offline');
      },
      { signal: controller.signal },
    );
    expect(observed.code).toBe(130);
    expect(observed.stderr).toBe('interrupted\n');
  });

  it('sends the events resume header and gives raw frames precedence over JSON', async () => {
    const observed = await runMain(
      ['runs', 'events', runId, '--after', '7', '--raw', '--json'],
      () =>
        stream(
          'event: run.status\nid: 8\ndata: {"status":"running","error":null}\n\nevent: done\ndata: null\n\n',
        ),
    );
    expect(observed.code).toBe(0);
    expect(observed.calls[0]?.headers.get('last-event-id')).toBe('7');
    const lines = observed.stdout.trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'run-status',
    ]);
  });

  it('uses a fresh signal for courtesy interrupt after cancelled follow', async () => {
    const controller = new AbortController();
    const observed = await runMain(
      ['runs', 'follow', runId, '--interrupt-on-cancel'],
      ({ url }) => {
        if (url.pathname.endsWith('/events')) {
          controller.abort();
          throw new TypeError('stream dropped');
        }
        return json(200, { run: run('cancelled') });
      },
      { signal: controller.signal },
    );
    expect(observed.code).toBe(130);
    expect(observed.calls.map((call) => call.url.pathname)).toEqual([
      `/api/runs/${runId}/events`,
      `/api/runs/${runId}/interrupt`,
    ]);
    expect(observed.calls[1]?.signal?.aborted).toBe(false);
  });

  it('retains interrupted exit when the courtesy interrupt is refused', async () => {
    const controller = new AbortController();
    const observed = await runMain(
      ['runs', 'follow', runId, '--interrupt-on-cancel'],
      ({ url }) => {
        if (url.pathname.endsWith('/events')) {
          controller.abort();
          throw new TypeError('stream dropped');
        }
        return json(503, { error: { code: 'service_unavailable', message: 'later' } });
      },
      { signal: controller.signal },
    );
    expect(observed.code).toBe(130);
    expect(observed.calls).toHaveLength(2);
    expect(observed.stderr).toBe('interrupted\n');
  });

  it('start --wait exits zero after a failed settled run', async () => {
    const observed = await runMain(
      ['runs', 'start', agent, '--prompt', 'go', '--wait', '--json'],
      ({ url, method }) => {
        if (method === 'POST')
          return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
        if (url.pathname.endsWith('/events')) return stream();
        return json(200, { run: run('failed') });
      },
    );
    expect(observed.code).toBe(0);
    expect(JSON.parse(observed.stdout)).toMatchObject({ status: 'failed' });
  });
});
