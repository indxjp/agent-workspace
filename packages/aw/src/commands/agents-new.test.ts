import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentVersionBodySchema,
  AgentVersionResourceSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { AW_CONTROL_SERVER, BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, mcpToolName } from '@indx-workspace/contracts/engines';
import { AgentFrameSchema, RunStatusEventDataSchema } from '@indx-workspace/contracts/run-events';
import { defineAgent, toAgentVersionBody } from '@indx-workspace/sdk/define';
import { diffBodies } from '@indx-workspace/sdk/portable';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { InterruptedError } from '../io.js';
import { EXIT_CODE } from '../output.js';
import {
  eventStream,
  FIXTURES,
  IDS,
  json,
  runCli,
  runFixture,
  tempDirectory,
  tempFile,
  type CliRun,
  type Route,
} from '../testing.js';

// The real diff, except where a test hands one call a change the contracts do not produce yet.
vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});

// `aw check` runs the real project loader, a forked Node process.
vi.setConfig({ testTimeout: 30_000 });

const ARGV = ['agents', 'new', '--from-prompt', 'Build a refunds helper'];
const MESSAGE = 'aw agents new --from-prompt needs a terminal to approve the save';
const DISABLED = 'the Builder is not enabled for this workspace';
const TERMINAL = { isTty: true, stdinIsTty: true } as const;
const PROJECT_SOURCE =
  'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: built\n' +
  'environments:\n  local:\n    cloud: local\n    identity:\n      bootstrapAdmin: admin@localhost.test\n';

const BUILDER = { ...FIXTURES.agent, id: IDS.connection, name: 'Builder', builtin: 'builder' };
const NEXT_RUN = '33333333-3333-4333-8333-333333333334';
const SAVE = 'Save this draft? [y/N] ';
const CHAT = '> ';
const THIRD_RUN = '33333333-3333-4333-8333-333333333335';
const CAP = `at most $${BUILDER_DEFAULT_LIMITS.trialBudgetUsd.toFixed(2)}`;

const bodyOf = (instructions: string): AgentVersionBody =>
  AgentVersionBodySchema.parse(
    toAgentVersionBody(defineAgent({ name: 'summariser', instructions })),
  );

const tool = (name: string): string =>
  mcpToolName(ENGINE_CATALOGUE['claude-agent-sdk'].mcpToolName, AW_CONTROL_SERVER, name);

// The CLI test server replays canned events, so each one is parsed through the contracts event
// schemas here: a drift in a frame's shape fails this suite instead of passing on a stale fixture.
const frame = (event: string, id: number, data: unknown): string =>
  `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
const agentFrame = (id: number, data: Record<string, unknown> & { frame: string }): string =>
  frame(data.frame, id, AgentFrameSchema.parse({ engine: 'claude-agent-sdk', raw: {}, ...data }));
const status = (id: number, value: string): string =>
  frame('run.status', id, RunStatusEventDataSchema.parse({ status: value, error: null }));
const DONE = 'event: done\ndata: null\n\n';

const message = (text: string): string =>
  agentFrame(1, {
    frame: 'agent.message',
    messageId: 'm1',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  });

type Pending = { toolName: string; canonicalCall: string };
const call = (name: string, input: unknown): Pending => ({
  toolName: tool(name),
  canonicalCall: JSON.stringify({ input, name: tool(name) }),
});

const result = (output: unknown): string =>
  agentFrame(1, {
    frame: 'agent.tool.result',
    toolCallId: 't1',
    status: 'completed',
    output: JSON.stringify(output),
    isError: false,
  });
const answered = (output: unknown, end = 'completed'): string =>
  result(output) + status(2, end) + DONE;

const SAVED = { ok: true, agentId: IDS.agent, version: 1, pointer: 'local', awCommand: 'aw x' };

interface Script {
  /** The versions the agent has, oldest first. */
  versions?: AgentVersionBody[];
  /** Frames ahead of the approval request. */
  before?: string;
  /** What the run streams after the decision. */
  after?: string;
  /** A second call the Builder pauses on after the first is decided. */
  then?: Pending;
  /** What the trial's agent is called. */
  agentName?: string;
  /** The status, and the `error`, the continuation ends in. */
  ended?: string;
  error?: string;
}

/** The Builder agent and one run that pauses on `pending`; the continuation streams `after`. */
function builder(pending: Pending, script: Script = {}): Route {
  const { versions = [], before = '', after = status(1, 'completed') + DONE } = script;
  const { ended = 'completed', error = null } = script;
  const items = versions.map((body, index) =>
    AgentVersionResourceSchema.parse({
      id: `v-${String(index + 1)}`,
      agentId: IDS.agent,
      workspaceId: IDS.workspace,
      number: index + 1,
      summary: 's',
      via: 'api',
      body,
      createdByPrincipalId: IDS.principal,
      createdAt: '2026-10-25T10:00:00.000Z',
    }),
  );
  const accepted = (id: string) => json(202, { run: { ...runFixture('queued'), id }, events: id });
  return ({ method, url }) => {
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /api/agents') return json(200, { agents: [BUILDER] });
    if (route === `POST /api/agents/${BUILDER.id}/runs`) return accepted(IDS.run);
    if (route === `GET /api/runs/${IDS.run}/events`) {
      const request = agentFrame(3, {
        frame: 'agent.approval.requested',
        toolCallId: 't1',
        ...pending,
      });
      return eventStream(before + request + status(4, 'awaiting_approval') + DONE);
    }
    if (route === `GET /api/runs/${IDS.run}`) {
      return json(200, { run: { ...runFixture('awaiting_approval'), pendingApproval: pending } });
    }
    if (route === `POST /api/runs/${IDS.run}/approval`) return accepted(NEXT_RUN);
    if (route === `GET /api/runs/${NEXT_RUN}/events`) {
      if (script.then === undefined) return eventStream(after);
      const request = agentFrame(5, {
        frame: 'agent.approval.requested',
        toolCallId: 't2',
        ...script.then,
      });
      return eventStream(after + request + status(6, 'awaiting_approval') + DONE);
    }
    if (route === `GET /api/runs/${NEXT_RUN}`) {
      const waiting = { id: NEXT_RUN, status: 'awaiting_approval', pendingApproval: script.then };
      return json(200, { run: { ...runFixture(ended), error, ...(script.then && waiting) } });
    }
    if (route === `POST /api/runs/${NEXT_RUN}/approval`) return accepted(THIRD_RUN);
    if (route === `GET /api/runs/${THIRD_RUN}/events`)
      return eventStream(status(1, 'completed') + DONE);
    if (route === `GET /api/runs/${THIRD_RUN}`) return json(200, { run: runFixture('completed') });
    if (route === `GET /api/agents/${IDS.agent}`) {
      return json(200, { ...FIXTURES.agent, name: script.agentName ?? 'Refunds' });
    }
    if (route.endsWith('/interrupt')) return json(200, { run: runFixture('interrupted') });
    if (route === `GET /api/agents/${IDS.agent}/versions`) {
      return json(200, { items, pointers: [], materialised: null });
    }
    return json(404, { error: { code: 'not_found', message: 'no route', details: [] } });
  };
}

/** Runs the command until the Builder pauses on `pending`; the person gives `answers` in order. */
async function ask(
  pending: Pending,
  answers: readonly string[],
  script: Script & { out?: string } = {},
) {
  const asked: string[] = [];
  const remaining = [...answers];
  const out = script.out === undefined ? [] : ['--out', script.out];
  const run = await runCli([...ARGV, ...out], {
    ...TERMINAL,
    prompt: (question) => {
      // The chat's own `> ` prompt is not an approval; the person has nothing more to say.
      if (question === CHAT) return Promise.resolve('');
      asked.push(question);
      return Promise.resolve(remaining.shift() ?? '');
    },
    route: builder(pending, script),
  });
  return { run, asked };
}

const decisions = (run: CliRun): unknown[] =>
  run.calls.filter((request) => request.url.pathname.endsWith('/approval')).map((r) => r.json);

/** Characters a terminal would act on: everything below space but tab and newline, DEL and C1. */
const controls = (text: string): string[] =>
  [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
  });

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function project(): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  await tempFile(root, 'agent-workspace.yaml', PROJECT_SOURCE);
  return root;
}

describe('aw agents new --from-prompt', () => {
  it.each([
    ['neither stdin nor stdout is a terminal', { isTty: false, stdinIsTty: false }],
    ['stdout is a terminal but stdin is piped', { isTty: true, stdinIsTty: false }],
    ['stdin is a terminal but stdout is redirected', { isTty: false, stdinIsTty: true }],
  ])('[US-BLD-06][api][cli] refuses before any request when %s', async (_name, tty) => {
    const route: Route = () => {
      throw new Error('the command must not reach the network');
    };
    const run = await runCli(ARGV, { ...tty, route, prompt: () => Promise.resolve('y') });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(MESSAGE);
    expect(run.calls).toEqual([]);
  });

  it('[US-BLD-06][api][cli] y saves once and exports files that pass aw check', async () => {
    const out = await project();
    const body = bodyOf('Refund politely.');
    const { run, asked } = await ask(call('draft_save', { body }), ['y'], {
      out,
      after: answered(SAVED),
      versions: [body],
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(asked).toEqual([SAVE]);
    expect(run.stdout).toContain('Save a new agent named "summariser":');
    expect(decisions(run)).toEqual([{ decision: 'approve' }]);
    expect(await readFile(path.join(out, 'agents', 'summariser.md'), 'utf8')).toBe(
      'Refund politely.',
    );
    const checked = await runCli(['check'], {
      cwd: out,
      route: ({ method, url }) =>
        method === 'POST'
          ? json(200, { ok: true, number: 1 })
          : json(200, url.pathname === '/api/agents' ? { agents: [] } : { connectors: [] }),
    });
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(EXIT_CODE.ok);
  });

  it.each(['n', '', 'yes', 'Maybe'])(
    '[US-BLD-06][api][cli] %j saves nothing and writes no files',
    async (answer) => {
      const out = await project();
      const { run } = await ask(call('draft_save', { body: bodyOf('x') }), [answer], { out });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(decisions(run)).toEqual([{ decision: 'reject' }]);
      expect(run.stdout).toContain('No draft was saved.');
      expect(run.calls.some((request) => request.url.pathname.endsWith('/versions'))).toBe(false);
      expect(await readdir(out)).toEqual(['agent-workspace.yaml']);
    },
  );

  it('prints the diff against the base version', async () => {
    const draft = { agentId: IDS.agent, baseVersion: 1, body: bodyOf('new'), summary: 'tighten' };
    const { run } = await ask(call('draft_save', draft), [], { versions: [bodyOf('old')] });
    expect(run.stdout).toContain(`Save changes to agent ${IDS.agent} on top of version 1:`);
    expect(run.stdout).toContain('"old" -> "new"');
    expect(run.stdout).toContain('Summary: "tighten"');
  });

  it.each([
    ['an agent the caller cannot read', { agentId: IDS.connection, baseVersion: 1 }],
    ['a base version that is not in the listing', { agentId: IDS.agent, baseVersion: 5 }],
    ['a call it cannot read', { nope: 1 }],
  ])('refuses without asking a save on top of %s', async (_name, draft) => {
    const pending = call('draft_save', { ...draft, body: bodyOf('new') });
    const { run, asked } = await ask(pending, [], { versions: [bodyOf('old')] });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(asked).toEqual([]);
    expect(decisions(run)).toEqual([{ decision: 'reject' }]);
  });

  it('[US-BLD-06][api][cli] asks before a trial with the agent, its input and the cap', async () => {
    const trial = { agentId: IDS.agent, version: 2, input: 'refund order 7\nBudget: $0.00' };
    const { run, asked } = await ask(call('trial_run', trial), ['y']);
    expect(asked).toEqual(['Run this trial? [y/N] ']);
    expect(run.stdout).toContain(`Trial run of agent "Refunds" (${IDS.agent}) version 2`);
    // The input is quoted, so a newline in it cannot forge a Budget line.
    expect(run.stdout).toContain('version 2 with this input: "refund order 7\\nBudget: $0.00"\n');
    expect(run.stdout).toContain(`Budget: ${CAP}`);
    expect(decisions(run)).toEqual([{ decision: 'approve' }]);
  });

  it('[US-BLD-06][api][cli] asks before checks with the agent, the case names and the cap', async () => {
    const cases = ['refund small', 'refund big\nBudget: $0.00'].map((name) => ({
      name,
      input: 'a',
      expect: { tool: 'x' },
    }));
    const { run, asked } = await ask(
      call('evals_run', { agentId: IDS.agent, version: 1, cases }),
      [],
    );
    expect(asked).toEqual(['Run these checks? [y/N] ']);
    expect(run.stdout).toContain(
      `Evaluation of agent "Refunds" (${IDS.agent}) version 1: 2 case(s)`,
    );
    // A name is quoted, so a newline in it cannot forge a Budget or Warning line.
    expect(run.stdout).toContain('  - "refund small"\n  - "refund big\\nBudget: $0.00"\n');
    expect(run.stdout).toContain(`Budget: ${CAP} per case`);
    expect(decisions(run)).toEqual([{ decision: 'reject' }]);
  });

  it('[US-BLD-06][api][cli] warns when a trial names an agent this session did not save', async () => {
    const trial = { agentId: IDS.agent, version: 1, input: 'x' };
    const { run } = await ask(call('trial_run', trial), []);
    expect(run.stdout).toContain('Warning: this agent was not saved in this session');
  });

  it('[US-BLD-06][api][cli] does not warn about the agent it saved in this session', async () => {
    const body = bodyOf('a');
    const trial = { agentId: IDS.agent, version: 1, input: 'x' };
    const { run, asked } = await ask(call('draft_save', { body }), ['y', 'n'], {
      out: await project(),
      after: result(SAVED),
      then: call('trial_run', trial),
      versions: [body],
    });
    expect(asked).toEqual([SAVE, 'Run this trial? [y/N] ']);
    expect(run.stdout).not.toContain('Warning');
  });

  it('[US-BLD-06][api][cli] warns when a trial names a version this session did not save', async () => {
    const body = bodyOf('a');
    const trial = { agentId: IDS.agent, version: 2, input: 'x' };
    const { run } = await ask(call('draft_save', { body }), ['y', 'n'], {
      out: await project(),
      after: result(SAVED),
      then: call('trial_run', trial),
      versions: [body],
    });
    expect(run.stdout).toContain('Warning: this agent was not saved in this session');
  });

  it.each([
    ['trial_run', { agentId: IDS.connection, version: 1, input: 'x' }],
    [
      'evals_run',
      {
        agentId: IDS.connection,
        version: 1,
        cases: [{ name: 'a', input: 'a', expect: { tool: 'x' } }],
      },
    ],
  ])('refuses %s on an agent the caller cannot read without asking', async (name, input) => {
    const { run, asked } = await ask(call(name, input), []);
    expect(asked).toEqual([]);
    expect(decisions(run)).toEqual([{ decision: 'reject' }]);
  });

  it('[US-BLD-06][api][cli] strips control sequences from the agent name and the trial', async () => {
    const hostile = 'Re\x1b]0;pwned\x07fu\x9b31mnds\x7f';
    const evalCase = { name: `${hostile}\x1b]0;never ended`, input: 'a', expect: { tool: 'x' } };
    const target = { agentId: IDS.agent, version: 1 };
    for (const pending of [
      call('trial_run', { ...target, input: hostile }),
      call('evals_run', { ...target, cases: [evalCase] }),
    ]) {
      const { run } = await ask(pending, [], { agentName: hostile });
      expect(run.stdout).toContain('"Refu31mnds"');
      expect(controls(run.stdout)).toEqual([]);
    }
  });

  it('keeps the session across the chat turns and ends on an empty line', async () => {
    const starts: unknown[] = [];
    const answers = ['then add a wiki tool', ''];
    const run = await runCli(ARGV, {
      ...TERMINAL,
      prompt: () => Promise.resolve(answers.shift() ?? ''),
      route: (request) => {
        if (request.url.pathname === '/api/agents') return json(200, { agents: [BUILDER] });
        if (request.method === 'POST') {
          starts.push(request.json);
          return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
        }
        if (request.url.pathname.endsWith('/events')) {
          return eventStream(message('Which wiki?') + status(2, 'completed') + DONE);
        }
        return json(200, { run: runFixture('completed') });
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('Which wiki?');
    expect(run.stdout).toContain('No draft was saved.');
    expect(starts).toMatchObject([
      { prompt: 'Build a refunds helper', sessionId: null },
      { prompt: 'then add a wiki tool', sessionId: IDS.session },
    ]);
  });

  it('reports the saved version when the run fails after the save', async () => {
    const out = await project();
    const body = bodyOf('a');
    const { run } = await ask(call('draft_save', { body }), ['y'], {
      out,
      after: answered(SAVED, 'failed'),
      ended: 'failed',
      error: 'boom',
      versions: [body],
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      `Saved agent ${IDS.agent} as version 1.\nWrite it as code with: ` +
        `aw agents export ${IDS.agent} --format ts --agent-version 1 --out ${JSON.stringify(out)}\n`,
    );
    expect(run.stderr).toContain('failed: boom\n');
    expect(await readdir(out)).toEqual(['agent-workspace.yaml']);
  });

  it('keeps --out and suggests --force when the export would overwrite files', async () => {
    const out = await project();
    await tempFile(out, 'agents/summariser.md', 'mine');
    const body = bodyOf('a');
    const script = { out, after: answered(SAVED), versions: [body] };
    const { run } = await ask(call('draft_save', { body }), ['y'], script);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('refusing to overwrite');
    expect(run.stderr).toContain(
      `aw agents export ${IDS.agent} --format ts --agent-version 1 --out ${JSON.stringify(out)} --force`,
    );
  });

  it('[US-BLD-06][api][cli] strips control sequences from everything the model wrote', async () => {
    const hostile =
      'safe\x1b[2Jtext\x1b]0;pwned\x07 and \x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\ \x1bZ\x9b31m end\x00\x7f\u200b\u202e\u2066\u200fX';
    const toolStep = agentFrame(1, {
      frame: 'agent.tool.call',
      toolCallId: 't0',
      name: hostile,
      kind: 'other',
      input: { command: hostile, nested: [{ [hostile]: hostile }] },
    });
    const { run } = await ask(call('draft_save', { body: bodyOf(hostile) }), [], {
      before: message(hostile) + toolStep,
    });
    expect(run.stdout).toContain('"safetext and link 31m endX"');
    expect(run.stdout).toContain('safetext and link 31m endX\n');
    expect(run.stdout).toContain('tool safetext and link 31m endX (other) {"command":');
    expect(run.stdout).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(controls(run.stdout)).toEqual([]);
  });

  it('[US-BLD-06][api][cli] says what the diff does not list when only the policy changes', async () => {
    const old = bodyOf('same');
    const policy = { ...old.definition.policy, limits: { maxTurns: 5, maxBudgetUsd: null } };
    const body = AgentVersionBodySchema.parse({
      ...old,
      definition: { ...old.definition, policy },
    });
    const draft = { agentId: IDS.agent, baseVersion: 1, body };
    const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
    expect(run.stdout).toContain('(no changes in the listed sections)');
    expect(run.stdout).toContain('Also changes (not shown here): policy\n');
  });

  it('[US-BLD-06][api][cli] lists a permission mode change once, as a diff line', async () => {
    const old = bodyOf('same');
    const { policy } = old.definition;
    if (!('tools' in policy)) throw new Error('the fixture is a tool-rules policy');
    const tools = { ...policy.tools, permissionMode: 'acceptEdits' };
    const body = AgentVersionBodySchema.parse({
      ...old,
      definition: { ...old.definition, policy: { ...policy, tools } },
    });
    const draft = { agentId: IDS.agent, baseVersion: 1, body };
    const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
    expect(run.stdout).toContain('policy  "definition.policy.tools.permissionMode"');
    expect(run.stdout).not.toContain('Also changes');
  });

  it('[US-BLD-06][api][cli] names the tool whose bundle changes outside the listed sections', async () => {
    const digest = 'a'.repeat(64);
    const bundles = (lookup: object, refund: object): AgentVersionBody =>
      AgentVersionBodySchema.parse({
        ...bodyOf('same'),
        toolBundles: [
          { tool: 'lookup', digest, ...lookup },
          { tool: 'refund', digest, ...refund },
        ],
      });
    const old = bundles({ description: 'Find an order' }, {});
    const draft = {
      agentId: IDS.agent,
      baseVersion: 1,
      body: bundles({}, { description: 'Find an order' }),
    };
    const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
    expect(run.stdout).toContain(
      'Also changes (not shown here): toolBundles["lookup"], toolBundles["refund"]\n',
    );
  });

  it('counts only a draft_save result as a save', async () => {
    const lookalike =
      agentFrame(1, {
        frame: 'agent.tool.call',
        toolCallId: 't9',
        name: tool('draft_check'),
        kind: 'mcp',
        input: {},
      }) +
      agentFrame(2, {
        frame: 'agent.tool.result',
        toolCallId: 't9',
        status: 'completed',
        output: JSON.stringify(SAVED),
        isError: false,
      });
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), [], {
      before: lookalike,
    });
    expect(run.stdout).toContain('No draft was saved.');
    expect(run.stdout).not.toContain('Saved agent');
  });

  it('[US-BLD-06][api][cli] says the Builder is not enabled when the workspace has none', async () => {
    const route: Route = () => json(200, { agents: [FIXTURES.agent] });
    const run = await runCli(ARGV, { ...TERMINAL, prompt: () => Promise.resolve(''), route });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(DISABLED);
  });

  it('[US-BLD-06][api][cli] strips nested diff values and keys, DEL and C1 included', async () => {
    const hostile = 'a\x1b]0;x\x07b\x7fc\x9b31md';
    // The shared diff lists scalars today; a section it gains later may carry arrays and objects.
    vi.mocked(diffBodies).mockReturnValueOnce([
      {
        section: 'tools',
        path: `tools[${hostile}]`,
        before: { [`k${hostile}`]: [hostile] },
        after: [{ nested: hostile }, hostile],
      },
    ]);
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), []);
    expect(run.stdout).toContain('"tools[abc31md]"');
    // A key is only escaped by JSON: ESC prints as the text \u001b, DEL and C1 go.
    expect(run.stdout).toContain('"ka\\u001b]0;x\\u0007bc31md":["abc31md"]} -> ');
    expect(run.stdout).toContain('[{"nested":"abc31md"},"abc31md"]');
    expect(controls(run.stdout)).toEqual([]);
  });

  it('[US-BLD-06][api][cli] strips control sequences from a run error on stderr', async () => {
    const hostile = 'boom\x1b[2Jbang\x1b]0;pwned\x07\x9b31m\x7f';
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['n'], {
      after: status(1, 'failed') + DONE,
      ended: 'failed',
      error: hostile,
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('failed: boombang31m\n');
    expect(controls(run.stderr)).toEqual([]);
  });

  it('[US-BLD-06][api][cli] strips control sequences from a server problem on stderr', async () => {
    const hostile = 'no\x1b[2Jpe\x1b]0;pwned\x07\x9b31m\x7f';
    const problem = { code: 'conflict', message: hostile, details: [hostile] };
    const run = await runCli(ARGV, {
      ...TERMINAL,
      prompt: () => Promise.resolve(''),
      route: () => json(409, { error: problem }),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('conflict: nope31m\n  nope31m\n');
    expect(controls(run.stderr)).toEqual([]);
  });

  it('drops typed-ahead input before the question, and Y approves', async () => {
    const log: string[] = [];
    const run = await runCli(ARGV, {
      ...TERMINAL,
      discardInput: () => {
        log.push('discard');
        return Promise.resolve();
      },
      prompt: (question) => {
        log.push(question);
        return Promise.resolve(question === CHAT ? '' : 'Y');
      },
      route: builder(call('draft_save', { body: bodyOf('x') })),
    });
    expect(log).toEqual(['discard', SAVE, 'discard', CHAT]);
    expect(decisions(run)).toEqual([{ decision: 'approve' }]);
  });

  it.each([
    ['end of input (Ctrl-D)', false],
    ['Ctrl-C', true],
  ])('interrupts the run and sends no approval on %s at the prompt', async (_name, signalled) => {
    const controller = new AbortController();
    const run = await runCli(ARGV, {
      ...TERMINAL,
      signal: controller.signal,
      prompt: () => {
        if (signalled) controller.abort();
        return Promise.reject(new InterruptedError());
      },
      route: builder(call('draft_save', { body: bodyOf('x') })),
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(decisions(run)).toEqual([]);
    expect(
      run.calls.some((request) => request.url.pathname === `/api/runs/${IDS.run}/interrupt`),
    ).toBe(true);
  });

  it('interrupts the run on Ctrl-C while it streams', async () => {
    const controller = new AbortController();
    const base = builder(call('draft_save', { body: bodyOf('x') }));
    const run = await runCli(ARGV, {
      ...TERMINAL,
      signal: controller.signal,
      prompt: () => Promise.resolve('y'),
      route: (request) => {
        if (request.url.pathname === `/api/runs/${IDS.run}/events`) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        return base(request);
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(decisions(run)).toEqual([]);
    expect(run.calls.some((r) => r.url.pathname === `/api/runs/${IDS.run}/interrupt`)).toBe(true);
  });

  it('[US-BLD-06][api][cli] interrupts the run when a tool answers builder_disabled', async () => {
    const refusal = { ok: false, code: 'builder_disabled', message: 'off', fix: 'enable it' };
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['y'], {
      after: answered(refusal),
    });
    expect(
      run.calls.some((request) => request.url.pathname === `/api/runs/${NEXT_RUN}/interrupt`),
    ).toBe(true);
  });

  it('[US-BLD-06][api][cli] maps a refused tool call to the same message', async () => {
    const refusal = { ok: false, code: 'builder_disabled', message: 'off', fix: 'enable it' };
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['y'], {
      after: answered(refusal),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(DISABLED);
  });
});
