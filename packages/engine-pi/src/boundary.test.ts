/**
 * The real pi coding agent, run through this adapter against a fake gateway (ENG-08, #307).
 *
 * The conformance kit drives the adapter with replayed events; this suite drives **pi** —
 * `createAgentSession`, its Anthropic client, its built-in tools, its `SessionManager` — against an
 * HTTP server that answers in the Anthropic Messages dialect. The fixtures are hand-authored from
 * the published event schema; no live credential is used. What the suite proves is the adapter's
 * half of each acceptance criterion:
 *
 *  * a run that reads and writes a file streams `agent.message.delta`, `agent.tool.call` /
 *    `agent.tool.result` and `agent.result {stopReason: 'end_turn'}`;
 *  * every request goes to the gateway with `Authorization: Bearer <run token>`; the `x-api-key`
 *    pi insists on is the public placeholder, even with a real-looking `ANTHROPIC_API_KEY` and an
 *    `ANTHROPIC_BASE_URL` in the runner's environment;
 *  * a write to a read-only grant — named directly, through `..` or through a symbolic link — is
 *    blocked as `agent.tool.result {status: 'failed'}` and the file is unchanged;
 *  * with `runCommands: false` the request's `tools` has no `bash`, and a `bash` call is blocked;
 *  * nothing under `~/.pi`, `~/.agents` or the project's own discovery paths is loaded, while the
 *    platform's placed skill is;
 *  * `bash` runs with the request's environment, never the runner's;
 *  * a second run on the session sends the first run's messages; a fork does too, under a new id;
 *  * `maxTurns` ends a looping agent `max_turns`, a spent budget `max_budget`, and an interrupt
 *    during `bash` ends the run `cancelled` promptly.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { EngineFrame, EngineRunRequest, EngineSessionStore } from '@agent-workspace/engine';
import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installedPiDefaultAnthropicModel, piRunSettings } from './boundary.js';
import { PI_DEFAULT_ANTHROPIC_MODEL, PI_GATEWAY_API_KEY_PLACEHOLDER } from './compile.js';
import { createPiEngine } from './engine.js';

const TOKEN = 'run-token-for-the-fake-gateway';
const SESSION_ID = '5b0c1f7e-8d2a-4c3b-9e1f-2a3b4c5d6e7f';

type Recorded = {
  readonly path: string;
  readonly authorization: string | null;
  readonly apiKeyHeader: string | null;
  readonly body: Record<string, unknown>;
};

/** One scripted model turn. */
type Turn = (
  | { readonly call: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly text: string }
) & {
  /** Prompt-cache write tokens the response reports (`cache_creation_input_tokens`). */
  readonly cacheWrite?: number;
};

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function messagesStream(turn: Turn, index: number): string {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${String(index)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        ...(turn.cacheWrite === undefined ? {} : { cache_creation_input_tokens: turn.cacheWrite }),
      },
    },
  };
  const block =
    'call' in turn
      ? [
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: `toolu_${String(index)}`,
              name: turn.call.name,
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.call.args) },
          },
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } },
        ];
  return sse([
    start,
    ...block,
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'call' in turn ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
}

/** A scripted refusal: the provider (or the gateway, with a `token_*` code) answers with a status. */
type Refusal = { readonly refuse: { readonly status: number; readonly code?: string } };

type Gateway = {
  readonly baseUrl: string;
  readonly requests: Recorded[];
  script(turns: readonly (Turn | Refusal)[]): void;
  close(): Promise<void>;
};

async function startGateway(): Promise<Gateway> {
  const requests: Recorded[] = [];
  let turns: readonly (Turn | Refusal)[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const index = requests.length;
      requests.push({
        path: new URL(request.url ?? '/', 'http://gateway.test').pathname,
        authorization: request.headers.authorization ?? null,
        apiKeyHeader: (request.headers['x-api-key'] as string | undefined) ?? null,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const turn = turns[index] ?? { text: 'Done.' };
      if ('refuse' in turn) {
        response.writeHead(turn.refuse.status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'refused', code: turn.refuse.code },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(messagesStream(turn, index));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    script(next) {
      turns = next;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let gateway: Gateway;
let decoy: Gateway;
let root: string;

beforeAll(async () => {
  gateway = await startGateway();
  decoy = await startGateway();
  root = mkdtempSync(path.join(tmpdir(), 'engine-pi-'));
});

afterAll(async () => {
  await gateway.close();
  await decoy.close();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let workspaceCount = 0;
function workspace(): string {
  workspaceCount += 1;
  const cwd = path.join(root, `ws-${String(workspaceCount)}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function baseRequest(cwd: string, overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'b6f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    sessionId: SESSION_ID,
    projectKey: 'pi-tenant',
    cwd,
    prompt: 'Read a.md and write b.md.',
    engine: 'pi',
    portable: {
      name: 'pi agent',
      instructions: 'PLATFORM INSTRUCTIONS: be terse.',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: gateway.baseUrl, token: TOKEN, protocol: 'anthropic-messages' },
    resources: { files: [], skills: [] },
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
    ...overrides,
  };
}

async function run(
  request: EngineRunRequest,
  store?: EngineSessionStore,
  onFrame?: (frame: EngineFrame, interrupt: () => Promise<void>) => void,
): Promise<EngineFrame[]> {
  const connection = createPiEngine().start(
    request,
    store === undefined ? {} : { sessionStore: store },
  );
  const frames: EngineFrame[] = [];
  for await (const frame of connection.frames) {
    frames.push(frame);
    onFrame?.(frame, () => connection.interrupt());
  }
  return frames;
}

function systemText(recorded: Recorded): string {
  return JSON.stringify(recorded.body['system'] ?? '');
}

function toolNames(recorded: Recorded): string[] {
  const tools = recorded.body['tools'];
  return Array.isArray(tools)
    ? tools.map((tool) => String((tool as Record<string, unknown>)['name']))
    : [];
}

function result(frames: readonly EngineFrame[]): EngineFrame | undefined {
  return frames.find((frame) => frame.frame === 'agent.result');
}

describe('pi through the adapter, against a fake gateway', () => {
  it('reads and writes a file, streaming the neutral frames, on the run token alone', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-a-real-looking-key-in-the-runner');
    vi.stubEnv('ANTHROPIC_BASE_URL', decoy.baseUrl);
    decoy.script([]);
    const cwd = workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'the source document');
    gateway.script([
      { call: { name: 'read', args: { path: 'a.md' } } },
      { call: { name: 'write', args: { path: 'b.md', content: 'the copy' } } },
      { text: 'Copied.' },
    ]);

    const frames = await run(baseRequest(cwd));

    expect(readFileSync(path.join(cwd, 'b.md'), 'utf8')).toBe('the copy');
    const names = frames.map((frame) => frame.frame);
    expect(names[0]).toBe('agent.session');
    expect(names).toContain('agent.message.delta');
    expect(frames.filter((frame) => frame.frame === 'agent.tool.call')).toHaveLength(2);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results.map((frame) => frame.frame === 'agent.tool.result' && frame.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(result(frames)).toMatchObject({ stopReason: 'end_turn', turns: 3 });
    expect(frames.every((frame) => frame.engine === 'pi')).toBe(true);

    expect(gateway.requests).toHaveLength(3);
    for (const recorded of gateway.requests) {
      expect(recorded.path).toBe('/v1/messages');
      expect(recorded.authorization).toBe(`Bearer ${TOKEN}`);
      expect(recorded.apiKeyHeader).toBe(PI_GATEWAY_API_KEY_PLACEHOLDER);
      expect(systemText(recorded)).toContain('PLATFORM INSTRUCTIONS: be terse.');
    }
    expect(decoy.requests).toHaveLength(0);
    expect(toolNames(gateway.requests[0] as Recorded).sort()).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ]);
  });

  it.each([401, 403] as const)(
    'fails fast and clearly when the provider answers %i, after one request',
    async (status) => {
      gateway.script([{ refuse: { status } }]);

      const failure = await run(baseRequest(workspace())).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        message: `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
      });
      expect(gateway.requests).toHaveLength(1);
    },
  );

  it("leaves the gateway's own token refusal as the plain model-call failure", async () => {
    gateway.script([{ refuse: { status: 401, code: 'token_expired' } }]);

    const failure = await run(baseRequest(workspace())).then(
      () => null,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("pi's model call failed");
    expect(String(failure)).not.toContain('model_credential_rejected');
  });

  it('blocks a write to a read-only grant — directly, through .. and through a link', async () => {
    const cwd = workspace();
    writeFileSync(path.join(cwd, 'locked.md'), 'original');
    mkdirSync(path.join(cwd, 'notes'));
    symlinkSync('../locked.md', path.join(cwd, 'notes', 'alias.md'));
    gateway.script([
      { call: { name: 'write', args: { path: 'locked.md', content: 'changed' } } },
      {
        call: {
          name: 'edit',
          args: {
            path: 'notes/../locked.md',
            edits: [{ oldText: 'original', newText: 'changed' }],
          },
        },
      },
      { call: { name: 'write', args: { path: 'notes/alias.md', content: 'changed' } } },
      { call: { name: 'write', args: { path: '../outside.md', content: 'escaped' } } },
      { text: 'Could not.' },
    ]);

    const frames = await run(
      baseRequest(cwd, {
        resources: { files: [{ kind: 'file', path: 'locked.md', access: 'read' }], skills: [] },
      }),
    );

    expect(readFileSync(path.join(cwd, 'locked.md'), 'utf8')).toBe('original');
    expect(existsSync(path.join(root, 'outside.md'))).toBe(false);
    const results = frames.filter((frame) => frame.frame === 'agent.tool.result');
    expect(results).toHaveLength(4);
    for (const frame of results) {
      expect(frame).toMatchObject({ status: 'failed', isError: true });
    }
    // A read-only grant withholds bash: a redirect would write the file the grant protects.
    expect(toolNames(gateway.requests[0] as Recorded)).not.toContain('bash');
  });

  it('offers no bash with runCommands off, and blocks a bash call the model invents', async () => {
    const cwd = workspace();
    gateway.script([
      { call: { name: 'bash', args: { command: 'touch ran.txt' } } },
      { text: 'ok' },
    ]);
    const request = baseRequest(cwd);
    const frames = await run({
      ...request,
      portable: {
        ...request.portable,
        permissions: { ...request.portable.permissions, runCommands: false },
      },
    });
    expect(toolNames(gateway.requests[0] as Recorded)).not.toContain('bash');
    expect(existsSync(path.join(cwd, 'ran.txt'))).toBe(false);
    const toolResults = frames.filter((frame) => frame.frame === 'agent.tool.result');
    for (const frame of toolResults) expect(frame).toMatchObject({ status: 'failed' });
  });

  it('loads the placed skill and nothing from ~/.pi, ~/.agents or project discovery', async () => {
    const home = path.join(root, 'hostile-home');
    const marker = path.join(root, 'hostile-extension-ran');
    const extension = `import { writeFileSync } from 'node:fs';\nexport default function () { writeFileSync(${JSON.stringify(marker)}, 'ran'); }\n`;
    const skill = (name: string): string =>
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n# ${name}\n`;
    for (const dir of [
      path.join(home, '.pi', 'agent', 'extensions'),
      path.join(home, '.pi', 'agent', 'skills', 'evil-home-skill'),
      path.join(home, '.agents', 'skills', 'evil-agents-skill'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path.join(home, '.pi', 'agent', 'extensions', 'evil.ts'), extension);
    writeFileSync(
      path.join(home, '.pi', 'agent', 'skills', 'evil-home-skill', 'SKILL.md'),
      skill('evil-home-skill'),
    );
    writeFileSync(
      path.join(home, '.agents', 'skills', 'evil-agents-skill', 'SKILL.md'),
      skill('evil-agents-skill'),
    );
    writeFileSync(path.join(home, '.pi', 'agent', 'AGENTS.md'), 'EVIL HOME CONTEXT');
    vi.stubEnv('HOME', home);

    const cwd = workspace();
    mkdirSync(path.join(cwd, '.agents', 'skills', 'evil-project-skill'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.agents', 'skills', 'evil-project-skill', 'SKILL.md'),
      skill('evil-project-skill'),
    );
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'evil.ts'), extension);
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'EVIL PROJECT CONTEXT');
    // What the runner writes from `placeSkills`: the one skill the platform granted.
    mkdirSync(path.join(cwd, '.pi', 'skills', 'good-skill'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'skills', 'good-skill', 'SKILL.md'), skill('good-skill'));

    gateway.script([{ text: 'Hello.' }]);
    const request = baseRequest(cwd, {
      resources: {
        files: [],
        skills: [{ name: 'good-skill', files: [{ path: 'SKILL.md', contentBase64: '' }] }],
      },
    });
    await run({
      ...request,
      env: { ...request.env, HOME: home },
      portable: { ...request.portable, skills: { mode: 'allowlist', names: ['good-skill'] } },
    });

    const system = systemText(gateway.requests[0] as Recorded);
    expect(system).toContain('good-skill');
    for (const hostile of [
      'evil-home-skill',
      'evil-agents-skill',
      'evil-project-skill',
      'EVIL HOME CONTEXT',
      'EVIL PROJECT CONTEXT',
    ]) {
      expect(system).not.toContain(hostile);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("runs bash in the request's environment, not the runner's", async () => {
    vi.stubEnv('RUNNER_ONLY_SECRET', 'must-not-leak');
    const cwd = workspace();
    gateway.script([
      {
        call: {
          name: 'bash',
          args: { command: 'echo "secret=[$RUNNER_ONLY_SECRET] mark=[$PLATFORM_MARK]"' },
        },
      },
      { text: 'ok' },
    ]);
    const request = baseRequest(cwd);
    const frames = await run({ ...request, env: { ...request.env, PLATFORM_MARK: 'given' } });
    const output = frames.find((frame) => frame.frame === 'agent.tool.result');
    expect(output).toMatchObject({ status: 'completed' });
    expect(output?.frame === 'agent.tool.result' ? output.output : '').toContain(
      'secret=[] mark=[given]',
    );
  });

  it('continues a session on a second run, and forks it under a new id', async () => {
    const store = createFakeSessionStore('accept');
    const cwd = workspace();
    gateway.script([{ text: 'FIRST ANSWER' }]);
    await run(baseRequest(cwd, { prompt: 'FIRST PROMPT' }), store);

    gateway.script([{ text: 'SECOND ANSWER' }]);
    const resumed = await run(
      baseRequest(cwd, {
        prompt: 'SECOND PROMPT',
        session: { mode: 'resume', engineSessionId: SESSION_ID },
      }),
      store,
    );
    const messages = JSON.stringify(gateway.requests[0]?.body['messages']);
    expect(messages).toContain('FIRST PROMPT');
    expect(messages).toContain('FIRST ANSWER');
    expect(messages).toContain('SECOND PROMPT');
    expect(resumed[0]).toMatchObject({ frame: 'agent.session', engineSessionId: SESSION_ID });

    const forkId = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
    gateway.script([{ text: 'FORKED ANSWER' }]);
    const forked = await run(
      baseRequest(cwd, {
        sessionId: forkId,
        prompt: 'FORK PROMPT',
        session: { mode: 'fork', engineSessionId: SESSION_ID },
      }),
      store,
    );
    expect(forked[0]).toMatchObject({ frame: 'agent.session', engineSessionId: forkId });
    expect(JSON.stringify(gateway.requests[0]?.body['messages'])).toContain('SECOND ANSWER');
    const forkStream = await store.load({ projectKey: 'pi-tenant', sessionId: forkId });
    expect(forkStream?.[0]).toMatchObject({
      type: 'session',
      id: forkId,
      parentSession: SESSION_ID,
    });
    const parentStream = await store.load({ projectKey: 'pi-tenant', sessionId: SESSION_ID });
    expect(JSON.stringify(parentStream)).not.toContain('FORK PROMPT');
  });

  it('stops a looping agent at maxTurns with max_turns', async () => {
    const cwd = workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'loop');
    gateway.script(
      Array.from({ length: 6 }, () => ({ call: { name: 'read', args: { path: 'a.md' } } })),
    );
    const request = baseRequest(cwd);
    const frames = await run({
      ...request,
      portable: { ...request.portable, limits: { maxTurns: 2, maxBudgetUsd: null } },
    });
    expect(result(frames)).toMatchObject({ stopReason: 'max_turns', turns: 2 });
    // No request for a third turn is ever sent.
    expect(gateway.requests).toHaveLength(2);
  });

  it('stops at the provisional budget cap with max_budget', async () => {
    const cwd = workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'loop');
    gateway.script(
      Array.from({ length: 6 }, () => ({ call: { name: 'read', args: { path: 'a.md' } } })),
    );
    const request = baseRequest(cwd);
    // claude-sonnet-4-5 at 3/15 USD per million: 10 in + 5 out is 0.000105 USD a response.
    const frames = await run({
      ...request,
      portable: { ...request.portable, limits: { maxTurns: null, maxBudgetUsd: 0.0002 } },
    });
    expect(result(frames)).toMatchObject({ stopReason: 'max_budget' });
    expect(gateway.requests.length).toBeLessThanOrEqual(3);
  });

  it('prices prompt-cache writes above the input rate, so they count against the cap', async () => {
    const cwd = workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'loop');
    gateway.script(
      Array.from({ length: 6 }, () => ({
        call: { name: 'read', args: { path: 'a.md' } },
        cacheWrite: 100,
      })),
    );
    const request = baseRequest(cwd);
    // 10 in + 5 out at 3/15 USD per million is 0.000105 USD; 100 cache-write tokens at 1.25 × 3
    // USD per million add 0.000375, so one response costs 0.00048 and passes a 0.00045 cap. At
    // the plain input rate it would cost 0.000405 and a second request would be sent.
    const frames = await run({
      ...request,
      portable: { ...request.portable, limits: { maxTurns: null, maxBudgetUsd: 0.00045 } },
    });
    expect(result(frames)).toMatchObject({ stopReason: 'max_budget' });
    expect(gateway.requests).toHaveLength(1);
  });

  it('ends an interrupted bash run cancelled, promptly', async () => {
    const cwd = workspace();
    gateway.script([{ call: { name: 'bash', args: { command: 'sleep 30' } } }]);
    const started = Date.now();
    const frames = await run(baseRequest(cwd), undefined, (frame, interrupt) => {
      if (frame.frame === 'agent.tool.call') void interrupt();
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result(frames)).toMatchObject({ stopReason: 'cancelled' });
  });

  it("restates pi's own default Anthropic model", async () => {
    expect(await installedPiDefaultAnthropicModel()).toBe(PI_DEFAULT_ANTHROPIC_MODEL);
  });

  it('starts every run with cache warming and install telemetry off', () => {
    expect(piRunSettings()).toEqual({ cacheWarming: 'off', installTelemetry: false });
  });
});
