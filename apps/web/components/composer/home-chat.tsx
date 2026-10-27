'use client';

/**
 * The home chat screen — spec §19.5, §19.5.1 and §45, transcribed from `ui/home.html`.
 *
 * Every class below is a translation of a rule in `ui/assets/app.css` — `.hero`, `.hero-sub`,
 * `.composer`, `.composer.big`, `.picker`, `.picker .panel`, `.chip`, `.section-head`, `.rows`,
 * `.badge`, `.btn` — spending the tokens `apps/web/app/globals.css` already ports. Pixel values the
 * mockup uses that are not on Tailwind's scale (13.5px type, a 27px control, a 330px panel) are
 * arbitrary-value utilities, because rounding them to the nearest step would be redesigning the
 * mockup. Every visible string is copied from `ui/home.html` verbatim.
 *
 * ## §19.5.1 rule 5 — this screen *becomes* the run view
 *
 * "Once the first message is sent, the screen becomes the run view of section 19 … There is no
 * second chat implementation." So this component returns `components/run/run-view.tsx` once a run
 * exists, and the decision is `screenFor` in `@indx-workspace/react/run-model` rather than a condition
 * written here. The two together are the only path to the run view in this repository, and
 * `components/run/run-view.test.ts` derives the set of chat and run implementations from the tree
 * and fails if a second one is ever added.
 *
 * ## What is transcribed here and what is decided in `model.ts`
 *
 * This file is layout, strings and the two small interactions the mockup's own script performs:
 * a picker closes when the click lands outside it, and choosing an agent closes the agent picker
 * while ticking a file or a connector leaves its picker open. The rules of §19.5.1 — the pickers
 * narrow rather than widen, and switching agent starts a new session — are in `./model.ts`, where
 * they are functions a test can call rather than behaviour a reviewer has to infer from JSX.
 *
 * ## W1-UI-05 — **Send** now starts a real run
 *
 * `send` below still calls `beginRun` first, exactly as before — the screen becomes the run view
 * the instant the first message exists, because that transition does not need the network to have
 * answered anything yet. What is new is `runAgentAndFollow`, called right after: it `POST`s
 * `/api/agents/:id/runs` and folds `../run/live.ts`'s reading of `/api/runs/:id/events` into the
 * same `Run` this screen is already showing, through `@indx-workspace/react/run-model`'s pure `withStatus`,
 * `withSdkEvent` and `withRuntimeEvent`. Nothing here writes a second event log or a second status
 * badge — `RunView` renders whatever `Run` this file hands it, same as it always has.
 *
 * A run that fails — including "Not logged in", the honest answer for a deployment with no
 * credential wired in (W1-UI-04, ADR-0021) — is not masked: `runAgentAndFollow` reports it in the
 * heading badge and in the Runtime tab of the technical-details disclosure, because streaming
 * honestly is this task's bar, not that a model answers.
 *
 * ## Three places this screen says less than the mockup, and why
 *
 * The mockup is a *demonstration*: it shows five agents, four file sets, four connectors, four
 * recent runs and three projects that belong to a fictional workspace. None of that is design, so
 * none of it is transcribed as content — the shapes are transcribed and the content arrives as
 * props. Three consequences follow, and each is recorded:
 *
 *   1. **A destination that does not exist is not a link.** "Manage agents", "Upload" and "See all"
 *      point at screens no Wave 1 task builds. They render with the label the mockup gives them, in
 *      the disabled idiom the shell already uses for an unbuilt navigation entry, rather than as a
 *      link that answers a click with a 404. See W1-UI-02-unbuilt-destinations-are-not-links.md.
 *   2. **An empty Recent section is absent, not an empty box.** §43 asks for calm and sparse; a
 *      framed empty container is furniture. See W1-UI-02-empty-recent-is-absent.md.
 *   3. **The Projects section is not here.** §45 prints the home page and shows the composer and
 *      Recent only, and projects (§20.5) exist in no Wave 1 schema.
 *      See W1-UI-02-home-omits-the-projects-section.md.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { RUN_STATUS_EVENT, RUN_WARNING_EVENT } from '@indx-workspace/contracts/run-events';
import { isStoppedRunStatus } from '@indx-workspace/contracts/runs';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { toAgentEvent, type AgentEvent, type RunEventFrame } from '@indx-workspace/sdk/events';

import { followRunEvents, startAgentRunForSession } from '../run/live';
import { browserClient } from '../../lib/browser-client';
import {
  assistantResponseFromAgentEvent,
  badgeForRunStatus,
  beginRun,
  eventLineFrom,
  failureBadge,
  failureNoticeFrom,
  formatEventTime,
  screenFor,
  userMessage,
  withAssistantResponse,
  withFailure,
  withMessage,
  withRuntimeEvent,
  withSdkEvent,
  withStatus,
  type Run,
  type RunOpening,
  type Speaker,
} from '@indx-workspace/react/run-model';
import { RunView, useComposerPrefill, type ComposerPrefill } from '../run/run-view';
import {
  findAgent,
  initialSession,
  lastAgentStorageKey,
  offeredBy,
  preferredAgent,
  projectStartRefusal,
  runTargetIn,
  runTargetLine,
  runTargetWarns,
  selectAgent,
  selectedChips,
  selectedIn,
  startSession,
  toggleOption,
  type Badge,
  type ComposerAgent,
  type ComposerModelConnection,
  type ComposerProject,
  type ComposerSession,
  type PickerKind,
  type PickerOption,
  type RecentSession,
} from './model';
import type { ModelSelectionValue } from '../models/catalog';
import { modelsDrivableBy } from '../models/engine-models';
import { ModelSelector, ModelUnavailableNotice, useModelCatalog } from '../models/model-selector';

/**
 * What the composer can run this message as.
 *
 * `no-agents` carries the reason rather than leaving the screen to guess one, because "the store is
 * not wired" and "this workspace has deleted every agent" are different facts and only the caller
 * knows which happened. Rendering an agent that was not read would be the failure ADR-0015 names:
 * a capability asserted because nothing contradicted it.
 */
export type ComposerAgents =
  | {
      readonly kind: 'agents';
      readonly agents: readonly [ComposerAgent, ...ComposerAgent[]];
      /** The agent first-run setup configured, preferred before the user chooses (PR #403). */
      readonly setupAgentId?: string | null;
      /**
       * Whose last-used agent this browser remembers: the workspace and the user id. `null` (or
       * absent) when the signed-in principal could not be resolved; nothing is remembered then.
       */
      readonly viewer?: { readonly workspaceId: string; readonly userId: string } | null;
    }
  | { readonly kind: 'no-agents'; readonly reason: string };

export interface HomeChatProps {
  readonly agents: ComposerAgents;
  readonly modelConnections?: readonly ComposerModelConnection[];
  /** The **Recent** rows, newest first. Empty means the section is not rendered at all. */
  readonly recent: readonly RecentSession[];
  /**
   * The run this screen opens on, or `null` for the composer — §19.5.1 rule 5.
   *
   * `null` is the home page as §45 prints it. A {@link Run} is a conversation that has already
   * started, which is what a resumed session (§20) is, and this screen then *is* the run view
   * from its first paint. The value is passed to {@link screenFor}, which is the one place in
   * this repository that decides between the two screens.
   *
   * The prop is optional and defaults to `null` rather than being required, because a caller
   * that omits it means the home page; `undefined` never reaches {@link screenFor}, which
   * rejects it.
   */
  readonly run?: Run | null;

  /**
   * Who is typing, for the avatar and the name above their own message in the transcript.
   *
   * `null` — the default — means the caller has not resolved the signed-in user, and **Send** is
   * refused for exactly that reason. A message attributed to a person nobody named would be a
   * claim about authorship the screen never checked, and substituting "You" would make that claim
   * silently. In this wave `app/(shell)/page.tsx` passes nothing, because the session cookie
   * carries a workspace slug and no user record has been read; the composer is already inert there
   * for the separate reason that no agent could be offered.
   */
  readonly user?: Speaker | null;

  /**
   * Start every session with this agent and hide the agent picker. An id the list does not hold
   * leaves no session, so **Send** stays off: a locked chat never falls back to another agent.
   */
  readonly agent?: { readonly id: string; readonly locked: true };
  /** Starts the first run of a new session on this numbered version of the agent. */
  readonly version?: number;
  /** Sets the composer text, and focuses it, each time `nonce` changes. */
  readonly prefill?: ComposerPrefill;
  /** Receives each agent event of the runs this screen follows, already parsed, with that run's id. */
  readonly onAgentEvent?: (event: AgentEvent, runId?: string) => void;
  /**
   * Follows this run into the transcript each time `nonce` changes after mount: the continuation
   * an approval starts in the session this screen already shows.
   */
  readonly follow?: { readonly runId: string; readonly nonce: number };
  /** Rendered under the transcript, for the caller's own prompt (the Builder's approval card). */
  readonly approval?: ReactNode;
}

// ── Transcribed class strings ───────────────────────────────────────────────────────────────

/** `.btn` + `.btn.sm`. */
const BTN_SM =
  'inline-flex h-[27px] items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[9px] text-[12.5px] font-medium no-underline';
/** `.btn.primary`. The dark-mode foreground is `ui/assets/app.css`'s own `@media` override. */
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
/** `.btn[disabled]`. */
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
/** `.btn.ghost`. */
const BTN_GHOST = 'border-transparent bg-transparent text-text-2';
/** `.picker > summary`. */
const SUMMARY =
  'inline-flex h-[27px] cursor-pointer list-none items-center gap-1.5 rounded-[999px] border border-border-strong bg-surface px-2.5 text-[12.5px] whitespace-nowrap text-text-2 [&::-webkit-details-marker]:hidden hover:bg-surface-2 hover:text-text group-open:border-accent group-open:text-accent group-open:hover:border-accent group-open:hover:text-accent';
/** `.picker .panel`. */
const PANEL =
  'absolute bottom-[calc(100%+8px)] left-0 z-40 max-h-[340px] w-[330px] overflow-auto rounded-[10px] border border-border bg-surface p-2 shadow-(--shadow-lg)';
/** `.picker .panel .phead`. */
const PHEAD = 'px-2 py-1.5 text-[11.5px] tracking-[.05em] text-muted uppercase';
/** `.picker .opt`. */
const OPT =
  'flex w-full items-start gap-2.5 rounded-(--radius-sm) p-2 text-left text-[13px] hover:bg-surface-2';
/** `.picker .panel .pfoot` + `.muted`. */
const PFOOT = 'mt-1.5 border-t border-border px-2 pt-2 pb-1 text-[12.5px] text-muted';
/** `.badge`. */
const BADGE =
  'inline-flex items-center gap-[5px] rounded-[999px] px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap';
/** `.section-head`. */
const SECTION_HEAD = 'mt-[30px] mb-3 flex items-center gap-3';
/** `.row`. */
const ROW =
  'flex items-center gap-3.5 border-b border-border px-4 py-[13px] text-inherit no-underline last:border-b-0';

const BADGE_TONE: Readonly<Record<Badge['tone'], string>> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  muted: 'bg-surface-3 text-muted',
};

/** Which picker is open. At most one, exactly as the mockup's outside-click handler enforces. */
type OpenPicker = 'agent' | PickerKind | null;

let liveEventSeq = 0;
/** A React key for a control frame, which `sse.ts` never gives an `id:`. */
function nextControlFrameId(prefix: string): string {
  liveEventSeq += 1;
  return `${prefix}-${String(liveEventSeq)}`;
}

/**
 * Parse one relayed frame into the SDK's neutral event, or say why it could not be read.
 *
 * The SDK's parser throws a `ContractViolationError` on a payload that does not satisfy its frame
 * schema, which is the right answer for a program and the wrong one for a screen: the exception
 * would escape `onFrame` into `followRunEvents`' catch and be reported as a lost connection, so the
 * user would be told to reconnect over a frame the server had already delivered. It is caught here
 * and turned into a fact about that one frame.
 */
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

/**
 * What one classified frame of a run's stream does to the run on screen, and whether it settles
 * the run's outcome — a `run-failed` frame, or a `run.status` that is stopped or carries an
 * error — so that the stream's later `done` is not read as a guessed "Completed".
 *
 * Every frame is also logged as itself in the Runtime tab of the technical-details disclosure.
 */
function runFrameUpdate(
  frame: RunEventFrame,
  assistant: Speaker,
): {
  readonly update: (run: Run) => Run;
  readonly terminal: boolean;
  /** The agent event this frame carried, when it carried a readable one. */
  readonly event?: AgentEvent;
} {
  const time = formatEventTime(new Date());
  switch (frame.kind) {
    case 'run-failed': {
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
    case 'run-status': {
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
    case 'done':
      // `runs.follow` ends at `done` rather than yielding it; `followRunEvents` reports it.
      return { terminal: false, update: (run) => run };
    case 'runtime':
      break;
  }
  // A durable event the runtime produced — since ENG-03 (#302) one engine-neutral `agent.*`
  // frame, read through the SDK's parser: there is no parse of `frame.data` here, and no
  // knowledge of any engine's message shape.
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

/**
 * Follow run `runId` and fold each frame into the run on screen through `apply`; returns the
 * abort. `client` is the SDK client to follow with — the page's own by default. `onEvent`
 * receives each frame's already-parsed agent event, for a caller that reads typed tool input.
 */
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

function openingSession(
  list: readonly ComposerAgent[],
  locked: HomeChatProps['agent'],
  setupAgentId: string | null,
): ComposerSession | null {
  if (locked === undefined) return initialSession(list, null, setupAgentId);
  const found = findAgent(list, locked.id);
  return found === null ? null : startSession(found, 0);
}

/** The storage key that remembers the last agent used; `null` when nothing may be remembered. */
function rememberedAgentKey(
  locked: boolean,
  user: Speaker | null,
  viewer: { readonly workspaceId: string; readonly userId: string } | null,
): string | null {
  return locked || user === null || viewer === null
    ? null
    : lastAgentStorageKey(viewer.workspaceId, viewer.userId);
}

function speakerForAgent(name: string): Speaker {
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

/**
 * Start a real run and fold its event stream into the screen — the network half of §19.5.1 rule 5.
 *
 * `apply` never touches component state directly; it is `setStarted`, wrapped by the caller so a
 * frame that arrives after the user has switched agents (§19.5.1 rule 4 — a fresh `null` session)
 * or after the component has unmounted updates nothing. `signal` is the caller's per-send abort:
 * once it fires (a newer send, or unmount) a start still in flight applies nothing and opens no
 * stream, and an already-open stream is closed.
 *
 * Every branch below updates the run rather than replacing it — `apply` always receives a function
 * from the run that is already on screen to the run with one more fact folded in, never a value
 * built from nothing, so a frame that arrives out of order still lands on the latest state React
 * has queued.
 */
function runAgentAndFollow(
  agentId: string,
  prompt: string,
  modelOverride: ModelSelectionValue,
  sessionId: string | null,
  projectId: string | null,
  assistant: Speaker,
  apply: (update: (run: Run) => Run) => void,
  signal: AbortSignal,
  onStarted: (sessionId: string, runId: string) => void,
  attachments: readonly string[] = [],
  onEvent?: (event: AgentEvent, runId: string) => void,
  version: number | null = null,
): void {
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

// `HomeChatProps['modelConnections']` is superseded by issue #130: the run-override control below
// reads `../models/catalog.ts`'s real `(connectionId, providerModelId)` catalog via
// `useModelCatalog()`, fetched client-side the same way every other model-selection surface this
// task touches does. The prop stays on `HomeChatProps` (and `app/(shell)/page.tsx`, outside this
// task's `Owns` glob, keeps passing it) so that file needs no edit; this screen simply never binds
// it, rather than binding and discarding it.
export function HomeChat({
  agents,
  recent,
  run = null,
  user = null,
  agent: lockedAgent,
  version,
  prefill,
  onAgentEvent,
  follow,
  approval,
}: HomeChatProps) {
  const list = agents.kind === 'agents' ? agents.agents : [];
  const setupAgentId = agents.kind === 'agents' ? (agents.setupAgentId ?? null) : null;
  const viewer = agents.kind === 'agents' ? (agents.viewer ?? null) : null;
  const [session, setSession] = useState<ComposerSession | null>(() =>
    openingSession(list, lockedAgent, setupAgentId),
  );
  // Issue #393: the last agent this user sent a message as is remembered in this browser, and is
  // preferred when it can still run. Read after mount — the server render has no storage — and
  // applied only while the user has not chosen an agent themselves (`key === 0`). A locked agent
  // is neither replaced by it nor recorded as it.
  const rememberedKey = rememberedAgentKey(lockedAgent !== undefined, user, viewer);
  useEffect(() => {
    if (rememberedKey === null) return;
    let remembered: string | null;
    try {
      remembered = window.localStorage.getItem(rememberedKey);
    } catch {
      return;
    }
    const chosen = preferredAgent(list, remembered, setupAgentId);
    setSession((current) =>
      current === null || current.key !== 0 || chosen === null || chosen.id === current.agentId
        ? current
        : startSession(chosen, 1),
    );
  }, [list, rememberedKey, setupAgentId]);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useComposerPrefill(prefill, setDraft, composerRef);
  const [open, setOpen] = useState<OpenPicker>(null);
  const [started, setStarted] = useState<Run | null>(run);
  // Issue #130's per-run override — `null` means "no override; the agent's own saved default (and
  // below it, the project's, and below that, the workspace's) resolves the run", never a connection
  // this session merely happens to start with. §19.5.1 rule 4 (switching agent starts a fresh
  // session with nothing carried over) is `chooseAgent`'s own reason to reset this to `null` too.
  const [modelOverride, setModelOverride] = useState<ModelSelectionValue>(null);
  const catalogState = useModelCatalog();
  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  const [projects, setProjects] = useState<readonly ComposerProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  // §123's project picker fetches its own catalogue, the same way `../agents/agent-form.tsx`'s
  // Resources step fetches files, skills and connectors: `app/(shell)/page.tsx` builds every other
  // prop this screen takes on the server, but has no reason to know about projects, and projects
  // (like files and connectors) are an optional subsystem — a workspace with none configured, or a
  // deployment where the route answers `503`, contributes an empty list rather than an error this
  // screen has no room to show.
  useEffect(() => {
    let active = true;
    void browserClient()
      .projects.list()
      .then((found) => {
        if (active) setProjects(found.map(({ id, name }) => ({ id, name })));
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // The run's live event connection, so it can be closed when nobody is looking at it any more —
  // on unmount, and on every new **Send** (§19.5.1 rule 4: switching session means the old one's
  // stream is no longer this screen's business either).
  const runControllerRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // The runs this screen started in the active session: what its share publishes (ADR-0158).
  const [sessionRunIds, setSessionRunIds] = useState<readonly string[]>([]);
  useEffect(() => {
    return () => {
      runControllerRef.current?.abort();
    };
  }, []);

  // Aborts the previous send (its start or its stream) and hands out the controller for this one.
  const restartRunController = useCallback(() => {
    runControllerRef.current?.abort();
    runControllerRef.current = new AbortController();
    return runControllerRef.current;
  }, []);

  // Applies a live update to whatever run is currently on screen. `current === null` means the
  // frame arrived for a run this screen is no longer showing (a fresh session started under it);
  // dropping it there, rather than reviving a run nobody can see, is the ADR-0015 direction.
  const applyToRun = useCallback((update: (current: Run) => Run) => {
    setStarted((current) => (current === null ? current : update(current)));
  }, []);

  // The mockup closes any open picker when a click lands outside it. `data-picker` marks the three
  // `<details>` elements; a click that resolves to none of them is outside all of them. A target
  // that is not an Element (a text node, or a synthetic event) closes them too — the safe direction.
  useEffect(() => {
    if (open === null) return undefined;
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      const inside = target instanceof Element && target.closest('[data-picker]') !== null;
      if (!inside) setOpen(null);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [open]);

  const agent = session === null ? null : findAgent(list, session.agentId);

  const sendFollowUp = useCallback(
    (text: string, attachments: readonly string[]) => {
      // A null session id means the previous attempt never reached a started run — the server
      // then opens a fresh session for this message. Refusing here instead would swallow text the
      // composer has already cleared and the transcript has already shown as sent.
      if (agent === null || user === null) return;
      const assistant = speakerForAgent(agent.name);
      applyToRun((run) =>
        withFailure(
          withStatus(
            withMessage(run, userMessage(nextControlFrameId('user-follow-up'), user, text)),
            null,
          ),
          null,
        ),
      );
      runAgentAndFollow(
        agent.id,
        text,
        modelOverride,
        activeSessionIdRef.current,
        projectId,
        assistant,
        applyToRun,
        restartRunController().signal,
        (sessionId, runId) => {
          activeSessionIdRef.current = sessionId;
          setActiveSessionId(sessionId);
          setSessionRunIds((current) => [...current, runId]);
        },
        attachments,
        onAgentEvent,
        version ?? null,
      );
    },
    [
      agent,
      applyToRun,
      modelOverride,
      onAgentEvent,
      projectId,
      restartRunController,
      user,
      version,
    ],
  );

  const followedNonce = useRef(follow?.nonce);
  useEffect(() => {
    if (follow === undefined || agent === null || follow.nonce === followedNonce.current) return;
    followedNonce.current = follow.nonce;
    const { signal } = restartRunController();
    setSessionRunIds((current) => [...current, follow.runId]);
    const abort = followRunInto(
      follow.runId,
      speakerForAgent(agent.name),
      applyToRun,
      undefined,
      onAgentEvent,
    );
    signal.addEventListener('abort', abort, { once: true });
  }, [agent, applyToRun, follow, onAgentEvent, restartRunController]);

  const chooseAgent = useCallback(
    (agentId: string) => {
      setSession((current) => {
        if (current === null) return current;
        const update = selectAgent(list, current, agentId);
        // A refused switch leaves the session exactly as it was. `selectAgent` names the reason
        // rather than returning the input, so this branch is a decision and not a fallthrough.
        return update.ok ? update.session : current;
      });
      setOpen(null);
      // §19.5.1 rule 4: a new session carries nothing over, including a per-run model override —
      // it named a choice for the *previous* agent's run, not a default this one inherits.
      setModelOverride(null);
    },
    [list],
  );

  const toggle = useCallback(
    (kind: PickerKind, optionId: string) => {
      setSession((current) => {
        if (current === null) return current;
        const on = findAgent(list, current.agentId);
        if (on === null) return current;
        const update = toggleOption(on, current, kind, optionId);
        return update.ok ? update.session : current;
      });
    },
    [list],
  );

  // `agents.kind === 'agents'` carries a non-empty tuple, so a null agent means the caller said
  // there are none and gave the reason. `?? ''` is unreachable and is here because the compiler
  // cannot see that; it is a display slot, not a gate.
  const notice = agents.kind === 'no-agents' ? agents.reason : '';
  const chips = agent === null || session === null ? [] : selectedChips(agent, session);
  const canSend = agent !== null && user !== null && draft.trim() !== '';
  // Issue #393: the picker offers only models this agent's engine can drive.
  const drivableModels =
    agent === null ? [] : modelsDrivableBy(agent.drivableProviders, catalogModels);
  const overrideEntry =
    modelOverride === null
      ? undefined
      : drivableModels.find(
          (entry) =>
            entry.connectionId === modelOverride.connectionId &&
            entry.providerModelId === modelOverride.model,
        );

  /**
   * §19.5.1 rule 5 — **the screen becomes the run view**.
   *
   * This is the whole of the rule, in one place. Once a run exists the component returns
   * {@link RunView} and never reaches the hero, the composer or the Recent list below; there is no
   * second route, no second chat and no second transcript that could disagree. `screenFor` is what
   * decides, and it rejects anything that is neither `null` nor a run rather than falling through
   * to the composer and losing a conversation in flight (ADR-0015).
   */
  const screen = screenFor(started);
  if (screen.kind === 'run') {
    return (
      <RunView
        run={screen.run}
        sessionId={activeSessionId}
        runIds={sessionRunIds}
        onFollowUp={sendFollowUp}
        prefill={prefill}
        approval={approval}
      />
    );
  }

  /**
   * Pressing **Send** the first time is the transition rule 5 describes, and — as of W1-UI-05 —
   * also what actually starts a run: `POST /api/agents/:id/runs`, then `../run/live.ts` reads
   * `GET /api/runs/:id/events` until the server's own `done` frame.
   *
   * Every value the run opens with is one this screen actually holds: the agent's own name, the
   * status slot it was already showing, and the user the caller named. Nothing is filled in with a
   * plausible default — the run-state badge is `null` rather than "Running", because at this point
   * nothing has answered the POST yet and a badge is a claim (ADR-0015). `runAgentAndFollow` fills
   * it in the moment the server actually says something, not before.
   */
  const send = () => {
    if (agent === null || user === null) return;
    const text = draft.trim();
    if (text === '') return;

    const opening: RunOpening = {
      heading: { title: agent.name, subtitle: '', status: null, actions: [] },
      followUp: {
        placeholder:
          'Ask a follow-up. The session is resumed, so the agent still has the context above.',
        actions: [],
        status: agent.sandbox,
      },
    };
    setStarted(
      beginRun(opening, userMessage(`m${session === null ? 0 : session.key}-1`, user, text)),
    );
    setDraft('');
    if (rememberedKey !== null) {
      try {
        window.localStorage.setItem(rememberedKey, agent.id);
      } catch {
        // Remembering the agent is a convenience; a browser that refuses storage still sends.
      }
    }

    // A previous run's stream, if this session somehow still had one open, is no longer this
    // screen's business the moment a new one starts.
    runControllerRef.current?.abort();
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setSessionRunIds([]);
    // A project's session is opened before the run starts; one that cannot run is not opened.
    const refusal = projectStartRefusal(agent, projectId, modelOverride !== null);
    if (refusal !== null) {
      applyToRun((run) =>
        withFailure(
          withStatus(run, { label: `Cannot run · ${refusal.code}`, tone: 'danger', dot: false }),
          failureNoticeFrom(refusal.reason, refusal.code),
        ),
      );
      return;
    }
    runAgentAndFollow(
      agent.id,
      text,
      modelOverride,
      null,
      projectId,
      speakerForAgent(agent.name),
      applyToRun,
      restartRunController().signal,
      (sessionId, runId) => {
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessionRunIds([runId]);
      },
      [],
      onAgentEvent,
      version ?? null,
    );
  };

  return (
    <main className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mx-auto max-w-[720px] pt-[8vh]">
        <h1 className="text-center text-[26px] font-semibold tracking-[-.02em]">
          What can I help with?
        </h1>
        <div className="mt-2 mb-[26px] text-center text-[13.5px] text-muted">
          Pick an agent, add files or connectors, and start. Everything runs in a sandbox.
        </div>

        <div className="flex flex-col gap-2 rounded-[12px] border border-border-strong bg-surface px-3.5 pt-3.5 pb-[11px] shadow-(--shadow)">
          {/* The mockup's textarea carries `autofocus`: §19.5 opens the product on a place to
              type, so the caret starts there and not on the first picker. */}
          <textarea
            ref={composerRef}
            autoFocus
            data-testid="composer-input"
            aria-label="Ask anything"
            className="min-h-[68px] w-full resize-y rounded-(--radius-sm) border-0 bg-transparent p-0 text-[15px] leading-[1.6] text-text placeholder:text-muted focus:outline-none"
            placeholder="Ask anything…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          {chips.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.map((chip) => (
                <span
                  key={chip.id}
                  className="inline-flex h-6 items-center gap-1.5 rounded-[999px] bg-surface-3 px-[9px] text-[12px] text-text-2"
                >
                  {chip.name}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.name}`}
                    className="cursor-pointer opacity-55 hover:opacity-100"
                    title="Remove"
                    onClick={() => {
                      const kind: PickerKind =
                        agent !== null && agent.files.some((file) => file.id === chip.id)
                          ? 'files'
                          : 'connectors';
                      toggle(kind, chip.id);
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {drivableModels.length === 0 ? null : (
              <ModelSelector
                id="composer-model-override"
                label="Model"
                models={drivableModels}
                value={modelOverride}
                onChange={setModelOverride}
                inheritLabel="Agent default"
                ariaDescribedBy="composer-model-inheritance-line"
              />
            )}
            {projects.length === 0 ? null : (
              <label className="inline-flex items-center gap-1.5 text-[12.5px] text-text-2">
                Project
                <select
                  aria-label="Project"
                  className="h-[27px] rounded-[999px] border border-border-strong bg-surface px-2.5"
                  value={projectId ?? ''}
                  onChange={(event) => setProjectId(event.target.value || null)}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {lockedAgent !== undefined ? null : (
              <Picker
                id="agent"
                testId="composer-agent-picker"
                label={`Agent: ${agent === null ? 'none' : agent.name}`}
                open={open}
                setOpen={setOpen}
                disabled={agent === null}
              >
                <div className={PHEAD}>Run this message as</div>
                {list.map((option) => {
                  const target = runTargetIn(option, projectId);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      data-testid="composer-agent-option"
                      data-agent-id={option.id}
                      data-run-target={target.kind}
                      className={`${OPT} ${option.id === agent?.id ? 'bg-accent-soft' : ''}`}
                      onClick={() => chooseAgent(option.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{option.name}</span>
                        <span className="block text-[12px] text-muted">{option.detail}</span>
                        {target.kind === 'unrunnable' ? (
                          <span className="block text-[12px] text-warn">
                            Cannot run yet · {target.code}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                <div className={PFOOT}>
                  Switching agent mid-conversation starts a new session.{' '}
                  <Unbuilt>Manage agents</Unbuilt>
                </div>
              </Picker>
            )}

            <NarrowingPicker
              kind="files"
              label="+ Files"
              agent={agent}
              session={session}
              open={open}
              setOpen={setOpen}
              onToggle={toggle}
              footer={
                <>
                  Only files this agent is permitted to read are listed. <Unbuilt>Upload</Unbuilt>
                </>
              }
            />

            <NarrowingPicker
              kind="connectors"
              label="+ Connectors"
              agent={agent}
              session={session}
              open={open}
              setOpen={setOpen}
              onToggle={toggle}
              footer="Pickers narrow what the agent may use — they never grant new capability."
            />

            <span className="flex-1" />
            <span className="text-[12.5px] text-muted">
              {agent === null ? notice : agent.sandbox}
            </span>
            <button
              type="button"
              data-testid="composer-send"
              disabled={!canSend}
              onClick={send}
              className={`${BTN_SM} ${BTN_PRIMARY} ${canSend ? 'cursor-pointer hover:border-accent-hover hover:bg-accent-hover' : BTN_DISABLED}`}
            >
              Send
            </button>
          </div>
          {agent === null ? null : (
            <p
              id="composer-model-inheritance-line"
              data-testid="composer-run-target"
              data-agent-id={agent.id}
              data-run-target={runTargetIn(agent, projectId).kind}
              className={`text-[12px] ${runTargetWarns(runTargetIn(agent, projectId), overrideEntry !== undefined) ? 'text-warn' : 'text-muted'}`}
            >
              {runTargetLine(
                agent,
                overrideEntry === undefined
                  ? null
                  : {
                      connectionName: overrideEntry.connectionName,
                      model: overrideEntry.displayName,
                    },
                projectId,
              )}
            </p>
          )}
          <ModelUnavailableNotice unavailable={catalogUnavailable} />
        </div>

        {recent.length === 0 ? null : (
          <>
            <div className={SECTION_HEAD}>
              <h2 className="text-[15px] font-semibold">Recent</h2>
              <div className="ml-auto flex gap-2">
                <span
                  className={`${BTN_SM} ${BTN_GHOST} cursor-not-allowed opacity-[.62]`}
                  aria-disabled="true"
                >
                  See all
                </span>
              </div>
            </div>
            <div className="overflow-hidden rounded-(--radius) border border-border bg-surface shadow-(--shadow)">
              {recent.map((run) => (
                <RecentRow key={run.id} run={run} />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * A label the mockup draws as a link to a screen this wave does not build.
 *
 * The shell already answers this question for the navigation (`components/shell/sidebar-nav.tsx`):
 * show the label, mark it disabled, do not link. Repeating that answer here keeps one idiom for
 * "the destination is absent" across the application.
 */
function Unbuilt({ children }: { readonly children: string }) {
  return (
    <span aria-disabled="true" className="cursor-not-allowed opacity-[.62]">
      {children}
    </span>
  );
}

/**
 * The `<details class="picker">` shell: a pill summary, and a panel above it.
 *
 * `open` is React state rather than the element's own, because the mockup closes a picker on an
 * outside click and native `<details>` does not. `preventDefault` on the summary stops the browser
 * toggling it underneath us, so there is exactly one source of truth for which panel is showing.
 */
function Picker({
  id,
  testId,
  label,
  open,
  setOpen,
  disabled,
  children,
}: {
  readonly id: 'agent' | PickerKind;
  readonly testId?: string;
  readonly label: string;
  readonly open: OpenPicker;
  readonly setOpen: (next: OpenPicker) => void;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const isOpen = open === id && !disabled;
  return (
    <details
      className="group relative inline-block"
      data-picker={id}
      data-testid={testId}
      open={isOpen}
    >
      <summary
        aria-disabled={disabled ? 'true' : undefined}
        className={`${SUMMARY} ${disabled ? 'cursor-not-allowed opacity-[.62]' : ''}`}
        onClick={(event) => {
          event.preventDefault();
          if (disabled) return;
          setOpen(isOpen ? null : id);
        }}
      >
        {label} <span className="text-[9px] opacity-60">▾</span>
      </summary>
      <div className={PANEL}>{children}</div>
    </details>
  );
}

/**
 * A Files or Connectors picker — §19.5.1 rule 2 made visible.
 *
 * The rows come from {@link offeredBy}, whose only reachable source is the selected agent's own
 * permitted set. There is no workspace-wide list in scope here to filter, and therefore none to
 * leak: a row appears because the agent carries it. When the agent carries none, the panel says so
 * in the sentence the mockup already puts in its footer, and offers nothing.
 */
function NarrowingPicker({
  kind,
  label,
  agent,
  session,
  open,
  setOpen,
  onToggle,
  footer,
}: {
  readonly kind: PickerKind;
  readonly label: string;
  readonly agent: ComposerAgent | null;
  readonly session: ComposerSession | null;
  readonly open: OpenPicker;
  readonly setOpen: (next: OpenPicker) => void;
  readonly onToggle: (kind: PickerKind, optionId: string) => void;
  readonly footer: ReactNode;
}) {
  const options: readonly PickerOption[] = agent === null ? [] : offeredBy(agent, kind);
  const selected = session === null ? [] : selectedIn(session, kind);

  return (
    <Picker id={kind} label={label} open={open} setOpen={setOpen} disabled={agent === null}>
      <div className={PHEAD}>Available to this agent</div>
      {options.map((option) => {
        const on = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            className={`${OPT} ${on ? 'bg-accent-soft' : ''}`}
            onClick={() => onToggle(kind, option.id)}
          >
            <span
              className={`mt-0.5 grid size-4 flex-none place-items-center rounded-[4px] border-[1.5px] text-[11px] leading-none ${
                on
                  ? 'border-accent bg-accent font-bold text-white dark:text-[#10131c]'
                  : 'border-border-strong bg-surface'
              }`}
            >
              {on ? '✓' : ''}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{option.name}</span>
              <span className="block text-[12px] text-muted">{option.detail}</span>
            </span>
          </button>
        );
      })}
      <div className={PFOOT}>{footer}</div>
    </Picker>
  );
}

/** One `.row` of the Recent list. A row with no destination does not pretend to be a link. */
function RecentRow({ run }: { readonly run: RecentSession }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          {run.title}
          {run.titleBadges.map((badge) => (
            <span key={badge.label} className={`${BADGE} ${BADGE_TONE[badge.tone]}`}>
              {badge.label}
            </span>
          ))}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">{run.meta}</div>
      </div>
      <div className="flex items-center gap-3.5 text-[12.5px] whitespace-nowrap text-muted">
        <span className={`${BADGE} ${BADGE_TONE[run.status.tone]}`}>{run.status.label}</span>
        {run.cost === null ? null : <span>{run.cost}</span>}
      </div>
    </>
  );

  if (run.href === null) return <div className={ROW}>{body}</div>;
  return (
    <a className={`${ROW} hover:bg-surface-2 hover:no-underline`} href={run.href}>
      {body}
    </a>
  );
}
