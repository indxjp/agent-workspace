/**
 * The run view's data model, and the one decision §19.5.1 rule 5 turns on.
 *
 * `@indx-workspace/react/run-model` is an internal subpath (issue #623): the console's run view and
 * the surface chat share this one conversation model through it. It is not in the README or the
 * semver promise, and may change in any release.
 *
 * The screen itself is a transcription of `ui/agent-run.html` and lives in `run-view.tsx`. What
 * lives here is the part that is *behaviour* rather than layout, kept out of the component so a
 * test can call it:
 *
 *   * **Rule 5 — the home chat becomes the run view.** {@link screenFor} is the only thing in this
 *     repository that decides which of the two screens the home route shows, and {@link beginRun}
 *     is the only way to reach the run screen. There is no second chat implementation and no second
 *     route that could disagree with this function.
 *
 *   * **§19 — plain language first, technical detail behind a disclosure.** A {@link Run} carries
 *     the transcript and the {@link TechnicalDetails} as two separate fields, and the component
 *     renders the second inside a `<details>` that is never given `open`. The separation is in the
 *     type so that "the SDK event stream leaked into the transcript" is a compile error rather than
 *     a thing a reviewer has to notice.
 *
 * ## ADR-0015 — the composer screen is shown because a run is *absent*, asserted
 *
 * The failure this module is written against is the obvious one: a malformed or missing run makes
 * some comparison falsy, control falls through, and the user is shown an empty composer while a run
 * is in flight — the screen silently forgetting a conversation that exists. So:
 *
 *   * {@link screenFor} parses before it compares. `null` is the one value that means "no run has
 *     started"; `undefined` is not that value and is rejected, because "nobody said" and "there is
 *     none" are different facts and only one of them is safe to render as an empty composer.
 *   * It ends in a total, explicit rejection that names what it rejected.
 *   * {@link Run} carries a **non-empty** message tuple. A run with an empty transcript is not
 *     representable, so "after the first message" is a property of the type rather than a length
 *     check somebody can forget.
 */
import {
  assistantResponseFromAgentEvent,
  type AssistantResponse,
} from '@indx-workspace/sdk/events';

import { parseRunFailure } from '@indx-workspace/contracts/runs';

/** A tone from the design system's badge palette (`.badge.ok`, `.badge.warn`, … in `ui/assets/app.css`). */
export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

/** One badge as the mockup draws it: a label and a tone, and nothing else. */
export interface Badge {
  readonly label: string;
  readonly tone: BadgeTone;
}

/**
 * A badge as the run view draws it: the design system's badge, plus the mockup's optional `.dot`.
 *
 * The dot is data and not a function of the tone. `ui/agent-run.html` puts one on "Running" and
 * none on "Completed · 23 s · $0.08" — both `.badge.ok` — because the dot means *live*, not
 * *green*. Deriving it from the tone would make the screen claim a run is still going because its
 * badge happens to be the same colour, which is a state asserted from a coincidence (ADR-0015).
 */
export interface RunBadge extends Badge {
  readonly dot: boolean;
}

// ── Prose ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One run of inline text.
 *
 * `ui/agent-run.html` uses exactly two inline constructs inside a message body: `<b>`, for the
 * lead-in of each numbered contract and for the two deviations, and `<span class="mono">`, for the
 * path in the user's question and the written output file. Both are modelled and neither is more
 * than a flag.
 *
 * That is the whole inline vocabulary, on purpose. The alternative is rendering the agent's prose
 * as Markdown, which means a Markdown parser and a sanitiser; §19 asks for plain language and §40
 * makes a dependency the last resort, so the mockup's two constructs are the two constructs
 * modelled. See `docs/adr/W1-UI-03-agent-prose-is-not-markdown.md`.
 *
 * Amended by ADR-0141: assistant prose is now rendered as Markdown from its runs' joined text
 * (`./assistant-prose.tsx`); these flags still style user text and fact notes.
 */
export interface Inline {
  readonly text: string;
  /** `<b>`. */
  readonly strong: boolean;
  /** `.mono` — the design system's monospace face at 12.5px. */
  readonly mono: boolean;
}

/** One `<p>` in a message body. */
export type Paragraph = readonly Inline[];

/** Convenience for the common case: a paragraph with no emphasis in it. */
export function plain(text: string): Paragraph {
  return [{ text, strong: false, mono: false }];
}

/** One emphasised run — the mockup's `<b>`. */
export function strong(text: string): Inline {
  return { text, strong: true, mono: false };
}

/** One monospace run — the mockup's `<span class="mono">`, used for paths and identifiers. */
export function mono(text: string): Inline {
  return { text, strong: false, mono: true };
}

/** One ordinary run, for composing a paragraph that also has emphasis or a path in it. */
export function text(value: string): Inline {
  return { text: value, strong: false, mono: false };
}

// ── The activity list (§19) ─────────────────────────────────────────────────────────────────────

/**
 * One line of the plain-language activity list — the mockup's `.activity .act`.
 *
 * `state` is what separates "✓ Read agreement-01.pdf · 0.6 s" from "◌ Preparing summary… · —", and
 * it is a closed union so the component's rendering of it is a total switch rather than a
 * truthiness test on a duration that may legitimately be absent.
 */
export interface ActivityStep {
  readonly id: string;
  readonly state: 'done' | 'running';
  /** The plain-language verb: "Read", "Internal Search", "Preparing summary…". */
  readonly label: string;
  /** The `.tool` chip after the label — a path or an MCP method — or `null` when there is none. */
  readonly tool: string | null;
  /** The right-aligned `.dur` cell. The mockup shows "—" while a step is still running. */
  readonly duration: string;
}

/** One block of an agent turn's body: prose, or a bracket of activity beside it. */
export type TurnBlock =
  | { readonly kind: 'prose'; readonly paragraphs: readonly Paragraph[] }
  | { readonly kind: 'activity'; readonly steps: readonly ActivityStep[] };

// ── The transcript ──────────────────────────────────────────────────────────────────────────────

/** The `.who` avatar and the `.name` line above a message body. */
export interface Speaker {
  /** The two characters inside the circle — "AI" for Aya Ito, "CS" for the Customer Support Agent. */
  readonly initials: string;
  readonly name: string;
}

/**
 * One message. The two arms are the mockup's `.msg.user` and `.msg.agent`, and they differ in more
 * than a colour: a person writes prose, an agent produces prose *interleaved with* activity.
 */
export type Message =
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly speaker: Speaker;
      readonly paragraphs: readonly Paragraph[];
    }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly speaker: Speaker;
      readonly blocks: readonly TurnBlock[];
    };

// ── Show technical details (§19) ────────────────────────────────────────────────────────────────

/** One line of an `.event-log` — a timestamp, an event name, and the rest. */
export interface EventLine {
  readonly id: string;
  /** The `.ts` cell, already formatted: the mockup shows `14:32:04.118`. */
  readonly time: string;
  /** The `.ev` cell: `system.init`, `tool_use.Read`, `runtime.ready`. */
  readonly event: string;
  /** The `.dt` cell: whatever that event carried, already rendered to one line. */
  readonly detail: string;
}

/** One cell of the Usage tab's `.stat-row`. */
export interface UsageStat {
  readonly id: string;
  /** The `.k` line, drawn uppercase by the design system. */
  readonly label: string;
  /** The `.v` line. Already formatted — the mockup writes "11 940" and "$0.08". */
  readonly value: string;
}

/** One `<dt>`/`<dd>` pair of the Usage tab's `.kv` list. */
export interface UsageFact {
  readonly term: string;
  /** The main text of the `<dd>`, or `''` when the badge alone is the answer. */
  readonly detail: string;
  /**
   * The `.muted.small` continuation after the detail, or `null`.
   *
   * A {@link Paragraph} and not a string, because the mockup puts a `.mono` span inside it — the
   * gateway URL under **Provider**, the container id under **Runtime**. Flattening it to a string
   * loses the monospace face, which is the difference between a label and an identifier.
   */
  readonly note: Paragraph | null;
  /** A badge before the detail, or `null`. The mockup uses one for "Prompt caching · Used". */
  readonly badge: RunBadge | null;
  /** Whether `detail` is drawn in the monospace face, as the mockup draws the model id. */
  readonly mono: boolean;
}

/**
 * Everything §19 lists behind **Show technical details**: SDK events, tool calls, MCP calls, token
 * usage, runtime events and errors.
 *
 * Tool calls and MCP calls are not separate fields because the mockup does not give them separate
 * panels — they are lines in the SDK event log (`tool_use.Read`, `mcp.request`), which is where the
 * SDK actually emits them. Errors likewise arrive as event lines.
 */
export interface TechnicalDetails {
  /** The **SDK events** tab. */
  readonly sdkEvents: readonly EventLine[];
  /** The sentence under the SDK event log. */
  readonly sdkEventsNote: string;
  /** The **Usage** tab's stat row. */
  readonly usageStats: readonly UsageStat[];
  /** The **Usage** tab's key/value card. */
  readonly usageFacts: readonly UsageFact[];
  /** The **Runtime** tab. */
  readonly runtimeEvents: readonly EventLine[];
}

/** A technical-details value with nothing in it yet — what a run has before its first SDK event. */
export const NO_TECHNICAL_DETAILS: TechnicalDetails = {
  sdkEvents: [],
  sdkEventsNote: '',
  usageStats: [],
  usageFacts: [],
  runtimeEvents: [],
};

// ── The page around the transcript ──────────────────────────────────────────────────────────────

/** A label the mockup draws as a control for something no task in this wave builds. */
export interface UnbuiltAction {
  readonly id: string;
  readonly label: string;
  /** `true` for the mockup's `.btn.primary`. */
  readonly primary: boolean;
}

/** The `.page-head`: the agent's name, the session line under it, and the run's state badge. */
export interface RunHeading {
  /** The `<h1>` — the agent this run is of. */
  readonly title: string;
  /** The `.sub` line: session id, when it started, model, runtime. `''` renders no line. */
  readonly subtitle: string;
  /**
   * The run-state badge, or `null` when the screen does not know the run's state.
   *
   * `null` is not decoration-avoidance; it is the difference between "this run is Running" and
   * "nobody has told this screen anything yet". The home chat's first message reaches this type
   * before any event has arrived, and a badge reading "Running" there would be a state asserted
   * because nothing contradicted it (ADR-0015). Absent says less, and what it says is true.
   */
  readonly status: RunBadge | null;
  /** The buttons beside the badge. Empty renders none. */
  readonly actions: readonly UnbuiltAction[];
}

/** One row of a right-rail card that is a `.kv` list. */
export interface RailFact {
  readonly term: string;
  readonly detail: string;
  /** The `.muted.small` second line under the detail, or `null`. See {@link UsageFact.note}. */
  readonly note: Paragraph | null;
  readonly badge: RunBadge | null;
}

/** One row of a right-rail card that is a `.rows` list — the mockup's **Output files** card. */
export interface RailFile {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly action: UnbuiltAction | null;
}

/** One group inside a right-rail card that is a list of labels — the **In use** card. */
export interface RailGroup {
  readonly label: string;
  /** Rendered in the monospace face, joined with the mockup's " · ". */
  readonly items: readonly string[];
}

/**
 * One card of the right rail. Three shapes, because the mockup draws exactly three: a key/value
 * list, groups of monospace labels, and a row list with a footnote.
 */
export type RailCard =
  | {
      readonly kind: 'facts';
      readonly id: string;
      readonly title: string;
      readonly facts: readonly RailFact[];
    }
  | {
      readonly kind: 'groups';
      readonly id: string;
      readonly title: string;
      readonly groups: readonly RailGroup[];
    }
  | {
      readonly kind: 'files';
      readonly id: string;
      readonly title: string;
      readonly files: readonly RailFile[];
      readonly footnote: string;
    };

/** The composer under the transcript — §19.5.1 rule 5's "the same chat, still a chat". */
export interface FollowUp {
  readonly placeholder: string;
  /** The ghost buttons on the left of the tool row. */
  readonly actions: readonly UnbuiltAction[];
  /** The `.small.muted` line before **Send**: "Claude Sonnet 5 · $0.08 spent of $1.50". */
  readonly status: string;
}

/**
 * Why the run on screen failed, in the conversation itself (issue #393) — not only in the Runtime
 * tab of the technical details, where a person reading the chat would never look. `code` is the
 * safe, contract-declared code when the server named one (`RUN_START_PROBLEM_CODES`, or a coded
 * run error), so the screen can say *which* piece is missing; `null` when it named none.
 */
export interface RunFailureNotice {
  readonly code: string | null;
  readonly message: string;
}

/**
 * A run, as this screen shows it.
 *
 * `messages` is a **non-empty tuple**. That is the type-level statement of §19.5.1 rule 5: this
 * value cannot exist before the first message, so no code path can render the run view of an
 * empty conversation and no code path needs a length check to avoid it.
 */
export interface Run {
  readonly heading: RunHeading;
  readonly messages: readonly [Message, ...Message[]];
  readonly technical: TechnicalDetails;
  /** The right rail. Empty renders no `<aside>` at all, and the transcript takes the full width. */
  readonly rail: readonly RailCard[];
  readonly followUp: FollowUp;
  /** The failure shown in the transcript, or `null` while the run has not failed. */
  readonly failure: RunFailureNotice | null;
}

// ── §19.5.1 rule 5 ──────────────────────────────────────────────────────────────────────────────

/**
 * Which of the two screens the home route shows. There is no third arm and there is no default.
 */
export type Screen = { readonly kind: 'composer' } | { readonly kind: 'run'; readonly run: Run };

/** The reason {@link screenFor} refuses a value, so a caller cannot mistake refusal for "no run". */
export class NotARunError extends TypeError {}

/**
 * §19.5.1 rule 5, as one function: **`null` is the composer, a run is the run view, and everything
 * else is refused by name.**
 *
 * The input is parsed before it is compared. `undefined` is refused rather than treated as `null`,
 * because a caller that forgot to pass the run and a caller that says there is no run are different
 * callers, and only the second one may be answered with an empty composer — showing one to the first
 * would silently discard a conversation in flight. A value that is neither is refused for the same
 * reason: a falsy check here would fail open onto the composer, which is exactly the shape
 * ADR-0015 forbids.
 *
 * The run's structure is checked positively rather than trusted. A `Run` is only constructible
 * through {@link beginRun} and {@link withMessage} in TypeScript, but this function is also the
 * boundary for a value that crossed a serialisation (a resumed session read back from the run API),
 * where the compiler guarantees nothing.
 *
 * @throws NotARunError when the value is neither `null` nor a run with at least one message.
 */
export function screenFor(run: unknown): Screen {
  if (run === null) return { kind: 'composer' };

  if (run === undefined) {
    throw new NotARunError(
      'screenFor received undefined; pass null to mean "no run has started yet". ' +
        'undefined is a caller that forgot, not a conversation that is absent.',
    );
  }

  if (typeof run !== 'object') {
    throw new NotARunError(`screenFor received a ${typeof run}, which is not a run`);
  }

  const candidate = run as Partial<Run>;
  if (!Array.isArray(candidate.messages)) {
    throw new NotARunError('screenFor received an object with no messages array; it is not a run');
  }
  if (candidate.messages.length === 0) {
    throw new NotARunError(
      'screenFor received a run with an empty transcript. The home chat becomes the run view ' +
        'after the first message (§19.5.1 rule 5); before it, the run is null.',
    );
  }
  if (candidate.heading === undefined || candidate.followUp === undefined) {
    throw new NotARunError(
      'screenFor received an object with a messages array but no heading or follow-up; it is not a run',
    );
  }

  return { kind: 'run', run: candidate as Run };
}

/** What {@link beginRun} needs that the first message does not carry. */
export interface RunOpening {
  readonly heading: RunHeading;
  readonly technical?: TechnicalDetails;
  readonly rail?: readonly RailCard[];
  readonly followUp: FollowUp;
}

/**
 * The transition §19.5.1 rule 5 describes: the first message turns the composer screen into the run
 * view. This is the only constructor of a {@link Run}, and it requires the message, so the run view
 * cannot be reached without one.
 *
 * The first message is the user's, always. An agent cannot speak first — there is nothing for it to
 * answer — and a caller that tries is refused by name rather than producing a transcript that opens
 * mid-conversation.
 */
export function beginRun(opening: RunOpening, first: Message): Run {
  if (first.kind !== 'user') {
    throw new NotARunError(
      `a run begins with the user's message; received a ${JSON.stringify(first.kind)} message`,
    );
  }
  return {
    heading: opening.heading,
    messages: [first],
    technical: opening.technical ?? NO_TECHNICAL_DETAILS,
    rail: opening.rail ?? [],
    followUp: opening.followUp,
    failure: null,
  };
}

/** Append one message to a run. The tuple stays non-empty by construction. */
export function withMessage(run: Run, message: Message): Run {
  return { ...run, messages: [run.messages[0], ...run.messages.slice(1), message] };
}

/**
 * Reading the assistant's visible answer out of one neutral `agent.message` event is the
 * `assistant` arm of the SDK's event view (`@indx-workspace/sdk/events`,
 * `assistantResponseFromAgentEvent`) and lives there — the same seam `./live.ts` uses for the SSE
 * parser. Since ENG-03 (#302) the stream carries that vocabulary itself, so this screen reads a
 * parsed event and no longer parses an engine's message shape.
 */
export { assistantResponseFromAgentEvent, type AssistantResponse };

/**
 * Insert or update one visible assistant turn. Agent SDK assistant events are snapshots, so a
 * repeated event with the same provider id replaces that turn rather than appending a duplicate.
 */
export function withAssistantResponse(
  run: Run,
  speaker: Speaker,
  response: AssistantResponse,
): Run {
  const id = `assistant-${response.id}`;
  const message: Message = {
    kind: 'agent',
    id,
    speaker,
    blocks: [
      {
        kind: 'prose',
        paragraphs: response.text.map((value) => plain(value)),
      },
    ],
  };
  const index = run.messages.findIndex((candidate) => candidate.id === id);
  if (index === -1) return withMessage(run, message);

  const messages = [...run.messages];
  messages[index] = message;
  return { ...run, messages: messages as [Message, ...Message[]] };
}

/**
 * The user's first message, built from what the home composer has when **Send** is pressed.
 *
 * Empty and whitespace-only text is refused rather than sent. The composer disables **Send** for
 * exactly that case, but a disabled button is a courtesy and this is the check — a gate that exists
 * only in the control that calls it is not a gate.
 */
export function userMessage(id: string, speaker: Speaker, text: string): Message {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') {
    throw new NotARunError('a message with no text is not a message');
  }
  return { kind: 'user', id, speaker, paragraphs: [plain(trimmed)] };
}

// ── Live runs ───────────────────────────────────────────────────────────────────────────────────
//
// W1-UI-05: turning what `POST /api/agents/:id/runs` and `GET /api/runs/:id/events` actually say
// into updates to a `Run` already on screen. `./live.ts` is the transport — it reads the network
// and knows nothing about a `Run`; every function below is pure, so what a frame *means* is
// asserted here and checked without a browser.

/**
 * The run lifecycle this control plane defines, restated from `server/runs/store.ts`'s own
 * `runStatuses` (itself restated from `packages/core`, for the same reason stated there:
 * `home-chat.tsx` is `'use client'`, so nothing under `apps/web/server/**` — Node-only modules
 * included — may be imported from this file). If the two lists ever disagree, {@link
 * badgeForRunStatus} does not crash and does not fabricate one of the five it expected; it shows
 * the raw string the server actually sent.
 */
export const RUN_STATUS_NAMES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
type RunStatusName = (typeof RUN_STATUS_NAMES)[number];

function isRunStatusName(value: unknown): value is RunStatusName {
  return typeof value === 'string' && (RUN_STATUS_NAMES as readonly string[]).includes(value);
}

/**
 * The platform's own lifecycle event name — `server/runs/sse.ts`'s `RUN_STATUS_EVENT`, restated
 * for the reason above. `home-chat.tsx` uses this to tell the platform's own status frame apart
 * from an arbitrary relayed SDK event, which is otherwise indistinguishable by shape alone.
 */
export const RUN_STATUS_EVENT_NAME = 'run.status';

/** Replace the run's status badge. `null` clears it — "nobody has told this screen anything yet". */
export function withStatus(run: Run, status: RunBadge | null): Run {
  return { ...run, heading: { ...run.heading, status } };
}

/** Show (or, with `null`, clear) the failure the transcript carries — issue #393. */
export function withFailure(run: Run, failure: RunFailureNotice | null): Run {
  return { ...run, failure };
}

/**
 * A failure as the transcript shows it: a coded message (`<code>: <text>`, the shape a run refused
 * while it was being composed stores) is split so the code is shown apart from the sentence.
 */
export function failureNoticeFrom(message: string, code: string | null = null): RunFailureNotice {
  if (code !== null) return { code, message };
  const parsed = parseRunFailure(message);
  return parsed === null ? { code: null, message } : { code: parsed.code, message: parsed.message };
}

/** Append one line to the SDK event log — §19's raw stream behind "Show technical details". */
export function withSdkEvent(run: Run, line: EventLine): Run {
  return { ...run, technical: { ...run.technical, sdkEvents: [...run.technical.sdkEvents, line] } };
}

/** Append one line to the Runtime tab — this server's own lifecycle frames, not a relayed SDK event. */
export function withRuntimeEvent(run: Run, line: EventLine): Run {
  return {
    ...run,
    technical: { ...run.technical, runtimeEvents: [...run.technical.runtimeEvents, line] },
  };
}

/** `HH:MM:SS.mmm` — the mockup's own event-log timestamp shape (`mockup-fixture.ts`), for a real clock reading. */
export function formatEventTime(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * A frame's `data:` payload, as the one line of text an {@link EventLine} shows. A string is shown
 * as itself; anything else is its JSON. Never throws — a payload this cannot render (a BigInt, a
 * cycle) is shown as `String(data)` rather than dropped, because a frame that arrived is real and
 * is worth a line even when it will not serialise cleanly.
 */
function renderEventDetail(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/** One line of an event log, built from a real frame this screen received. */
export function eventLineFrom(id: string, time: string, event: string, data: unknown): EventLine {
  return { id, time, event, detail: renderEventDetail(data) };
}

/**
 * The run-state badge for a status string this screen read off a real API response. Total over
 * the five names this platform defines; an unrecognised string is still shown, in its own words,
 * rather than hidden (ADR-0015 — a status this function did not check is not asserted as one it
 * did).
 */
export function badgeForRunStatus(status: unknown): RunBadge {
  if (!isRunStatusName(status)) {
    return { label: typeof status === 'string' ? status : 'Unknown', tone: 'muted', dot: false };
  }
  switch (status) {
    case 'queued':
      return { label: 'Queued', tone: 'muted', dot: true };
    case 'running':
      return { label: 'Running', tone: 'info', dot: true };
    case 'completed':
      return { label: 'Completed', tone: 'ok', dot: false };
    case 'failed':
      return { label: 'Failed', tone: 'danger', dot: false };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'warn', dot: false };
    default: {
      // Unreachable while `status` is a RunStatusName, and a rejection rather than a fallthrough
      // if a later edit widens the union without widening this switch (ADR-0015).
      const unreachable: never = status;
      throw new TypeError(`unhandled run status ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The badge for a run the server has already told this screen did not succeed — a `run-failed`
 * control frame, or a terminal `run.status` event carrying a non-null `error`. Cancellation reads
 * as a deliberate stop, not a failure; everything else is `danger`, named with whatever status the
 * server actually gave rather than a bare "Failed".
 */
export function failureBadge(status: string): RunBadge {
  if (status === 'cancelled') return { label: 'Cancelled', tone: 'warn', dot: false };
  return {
    label: status === 'unknown' ? 'Failed' : `Failed · ${status}`,
    tone: 'danger',
    dot: false,
  };
}

/** The `{ status, message }` a `run-failed` control frame carries — `server/runs/sse.ts`'s own words for the shape. Parsed rather than trusted: this value crossed the network. */
export function parseRunFailedPayload(data: unknown): {
  readonly status: string;
  readonly message: string;
} {
  if (typeof data !== 'object' || data === null) {
    return { status: 'unknown', message: 'the run-failed frame carried no readable payload.' };
  }
  const record = data as Record<string, unknown>;
  const status = typeof record['status'] === 'string' ? record['status'] : 'unknown';
  const message =
    typeof record['message'] === 'string' ? record['message'] : 'the run did not succeed.';
  return { status, message };
}

/** The `{ status, error }` a `run.status` platform event carries — `server/runs/launcher.ts`'s own `conclude`. */
export function parseRunStatusPayload(data: unknown): {
  readonly status: unknown;
  readonly error: string | null;
} {
  if (typeof data !== 'object' || data === null) {
    return { status: undefined, error: null };
  }
  const record = data as Record<string, unknown>;
  const error = typeof record['error'] === 'string' ? record['error'] : null;
  return { status: record['status'], error };
}
