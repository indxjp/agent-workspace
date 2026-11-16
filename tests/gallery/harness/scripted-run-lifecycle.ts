import {
  RunApprovalRequestSchema,
  StartRunRequestSchema,
  type RunApprovalCall,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import { fixtures, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { randomUUID } from 'node:crypto';
import { frame, scriptedCompletion, statusFrame } from './scripted-frames.ts';
import { createScriptContext, createScriptRecorder, PausedForApproval } from './scripted-tools.ts';
import type {
  BuiltinTools,
  Script,
  ScriptAnswer,
  ScriptedConnector,
  ScriptedOptions,
} from './scripted-workspace-types.ts';

export type ScriptedStart = {
  readonly prompt: string;
  readonly sessionId?: string | null | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | null | undefined;
  readonly subject?: string | null | undefined;
  readonly approvedToolCalls?: readonly RunApprovalCall[] | undefined;
  readonly fileScope?: readonly string[] | null | undefined;
};

export function createScriptedRunLifecycle(
  agent: { readonly id: string },
  files: Map<string, Uint8Array>,
  settings: {
    readonly script: Script;
    readonly connectors: Readonly<Record<string, ScriptedConnector>>;
    readonly builtins: BuiltinTools;
    readonly options: ScriptedOptions;
  },
) {
  const { script, connectors, builtins, options } = settings;
  const streams = new Map<string, string>();
  const settled = new Map<string, RunResource>();
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

  async function begin(body: ScriptedStart): Promise<RunResource> {
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
    const recorder = createScriptRecorder(events, gated, approved);
    const { state } = recorder;
    let scripted: ScriptAnswer | null = null;
    try {
      scripted = await script(
        createScriptContext({
          prompt: body.prompt,
          sessionId,
          runId,
          subject,
          approved,
          fileScope,
          connectors,
          builtins,
          options,
          files,
          toolName,
          recorder,
        }),
      );
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
    const completion = scriptedCompletion(runId, scripted, outputSchema, state.handoff);
    const { status, output, error } = completion;
    events.push(...completion.events);
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

  return { streams, settled, runs, begin, start, decide, toolName };
}
