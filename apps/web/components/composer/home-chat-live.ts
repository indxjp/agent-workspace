'use client';

import { RUN_STATUS_EVENT, RUN_WARNING_EVENT } from '@indx-workspace/contracts/run-events';
import { isStoppedRunStatus } from '@indx-workspace/contracts/runs';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { toAgentEvent, type AgentEvent, type RunEventFrame } from '@indx-workspace/sdk/events';
import { followRunEvents, startAgentRunForSession } from '../run/live';
import { browserClient } from '../../lib/browser-client';
import {
  assistantResponseFromAgentEvent,
  badgeForRunStatus,
  eventLineFrom,
  failureBadge,
  failureNoticeFrom,
  formatEventTime,
  withAssistantResponse,
  withFailure,
  withRuntimeEvent,
  withSdkEvent,
  withStatus,
  type Run,
  type Speaker,
} from '@indx-workspace/react/run-model';
import type { ModelSelectionValue } from '../models/catalog';

let liveEventSeq = 0;

export function nextControlFrameId(prefix: string): string {
  liveEventSeq += 1;
  return `${prefix}-${String(liveEventSeq)}`;
}

function parseAgentFrame(
  frame: Extract<RunEventFrame, { readonly kind: 'runtime' }>,
):
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'unreadable'; readonly message: string } {
  try {
    const event = toAgentEvent(frame);
    if (event !== null) return { kind: 'event', event };
    return {
      kind: 'unreadable',
      message: `the frame "${frame.name}" is not one this build can read as an agent event`,
    };
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
}

type FrameUpdate = {
  readonly update: (run: Run) => Run;
  readonly terminal: boolean;
  /** The agent event this frame carried, when it carried a readable one. */
  readonly event?: AgentEvent;
};

function failedFrameUpdate(
  frame: Extract<RunEventFrame, { readonly kind: 'run-failed' }>,
  time: string,
): FrameUpdate {
  const { status, message } = frame.data;
  return {
    terminal: true,
    update: (run) =>
      withRuntimeEvent(
        withFailure(
          withStatus(run, failureBadge(status)),
          status === 'cancelled' ? null : failureNoticeFrom(message),
        ),
        eventLineFrom(nextControlFrameId('run-failed'), time, 'run-failed', message),
      ),
  };
}

function statusFrameUpdate(
  frame: Extract<RunEventFrame, { readonly kind: 'run-status' }>,
  time: string,
): FrameUpdate {
  const { status, error } = frame.data;
  const badge = error === null ? badgeForRunStatus(status) : failureBadge(status);
  return {
    // A stopped status — terminal, or the `awaiting_approval` pause — is the outcome `done`
    // must not overwrite with a guessed "Completed".
    terminal: error !== null || isStoppedRunStatus(status),
    update: (run) =>
      withRuntimeEvent(
        withFailure(
          withStatus(run, badge),
          status === 'failed' && error !== null ? failureNoticeFrom(error) : run.failure,
        ),
        eventLineFrom(
          frame.id ?? nextControlFrameId('run-status'),
          time,
          RUN_STATUS_EVENT,
          frame.data,
        ),
      ),
  };
}

function runtimeFrameUpdate(
  frame: Extract<RunEventFrame, { readonly kind: 'runtime' }>,
  assistant: Speaker,
  time: string,
): FrameUpdate {
  const parsed = parseAgentFrame(frame);
  if (parsed.kind === 'unreadable') {
    // The parser refused the payload: the platform wrote a frame that does not satisfy its own
    // contract, which is drift and not a broken connection. It is shown as itself in the Runtime
    // tab — not as a transport error, which would tell the user to reconnect — and the stream
    // continues, because the frames around it are still readable.
    return {
      terminal: false,
      update: (run) =>
        withRuntimeEvent(
          run,
          eventLineFrom(
            frame.id ?? nextControlFrameId('agent-frame-unreadable'),
            time,
            'frame.unreadable',
            parsed.message,
          ),
        ),
    };
  }
  const response = assistantResponseFromAgentEvent(parsed.event);
  return {
    terminal: false,
    event: parsed.event,
    update: (run) => {
      const logged = withSdkEvent(
        run,
        eventLineFrom(
          frame.id ?? nextControlFrameId('agent-frame'),
          time,
          frame.name,
          // The engine-native payload, which is what Technical details is for. The neutral fields
          // beside it are already rendered as the conversation.
          parsed.event.raw,
        ),
      );
      return response === null ? logged : withAssistantResponse(logged, assistant, response);
    },
  };
}

function runFrameUpdate(frame: RunEventFrame, assistant: Speaker): FrameUpdate {
  const time = formatEventTime(new Date());
  switch (frame.kind) {
    case 'run-failed':
      return failedFrameUpdate(frame, time);
    case 'stream-reset':
      return {
        terminal: false,
        update: (run) =>
          withRuntimeEvent(
            run,
            eventLineFrom(nextControlFrameId('stream-reset'), time, 'stream-reset', frame.data),
          ),
      };
    case 'run-warning':
      // A platform notice (ADR-0146), not an agent frame and not an outcome: logged as itself.
      return {
        terminal: false,
        update: (run) =>
          withRuntimeEvent(
            run,
            eventLineFrom(
              frame.id ?? nextControlFrameId('run-warning'),
              time,
              RUN_WARNING_EVENT,
              frame.data,
            ),
          ),
      };
    case 'run-status':
      return statusFrameUpdate(frame, time);
    case 'done':
      // `runs.follow` ends at `done` rather than yielding it; `followRunEvents` reports it.
      return { terminal: false, update: (run) => run };
    case 'runtime':
      return runtimeFrameUpdate(frame, assistant, time);
  }
}

export function followRunInto(
  runId: string,
  assistant: Speaker,
  apply: (update: (run: Run) => Run) => void,
  client?: AgentWorkspaceClient,
  onEvent?: (event: AgentEvent, runId: string) => void,
): () => void {
  // Once an outcome is known — a `run-failed` frame, or a `run.status` event carrying a stopped
  // status (terminal, or the `awaiting_approval` pause) or an error — `done` is a stream ending,
  // not a run succeeding (`server/runs/sse.ts`'s own distinction). This flag is what keeps
  // `onDone` from overwriting that outcome with a guessed "Completed".
  let outcomeKnown = false;
  return followRunEvents(
    runId,
    {
      onFrame: (frame) => {
        const { update, terminal, event } = runFrameUpdate(frame, assistant);
        if (terminal) outcomeKnown = true;
        if (event !== undefined) onEvent?.(event, runId);
        apply(update);
      },
      onDone: () => {
        if (!outcomeKnown) {
          apply((run) => withStatus(run, { label: 'Completed', tone: 'ok', dot: false }));
        }
      },
      onTransportError: (message) => {
        apply((run) =>
          withRuntimeEvent(
            withStatus(run, { label: 'Disconnected', tone: 'danger', dot: false }),
            eventLineFrom(
              nextControlFrameId('stream-transport-error'),
              formatEventTime(new Date()),
              'transport.error',
              message,
            ),
          ),
        );
      },
    },
    client,
  );
}

export function speakerForAgent(name: string): Speaker {
  return {
    initials:
      name
        .trim()
        .split(/\s+/u)
        .slice(0, 2)
        .map((word) => Array.from(word)[0] ?? '')
        .join('')
        .toUpperCase() || 'AI',
    name,
  };
}

export function runAgentAndFollow({
  agentId,
  prompt,
  modelOverride,
  sessionId,
  projectId,
  assistant,
  apply,
  signal,
  onStarted,
  attachments = [],
  onEvent,
  version = null,
}: {
  readonly agentId: string;
  readonly prompt: string;
  readonly modelOverride: ModelSelectionValue;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly assistant: Speaker;
  readonly apply: (update: (run: Run) => Run) => void;
  readonly signal: AbortSignal;
  readonly onStarted: (sessionId: string, runId: string) => void;
  readonly attachments?: readonly string[];
  readonly onEvent?: (event: AgentEvent, runId: string) => void;
  readonly version?: number | null;
}): void {
  void (async (): Promise<void> => {
    const outcome = await startAgentRunForSession(
      agentId,
      prompt,
      modelOverride,
      sessionId,
      projectId,
      browserClient(),
      attachments,
      version,
    );
    if (signal.aborted) return;

    if (outcome.kind === 'transport-error') {
      apply((run) =>
        withRuntimeEvent(
          withFailure(
            withStatus(run, { label: 'Could not start', tone: 'danger', dot: false }),
            failureNoticeFrom(outcome.message),
          ),
          eventLineFrom(
            nextControlFrameId('start-transport-error'),
            formatEventTime(new Date()),
            'transport.error',
            outcome.message,
          ),
        ),
      );
      return;
    }
    if (outcome.kind === 'rejected') {
      // Issue #393: a refused start names the missing piece (`agent_runtime_profile_missing`,
      // `model_connection_unresolved`, …), and the person who sent the message reads it here, in
      // the conversation — the Runtime tab below keeps the raw line.
      apply((run) =>
        withRuntimeEvent(
          withFailure(
            withStatus(run, {
              label: `${String(outcome.status)} ${outcome.code}`,
              tone: 'danger',
              dot: false,
            }),
            failureNoticeFrom(outcome.message, outcome.code),
          ),
          eventLineFrom(
            nextControlFrameId('start-rejected'),
            formatEventTime(new Date()),
            'http.error',
            outcome.message,
          ),
        ),
      );
      return;
    }

    // `outcome.kind === 'started'`: the server accepted the run and named where its events live.
    apply((run) => withStatus(run, badgeForRunStatus(outcome.status)));
    if (outcome.sessionId !== null) onStarted(outcome.sessionId, outcome.runId);

    const abort = followRunInto(outcome.runId, assistant, apply, undefined, onEvent);
    signal.addEventListener('abort', abort, { once: true });
  })();
}
