/**
 * How the hosted surface chat sends one message (ADR-0105 slice 1; S1-17, issue #455): open the
 * session lazily through the page's local bootstrap, start a run in it with the session-scoped
 * token, and fold the run's SDK frames into the transcript as they arrive. A `401` on a start means
 * the token expired: the session is opened once more — resumed when the history holds its key —
 * and the message is sent there.
 *
 * History, the switcher and feedback (ADR-0108 SD10, C18, C19; issue #540): a bootstrap resumes
 * the agent's stored session and names the agent when it is not the surface's own; a fresh session
 * stores its resume key, and each started run is added to the entry. A reload replays the stored
 * runs' events into the transcript; a run that cannot be replayed leaves the transcript as it was
 * before it, turn and all. Feedback is posted at most once per run; on a `401` it resumes the
 * run's own stored session and never opens another, and a rating that was not sent may be pressed
 * again (issue #628).
 *
 * Visitor limits (issue #622): a `429 surface_rate_limited` or `surface_turn_limit_reached` from
 * the bootstrap or a start is shown in the surface's own language, with the `Retry-After` wait. A
 * conversation at its turn limit is forgotten, so the next load or switch opens a fresh one.
 *
 * Kept apart from `surface-chat.tsx` so the whole send path — bootstrap, start, retry and follow —
 * runs in a test against the real SDK client over an injected `fetch`; the component only holds
 * the state this reads and writes.
 */
import { ApiProblemError, createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { RunFeedbackRating, RunFeedbackRequest } from '@indx-workspace/contracts/feedback';
import type {
  SurfaceLimitProblemCode,
  SurfaceSessionRequest,
  SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

import type { Run, Speaker } from './run-model.js';
import type { SurfaceStrings } from './locale.js';
import {
  appendSurfaceRun,
  readSurfaceHistory,
  surfaceEntryOf,
  writeSurfaceEntry,
  type SurfaceHistoryEntry,
  type SurfaceHistoryStorage,
} from './history.js';
import {
  openSurfaceSession,
  postRunFeedback,
  type RunFeedbackResult,
  type SurfaceSessionResult,
} from './session.js';
import {
  emptySurfaceTurn,
  reduceSurfaceRunFrame,
  reduceSurfaceTurnFrame,
  withSurfaceFailure,
  withVisitorMessage,
  type SurfaceRunState,
  type SurfaceTurn,
} from './surface-chat-model.js';

/** The network side of the chat: the bootstrap, feedback, and an SDK client for a session. */
export interface SurfaceChatTransport {
  readonly openSession: (
    surfaceName: string,
    request: SurfaceSessionRequest,
  ) => Promise<SurfaceSessionResult>;
  readonly postFeedback: (
    token: string,
    runId: string,
    request: RunFeedbackRequest,
  ) => Promise<RunFeedbackResult>;
  readonly clientFor: (session: SurfaceSessionResponse) => AgentWorkspaceClient;
}

/**
 * The browser's transport: the Agent Workspace at `baseUrl`, else the page's own origin, with the
 * session's token. On the try page every session request asks for `environment` (`local`, issue
 * #612).
 */
export function browserSurfaceChatTransport(
  environment?: 'local',
  baseUrl?: string,
): SurfaceChatTransport {
  return {
    openSession: (surfaceName, request) =>
      openSurfaceSession(
        surfaceName,
        fetch,
        environment === undefined ? request : { ...request, environment },
        baseUrl,
      ),
    postFeedback: (token, runId, request) => postRunFeedback(runId, token, request, fetch, baseUrl),
    clientFor: (session) =>
      createClient({
        baseUrl: baseUrl ?? window.location.origin,
        auth: { kind: 'browser-token', token: session.token },
      }),
  };
}

/** The chat's state, as the send path reads and writes it. */
export interface SurfaceChatDriver {
  readonly surfaceName: string;
  /** The agent this conversation talks to. */
  readonly agentName: string;
  /** The surface's own agent, which a bootstrap does not need to name. */
  readonly ownAgentName: string;
  readonly assistant: Speaker;
  readonly transport: SurfaceChatTransport;
  /** Where each agent's resumable session and runs are kept (`./history.ts`). */
  readonly history: SurfaceHistoryStorage;
  /** The session the next message is sent in; replaced when a new one is opened. */
  readonly session: { current: SurfaceSessionResponse | null };
  /** The transcript as last shown. */
  readonly current: () => Run | null;
  /** Show `run` as the transcript; `null` clears it. */
  readonly show: (run: Run | null) => void;
  /** Show one run's tool steps and answers, replacing the turn with the same `runId`. */
  readonly showTurn: (turn: SurfaceTurn) => void;
  /** Remove run `runId`'s turn, as when its replay failed. */
  readonly dropTurn: (runId: string) => void;
  /** The runs already rated on this page: the gate that makes feedback post once. */
  readonly feedbackSent: Set<string>;
  /** The surface's own words, for the refusals a visitor is expected to meet. */
  readonly strings: SurfaceStrings;
  /** Ends a followed run's stream once its chat is gone (unmounted); nothing is shown after. */
  readonly signal?: AbortSignal | undefined;
}

const RATE_LIMITED = 'surface_rate_limited' satisfies SurfaceLimitProblemCode;
/** The refusal that ends a conversation: its session may send no more turns (issue #622). */
export const TURN_LIMIT_REACHED = 'surface_turn_limit_reached' satisfies SurfaceLimitProblemCode;

/** A refusal that stopped a message before its run produced any frame. */
class SurfaceChatRefusal extends Error {
  public readonly code: string | null;
  public readonly retryAfterSeconds: number | null;

  public constructor(message: string, code: string | null, retryAfterSeconds: number | null) {
    super(message);
    this.name = 'SurfaceChatRefusal';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function storedEntry(driver: SurfaceChatDriver): SurfaceHistoryEntry | null {
  const history = readSurfaceHistory(driver.history, driver.surfaceName, [driver.agentName]);
  return surfaceEntryOf(history, driver.agentName);
}

/**
 * Open the agent's session. `stored-or-fresh` resumes the stored one when there is one, else opens
 * a fresh one; a stored session the server will not resume is forgotten, and a fresh one opened
 * instead. `fresh` opens a fresh one. `stored` only resumes the stored one, and refuses otherwise.
 */
async function bootstrap(
  driver: SurfaceChatDriver,
  opening: 'stored-or-fresh' | 'fresh' | 'stored' = 'stored-or-fresh',
): Promise<SurfaceSessionResponse> {
  const entry = opening === 'fresh' ? null : storedEntry(driver);
  if (opening === 'stored' && entry === null) {
    throw new SurfaceChatRefusal('No stored session to resume.', null, null);
  }
  const request: SurfaceSessionRequest = {
    ...(driver.agentName === driver.ownAgentName ? {} : { agent: driver.agentName }),
    ...(entry === null
      ? {}
      : { resume: { sessionId: entry.sessionId, resumeKey: entry.resumeKey } }),
  };
  const result = await driver.transport.openSession(driver.surfaceName, request);
  if (result.kind === 'opened') {
    const { session } = result;
    driver.session.current = session;
    // Only a fresh session carries a key; a resumed one keeps the entry it was resumed from.
    if (session.resumeKey !== undefined) {
      writeSurfaceEntry(driver.history, driver.surfaceName, driver.agentName, {
        sessionId: session.sessionId,
        resumeKey: session.resumeKey,
        runIds: [],
      });
    }
    return session;
  }
  if (
    opening === 'stored-or-fresh' &&
    entry !== null &&
    result.kind === 'problem' &&
    result.code === 'surface_session_not_resumable'
  ) {
    writeSurfaceEntry(driver.history, driver.surfaceName, driver.agentName, null);
    return bootstrap(driver, 'fresh');
  }
  if (result.kind === 'failed' && result.unreachable === true) {
    // The visitor reads a plain sentence; whoever runs the page reads the likely fix (BH061-016).
    console.error(
      `The session request of surface "${driver.surfaceName}" did not complete ` +
        `(${result.message}). If the Agent Workspace is running, this page's origin ` +
        `(${typeof location === 'undefined' ? 'unknown' : location.origin}) may be missing from the surface's ` +
        'allowedOrigins: a refused origin reads as a network failure in the browser.',
    );
    throw new SurfaceChatRefusal(driver.strings.unreachable, null, null);
  }
  throw result.kind === 'problem'
    ? new SurfaceChatRefusal(result.message, result.code, result.retryAfterSeconds)
    : new SurfaceChatRefusal(result.message, null, null);
}

async function startRun(
  driver: SurfaceChatDriver,
  prompt: string,
): Promise<{ readonly client: AgentWorkspaceClient; readonly runId: string }> {
  const attempt = async (
    session: SurfaceSessionResponse,
  ): Promise<{ readonly client: AgentWorkspaceClient; readonly runId: string }> => {
    const client = driver.transport.clientFor(session);
    const started = await client.runs.start(session.agentId, {
      prompt,
      sessionId: session.sessionId,
    });
    return { client, runId: started.run.id };
  };
  try {
    return await attempt(driver.session.current ?? (await bootstrap(driver)));
  } catch (error) {
    if (!(error instanceof ApiProblemError) || error.status !== 401) throw error;
    // The session's token expired: open the session once more, and send the message there.
    return attempt(await bootstrap(driver));
  }
}

function failureOf(
  error: unknown,
  strings: SurfaceStrings,
): { readonly message: string; readonly code: string | null } {
  if (error instanceof SurfaceChatRefusal || error instanceof ApiProblemError) {
    const { code } = error;
    if (code === RATE_LIMITED) {
      return { message: strings.rateLimited(error.retryAfterSeconds), code };
    }
    if (code === TURN_LIMIT_REACHED) return { message: strings.turnLimitReached, code };
    return { message: error.message, code };
  }
  return {
    message: error instanceof Error ? error.message : 'The message could not be sent.',
    code: null,
  };
}

/** Follow run `runId` from its first event, folding each frame into the transcript and its turn. */
async function followRun(
  driver: SurfaceChatDriver,
  client: AgentWorkspaceClient,
  runId: string,
): Promise<void> {
  const opened = driver.current();
  if (opened === null) return;
  let state: SurfaceRunState = { run: opened, outcomeKnown: false };
  let turn = emptySurfaceTurn(runId);
  for await (const frame of client.runs.follow(
    runId,
    driver.signal === undefined ? {} : { signal: driver.signal },
  )) {
    state = reduceSurfaceRunFrame(
      { ...state, run: driver.current() ?? state.run },
      frame,
      driver.assistant,
    );
    driver.show(state.run);
    const next = reduceSurfaceTurnFrame(turn, frame);
    if (next !== turn) {
      turn = next;
      driver.showTurn(turn);
    }
  }
}

/** Send the visitor's message `prompt` and follow its run to the end of its stream. */
export async function sendSurfaceMessage(
  driver: SurfaceChatDriver,
  messageId: string,
  prompt: string,
): Promise<void> {
  driver.show(withVisitorMessage(driver.current(), driver.agentName, messageId, prompt));
  try {
    const { client, runId } = await startRun(driver, prompt);
    appendSurfaceRun(driver.history, driver.surfaceName, driver.agentName, runId);
    await followRun(driver, client, runId);
  } catch (error) {
    if (driver.signal?.aborted === true) return;
    const { message, code } = failureOf(error, driver.strings);
    if (code === TURN_LIMIT_REACHED) {
      // The server counts turns per session, so resuming this one would only be refused again.
      writeSurfaceEntry(driver.history, driver.surfaceName, driver.agentName, null);
      driver.session.current = null;
    }
    const current = driver.current();
    if (current === null) return;
    driver.show(withSurfaceFailure(current, message, code));
  }
}

/**
 * Rebuild the agent's stored conversation: resume its session, then replay each stored run's
 * events after a `placeholder` line for the visitor's prompt. Without a stored entry it does
 * nothing, and the session is opened on the first Send as before.
 */
export async function restoreSurfaceConversation(
  driver: SurfaceChatDriver,
  placeholder: string,
): Promise<void> {
  if (storedEntry(driver) === null) return;
  let session: SurfaceSessionResponse;
  try {
    session = await bootstrap(driver);
  } catch {
    // Best effort: the session stays unopened, so the next Send bootstraps again and shows why.
    return;
  }
  // A refused resume was replaced by a fresh entry, which has no runs.
  const runIds = storedEntry(driver)?.runIds ?? [];
  const client = driver.transport.clientFor(session);
  for (const runId of runIds) {
    const before = driver.current();
    // ponytail: the visitor's earlier prompt is not in the event stream and the entry keeps ids only (C18 shape); upgrade: store the prompt text per run or read it from a run-prompt route
    driver.show(
      withVisitorMessage(driver.current(), driver.agentName, `earlier-${runId}`, placeholder),
    );
    try {
      await followRun(driver, client, runId);
    } catch {
      // A run that cannot be replayed (gone, or no longer readable) is skipped, placeholder, turn
      // and all; the rest still are.
      driver.show(before);
      driver.dropTurn(runId);
    }
  }
}

/** What rating a run did: posted (or refused), or not posted because it was already rated. */
export type SurfaceFeedbackOutcome = RunFeedbackResult['kind'] | 'already';

async function postFeedback(
  driver: SurfaceChatDriver,
  session: SurfaceSessionResponse,
  runId: string,
  rating: RunFeedbackRating,
): Promise<SurfaceFeedbackOutcome> {
  const post = (token: string): Promise<RunFeedbackResult> =>
    driver.transport.postFeedback(token, runId, { rating });
  const result = await post(session.token);
  if (result.kind !== 'problem' || result.status !== 401) return result.kind;
  // The session's token expired: resume that same session, and rate there. Another session could
  // not rate this run, and opening one would fork the conversation (#628).
  if (storedEntry(driver)?.sessionId !== session.sessionId) return 'failed';
  try {
    return (await post((await bootstrap(driver, 'stored')).token)).kind;
  } catch {
    return 'failed';
  }
}

/** Rate run `runId` once per page: a press while one is in flight, or after it was sent, is not. */
export async function sendSurfaceFeedback(
  driver: SurfaceChatDriver,
  runId: string,
  rating: RunFeedbackRating,
): Promise<SurfaceFeedbackOutcome> {
  if (driver.feedbackSent.has(runId)) return 'already';
  const session = driver.session.current;
  if (session === null) return 'failed';
  driver.feedbackSent.add(runId);
  const outcome = await postFeedback(driver, session, runId, rating);
  if (outcome !== 'sent') driver.feedbackSent.delete(runId);
  return outcome;
}
