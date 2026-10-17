/**
 * A workspace double for the gallery's flow tests: the SDK client is real, the tools are real, and
 * only the model's decisions are scripted.
 *
 * `createClient({ fetch })` talks to `fetchDouble` from `@indx-workspace/sdk/testing`. When the
 * backend starts a run, the double runs the use case's `script`, which calls tools exactly as a
 * model would: each call goes to the real MCP server process (`./mcp-client.ts`) and is recorded.
 * The double then serves the run's event stream as the platform would — `agent.tool.call` /
 * `agent.tool.result` pairs with the server's real output, the assistant's final `agent.message`,
 * `agent.usage`, `agent.result`, the terminal `run.status`, `done` — every frame built to the
 * contract's schemas, so the SDK parses them as it parses a live stream.
 *
 * What this proves: the backend code, the SDK calls, the event parsing and the tool servers work
 * together. What it does not prove: that a model makes these calls. That is the live tier
 * (`AW_GALLERY_LIVE`), and each benchmark records which tier backs each claim.
 */
import { randomUUID } from 'node:crypto';

import { AgentFrameSchema, RunStatusEventDataSchema } from '@indx-workspace/contracts/run-events';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import type { McpSession, McpToolResult } from './mcp-client.ts';

/** The connector a scripted call goes to, and the `mcpServers` key a Claude run gives it. */
export interface ScriptedConnector {
  readonly id: string;
  readonly session: McpSession;
}

export interface ScriptContext {
  /** The prompt the backend sent. */
  readonly prompt: string;
  /** The session the run belongs to; the same id across turns of one conversation. */
  readonly sessionId: string;
  /** Call `tool` on `connector`, as the model would, and record the call and its real result. */
  readonly tool: (
    connector: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<McpToolResult>;
}

/** What the model "does" for one run: call tools, then return its final answer. */
export type Script = (context: ScriptContext) => Promise<string>;

export interface ScriptedWorkspace {
  readonly aw: AgentWorkspaceClient;
  readonly agentId: string;
  readonly calls: RecordedRequest[];
  /** The runs started so far, in order, with the prompt each was given. */
  readonly runs: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly sessionId: string;
  }[];
  /** The tool name a Claude run reports for `tool` on `connector`: `mcp__<key>__<tool>`, the key being the connector's name (`connectorServerKey`). */
  readonly toolName: (connector: string, tool: string) => string;
}

const ENGINE = 'claude-agent-sdk';

function frame(name: string, fields: Record<string, unknown>): string {
  const data = AgentFrameSchema.parse({ frame: name, engine: ENGINE, raw: null, ...fields });
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function statusFrame(id: number, status: RunResource['status']): string {
  const data = RunStatusEventDataSchema.parse({ status, error: null });
  return `event: run.status\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A scripted workspace whose single agent runs `script`, with `connectors` by name. */
export function scriptedWorkspace(
  script: Script,
  connectors: Readonly<Record<string, ScriptedConnector>> = {},
): ScriptedWorkspace {
  const agent = fixtures.agent({ id: randomUUID() });
  const streams = new Map<string, string>();
  const settled = new Map<string, RunResource>();
  const runs: { id: string; prompt: string; sessionId: string }[] = [];
  const toolName = (connector: string, tool: string): string => {
    const target = connectors[connector];
    if (target === undefined) throw new Error(`no scripted connector named ${connector}`);
    return `mcp__${connectorServerKey(connector, target.id, new Set())}__${tool}`;
  };

  async function start(request: RecordedRequest): Promise<Response> {
    const body = request.json as { prompt: string; sessionId?: string | null };
    const runId = randomUUID();
    const sessionId = body.sessionId ?? randomUUID();
    runs.push({ id: runId, prompt: body.prompt, sessionId });

    const events: string[] = [statusFrame(1, 'running')];
    events.push(frame('agent.session', { engineSessionId: sessionId, model: 'scripted' }));
    const answer = await script({
      prompt: body.prompt,
      sessionId,
      tool: async (connector, tool, args) => {
        const target = connectors[connector];
        if (target === undefined) throw new Error(`no scripted connector named ${connector}`);
        const toolCallId = `call_${String(events.length)}`;
        events.push(
          frame('agent.tool.call', {
            toolCallId,
            name: toolName(connector, tool),
            kind: 'other',
            input: args,
          }),
        );
        const result = await target.session.call(tool, args);
        events.push(
          frame('agent.tool.result', {
            toolCallId,
            status: result.isError ? 'failed' : 'completed',
            output: result.text,
            isError: result.isError,
          }),
        );
        return result;
      },
    });
    events.push(
      frame('agent.message', {
        messageId: `msg_${runId}`,
        role: 'assistant',
        blocks: [{ type: 'text', text: answer }],
      }),
    );
    events.push(
      frame('agent.usage', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        reasoningTokens: null,
      }),
    );
    events.push(frame('agent.result', { stopReason: 'end_turn', turns: 1, engineCostUsd: null }));
    events.push(statusFrame(2, 'completed'), 'event: done\ndata: null\n\n');
    streams.set(runId, events.join(''));

    const queued = fixtures.run({ id: runId, agentId: agent.id, sessionId, status: 'queued' });
    settled.set(
      runId,
      fixtures.run({ id: runId, agentId: agent.id, sessionId, status: 'completed' }),
    );
    return jsonResponse(202, { run: queued, events: `/api/runs/${runId}/events` });
  }

  const double = fetchDouble(async (request) => {
    const { pathname } = request.url;
    if (request.method === 'POST' && pathname === `/api/agents/${agent.id}/runs`)
      return start(request);
    const events = /^\/api\/runs\/([^/]+)\/events$/u.exec(pathname);
    if (events?.[1] !== undefined) return eventStreamResponse(streams.get(events[1]) ?? '');
    const run = /^\/api\/runs\/([^/]+)$/u.exec(pathname);
    if (run?.[1] !== undefined) {
      const found = settled.get(run[1]);
      return found === undefined
        ? jsonResponse(404, { error: { code: 'not_found', message: 'no run' } })
        : jsonResponse(200, { run: found });
    }
    return jsonResponse(404, {
      error: { code: 'not_found', message: `no route ${request.method} ${pathname}` },
    });
  });

  const aw = createClient({
    baseUrl: 'https://workspace.example.co.jp',
    auth: { kind: 'api-key', apiKey: 'aw_test_gallery' },
    fetch: double.fetch,
  });
  return { aw, agentId: agent.id, calls: double.calls, runs, toolName };
}
