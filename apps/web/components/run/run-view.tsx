'use client';

/**
 * The run view — spec §19, transcribed from `ui/agent-run.html`.
 *
 * This is **the** run component. §19.5.1 rule 5 says the home chat *becomes* this screen once the
 * first message is sent, so there is one of it and `components/composer/home-chat.tsx` renders it
 * rather than growing a second transcript of its own. `run-view.test.ts` fails if a second one
 * appears anywhere under `apps/web`.
 *
 * Every class below is a translation of a rule in `ui/assets/app.css` — `.page.wide`, `.page-head`,
 * `.split-wide`, `.chat`, `.msg`, `.activity`, `details.adv`, `.tabs`, `.event-log`, `.stat-row`,
 * `.kv`, `.card`, `.rows`, `.composer`, `.badge`, `.btn` — spending the tokens
 * `apps/web/app/globals.css` already ports. Pixel values the mockup uses that are not on Tailwind's
 * scale (13.5px type, a 155px event column, a 330px rail, the 981px breakpoint) are arbitrary-value
 * utilities, because rounding them to the nearest step would be redesigning the mockup. Every
 * visible string is copied from `ui/agent-run.html` verbatim, or arrives as data.
 *
 * ## The one thing §19 is emphatic about
 *
 * "Show technical details … but keep it hidden by default." The `<details>` below is never given
 * `open`, and nothing in this file can open it — there is no prop, no state and no effect that
 * would. It opens because a person clicked it. A test asserts the rendered markup carries no `open`
 * attribute, which is the only form of that assertion that cannot rot.
 *
 * ## What is transcribed here and what arrives as data
 *
 * The mockup is a *demonstration*: a fictional session about three supplier contracts, with a
 * fictional agent, container id, cost and file list. None of that is design, so none of it is
 * transcribed as content — the shapes are transcribed and the content arrives in a {@link Run}. Two
 * consequences follow, and each is recorded in `docs/adr/`:
 *
 *   1. **An action nobody has built is a disabled button, not a live one.** Interrupt, Sessions,
 *      Attach file, Resume another session and Download point at capability no Wave 1 task ships.
 *      They render with the label the mockup gives them, in the design system's own
 *      `.btn[disabled]` treatment. See W1-UI-03-an-unbuilt-action-is-a-disabled-button.md.
 *   2. **A region with no data is absent, not an empty frame.** No rail cards renders no `<aside>`
 *      and the transcript takes the full width; no SDK events renders the tab's empty line rather
 *      than an empty log. §43 asks for calm and sparse, and a framed empty container is furniture.
 */
import { useState } from 'react';
import { AssistantProse } from '@indx-workspace/react';
import { ShareDialog, type ShareSubject } from '../shares/share-dialog';

import {
  type ActivityStep,
  type BadgeTone,
  type EventLine,
  type Message,
  type Paragraph,
  type RailCard,
  type Run,
  type RunBadge,
  type RunFailureNotice,
  type TurnBlock,
  type UnbuiltAction,
} from '@indx-workspace/react/run-model';

// ── Transcribed class strings ───────────────────────────────────────────────────────────────────

/**
 * `.badge`. {@link StatusBadge} is exported so issue #136's Runs list and detail panel render the
 * same badge rather than a second translation that could drift from this one.
 */
const BADGE =
  'inline-flex items-center gap-[5px] rounded-[999px] px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap';
/** `.badge.ok`, `.badge.warn`, … Same map as the composer's, because it is the same CSS. */
const BADGE_TONE: Readonly<Record<BadgeTone, string>> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  muted: 'bg-surface-3 text-muted',
};
/**
 * `.btn`, split into the parts the mockup composes.
 *
 * Size and colour are separate constants because Tailwind resolves two utilities of the same
 * property by their order **in the generated stylesheet**, not by the order they appear in a
 * `className`. A base that carried `bg-surface` and a variant that carried `bg-accent` would not
 * reliably produce a blue button — the first draft of this file produced a white one with white
 * text on it. Every call site therefore picks exactly one size and exactly one colour.
 */
const BTN =
  'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border font-medium';
/** `.btn`'s own geometry. */
const BTN_MD = 'h-8 px-[13px] text-[13px]';
/** `.btn.sm`. */
const BTN_SM = 'h-[27px] px-[9px] text-[12.5px]';
/** `.btn`'s own colours. */
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
/** `.btn.primary`. The dark-mode foreground is `ui/assets/app.css`'s own `@media` override. */
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
/** `.btn.ghost`. */
const BTN_GHOST = 'border-transparent bg-transparent text-text-2';
/** `.btn[disabled]`. The design system's own answer for an action that cannot be taken. */
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
/** `.card`. */
const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
/** `.card .card-head`. */
const CARD_HEAD = 'flex items-center gap-3 border-b border-border px-4 py-[13px]';
/** `.event-log`. */
const EVENT_LOG = 'font-mono text-[12px] leading-[1.7]';
/** `.kv`. */
const KV =
  'm-0 grid grid-cols-1 gap-x-4 gap-y-[11px] text-[13.5px] sm:grid-cols-[150px_minmax(0,1fr)] [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere]';

// ── The screen ──────────────────────────────────────────────────────────────────────────────────

export interface RunViewProps {
  readonly run: Run;
  readonly sessionId: string | null;
  readonly onFollowUp?: (text: string) => void;
}

/** A session share must use the durable session id, never a display title or subtitle. */
export function shareSubjectForSession(
  sessionId: string | null,
  label: string,
): ShareSubject | null {
  const id = sessionId === null ? '' : sessionId.trim();
  return id === '' ? null : { type: 'session', id, label };
}

/** Publish visible message content without the signed-in user's identity. */
export function shareableTranscript(messages: readonly Message[]): readonly unknown[] {
  return messages.map((message) => {
    switch (message.kind) {
      case 'user':
        return { kind: message.kind, id: message.id, paragraphs: message.paragraphs };
      case 'agent':
        return { kind: message.kind, id: message.id, blocks: message.blocks };
      default: {
        const unknown: never = message;
        throw new TypeError(`no message of kind ${JSON.stringify(unknown)} can be shared`);
      }
    }
  });
}

/**
 * The §19 run view. One component, rendered by the home chat after the first message and by
 * nothing else in this wave.
 */
export function RunView({ run, sessionId, onFollowUp }: RunViewProps) {
  const { heading, messages, technical, rail, followUp, failure } = run;
  const shareSubject = shareSubjectForSession(sessionId, heading.title);
  const [followUpDraft, setFollowUpDraft] = useState('');
  const lastMessage = messages[messages.length - 1] ?? messages[0];
  // `dot` means *live* (`badgeForRunStatus`), and a null status is a run whose status is not known
  // yet. A follow-up is a second run on the same session, so it must wait for a terminal status —
  // not merely for the assistant's first streamed snapshot, which arrives mid-run.
  const runIsLive = heading.status === null || heading.status.dot;
  const assistantIsWorking = lastMessage.kind === 'user' && runIsLive && failure === null;
  const canSendFollowUp = onFollowUp !== undefined && !runIsLive && followUpDraft.trim() !== '';

  const submitFollowUp = () => {
    if (!canSendFollowUp || onFollowUp === undefined) return;
    const text = followUpDraft.trim();
    setFollowUpDraft('');
    onFollowUp(text);
  };

  return (
    <main className="w-full max-w-[1320px] px-5 pt-5 pb-[90px] sm:px-8">
      <div className="mx-auto mb-8 flex max-w-[900px] items-center gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold">{heading.title}</h1>
          {heading.subtitle === '' ? null : (
            <div className="mt-0.5 truncate text-[12px] text-muted">{heading.subtitle}</div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {shareSubject === null ? null : (
            <ShareDialog subject={shareSubject} transcript={shareableTranscript(messages)} />
          )}
          {heading.status === null ? null : <StatusBadge badge={heading.status} />}
          {heading.actions.map((action) => (
            <UnbuiltButton key={action.id} action={action} />
          ))}
        </div>
      </div>

      {/* A calm, conversation-first column. Operational data stays in the optional rail/details. */}
      <div
        className={`mx-auto grid items-start gap-7 ${
          rail.length === 0
            ? 'max-w-[820px] grid-cols-1'
            : 'max-w-[1180px] grid-cols-1 min-[981px]:grid-cols-[minmax(0,820px)_300px]'
        }`}
      >
        <div className="min-w-0">
          <div aria-live="polite" className="flex flex-col gap-8">
            {messages.map((message) => (
              <MessageBlock key={message.id} message={message} />
            ))}
            {assistantIsWorking ? <PendingAssistant name={heading.title} /> : null}
            {failure === null ? null : <FailureNotice failure={failure} />}
          </div>

          <div className="mt-10 flex flex-col gap-2 rounded-[18px] border border-border-strong bg-surface px-4 py-3 shadow-(--shadow)">
            <textarea
              aria-label="Ask a follow-up"
              className="min-h-[52px] w-full resize-y border-0 bg-transparent p-0 text-[14.5px] leading-[1.6] text-text placeholder:text-muted focus:outline-none"
              placeholder={followUp.placeholder}
              value={followUpDraft}
              onChange={(event) => setFollowUpDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                submitFollowUp();
              }}
            />
            <div className="flex items-center gap-2">
              {followUp.actions.map((action) => (
                <UnbuiltButton key={action.id} action={action} ghost small />
              ))}
              <span className="flex-1" />
              <span className="text-[12.5px] text-muted">{followUp.status}</span>
              <button
                type="button"
                disabled={!canSendFollowUp}
                onClick={submitFollowUp}
                className={`${BTN} ${BTN_SM} ${BTN_PRIMARY} ${
                  canSendFollowUp
                    ? 'cursor-pointer hover:border-accent-hover hover:bg-accent-hover'
                    : BTN_DISABLED
                }`}
              >
                Send
              </button>
            </div>
          </div>

          {/* Diagnostics are secondary to the conversation and remain collapsed by default. */}
          <details className="group mt-5 border-t border-border pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-[7px] text-[12.5px] text-muted before:text-[10px] before:content-['▸'] group-open:before:content-['▾'] hover:text-text-2 [&::-webkit-details-marker]:hidden">
              Show technical details
              <span className="font-normal text-muted">SDK events, tool calls, usage</span>
            </summary>
            <div className="pt-3">
              <TechnicalPanels technical={technical} />
            </div>
          </details>
        </div>

        {rail.length === 0 ? null : (
          <aside className="flex flex-col gap-[14px]">
            {rail.map((card) => (
              <RailCardView key={card.id} card={card} />
            ))}
          </aside>
        )}
      </div>
    </main>
  );
}

// ── The transcript ──────────────────────────────────────────────────────────────────────────────

/**
 * Why the run failed, in the conversation (issue #393). The code, when the server named one, is
 * shown apart from the sentence so a reader can tell "no runtime profile" from "the key was
 * rejected" at a glance. The `data-testid`s are the stable hooks the generated-project E2E reads.
 */
export function FailureNotice({ failure }: { readonly failure: RunFailureNotice }) {
  return (
    <div
      role="alert"
      data-testid="run-failure"
      data-failure-code={failure.code ?? ''}
      className="rounded-[10px] border border-danger bg-danger-soft px-4 py-3 text-[13.5px] text-danger"
    >
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        This run did not complete
        {failure.code === null ? null : (
          <code
            data-testid="run-failure-code"
            className="rounded-[6px] bg-surface px-1.5 py-0.5 font-mono text-[12px]"
          >
            {failure.code}
          </code>
        )}
      </div>
      <p data-testid="run-failure-message" className="mt-1 text-text-2 [overflow-wrap:anywhere]">
        {failure.message}
      </p>
    </div>
  );
}

/** One `.msg`. Total over the two arms; there is no third kind of speaker. */
function MessageBlock({ message }: { readonly message: Message }) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="flex justify-end" aria-label={`Message from ${message.speaker.name}`}>
          <div className="max-w-[78%] rounded-[20px] bg-surface-3 px-4 py-2.5 text-[14.5px] leading-7 [&_p:last-child]:mb-0">
            {message.paragraphs.map((paragraph, index) => (
              <Prose key={index} paragraph={paragraph} />
            ))}
          </div>
        </div>
      );
    case 'agent':
      return (
        <div className="flex gap-3.5">
          <Avatar initials={message.speaker.initials} tone="agent" />
          <div className="min-w-0 flex-1 pt-0.5 text-[15px] leading-7 [&_p:last-child]:mb-0">
            <div className="mb-2 text-[13px] font-semibold text-text-2">{message.speaker.name}</div>
            {message.blocks.map((block, index) => (
              <BlockView key={index} block={block} />
            ))}
          </div>
        </div>
      );
    default: {
      // Unreachable while `message` is a Message, and a rejection rather than a fallthrough if a
      // later edit widens the union without widening this switch (ADR-0015).
      const unknown: never = message;
      throw new TypeError(`no message of kind ${JSON.stringify(unknown)} can be shown`);
    }
  }
}

/** The assistant occupies its eventual answer position while the SDK is still working. */
function PendingAssistant({ name }: { readonly name: string }) {
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <div className="flex gap-3.5" role="status" aria-label={`${name} is working`}>
      <Avatar initials={initials || 'AI'} tone="agent" />
      <div className="flex min-h-8 items-center gap-2 pt-0.5 text-[13.5px] text-muted">
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border-2 border-border-strong border-t-accent [animation-duration:.8s]"
        />
        Thinking…
      </div>
    </div>
  );
}

/** `.msg .who`. */
function Avatar({
  initials,
  tone,
}: {
  readonly initials: string;
  readonly tone: 'user' | 'agent';
}) {
  return (
    <div
      aria-hidden="true"
      className={`grid size-7 flex-none place-items-center rounded-full text-[11px] font-bold ${
        tone === 'user' ? 'bg-surface-3 text-text-2' : 'bg-text text-surface'
      }`}
    >
      {initials}
    </div>
  );
}

/**
 * Assistant Markdown (ADR-0141). Tailwind's preflight strips list, heading and table styles, and
 * `globals.css` restores only margins, heading weight and the monospace font, so the rest is here.
 */
const ASSISTANT_PROSE =
  '[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-[20px] [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[17px] [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-[15px] [&_h4]:mt-3 [&_h5]:mt-3 [&_h6]:mt-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-3 [&_pre]:px-3 [&_pre]:py-2 [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-2 [&_table]:mb-3 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_a]:underline';

/** One `<p>` of a user message or a fact note, with the mockup's one inline construct. */
function Prose({ paragraph }: { readonly paragraph: Paragraph }) {
  return (
    <p className="whitespace-pre-wrap">
      <Runs paragraph={paragraph} />
    </p>
  );
}

/**
 * The inline runs of one paragraph.
 *
 * `.mono` is a font change and `<b>` is emphasis; the mockup applies them independently, so the
 * element and the class are chosen independently rather than in one three-way branch.
 */
function Runs({ paragraph }: { readonly paragraph: Paragraph }) {
  return (
    <>
      {paragraph.map((run, index) => {
        const className = run.mono ? 'font-mono text-[12.5px]' : undefined;
        return run.strong ? (
          <b key={index} className={className}>
            {run.text}
          </b>
        ) : (
          <span key={index} className={className}>
            {run.text}
          </span>
        );
      })}
    </>
  );
}

/** Prose, or the activity bracket beside it. Total over {@link TurnBlock}. */
function BlockView({ block }: { readonly block: TurnBlock }) {
  switch (block.kind) {
    case 'prose':
      return (
        <>
          {block.paragraphs.map((paragraph, index) => (
            <AssistantProse
              key={index}
              text={paragraph.map((run) => run.text).join('')}
              className={ASSISTANT_PROSE}
            />
          ))}
        </>
      );
    case 'activity':
      return (
        <div className="my-3 flex flex-col gap-[7px] border-l-2 border-border pl-[14px]">
          {block.steps.map((step) => (
            <ActivityRow key={step.id} step={step} />
          ))}
        </div>
      );
    default: {
      const unknown: never = block;
      throw new TypeError(`no turn block of kind ${JSON.stringify(unknown)} can be shown`);
    }
  }
}

/**
 * One `.act` — the plain-language line §19's example is made of.
 *
 * The marker is chosen on `state`, which is a closed union, rather than on whether a duration
 * happens to be present. A running step legitimately has no duration and would otherwise be drawn
 * as finished.
 */
function ActivityRow({ step }: { readonly step: ActivityStep }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-2">
      {step.state === 'done' ? (
        <span className="text-[12px] text-ok">✓</span>
      ) : (
        <span
          aria-hidden="true"
          className="size-[11px] flex-none animate-spin rounded-full border-2 border-border-strong border-t-accent [animation-duration:.8s]"
        />
      )}
      {step.label}
      {step.tool === null ? null : (
        <span className="rounded-[4px] border border-border bg-surface-2 px-1.5 py-px font-mono text-[12px]">
          {step.tool}
        </span>
      )}
      <span className="ml-auto text-[12px] text-muted">{step.duration}</span>
    </div>
  );
}

// ── Show technical details ──────────────────────────────────────────────────────────────────────

/** The three tabs the mockup puts inside the disclosure, in the mockup's order. */
const TABS = [
  { id: 'events', label: 'SDK events' },
  { id: 'usage', label: 'Usage' },
  { id: 'runtime', label: 'Runtime' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function TechnicalPanels({ technical }: { readonly technical: Run['technical'] }) {
  const [active, setActive] = useState<TabId>('events');

  return (
    <>
      <div className="mb-[22px] flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={tab.id === active}
            className={`-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-3 py-[9px] text-[13.5px] whitespace-nowrap ${
              tab.id === active
                ? 'border-b-text font-semibold text-text'
                : 'border-b-transparent text-muted hover:text-text'
            }`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === 'events' ? (
        <section>
          <EventLogCard
            lines={technical.sdkEvents}
            empty="No SDK events have been received for this run."
          />
          {technical.sdkEventsNote === '' ? null : (
            <p className="mt-2 mb-0 text-[12.5px] text-muted">{technical.sdkEventsNote}</p>
          )}
        </section>
      ) : null}

      {active === 'usage' ? (
        <section>
          {technical.usageStats.length === 0 ? (
            <p className="mt-0 mb-0 text-[12.5px] text-muted">
              No usage has been reported for this run.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(94px,1fr))] gap-px overflow-hidden rounded-(--radius) border border-border bg-border">
              {technical.usageStats.map((stat) => (
                <div key={stat.id} className="bg-surface px-[15px] py-[13px]">
                  <div className="text-[11.5px] tracking-[.04em] text-muted uppercase">
                    {stat.label}
                  </div>
                  <div className="mt-[3px] text-[19px] font-semibold [font-variant-numeric:tabular-nums]">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {technical.usageFacts.length === 0 ? null : (
            <div className={`mt-4 ${CARD}`}>
              <div className="p-4">
                <dl className={KV}>
                  {technical.usageFacts.map((fact) => (
                    <div key={fact.term} className="contents">
                      <dt className="text-[13px] text-muted">{fact.term}</dt>
                      <dd className="m-0">
                        {fact.badge === null ? null : (
                          <>
                            <span
                              className={`${BADGE} ${BADGE_TONE[fact.badge.tone]} align-middle`}
                            >
                              {fact.badge.label}
                            </span>{' '}
                          </>
                        )}
                        {fact.detail === '' ? null : (
                          <span className={fact.mono ? 'font-mono text-[12.5px]' : undefined}>
                            {fact.detail}
                          </span>
                        )}
                        {fact.note === null ? null : (
                          <span className="text-[12.5px] text-muted">
                            {' '}
                            <Runs paragraph={fact.note} />
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {active === 'runtime' ? (
        <section>
          <EventLogCard
            lines={technical.runtimeEvents}
            empty="No runtime events have been received for this run."
          />
        </section>
      ) : null}
    </>
  );
}

/** A `.card` wrapping an `.event-log`, or the reason there is nothing in it. */
function EventLogCard({
  lines,
  empty,
}: {
  readonly lines: readonly EventLine[];
  readonly empty: string;
}) {
  if (lines.length === 0) {
    return <p className="mt-0 mb-0 text-[12.5px] text-muted">{empty}</p>;
  }
  return (
    <div className={`${CARD} max-h-[320px] overflow-auto`}>
      <div className={`p-4 ${EVENT_LOG}`}>
        {lines.map((line) => (
          <div key={line.id} className="flex gap-2.5 py-0.5">
            <span className="flex-none text-muted">{line.time}</span>
            <span className="w-[155px] flex-none text-accent">{line.event}</span>
            <span className="min-w-0 flex-1 text-text-2 [overflow-wrap:anywhere]">
              {line.detail}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── The right rail ──────────────────────────────────────────────────────────────────────────────

/** One rail `.card`. Total over {@link RailCard}; the mockup draws exactly these three shapes. */
function RailCardView({ card }: { readonly card: RailCard }) {
  switch (card.kind) {
    case 'facts':
      return (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <h3 className="text-[14px]">{card.title}</h3>
          </div>
          <div className="p-4">
            <dl className={`${KV} sm:grid-cols-[105px_minmax(0,1fr)]`}>
              {card.facts.map((fact) => (
                <div key={fact.term} className="contents">
                  <dt className="text-[13px] text-muted">{fact.term}</dt>
                  <dd className="m-0">
                    {fact.badge === null ? null : <StatusBadge badge={fact.badge} />}
                    {fact.detail === '' ? null : fact.detail}
                    {fact.note === null ? null : (
                      <div className="text-[12.5px] text-muted">
                        <Runs paragraph={fact.note} />
                      </div>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      );
    case 'groups':
      return (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <h3 className="text-[14px]">{card.title}</h3>
          </div>
          <div className="p-4">
            {card.groups.map((group, index) => (
              <div key={group.label}>
                <div className={`mb-2 text-[12.5px] text-muted ${index === 0 ? '' : 'mt-4'}`}>
                  {group.label}
                </div>
                <div className="font-mono text-[12.5px]">{group.items.join(' · ')}</div>
              </div>
            ))}
          </div>
        </div>
      );
    case 'files':
      return (
        <div className={CARD}>
          <div className={CARD_HEAD}>
            <h3 className="text-[14px]">{card.title}</h3>
          </div>
          <div className="p-4">
            <div className="overflow-hidden rounded-(--radius) border border-border bg-surface">
              {card.files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-3.5 border-b border-border px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                      {file.title}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-muted">{file.meta}</div>
                  </div>
                  {file.action === null ? null : (
                    <div className="flex items-center gap-3.5">
                      <UnbuiltButton action={file.action} small />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 mb-0 text-[12.5px] text-muted">{card.footnote}</p>
          </div>
        </div>
      );
    default: {
      const unknown: never = card;
      throw new TypeError(`no rail card of kind ${JSON.stringify(unknown)} can be shown`);
    }
  }
}

// ── Shared pieces ───────────────────────────────────────────────────────────────────────────────

/** `.badge`, with the mockup's leading `.dot` where the mockup puts one. */
export function StatusBadge({ badge }: { readonly badge: RunBadge }) {
  return (
    <span className={`${BADGE} ${BADGE_TONE[badge.tone]}`}>
      {badge.dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {badge.label}
    </span>
  );
}

/**
 * A control the mockup draws for capability this wave does not ship.
 *
 * The shell answers "the destination is absent" with a disabled navigation entry
 * ([W1-UI-01]) and the composer answers it the same way for its three in-panel links
 * ([W1-UI-02]). An *action* has its own answer already in the design system —
 * `.btn[disabled]` — so that is the one used here: the mockup's label, unchanged, on a button that
 * says plainly it cannot be pressed. See W1-UI-03-an-unbuilt-action-is-a-disabled-button.md.
 */
function UnbuiltButton({
  action,
  ghost = false,
  small = false,
}: {
  readonly action: UnbuiltAction;
  readonly ghost?: boolean;
  readonly small?: boolean;
}) {
  return (
    <button
      type="button"
      disabled
      className={`${BTN} ${small ? BTN_SM : BTN_MD} ${
        action.primary ? BTN_PRIMARY : ghost ? BTN_GHOST : BTN_DEFAULT
      } ${BTN_DISABLED}`}
    >
      {action.label}
    </button>
  );
}
