import { rm } from 'node:fs/promises';

import {
  AgentVersionBodySchema,
  AgentVersionResourceSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { AW_CONTROL_SERVER, BUILDER_DEFAULT_LIMITS } from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, mcpToolName } from '@indx-workspace/contracts/engines';
import { AgentFrameSchema, RunStatusEventDataSchema } from '@indx-workspace/contracts/run-events';
import { defineAgent, toAgentVersionBody } from '@indx-workspace/sdk/define';

import { afterAll, vi } from 'vitest';

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

// `aw check` runs the real project loader, a forked Node process.
vi.setConfig({ testTimeout: 30_000 });

export const ARGV = ['agents', 'new', '--from-prompt', 'Build a refunds helper'];

export const MESSAGE = 'aw agents new --from-prompt needs a terminal to approve the save';

export const DISABLED = 'the Builder is not enabled for this workspace';

export const TERMINAL = { isTty: true, stdinIsTty: true } as const;

const PROJECT_SOURCE =
  'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: built\n' +
  'environments:\n  local:\n    cloud: local\n    identity:\n      bootstrapAdmin: admin@localhost.test\n';

export const BUILDER = {
  ...FIXTURES.agent,
  id: IDS.connection,
  name: 'Builder',
  builtin: 'builder',
};

export const NEXT_RUN = '33333333-3333-4333-8333-333333333334';

export const SAVE = 'Save this draft? [y/N] ';

export const CHAT = '> ';

const THIRD_RUN = '33333333-3333-4333-8333-333333333335';

export const CAP = `at most $${BUILDER_DEFAULT_LIMITS.trialBudgetUsd.toFixed(2)}`;

export const bodyOf = (instructions: string): AgentVersionBody =>
  AgentVersionBodySchema.parse(
    toAgentVersionBody(defineAgent({ name: 'summariser', instructions })),
  );

export const tool = (name: string): string =>
  mcpToolName(ENGINE_CATALOGUE['claude-agent-sdk'].mcpToolName, AW_CONTROL_SERVER, name);

const frame = (event: string, id: number, data: unknown): string =>
  `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;

export const agentFrame = (id: number, data: Record<string, unknown> & { frame: string }): string =>
  frame(data.frame, id, AgentFrameSchema.parse({ engine: 'claude-agent-sdk', raw: {}, ...data }));

export const status = (id: number, value: string): string =>
  frame('run.status', id, RunStatusEventDataSchema.parse({ status: value, error: null }));

export const DONE = 'event: done\ndata: null\n\n';

export const message = (text: string): string =>
  agentFrame(1, {
    frame: 'agent.message',
    messageId: 'm1',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  });

type Pending = { toolName: string; canonicalCall: string };

export const call = (name: string, input: unknown): Pending => ({
  toolName: tool(name),
  canonicalCall: JSON.stringify({ input, name: tool(name) }),
});

export const result = (output: unknown): string =>
  agentFrame(1, {
    frame: 'agent.tool.result',
    toolCallId: 't1',
    status: 'completed',
    output: JSON.stringify(output),
    isError: false,
  });

export const answered = (output: unknown, end = 'completed'): string =>
  result(output) + status(2, end) + DONE;

export const SAVED = {
  ok: true,
  agentId: IDS.agent,
  version: 1,
  pointer: 'local',
  awCommand: 'aw x',
};

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

export function builder(pending: Pending, script: Script = {}): Route {
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

export async function ask(
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

export const decisions = (run: CliRun): unknown[] =>
  run.calls.filter((request) => request.url.pathname.endsWith('/approval')).map((r) => r.json);

export const controls = (text: string): string[] =>
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

export async function project(): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  await tempFile(root, 'agent-workspace.yaml', PROJECT_SOURCE);
  return root;
}
