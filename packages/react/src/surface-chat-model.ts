/**
 * The hosted surface chat's pure half (ADR-0105 slice 1; S1-17, issue #455): how a conversation
 * opens, and how one frame of the SDK's run event stream changes it. It folds the SDK's classified
 * `RunEventFrame`s into the run view's own {@link Run} model (`../run/model.ts`), so the surface
 * and the workspace chat read a stream the same way; the transport is the SDK's, not
 * `../run/live.ts`.
 */
import {
  assistantResponseFromAgentEvent,
  toAgentEvent,
  type AgentEvent,
  type AssistantResponse,
  type RunEventFrame,
} from '@indx-workspace/sdk/events';

import {
  badgeForRunStatus,
  beginRun,
  failureBadge,
  failureNoticeFrom,
  userMessage,
  withAssistantResponse,
  withFailure,
  withMessage,
  withStatus,
  type Message,
  type Run,
  type RunFailureNotice,
  type RunOpening,
  type Speaker,
} from './run-model.js';
import { awDevModelFix, type SurfaceStrings } from './locale.js';

/** Who the visitor is in the transcript. The page knows no name, and asks for none. */
export const SURFACE_VISITOR: Speaker = { initials: 'You', name: 'You' };

/** The agent as the transcript names it. */
export function surfaceAgentSpeaker(agentName: string): Speaker {
  const initials = agentName
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('');
  return { initials: initials === '' ? 'AI' : initials, name: agentName };
}

function surfaceOpening(agentName: string): RunOpening {
  return {
    heading: { title: agentName, subtitle: '', status: null, actions: [] },
    followUp: { placeholder: `Message ${agentName}`, actions: [], status: '' },
  };
}

/**
 * The conversation after the visitor's message `text`: a new one, or `run` with it appended. A new
 * message starts a new run, so the previous run's outcome — its status badge and any failure — is
 * cleared rather than shown beside the new run's.
 */
export function withVisitorMessage(
  run: Run | null,
  agentName: string,
  id: string,
  text: string,
): Run {
  const message = userMessage(id, SURFACE_VISITOR, text);
  if (run === null) return beginRun(surfaceOpening(agentName), message);
  return withFailure(withStatus(withMessage(run, message), null), null);
}

/** One run of the conversation, as its frames arrive. */
export interface SurfaceRunState {
  readonly run: Run;
  /**
   * Whether a terminal outcome is already known. `done` ends the stream and says nothing about
   * whether the run succeeded, so it reads as "Completed" only when nothing said otherwise.
   */
  readonly outcomeKnown: boolean;
}

/**
 * The assistant's visible answer in one relayed frame, or `null`. A frame that does not satisfy
 * its contract is drift, not an answer: it is skipped, and the stream continues.
 */
function assistantResponseOf(frame: RunEventFrame): AssistantResponse | null {
  try {
    const event = toAgentEvent(frame);
    return event === null ? null : assistantResponseFromAgentEvent(event);
  } catch {
    return null;
  }
}

/** The state after one frame of the run's stream. */
export function reduceSurfaceRunFrame(
  state: SurfaceRunState,
  frame: RunEventFrame,
  assistant: Speaker,
): SurfaceRunState {
  switch (frame.kind) {
    case 'run-status': {
      const { status, error } = frame.data;
      const badge = error === null ? badgeForRunStatus(status) : failureBadge(status);
      const failure =
        status === 'failed' && error !== null ? failureNoticeFrom(error) : state.run.failure;
      return {
        run: withFailure(withStatus(state.run, badge), failure),
        outcomeKnown: state.outcomeKnown || error !== null,
      };
    }
    case 'run-failed': {
      const { status, message } = frame.data;
      return {
        run: withFailure(
          withStatus(state.run, failureBadge(status)),
          status === 'cancelled' ? null : failureNoticeFrom(message),
        ),
        outcomeKnown: true,
      };
    }
    case 'runtime': {
      const response = assistantResponseOf(frame);
      return response === null
        ? state
        : { ...state, run: withAssistantResponse(state.run, assistant, response) };
    }
    case 'run-warning':
    case 'stream-reset':
      return state;
    case 'done':
      return state.outcomeKnown
        ? state
        : {
            run: withStatus(state.run, { label: 'Completed', tone: 'ok', dot: false }),
            outcomeKnown: true,
          };
  }
}

/** The conversation after a refusal that stopped the run before any frame arrived. */
export function withSurfaceFailure(run: Run, message: string, code: string | null): Run {
  return withFailure(withStatus(run, failureBadge('unknown')), failureNoticeFrom(message, code));
}

/** One tool call of a run and, once it answered, its result. */
export interface SurfaceToolStep {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** `null` until the result arrives. */
  readonly output: string | null;
  readonly isError: boolean;
}

/**
 * What one run did beside its prose, folded in the surface's own model rather than the run view's
 * (which keeps the single-chat rule): its tool steps, and the transcript ids of its answers so the
 * steps and the feedback buttons can be placed around them.
 */
export interface SurfaceTurn {
  readonly runId: string;
  readonly answerIds: readonly string[];
  readonly tools: readonly SurfaceToolStep[];
  /**
   * Set when the run ended in `agent.handoff` (ADR-0145 D4). The reason is for the operator, not the
   * visitor: a visitor's stream does not carry it, so it is `null` there.
   */
  readonly handoff: { readonly reason: string | null } | null;
}

/** A run's turn before any frame. */
export function emptySurfaceTurn(runId: string): SurfaceTurn {
  return { runId, answerIds: [], tools: [], handoff: null };
}

/** The turn after one frame. A frame that is not an agent event, or breaks its contract, is skipped. */
export function reduceSurfaceTurnFrame(turn: SurfaceTurn, frame: RunEventFrame): SurfaceTurn {
  let event: AgentEvent | null;
  try {
    event = toAgentEvent(frame);
  } catch {
    return turn;
  }
  if (event === null) return turn;
  switch (event.frame) {
    case 'agent.tool.call':
      return {
        ...turn,
        tools: [
          ...turn.tools,
          {
            id: event.toolCallId,
            name: event.name,
            input: event.input,
            output: null,
            isError: false,
          },
        ],
      };
    case 'agent.tool.result': {
      const { toolCallId, output, isError } = event;
      if (!turn.tools.some((step) => step.id === toolCallId)) return turn;
      return {
        ...turn,
        tools: turn.tools.map((step) =>
          step.id === toolCallId ? { ...step, output, isError } : step,
        ),
      };
    }
    case 'agent.handoff':
      return { ...turn, handoff: { reason: event.reason ?? null } };
    default: {
      const response = assistantResponseFromAgentEvent(event);
      if (response === null) return turn;
      // The id `withAssistantResponse` (`../run/model.ts`) gives the answer's message.
      const id = `assistant-${response.id}`;
      return turn.answerIds.includes(id) ? turn : { ...turn, answerIds: [...turn.answerIds, id] };
    }
  }
}

/** Each turn by the id of its first answer, and by the id of its last. */
export function answerPlacement(turns: readonly SurfaceTurn[]): {
  readonly first: ReadonlyMap<string, SurfaceTurn>;
  readonly last: ReadonlyMap<string, SurfaceTurn>;
} {
  const first = new Map<string, SurfaceTurn>();
  const last = new Map<string, SurfaceTurn>();
  for (const turn of turns) {
    const [head] = turn.answerIds;
    const tail = turn.answerIds.at(-1);
    if (head !== undefined) first.set(head, turn);
    if (tail !== undefined) last.set(tail, turn);
  }
  return { first, last };
}

/** The last turn while it has tool steps and no answer yet, to show under the transcript. */
export function pendingTurn(turns: readonly SurfaceTurn[]): SurfaceTurn | null {
  const turn = turns.at(-1);
  return turn !== undefined && turn.tools.length > 0 && turn.answerIds.length === 0 ? turn : null;
}

/** The visible text of one message, paragraph by paragraph, for the surface's own transcript. */
export function messageParagraphs(message: Message): readonly string[] {
  const paragraphs =
    message.kind === 'user'
      ? message.paragraphs
      : message.blocks.flatMap((block) => (block.kind === 'prose' ? block.paragraphs : []));
  return paragraphs.map((paragraph) => paragraph.map((inline) => inline.text).join(''));
}

/** A run refused or failed because of the workspace's model setup: the operator's to fix. */
const MODEL_SETUP_CODES: ReadonlySet<string> = new Set([
  'model_connection_unresolved',
  'model_connection_failed',
  'model_unavailable',
  'model_credential_rejected',
]);

/**
 * Issue #661: what the chat shows for `failure`. The try page (`environment: 'local'`, served only
 * by `aw dev`) keeps the code and the server's text, and adds the fix: set the key for a missing or
 * refused one, check the network for a provider that could not be connected to. The widget is a
 * visitor's surface: a model-setup failure there is a generic sentence, with no code and no admin
 * advice (the caller logs the details to the console instead).
 */
export function visibleSurfaceFailure(
  failure: RunFailureNotice,
  environment: 'local' | undefined,
  strings: SurfaceStrings,
): RunFailureNotice {
  if (failure.code === null || !MODEL_SETUP_CODES.has(failure.code)) return failure;
  if (environment !== 'local') return { code: null, message: strings.unavailable };
  const fix = awDevModelFix(failure.code, strings);
  return fix === null ? failure : { code: failure.code, message: `${failure.message} ${fix}` };
}
