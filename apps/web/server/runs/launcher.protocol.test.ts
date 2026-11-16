import { OUTPUT_SCHEMA_UNSATISFIED_MESSAGE, parseRunFailure } from '@indx-workspace/contracts/runs';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerLauncher, RUN_STATUS_EVENT } from './launcher';
import { InMemoryRunStore } from './memory-store';
import type { RunRecord } from './store';
import {
  buildRunRequest,
  context,
  newRun,
  RUN,
  RUN_DONE,
  RUN_REQUEST_FIXTURE,
  runtimeOf,
  settle,
  silenceErrorLog,
  sse,
  sseStream,
  transcript,
  urlOf,
} from './launcher.test-support';

const BASE = 'http://runner:8080';
const ASSISTANT_THEN_DONE = `event: assistant\ndata: {"text":"hi"}\n\n${RUN_DONE}`;

/** Launches a run against `BASE` whose runtime answers `fetch`, and waits for it to settle. */
async function launchAgainst(
  fetch: typeof globalThis.fetch,
  options: Partial<Parameters<typeof createRunnerLauncher>[0]> = {},
) {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  createRunnerLauncher({ baseUrl: BASE, store, buildRunRequest, fetch, ...options })(context(run));
  return { store, settled: await settle(store) };
}

// PR #403 review: per-launch state is released however the launch ends.
async function callsOnLaunchSettledOncePerLaunch() {
  for (const fails of [false, true]) {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    const settledFor: string[] = [];
    const launch = createRunnerLauncher({
      baseUrl: BASE,
      store,
      buildRunRequest: fails
        ? () => {
            throw new Error('compose failed');
          }
        : buildRunRequest,
      onLaunchSettled: (launched) => {
        settledFor.push(launched.run.id);
      },
      fetch: () => Promise.resolve(sse(RUN_DONE)),
    });
    const log = silenceErrorLog();
    launch(context(run));
    const settled = await settle(store);
    await vi.waitFor(() => expect(settledFor).toEqual([RUN]));
    expect(settled.status).toBe(fails ? 'failed' : 'completed');
    log.mockRestore();
  }
}

// PR #403 review: the composition root names a runtime failure it recognises with a code.
async function storesTheCodedRuntimeFailure() {
  const seen: string[] = [];
  const { settled } = await launchAgainst(
    () =>
      Promise.resolve(
        sse('event: run-error\ndata: {"message":"not_found_error: model: gone"}\n\n'),
      ),
    {
      codeRuntimeFailure: (_context, reason) => {
        seen.push(reason);
        return 'model_unavailable: model "gone" is not available.';
      },
    },
  );
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('model_unavailable: model "gone" is not available.');
  expect(seen).toHaveLength(1);
}

/** Registers the ADR-0143 output tests inside the caller's `describe`, keeping their full names. */
function runOutputTests(): void {
  describe('the run output (ADR-0143)', runOutputCases);
}

function runOutputCases(): void {
  const launchWith = async (
    frames: string,
    outputSchema?: Record<string, unknown>,
  ): Promise<RunRecord> => {
    const store = new InMemoryRunStore();
    const run = await newRun(store);
    createRunnerLauncher({
      baseUrl: BASE,
      store,
      buildRunRequest,
      fetch: () => Promise.resolve(sse(frames)),
    })({ ...context(run), ...(outputSchema === undefined ? {} : { outputSchema }) });
    return settle(store);
  };

  const unsatisfied = {
    code: 'output_schema_unsatisfied',
    message: OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
  };

  it('stores the agent.result output on the completed run', async () => {
    const output = { text: '{"ok":true}', structured: { ok: true } };
    const frame = `event: agent.result\ndata: ${JSON.stringify({ stopReason: 'end_turn', output })}\n\n`;
    const settled = await launchWith(`${frame}${RUN_DONE}`);
    expect(settled.status).toBe('completed');
    expect(settled.output).toEqual(output);
  });

  it('fails a completed run that carries a schema but no structured value (ADR-0143)', async () => {
    const output = { text: 'prose only', structured: null };
    const frame = `event: agent.result\ndata: ${JSON.stringify({ stopReason: 'end_turn', output })}\n\n`;
    const settled = await launchWith(`${frame}${RUN_DONE}`, { type: 'object' });
    expect(settled.status).toBe('failed');
    expect(settled.output).toBeNull();
    expect(parseRunFailure(settled.error)).toEqual(unsatisfied);
  });

  it('stores output_schema_unsatisfied with the contract’s fixed sentence and no output', async () => {
    const settled = await launchWith(
      'event: run-error\ndata: {"message":"output_schema_unsatisfied: the model could not produce an answer that matches the requested output schema."}\n\n',
    );
    expect(settled.status).toBe('failed');
    expect(settled.output).toBeNull();
    expect(parseRunFailure(settled.error)).toEqual(unsatisfied);
  });
}

async function keepsUntrustedFailureTextOffTheRecord() {
  const log = silenceErrorLog();
  try {
    const { store, settled } = await launchAgainst(() =>
      Promise.resolve(sse('event: run-error\ndata: {"message":"private runtime detail"}\n\n')),
    );
    expect(settled.status).toBe('failed');
    expect(settled.error).toBe('The runtime reported a run failure.');
    expect(JSON.stringify(await transcript(store))).not.toContain('private runtime detail');
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
}

async function resolvesTheProfileBeforeComposing() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const calls: string[] = [];
  const launch = createRunnerLauncher({
    store,
    runtime: runtimeOf({
      runtimeProfileId: 'profile-1',
      driver: 'local',
      networkPolicy: 'open',
      timeoutSeconds: 60,
      runnerUrl: 'http://selected-runner:9090',
      workspaceRoot: '/selected-workspace',
      fileTransfer: 'local-disk',
    }),
    buildRunRequest: (_context, target) => ({ profile: target?.runtimeProfileId }),
    fetch: (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push(`${urlOf(input)} ${body}`);
      return Promise.resolve(sse(ASSISTANT_THEN_DONE));
    },
  });
  launch(context(run));
  expect((await settle(store)).status).toBe('completed');
  expect(calls).toEqual(['http://selected-runner:9090/run {"profile":"profile-1"}']);
}

async function postsPerTheRunContractAndRelaysTheStream() {
  const calls: { url: string; body: unknown }[] = [];
  const { store, settled } = await launchAgainst(
    (input, init) => {
      const raw = typeof init?.body === 'string' ? init.body : 'null';
      calls.push({ url: urlOf(input), body: JSON.parse(raw) as unknown });
      return Promise.resolve(sse(ASSISTANT_THEN_DONE));
    },
    { baseUrl: `${BASE}/` },
  );
  expect(settled.status).toBe('completed');
  expect(settled.error).toBeNull();
  expect(calls[0]?.url).toBe('http://runner:8080/run');
  // Exactly what `buildRunRequest` returned, and nothing this module added. The body used to
  // be built here, out of the four fields `LaunchContext` happens to carry, and the real
  // `apps/runner` answered it 400 `invalid_run_request`; see the field's documentation.
  expect(calls[0]?.body).toEqual(RUN_REQUEST_FIXTURE);

  expect(await transcript(store)).toEqual([
    { type: RUN_STATUS_EVENT, data: { status: 'running', error: null } },
    { type: 'assistant', data: { text: 'hi' } },
    { type: RUN_STATUS_EVENT, data: { status: 'completed', error: null } },
  ]);
}

async function warnsWhenAttachmentsWereRemoved() {
  const store = new InMemoryRunStore();
  const run = await newRun(store);
  const launch = createRunnerLauncher({
    baseUrl: `${BASE}/`,
    store,
    buildRunRequest,
    fetch: () => Promise.resolve(sse(ASSISTANT_THEN_DONE)),
  });

  launch({
    ...context(run),
    attachments: [
      { fileId: 'a0000000-0000-4000-8000-000000000001', path: 'brief.md', kind: 'file' },
    ],
  });
  expect((await settle(store)).status).toBe('completed');
  const events = await transcript(store);
  expect(events.map((event) => event.type)).toEqual([
    RUN_STATUS_EVENT,
    'run.warning',
    'assistant',
    RUN_STATUS_EVENT,
  ]);
  expect(events[1]?.data).toEqual({ code: 'attachments_removed_shell' });
}

async function recordsFailureWhenRuntimeCannotBeReached() {
  const log = silenceErrorLog();
  const { store, settled } = await launchAgainst(() => Promise.reject(new Error('ECONNREFUSED')));
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The runtime could not be reached.');
  expect(settled.error).not.toContain('ECONNREFUSED');
  // The failure is also in the event log, so a client that reconnects after it learns about it
  // by replay rather than by having to poll the run record.
  const last = (await transcript(store)).at(-1);
  expect(last?.type).toBe(RUN_STATUS_EVENT);
  const data = last?.data as { status: string; error: string };
  expect(data.status).toBe('failed');
  expect(data.error).toBe('The runtime could not be reached.');
  const loggedFailure = (log.mock.calls[0]?.[1] as { error: Error } | undefined)?.error;
  expect(loggedFailure).toMatchObject({ operation: 'start-runtime-run' });
  expect(loggedFailure?.cause).toEqual(new Error('ECONNREFUSED'));
  log.mockRestore();
}

async function failsWhenAnswerIsNotAnSseStream() {
  const { settled } = await launchAgainst(() =>
    Promise.resolve(new Response('<html>502</html>', { status: 502 })),
  );
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The runtime reported a run failure.');
}

async function neverLeavesRunningOnMalformedFrame() {
  const { settled } = await launchAgainst(() =>
    Promise.resolve(sse('event: assistant\ndata: {oops\n\n')),
  );
  expect(settled.status).toBe('failed');
  expect(settled.error).toBe('The runtime reported a run failure.');
}

async function appliesTheTimeoutToTheConnectOnly() {
  // Regression, found by the acceptance run: the first version passed
  // `AbortSignal.timeout(ms)` straight into `fetch`, and that signal stays attached to the
  // response body — so a healthy stream was aborted `ms` after it began. Here the connect
  // deadline is 40 ms and the runtime keeps streaming for ten times that; the run must
  // complete.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 1; i <= 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(encoder.encode(`event: assistant\ndata: ${String(i)}\n\n`));
      }
      controller.enqueue(encoder.encode(RUN_DONE));
      controller.close();
    },
  });
  const { store, settled } = await launchAgainst(() => Promise.resolve(sseStream(body)), {
    connectTimeoutMs: 40,
  });
  expect(settled.error).toBeNull();
  expect(settled.status).toBe('completed');
  expect(await transcript(store)).toHaveLength(6); // running + 4 events + completed
}

async function concludesCancelledWhenRunnerReportsInterrupt() {
  const { store, settled } = await launchAgainst(() =>
    Promise.resolve(sse('event: run-interrupted\ndata: {"interrupted":true}\n\n')),
  );
  expect(settled.status).toBe('cancelled');
  expect(settled.error).toContain('interrupted');
  const statuses = (await transcript(store))
    .filter((event) => event.type === RUN_STATUS_EVENT)
    .map((event) => (event.data as { status: string }).status);
  expect(statuses).toEqual(['running', 'cancelled']);
}

async function pausesTheRunWhenTheRunnerStopsForApproval() {
  const data = {
    code: 'awaiting_approval',
    outcome: 'awaiting_approval',
    message: 'stopped for approval',
    approvalRequest: { toolName: 'send_email', toolUseId: 'toolu_1', canonicalCall: '{}' },
  };
  const { store, settled } = await launchAgainst(() =>
    Promise.resolve(sse(`event: run-error\ndata: ${JSON.stringify(data)}\n\n`)),
  );
  expect(settled.status).toBe('awaiting_approval');
  expect(settled.error).toBeNull();
  expect(settled.pendingApproval).toEqual({ toolName: 'send_email', canonicalCall: '{}' });
  const events = await transcript(store);
  expect(events.map((event) => event.type)).toEqual([
    RUN_STATUS_EVENT,
    'agent.approval.requested',
    RUN_STATUS_EVENT,
  ]);
  expect(events[1]?.data).toEqual({
    frame: 'agent.approval.requested',
    engine: 'claude-agent-sdk',
    raw: null,
    toolCallId: 'toolu_1',
    toolName: 'send_email',
    canonicalCall: '{}',
  });
  expect((events[2]?.data as { status: string }).status).toBe('awaiting_approval');
}

describe('createRunnerLauncher', () => {
  it(
    'calls onLaunchSettled once, after the terminal status, for a completed and a failed launch',
    callsOnLaunchSettledOncePerLaunch,
  );
  it(
    'stores the coded message codeRuntimeFailure returns instead of the generic one',
    storesTheCodedRuntimeFailure,
  );
  runOutputTests();
  it(
    'keeps untrusted runtime failure text out of the run record and replayable status',
    keepsUntrustedFailureTextOffTheRecord,
  );
  it(
    'resolves the selected profile before composing and posting the run',
    resolvesTheProfileBeforeComposing,
  );
  it(
    'posts to {base}/run per §14.3 and relays the stream into the store',
    postsPerTheRunContractAndRelaysTheStream,
  );
  it(
    'appends run.warning attachments_removed_shell before the first agent frame when the run has attachments (ADR-0146)',
    warnsWhenAttachmentsWereRemoved,
  );
  it(
    'records the failure on the run when the runtime cannot be reached',
    recordsFailureWhenRuntimeCannotBeReached,
  );
  it(
    'fails the run when the runtime answers with something that is not an SSE stream',
    failsWhenAnswerIsNotAnSseStream,
  );
  it(
    'never leaves a run at "running" when a frame is malformed',
    neverLeavesRunningOnMalformedFrame,
  );
  it(
    'applies the timeout to the connect, never to the stream that follows',
    appliesTheTimeoutToTheConnectOnly,
  );
  it(
    'concludes `cancelled`, not `failed`, when the runner alone reports run-interrupted (issue #235)',
    concludesCancelledWhenRunnerReportsInterrupt,
  );
  it(
    'pauses the run, with the frame and the call, when the runner stops for approval (ADR-0145)',
    pausesTheRunWhenTheRunnerStopsForApproval,
  );
});
