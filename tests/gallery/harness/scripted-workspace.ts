import { scriptedResourceResponse } from './scripted-resources.ts';
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
import { createScriptedRunLifecycle } from './scripted-run-lifecycle.ts';
import { createScriptedTriggers } from './scripted-triggers.ts';

import { RunResourceSchema } from '@indx-workspace/contracts/runs';
import { createClient } from '@indx-workspace/sdk';
import {
  eventStreamResponse,
  fetchDouble,
  fixtures,
  jsonResponse,
} from '@indx-workspace/sdk/testing';

import type {
  BuiltinTools,
  Script,
  ScriptedConnector,
  ScriptedOptions,
  ScriptedWorkspace,
} from './scripted-workspace-types.ts';

export type {
  BuiltinTools,
  FireAnswer,
  Script,
  ScriptAnswer,
  ScriptContext,
  ScriptedConnector,
  ScriptedOptions,
  ScriptedWorkspace,
} from './scripted-workspace-types.ts';

/** A scripted workspace whose single agent runs `script`, with `connectors` by name. */
export function scriptedWorkspace(
  script: Script,
  connectors: Readonly<Record<string, ScriptedConnector>> = {},
  builtins: BuiltinTools = {},
  options: ScriptedOptions = {},
): ScriptedWorkspace {
  const agent = fixtures.agent({ id: randomUUID() });
  const files = new Map<string, Uint8Array>();
  const { streams, settled, runs, begin, start, decide, toolName } = createScriptedRunLifecycle(
    agent,
    files,
    { script, connectors, builtins, options },
  );
  const { triggers, createTrigger, fireWebhook, startTriggered } = createScriptedTriggers(begin);

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
    const resource = scriptedResourceResponse(request, files, options, agent.id);
    if (resource !== null) return resource;
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
