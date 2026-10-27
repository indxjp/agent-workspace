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
 * The platform's own tools (`search_files`, ADR-0147) are not an MCP session of the use case's: pass
 * them as `builtins` and call them with `context.builtin`. The call is recorded as
 * `mcp__agent-workspace__<tool>`, the name a Claude run reports (`./file-search.ts` is the double).
 * A run started with `fileScope` (issue #1539) is recorded on `runs[n].fileScope`, and a built-in
 * receives it as its second argument, so `search_files` covers only that run's narrowed grants.
 *
 * Structured output (ADR-0143) works as the platform does. The start body is parsed with
 * `StartRunRequestSchema`, so an `outputSchema` over a limit is a `400 invalid_body`; it is kept on
 * `runs[n].outputSchema`. A script that returns `{ text, structured }` settles the run with that
 * `output`; a script that returns a bare string settles it with `structured: null`, and a run that
 * asked for a schema but got no value fails `output_schema_unsatisfied`. The double does not
 * validate `structured` against the JSON Schema: the SDK's `runs.result({ schema })` does that.
 *
 * Who is asking (ADR-0142 D1). A run started with `subject` records it on `runs[n].subject`, and a
 * connector given an `identityKey` is called as the platform calls an opted-in one: each call
 * carries an `x-aw-identity` header signed with that key for this subject, this run, this
 * connector (`aud`) and `GALLERY_WORKSPACE_ID` (`./identity.ts`).
 *
 * Triggers (ADR-0144) work as the platform's do, as far as a use case can see. `aw.triggers.create`
 * is parsed with `CreateTriggerRequestSchema`; a webhook answers its secret and `firePath`, a
 * schedule just `{ trigger }`. `fire(firePath, body, { idempotencyKey })` is the sender: a wrong
 * secret is the one `404 trigger_not_found`, the prompt is `renderTriggerPrompt(template, body)`, a
 * repeated `Idempotency-Key` answers the same run, and the answer is `202 { run }`. `fireSchedule(id)`
 * is the schedule pass's tick. A trigger-started run asks for the trigger's `outputSchema` (ADR-0154),
 * as `fire.ts` starts it; a trigger with none starts an untyped run, so a script's `structured` is
 * dropped to `null` exactly as the platform stores it.
 *
 * Approvals and handoffs (ADR-0145) work as the engine does. Pass the use case's own
 * `requireApproval` (and `handoff`) as `options`. A call the engine would gate records
 * `agent.tool.call` then `agent.approval.requested`, ends the script, and settles the run
 * `awaiting_approval` with `pendingApproval` and no `agent.result`; a call the platform has not
 * approved never reaches the connector. `POST /api/runs/:id/approval` answers as
 * `apps/web/server/runs/approval.ts` does: 409 `run_not_awaiting_approval` unless the run is paused,
 * otherwise the paused run completes and a continuation starts in the same session with the prompt
 * `approved` / `rejected: <comment>`, the approved call (none on a reject) and the paused run's
 * `outputSchema`, `fileScope` and `subject`. The continuation acts for the person who asked: the
 * server stores the paused run's subject and forwards it, and the approver cannot change it
 * (ADR-0157), so an identity-scoped connector gets the same caller from a continuation.
 * `context.handoff(reason)` is `handoff_to_person`: the run ends `completed` with an
 * `agent.handoff` frame after `agent.result`.
 *
 * A connector write the gateway gates pauses the run the same way (ADR-0145 D1). The engine gates
 * `options.requireApproval` plus each connector's `approvalRules` (`./openapi-gateway.ts`), as
 * compose merges them (`enginePolicyArmFor`), so a write is paused, consumed once and refused
 * `approval_call_mismatch` for any other call. The run's approved calls reach the gateway through
 * `McpCallOptions.approvedToolCalls`, as the real gateway reads them from the run.
 *
 * What this proves: the backend code, the SDK calls, the event parsing and the tool servers work
 * together. What it does not prove: that a model makes these calls. That is the live tier
 * (`AW_GALLERY_LIVE`), and each benchmark records which tier backs each claim.
 */
import { randomUUID } from 'node:crypto';

import {
  fileRouteId,
  FileResourceSchema,
  type FileResource,
} from '@indx-workspace/contracts/files';
import {
  AgentVersionListResponseSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import { AgentFrameSchema, RunStatusEventDataSchema } from '@indx-workspace/contracts/run-events';
import {
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
  RunApprovalRequestSchema,
  type RunApprovalCall,
  RunResourceSchema,
  StartRunRequestSchema,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import { SkillDetailSchema } from '@indx-workspace/contracts/skills';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import {
  CreateTriggerRequestSchema,
  renderTriggerPrompt,
  TriggerResourceSchema,
  type TriggerResource,
} from '@indx-workspace/contracts/triggers';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import { signedHeaders } from './identity.ts';
import type { McpSession, McpToolResult } from './mcp-client.ts';

/** The connector a scripted call goes to, and the `mcpServers` key a Claude run gives it. */
export interface ScriptedConnector {
  readonly id: string;
  readonly session: Pick<McpSession, 'call'> & {
    /** Write rules the engine gates on top of `requireApproval`: an OpenAPI gateway's. */
    readonly approvalRules?: readonly string[];
  };
  /** The signing secret the connector opted in with (`identity: { secret }`); none, no header. */
  readonly identityKey?: string;
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
  /**
   * Call the platform's built-in tool `tool` (`search_files`), as the model would. The call is
   * recorded under the name a run reports, `mcp__agent-workspace__<tool>`.
   */
  readonly builtin: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /**
   * Call the Claude built-in tool `name` (`Write`) with `input`, as the model would. It is gated
   * like any tool named in `requireApproval`; an ungated or approved call is answered `ok`.
   */
  readonly native: (name: string, input: Record<string, unknown>) => Promise<McpToolResult>;
  /**
   * Call `handoff_to_person({ reason })`. Throws unless the workspace was given `handoff: true`;
   * the first call wins, as in the engine.
   */
  readonly handoff: (reason: string) => Promise<McpToolResult>;
  /** Leave `name` in the run's `outputs/` directory, as a script the agent ran would. */
  readonly write: (name: string, body: string | Uint8Array) => void;
}

/** The platform's own tools a script may call: the tool's name, and what answers it. */
export type BuiltinTools = Readonly<
  Record<
    string,
    (
      args: Record<string, unknown>,
      run: { readonly fileScope: readonly string[] | null },
    ) => Promise<McpToolResult>
  >
>;

/** The engine settings a script's gates follow: pass the use case's own, never a literal. */
export interface ScriptedOptions {
  readonly requireApproval?: readonly string[] | undefined;
  readonly handoff?: boolean | undefined;
  /**
   * The agent as pushed (issue #1571): `body` is its `toAgentVersionBody`, saved as version 1 with
   * `local` pointing at it, so each run reports `agentVersion: 1`, `GET /api/agents/:id/versions`
   * lists it, and `GET /api/skills/:name` answers one published revision per entry of
   * `skillFileCounts` (the skill's real file count). Without it the runs are legacy: `null`.
   */
  readonly version?:
    | {
        readonly body: AgentVersionBody;
        readonly skillFileCounts: Readonly<Record<string, number>>;
      }
    | undefined;
}

/** What a sender gets back: `202 { run }`, or the problem code of a miss (`404 trigger_not_found`). */
export interface FireAnswer {
  readonly status: number;
  readonly run: RunResource | null;
  readonly code: string | null;
}

/** What a script answers: its final text, and the value for the `outputSchema` it was asked for. */
export type ScriptAnswer = string | { readonly text: string; readonly structured: unknown };

/** What the model "does" for one run: call tools, then return its final answer. */
export type Script = (context: ScriptContext) => Promise<ScriptAnswer>;

export interface ScriptedWorkspace {
  readonly aw: AgentWorkspaceClient;
  readonly agentId: string;
  readonly calls: RecordedRequest[];
  /** The runs started so far, in order, with the prompt each was given. */
  readonly runs: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly sessionId: string;
    /** The `subject` the backend sent; `null` when it sent none. */
    readonly subject: string | null;
    /** The `outputSchema` the backend sent, as JSON Schema; `null` when it asked for none. */
    readonly outputSchema: Readonly<Record<string, unknown>> | null;
    /** The calls the decision that started this run admitted; `[]` for a run nobody decided on. */
    readonly approvedToolCalls: readonly RunApprovalCall[];
    /** The `fileScope` the backend sent; `null` when it sent none. */
    readonly fileScope: readonly string[] | null;
  }[];
  /** Where senders post: the trigger's `firePath` is relative to this. */
  readonly baseUrl: string;
  /** A sender (Graph, a mail provider, the workflow system) calling a webhook trigger's `firePath`. */
  readonly fire: (
    firePath: string,
    body: unknown,
    options?: { readonly idempotencyKey?: string },
  ) => Promise<FireAnswer>;
  /** The schedule pass's tick for a schedule trigger: start its run now, with an empty body. */
  readonly fireSchedule: (triggerId: string) => Promise<RunResource>;
  /** The triggers created so far. */
  readonly triggers: readonly TriggerResource[];
  /** The tool name a Claude run reports for `tool` on `connector`: `mcp__<key>__<tool>`, the key being the connector's name (`connectorServerKey`). */
  readonly toolName: (connector: string, tool: string) => string;
}

const ENGINE = 'claude-agent-sdk';
/** Thrown into the script when the engine would stop the run at a gated call. */
class PausedForApproval extends Error {}

const HANDOFF_TOOL_NAME = 'mcp__agent-workspace__handoff_to_person';
const WRITTEN_AT = '2026-10-17T10:00:00.000Z';

/** What one level under `directory` holds, as `GET /api/files?path=` reports it. */
function listLevel(files: ReadonlyMap<string, Uint8Array>, directory: string): FileResource[] {
  const prefix = `${directory}/`;
  const found = new Map<string, FileResource>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const entryPath = slash === -1 ? path : `${prefix}${rest.slice(0, slash)}`;
    found.set(
      entryPath,
      FileResourceSchema.parse({
        id: fileRouteId(entryPath),
        path: entryPath,
        kind: slash === -1 ? 'file' : 'folder',
        sizeBytes: slash === -1 ? bytes.byteLength : null,
        contentType: null,
        lastModified: slash === -1 ? WRITTEN_AT : null,
      }),
    );
  }
  return [...found.values()];
}

function frame(name: string, fields: Record<string, unknown>): string {
  const data = AgentFrameSchema.parse({ frame: name, engine: ENGINE, raw: null, ...fields });
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function statusFrame(
  id: number,
  status: RunResource['status'],
  error: string | null = null,
): string {
  const data = RunStatusEventDataSchema.parse({ status, error });
  return `event: run.status\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A scripted workspace whose single agent runs `script`, with `connectors` by name. */
export function scriptedWorkspace(
  script: Script,
  connectors: Readonly<Record<string, ScriptedConnector>> = {},
  builtins: BuiltinTools = {},
  options: ScriptedOptions = {},
): ScriptedWorkspace {
  const agent = fixtures.agent({ id: randomUUID() });
  const streams = new Map<string, string>();
  const settled = new Map<string, RunResource>();
  // The workspace files the runs left, by path: what the platform collects from `outputs/`.
  const files = new Map<string, Uint8Array>();
  const runs: {
    id: string;
    prompt: string;
    sessionId: string;
    subject: string | null;
    outputSchema: Readonly<Record<string, unknown>> | null;
    approvedToolCalls: readonly RunApprovalCall[];
    fileScope: readonly string[] | null;
  }[] = [];
  // What compose sends the engine as `requireApproval`: the agent's own plus every connector's write rules.
  const gated = [
    ...(options.requireApproval ?? []),
    ...Object.values(connectors).flatMap((connector) => connector.session.approvalRules ?? []),
  ];
  const versionNumber = options.version === undefined ? null : 1;
  const runOf = (overrides: Partial<RunResource>): RunResource =>
    fixtures.run({ agentVersion: versionNumber, ...overrides });
  const toolName = (connector: string, tool: string): string => {
    const target = connectors[connector];
    if (target === undefined) throw new Error(`no scripted connector named ${connector}`);
    return `mcp__${connectorServerKey(connector, target.id, new Set())}__${tool}`;
  };

  async function begin(body: {
    readonly prompt: string;
    readonly sessionId?: string | null | undefined;
    readonly outputSchema?: Readonly<Record<string, unknown>> | null | undefined;
    readonly subject?: string | null | undefined;
    readonly approvedToolCalls?: readonly RunApprovalCall[] | undefined;
    readonly fileScope?: readonly string[] | null | undefined;
  }): Promise<RunResource> {
    const runId = randomUUID();
    const sessionId = body.sessionId ?? randomUUID();
    const outputSchema = body.outputSchema ?? null;
    const subject = body.subject ?? null;
    const approved = body.approvedToolCalls ?? [];
    const fileScope = body.fileScope ?? null;
    runs.push({
      id: runId,
      prompt: body.prompt,
      sessionId,
      subject,
      outputSchema,
      approvedToolCalls: approved,
      fileScope,
    });

    const events: string[] = [statusFrame(1, 'running')];
    events.push(frame('agent.session', { engineSessionId: sessionId, model: 'scripted' }));
    const state: { pending: RunApprovalCall | null; handoff: string | null } = {
      pending: null,
      handoff: null,
    };
    const consumed = new Set<string>();
    const record = async (
      name: string,
      args: Record<string, unknown>,
      answer: () => Promise<McpToolResult>,
    ): Promise<McpToolResult> => {
      if (state.pending !== null) throw new PausedForApproval();
      const toolCallId = `call_${String(events.length)}`;
      events.push(frame('agent.tool.call', { toolCallId, name, kind: 'other', input: args }));
      const result = await gate(name, args, toolCallId, answer);
      events.push(
        frame('agent.tool.result', {
          toolCallId,
          status: result.isError ? 'failed' : 'completed',
          output: result.text,
          isError: result.isError,
        }),
      );
      return result;
    };
    // `decideToolPermission` (packages/engine-claude-agent-sdk/src/boundary.ts), call for call.
    const gate = async (
      name: string,
      args: Record<string, unknown>,
      toolCallId: string,
      answer: () => Promise<McpToolResult>,
    ): Promise<McpToolResult> => {
      if (!needsApproval(gated, name)) return answer();
      const call = canonicalCall(name, args);
      if (approved.some((candidate) => candidate.canonicalCall === call)) {
        if (consumed.has(call)) {
          return {
            text: `approval_already_used: the approval for this ${name} call was already used.`,
            isError: true,
          };
        }
        consumed.add(call);
        return answer();
      }
      if (approved.length > 0) {
        return {
          text: `approval_call_mismatch: ${name} was called with arguments nobody approved.`,
          isError: true,
        };
      }
      return pause(toolCallId, name, args);
    };
    // The run stops at this call: it asks for approval, and nothing after it runs.
    const pause = (toolCallId: string, name: string, args: Record<string, unknown>): never => {
      const call = canonicalCall(name, args);
      events.push(
        frame('agent.approval.requested', { toolCallId, toolName: name, canonicalCall: call }),
      );
      state.pending = { toolName: name, canonicalCall: call };
      throw new PausedForApproval();
    };
    let scripted: ScriptAnswer | null = null;
    try {
      scripted = await script({
        prompt: body.prompt,
        sessionId,
        tool: async (connector, tool, args) => {
          const target = connectors[connector];
          if (target === undefined) throw new Error(`no scripted connector named ${connector}`);
          const headers =
            target.identityKey === undefined || subject === null
              ? {}
              : await signedHeaders({
                  key: target.identityKey,
                  connectorId: target.id,
                  subject,
                  runId,
                });
          return record(toolName(connector, tool), args, () =>
            target.session.call(tool, args, {
              headers,
              approvedToolCalls: approved.map((call) => call.canonicalCall),
            }),
          );
        },
        builtin: (tool, args) => {
          const answer = builtins[tool];
          if (answer === undefined) throw new Error(`no built-in tool named ${tool}`);
          return record(`mcp__agent-workspace__${tool}`, args, () => answer(args, { fileScope }));
        },
        native: (name, input) =>
          record(name, input, () => Promise.resolve({ text: 'ok', isError: false })),
        handoff: (reason) => {
          if (options.handoff !== true) throw new Error('this agent has no handoff_to_person tool');
          return record(HANDOFF_TOOL_NAME, { reason }, () => {
            state.handoff ??= reason;
            return Promise.resolve({
              text: 'The conversation is handed to a person.',
              isError: false,
            });
          });
        },
        write: (name, body) => {
          files.set(
            `runs/${runId}/outputs/${name}`,
            typeof body === 'string' ? new TextEncoder().encode(body) : body,
          );
        },
      });
    } catch (error) {
      if (!(error instanceof PausedForApproval)) throw error;
    }
    if (scripted === null) {
      events.push(statusFrame(2, 'awaiting_approval'), 'event: done\ndata: null\n\n');
      streams.set(runId, events.join(''));
      const waiting = runOf({
        id: runId,
        agentId: agent.id,
        sessionId,
        status: 'awaiting_approval',
        pendingApproval: state.pending,
      });
      settled.set(runId, waiting);
      return runOf({ id: runId, agentId: agent.id, sessionId, status: 'queued' });
    }
    // The platform stores `structured: null` for a run that asked for no schema (runs/store.ts).
    const text = typeof scripted === 'string' ? scripted : scripted.text;
    const structured =
      typeof scripted === 'string' || outputSchema === null ? null : scripted.structured;
    const unsatisfied = outputSchema !== null && structured === null;
    const output = unsatisfied ? null : { text, structured };
    events.push(
      frame('agent.message', {
        messageId: `msg_${runId}`,
        role: 'assistant',
        blocks: [{ type: 'text', text }],
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
    events.push(
      frame('agent.result', {
        stopReason: 'end_turn',
        turns: 1,
        engineCostUsd: null,
        ...(output === null ? {} : { output }),
      }),
    );
    if (state.handoff !== null) events.push(frame('agent.handoff', { reason: state.handoff }));
    const error = unsatisfied
      ? `${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`
      : null;
    const status = unsatisfied ? 'failed' : 'completed';
    events.push(statusFrame(2, status, error), 'event: done\ndata: null\n\n');
    streams.set(runId, events.join(''));

    const queued = runOf({ id: runId, agentId: agent.id, sessionId, status: 'queued' });
    settled.set(
      runId,
      runOf({
        id: runId,
        agentId: agent.id,
        sessionId,
        status,
        output,
        ...(error === null ? {} : { error }),
      }),
    );
    return queued;
  }

  // ADR-0151: one run per (agent, Idempotency-Key), as the server scopes a key to its agent; the same
  // key with a different body is a 409. The promise is kept so two concurrent starts share one run.
  const starts = new Map<string, { readonly body: string; readonly run: Promise<RunResource> }>();

  async function start(request: RecordedRequest): Promise<Response> {
    const parsed = StartRunRequestSchema.safeParse(request.json);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: {
          code: 'invalid_body',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
      });
    }
    const header = request.headers.get('idempotency-key')?.trim();
    const key = header === undefined || header === '' ? undefined : `${agent.id}:${header}`;
    const body = JSON.stringify(parsed.data);
    const held = key === undefined ? undefined : starts.get(key);
    if (held !== undefined && held.body !== body) {
      return jsonResponse(409, {
        error: {
          code: 'run_idempotency_conflict',
          message: 'this Idempotency-Key was already used with a different request.',
        },
      });
    }
    const run = held?.run ?? begin(parsed.data);
    if (held === undefined && key !== undefined) starts.set(key, { body, run });
    const queued = await run;
    return jsonResponse(202, { run: queued, events: `/api/runs/${queued.id}/events` });
  }

  async function decide(request: RecordedRequest, runId: string): Promise<Response> {
    const paused = settled.get(runId);
    if (paused === undefined) {
      return jsonResponse(404, { error: { code: 'run_not_found', message: 'no run' } });
    }
    const pending = paused.status === 'awaiting_approval' ? paused.pendingApproval : null;
    if (pending === null) {
      return jsonResponse(409, {
        error: {
          code: 'run_not_awaiting_approval',
          message: `run ${runId} is ${paused.status}, not awaiting_approval, so there is nothing to decide.`,
        },
      });
    }
    const parsed = RunApprovalRequestSchema.safeParse(request.json);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: {
          code: 'invalid_body',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
      });
    }
    const { decision, comment } = parsed.data;
    const verdict = decision === 'approve' ? 'approved' : 'rejected';
    settled.set(runId, fixtures.run({ ...paused, status: 'completed', pendingApproval: null }));
    const asked = runs.find((candidate) => candidate.id === runId);
    const queued = await begin({
      prompt: comment === undefined ? verdict : `${verdict}: ${comment}`,
      sessionId: paused.sessionId,
      outputSchema: asked?.outputSchema ?? null,
      // The paused run's narrowed grants and caller carry over, as `approval.ts` forwards
      // `fileGrants` and the stored subject (ADR-0157); the request body can name neither.
      fileScope: asked?.fileScope ?? null,
      subject: asked?.subject ?? null,
      approvedToolCalls: decision === 'approve' ? [pending] : [],
    });
    return jsonResponse(202, { run: queued, events: `/api/runs/${queued.id}/events` });
  }

  const triggers: TriggerResource[] = [];
  const secrets = new Map<string, string>();
  // One run per (trigger, Idempotency-Key); the promise is kept so two concurrent fires share it.
  const deliveries = new Map<string, Promise<RunResource>>();

  const notFound = (): Response =>
    jsonResponse(404, { error: { code: 'trigger_not_found', message: 'No such trigger.' } });

  function createTrigger(request: RecordedRequest): Response {
    const parsed = CreateTriggerRequestSchema.safeParse(request.json);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: {
          code: 'invalid_body',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
      });
    }
    const input = parsed.data;
    const now = new Date().toISOString();
    const trigger = TriggerResourceSchema.parse({
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      agentId: input.agentId,
      prompt: input.prompt,
      cron: input.kind === 'schedule' ? input.cron : null,
      timezone: input.kind === 'schedule' ? input.timezone : null,
      enabled: input.enabled ?? true,
      outputSchema: input.outputSchema ?? null,
      subject: input.subject ?? null,
      ownerPrincipalId: randomUUID(),
      hasSecret: input.kind === 'webhook',
      hasZoomSecretToken: input.kind === 'webhook' && input.zoomSecretToken !== undefined,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    });
    triggers.push(trigger);
    if (input.kind === 'schedule') return jsonResponse(201, { trigger });
    const secret = `awts_test_${randomUUID().replaceAll('-', '')}`;
    secrets.set(trigger.id, secret);
    return jsonResponse(201, {
      trigger,
      secret,
      firePath: `/api/triggers/${trigger.id}/fire/${secret}`,
      warning: 'Store this URL now; the secret is not shown again.',
    });
  }

  function startTriggered(trigger: TriggerResource, body: string, key: string | null) {
    const delivery = async (): Promise<RunResource> =>
      begin({
        prompt: renderTriggerPrompt(trigger.prompt, body),
        sessionId: null,
        outputSchema: trigger.outputSchema,
        subject: trigger.subject,
      });
    if (key === null) return delivery();
    const id = `${trigger.id}:${key}`;
    const known = deliveries.get(id);
    if (known !== undefined) return known;
    const started = delivery();
    deliveries.set(id, started);
    started.catch(() => deliveries.delete(id));
    return started;
  }

  async function fireWebhook(request: RecordedRequest, id: string, secret: string) {
    const trigger = triggers.find((candidate) => candidate.id === id);
    if (trigger?.kind !== 'webhook' || !trigger.enabled || secrets.get(id) !== secret) {
      return notFound();
    }
    const body = typeof request.init.body === 'string' ? request.init.body : '';
    const run = await startTriggered(trigger, body, request.headers.get('idempotency-key'));
    return jsonResponse(202, { run });
  }

  const double = fetchDouble(async (request) => {
    const { pathname } = request.url;
    if (request.method === 'POST' && pathname === `/api/agents/${agent.id}/runs`)
      return start(request);
    if (request.method === 'POST' && pathname === '/api/triggers') return createTrigger(request);
    const deciding = /^\/api\/runs\/([^/]+)\/approval$/u.exec(pathname);
    if (request.method === 'POST' && deciding?.[1] !== undefined) {
      return decide(request, deciding[1]);
    }
    const firing = /^\/api\/triggers\/([^/]+)\/fire\/([^/]+)$/u.exec(pathname);
    if (request.method === 'POST' && firing?.[1] !== undefined && firing[2] !== undefined) {
      return fireWebhook(request, firing[1], firing[2]);
    }
    if (request.method === 'GET' && pathname === '/api/files') {
      const directory = (request.url.searchParams.get('path') ?? '').replace(/\/+$/u, '');
      return jsonResponse(200, { files: listLevel(files, directory) });
    }
    const download = /^\/api\/files\/([^/]+)$/u.exec(pathname);
    if (request.method === 'GET' && download?.[1] !== undefined) {
      for (const [path, bytes] of files) {
        if (fileRouteId(path) !== download[1]) continue;
        const name = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${name}`,
          },
        });
      }
    }
    if (options.version !== undefined) {
      const { body, skillFileCounts } = options.version;
      if (request.method === 'GET' && pathname === `/api/agents/${agent.id}/versions`) {
        const version = fixtures.agentVersion({ agentId: agent.id, number: 1, body });
        return jsonResponse(
          200,
          AgentVersionListResponseSchema.parse({
            items: [version],
            pointers: [fixtures.agentVersionPointer({ number: 1 })],
            materialised: 1,
          }),
        );
      }
      const skill = /^\/api\/skills\/([^/]+)$/u.exec(pathname);
      const fileCount = skillFileCounts[skill?.[1] ?? ''];
      if (request.method === 'GET' && skill?.[1] !== undefined && fileCount !== undefined) {
        return jsonResponse(200, {
          skill: SkillDetailSchema.parse({
            id: skill[1],
            name: skill[1],
            enabled: true,
            description: null,
            fileCount,
            createdAt: WRITTEN_AT,
            updatedAt: WRITTEN_AT,
            source: null,
            instructions: null,
            allowedTools: null,
            files: [],
            revisions: [
              {
                // The first `aw skills publish` is revision 1; the pin is checked against it, not copied.
                number: 1,
                fileCount,
                publishedAt: WRITTEN_AT,
              },
            ],
          }),
        });
      }
    }
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

  const baseUrl = 'https://workspace.example.co.jp';
  const aw = createClient({
    baseUrl,
    auth: { kind: 'api-key', apiKey: 'aw_test_gallery' },
    fetch: double.fetch,
  });
  return {
    aw,
    agentId: agent.id,
    calls: double.calls,
    runs,
    baseUrl,
    triggers,
    toolName,
    fire: async (firePath, body, options = {}) => {
      const response = await double.fetch(`${baseUrl}${firePath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': options.idempotencyKey }),
        },
        body: JSON.stringify(body),
      });
      const answer = (await response.json()) as { run?: unknown; error?: { code?: string } };
      return {
        status: response.status,
        run: answer.run === undefined ? null : RunResourceSchema.parse(answer.run),
        code: answer.error?.code ?? null,
      };
    },
    fireSchedule: (triggerId) => {
      const trigger = triggers.find((candidate) => candidate.id === triggerId);
      if (trigger?.kind !== 'schedule') throw new Error(`no schedule trigger ${triggerId}`);
      return startTriggered(trigger, '', null);
    },
  };
}
