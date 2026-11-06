/**
 * The agent panel's state (issue #1509), pure: what the person sent, what the run's frames say,
 * and what the panel's routes answered, folded into one value through the run-model reducers of
 * `@indx-workspace/react/run-model` (`beginRun`, `withMessage`, `withAssistantResponse`,
 * `withStatus`, `withFailure`). No React, no network: `agent-panel-client.ts` is the transport and
 * `agent-panel.tsx` draws the state.
 *
 * - A `run.status` frame moves the status; `awaiting_approval` makes the panel ask for the call it
 *   waits on (`needsApprovalCall`), which `GET …/runs/:runId` answers.
 * - An `agent.*` frame adds a tool step or the agent's answer.
 * - `run-failed` shows the failure; `stream-reset` clears what this run showed, because what
 *   follows is not contiguous with it.
 * - Every durable frame moves `lastEventId`, the `Last-Event-ID` a reconnect sends.
 */
import type { RUN_STATUSES, RunApprovalCall } from '@indx-workspace/contracts/runs';
import type { ToolTraceProps } from '@indx-workspace/react';
import {
  beginRun,
  failureNoticeFrom,
  userMessage,
  withAssistantResponse,
  withFailure,
  withMessage,
  withStatus,
  type Message,
  type Run,
  type RunBadge,
  type Speaker,
} from '@indx-workspace/react/run-model';
import {
  assistantResponseFromAgentEvent,
  toAgentEvent,
  type AgentEvent,
  type RunEventFrame,
} from '@indx-workspace/sdk/events';

import type { AgentPanelRun } from '../agent-panel-wire.js';

/** A run's status, as the platform names it. */
export type PanelRunStatus = (typeof RUN_STATUSES)[number];

/** One tool step of the run, as `ToolTrace` draws it. */
type PanelToolStep = ToolTraceProps['steps'][number];

/** How many reconnects in a row may deliver nothing new before the panel stops: the SDK's own. */
export const MAX_RECONNECTS = 5;

/** What the panel is doing: nothing, sending a prompt, following a run, or sending a decision. */
type PanelPhase = 'idle' | 'sending' | 'following' | 'deciding';

/** The agent panel's state. */
export interface AgentPanelState {
  /** The conversation, `null` before the first prompt. */
  readonly transcript: Run | null;
  /** How many messages the transcript held when the current run began, for a `stream-reset`. */
  readonly turnStart: number;
  readonly runId: string | null;
  readonly status: PanelRunStatus | null;
  readonly tools: readonly PanelToolStep[];
  /** The call the run waits on while `awaiting_approval`, once the panel has read it. */
  readonly approval: RunApprovalCall | null;
  /** The resume cursor of the current run's stream. */
  readonly lastEventId: string | null;
  readonly phase: PanelPhase;
  /** The code of the last refusal or failure of the panel's routes, `null` when there is none. */
  readonly problem: string | null;
}

/** Before anything was sent. */
export const INITIAL_AGENT_PANEL_STATE: AgentPanelState = Object.freeze({
  transcript: null,
  turnStart: 0,
  runId: null,
  status: null,
  tools: Object.freeze([]),
  approval: null,
  lastEventId: null,
  phase: 'idle',
  problem: null,
});

/** The words a frame is folded with: who the agent is, and a status's badge in the page's words. */
export interface FrameContext {
  readonly agent: Speaker;
  readonly badge: (status: PanelRunStatus) => RunBadge;
}

/** What can happen to the panel. */
export type AgentPanelAction =
  | {
      readonly type: 'send';
      readonly messageId: string;
      readonly prompt: string;
      readonly you: Speaker;
      /** The transcript's heading, the agent's name. */
      readonly title: string;
    }
  | { readonly type: 'started'; readonly run: AgentPanelRun; readonly context: FrameContext }
  | { readonly type: 'frame'; readonly frame: RunEventFrame; readonly context: FrameContext }
  | { readonly type: 'run'; readonly run: AgentPanelRun; readonly context: FrameContext }
  | { readonly type: 'decide' }
  | { readonly type: 'refused'; readonly code: string };

const NO_ACTIONS = Object.freeze([]);

function isTerminal(status: PanelRunStatus | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function withRunStatus(
  state: AgentPanelState,
  status: PanelRunStatus,
  context: FrameContext,
): AgentPanelState {
  return {
    ...state,
    status,
    transcript:
      state.transcript === null ? null : withStatus(state.transcript, context.badge(status)),
  };
}

function sent(state: AgentPanelState, action: Extract<AgentPanelAction, { type: 'send' }>) {
  const message = userMessage(action.messageId, action.you, action.prompt);
  const transcript =
    state.transcript === null
      ? beginRun(
          {
            heading: { title: action.title, subtitle: '', status: null, actions: NO_ACTIONS },
            followUp: { placeholder: '', actions: NO_ACTIONS, status: '' },
          },
          message,
        )
      : withFailure(withMessage(state.transcript, message), null);
  return {
    ...state,
    transcript,
    turnStart: transcript.messages.length,
    phase: 'sending' as const,
    problem: null,
  };
}

/** A new run to follow: the one a prompt started, or a decision's continuation. */
function started(state: AgentPanelState, run: AgentPanelRun, context: FrameContext) {
  const next: AgentPanelState = {
    ...state,
    runId: run.id,
    tools: [],
    approval: null,
    lastEventId: null,
    phase: 'following',
    problem: null,
    turnStart: state.transcript?.messages.length ?? 0,
  };
  return withRunStatus(next, run.status, context);
}

function withAgentEvent(
  state: AgentPanelState,
  event: AgentEvent,
  context: FrameContext,
): AgentPanelState {
  switch (event.frame) {
    case 'agent.tool.call':
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            id: event.toolCallId,
            name: event.name,
            input: event.input,
            output: null,
            isError: false,
          },
        ],
      };
    case 'agent.tool.result':
      return {
        ...state,
        tools: state.tools.map((step) =>
          step.id === event.toolCallId
            ? { ...step, output: event.output, isError: event.isError }
            : step,
        ),
      };
    default: {
      const response = assistantResponseFromAgentEvent(event);
      if (response === null || state.transcript === null) return state;
      return {
        ...state,
        transcript: withAssistantResponse(state.transcript, context.agent, response),
      };
    }
  }
}

/** The transcript as it was when the run began: what a `stream-reset` keeps. */
function reset(state: AgentPanelState, resumedAfter: string | null): AgentPanelState {
  const transcript = state.transcript;
  if (transcript === null) return { ...state, tools: [], lastEventId: resumedAfter };
  const [first, ...rest] = transcript.messages;
  const kept: readonly [Message, ...Message[]] = [first, ...rest.slice(0, state.turnStart - 1)];
  return {
    ...state,
    transcript: withFailure({ ...transcript, messages: kept }, null),
    tools: [],
    lastEventId: resumedAfter,
  };
}

function cursorOf(frame: RunEventFrame, state: AgentPanelState): string | null {
  if (frame.kind === 'run-status' || frame.kind === 'run-warning' || frame.kind === 'runtime') {
    return frame.id ?? state.lastEventId;
  }
  return state.lastEventId;
}

/** The state after one frame of the current run's stream. */
function withFrame(
  state: AgentPanelState,
  frame: RunEventFrame,
  context: FrameContext,
): AgentPanelState {
  const moved: AgentPanelState = { ...state, lastEventId: cursorOf(frame, state) };
  switch (frame.kind) {
    case 'run-status': {
      const next = withRunStatus(moved, frame.data.status, context);
      if (frame.data.error === null || next.transcript === null) return next;
      return {
        ...next,
        transcript: withFailure(next.transcript, failureNoticeFrom(frame.data.error)),
      };
    }
    case 'runtime': {
      let event: AgentEvent | null;
      try {
        event = toAgentEvent(frame);
      } catch {
        // A frame that breaks its contract is not drawn; the cursor still moves past it.
        return moved;
      }
      return event === null ? moved : withAgentEvent(moved, event, context);
    }
    case 'run-failed': {
      const status = frame.data.status === 'unknown' ? 'failed' : frame.data.status;
      const next = withRunStatus(moved, status, context);
      return next.transcript === null
        ? next
        : {
            ...next,
            transcript: withFailure(next.transcript, failureNoticeFrom(frame.data.message)),
          };
    }
    case 'stream-reset':
      return reset(moved, frame.data.resumedAfter);
    case 'run-warning':
    case 'done':
      return moved;
    default: {
      const unhandled: never = frame;
      void unhandled;
      return moved;
    }
  }
}

/** The panel's state after `action`. */
export function agentPanelReducer(
  state: AgentPanelState,
  action: AgentPanelAction,
): AgentPanelState {
  switch (action.type) {
    case 'send':
      return sent(state, action);
    case 'started':
      return started(state, action.run, action.context);
    case 'frame':
      return withFrame(state, action.frame, action.context);
    case 'run': {
      // The run as `GET …/runs/:runId` reads it: a live one is followed again, from the cursor.
      if (action.run.id !== state.runId) return state;
      const next = withRunStatus(state, action.run.status, action.context);
      const live = action.run.status === 'queued' || action.run.status === 'running';
      return {
        ...next,
        approval: action.run.pendingApproval,
        phase: live ? 'following' : 'idle',
        problem: live ? null : state.problem,
      };
    }
    case 'decide':
      return { ...state, phase: 'deciding', problem: null };
    case 'refused':
      return refused(state, action.code);
    default: {
      const unhandled: never = action;
      void unhandled;
      return state;
    }
  }
}

/**
 * A refusal or failure of the panel's routes. A prompt that was refused was never queued (as on
 * `409 session_busy`), so it leaves the transcript again; the composer still holds its text.
 */
function refused(state: AgentPanelState, code: string): AgentPanelState {
  const next: AgentPanelState = { ...state, phase: 'idle', problem: code };
  if (state.phase !== 'sending' || state.transcript === null) return next;
  const [first, ...rest] = state.transcript.messages;
  if (rest.length === 0) return { ...next, transcript: null, turnStart: 0 };
  return {
    ...next,
    transcript: { ...state.transcript, messages: [first, ...rest.slice(0, -1)] },
    turnStart: state.transcript.messages.length - 1,
  };
}

/** Whether the run waits for an approval and the panel has not yet read the call it waits on. */
export function needsApprovalCall(state: AgentPanelState): boolean {
  return state.status === 'awaiting_approval' && state.approval === null;
}

/**
 * Whether the panel waits on nothing it can see: no request in flight, and a run that is neither
 * over nor showing its approval prompt. The panel then offers to check the run again.
 */
export function isStuck(state: AgentPanelState, drawsApproval: boolean): boolean {
  if (state.phase !== 'idle' || state.status === null || isTerminal(state.status)) return false;
  return !(state.status === 'awaiting_approval' && state.approval !== null && drawsApproval);
}

/** Whether a new prompt may be sent: nothing in flight, and no run still working. */
export function maySend(state: AgentPanelState): boolean {
  if (state.phase !== 'idle') return false;
  return state.status === null || isTerminal(state.status);
}

/**
 * Whether to reconnect after a stream that dropped, given how many reconnects in a row delivered
 * nothing new: the next count, or `null` once {@link MAX_RECONNECTS} is spent. A connection that
 * delivered a frame resets the count, as the SDK's `runs.follow` does.
 */
export function nextReconnect(failuresInARow: number, progressed: boolean): number | null {
  const failures = progressed ? 0 : failuresInARow;
  return failures >= MAX_RECONNECTS ? null : failures + 1;
}
