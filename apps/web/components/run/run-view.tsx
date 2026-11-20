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
 *      Resume another session and Download point at capability no Wave 1 task ships (Attach file
 *      is built: `attach-control.tsx`, issue #1680). They render with the label the mockup gives
 *      them, in the design system's own `.btn[disabled]` treatment. See W1-UI-03-an-unbuilt-action-is-a-disabled-button.md.
 *   2. **A region with no data is absent, not an empty frame.** No rail cards renders no `<aside>`
 *      and the transcript takes the full width; no SDK events renders the tab's empty line rather
 *      than an empty log. §43 asks for calm and sparse, and a framed empty container is furniture.
 */
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { sendsOnEnter } from '@indx-workspace/react';
import type { VersionsLocale } from '../agents/versions-messages';
import { ShareDialog, type ShareSubject } from '../shares/share-dialog';
import { AttachControl, type AttachedFile } from './attach-control';
import { blockedStrings } from './blocked-tools';
import { browserLocale } from './attach-messages';
import { RailCardView } from './run-rail';
import { RunOutputs } from './run-outputs';
import { runViewStrings, type RunViewStrings } from './run-view-messages';
import { matchMemberCalls, runHref, type ChildRunLink } from './run-tree-model';
import { TechnicalPanels } from './run-technical-panels';
import { teamStrings } from './team-messages';
import {
  BlockedNotice,
  FailureNotice,
  MessageBlock,
  PendingAssistant,
  toolCallsOf,
  type TeamLinks,
} from './run-transcript';
import { StatusBadge, UnbuiltButton } from './run-view-parts';
import { BTN, BTN_DISABLED, BTN_GHOST, BTN_PRIMARY, BTN_SM } from './run-view-styles';
import type { Run } from '@indx-workspace/react/run-model';

export { FailureNotice } from './run-transcript';
export { StatusBadge } from './run-view-parts';

export interface RunViewProps {
  readonly run: Run;
  readonly sessionId: string | null;
  /** The runs this screen started in the session; a session share publishes their stored text. */
  readonly runIds?: readonly string[];
  /** The follow-up's text and the ids of the files attached to the session since the last send. */
  readonly onFollowUp?: (text: string, attachments: readonly string[]) => void;
  /** Sets the follow-up text, and focuses it, each time `nonce` changes after mount. */
  readonly prefill?: ComposerPrefill | undefined;
  /** Rendered under the transcript: a caller's own prompt, such as the Builder's approval card. */
  readonly approval?: ReactNode;
  /**
   * The run's place in a run tree (ADR-0104): its lead run, when it is a member's child run, and
   * its child runs, which its `agent__<name>` activity rows link to. Absent for a run outside one.
   */
  readonly tree?: RunViewTree | undefined;
  /** `false` hides **Attach file**: the workspace has Files switched off (UX-21 in #2086). */
  readonly filesEnabled?: boolean | undefined;
  /** `false` inside another screen's `<main>`: a `<div>` and an `<h2>` (see HomeChatProps). */
  readonly landmark?: boolean;
}

/** What the run view knows of a run tree: the lead run's id, or the child runs to link to. */
export interface RunViewTree {
  readonly parentRunId: string | null;
  readonly children: readonly ChildRunLink[];
}

/** Text a caller asks a composer to hold; a new `nonce` is a new request, the same one is not. */
export interface ComposerPrefill {
  readonly text: string;
  readonly nonce: number;
}

/**
 * Applies `prefill` to a composer when its nonce changes. The nonce present at mount is the
 * baseline, so a composer that replaces another (the home screen becoming this view) does not
 * replay a request the earlier one already took.
 */
export function useComposerPrefill(
  prefill: ComposerPrefill | undefined,
  setText: (text: string) => void,
  composer: RefObject<HTMLTextAreaElement | null>,
): void {
  const applied = useRef(prefill?.nonce);
  useEffect(() => {
    if (prefill === undefined || prefill.nonce === applied.current) return;
    applied.current = prefill.nonce;
    setText(prefill.text);
    composer.current?.focus();
  }, [prefill, setText, composer]);
}

/** A session share must use the durable session id, never a display title or subtitle. */
export function shareSubjectForSession(
  sessionId: string | null,
  label: string,
): ShareSubject | null {
  const id = sessionId === null ? '' : sessionId.trim();
  return id === '' ? null : { type: 'session', id, label };
}

/** The reader's language: English until the browser says otherwise. */
function useBrowserLocale(): VersionsLocale {
  const [locale, setLocale] = useState<VersionsLocale>('en');
  useEffect(() => setLocale(browserLocale(navigator.languages)), []);
  return locale;
}

/** The follow-up composer's draft, attachments and send rule. */
function useFollowUp({
  sessionId,
  runIsLive,
  onFollowUp,
  prefill,
}: {
  readonly sessionId: string | null;
  readonly runIsLive: boolean;
  readonly onFollowUp: RunViewProps['onFollowUp'];
  readonly prefill: ComposerPrefill | undefined;
}) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useComposerPrefill(prefill, setDraft, textareaRef);
  const [attached, setAttached] = useState<readonly AttachedFile[]>([]);
  useEffect(() => setAttached([]), [sessionId]);
  // A follow-up is a second run on the same session, so it must wait for a terminal status.
  const canSend = onFollowUp !== undefined && !runIsLive && draft.trim() !== '';

  const submit = () => {
    if (!canSend || onFollowUp === undefined) return;
    const text = draft.trim();
    setDraft('');
    setAttached([]);
    onFollowUp(
      text,
      attached.map((file) => file.id),
    );
  };
  return { draft, setDraft, textareaRef, attached, setAttached, canSend, submit };
}

type FollowUpState = ReturnType<typeof useFollowUp>;

/**
 * The §19 run view. One component, rendered by the home chat after the first message and by
 * nothing else in this wave.
 */
export function RunView({
  run,
  sessionId,
  runIds = [],
  onFollowUp,
  prefill,
  approval,
  tree,
  filesEnabled = true,
  landmark = true,
}: RunViewProps) {
  const { heading, messages, technical, rail, followUp, failure, blocked } = run;
  const locale = useBrowserLocale();
  const strings = runViewStrings(locale);
  const team = useMemo<TeamLinks>(
    () => ({
      matched: matchMemberCalls(toolCallsOf(messages), tree?.children ?? []),
      strings: teamStrings(locale),
    }),
    [messages, tree, locale],
  );
  // `dot` means *live* (`badgeForRunStatus`), and a null status is a run whose status is not known
  // yet. Not merely the assistant's first streamed snapshot, which arrives mid-run.
  const runIsLive = heading.status === null || heading.status.dot;
  const state = useFollowUp({ sessionId, runIsLive, onFollowUp, prefill });
  const lastMessage = messages[messages.length - 1] ?? messages[0];
  const assistantIsWorking = lastMessage.kind === 'user' && runIsLive && failure === null;

  const Landmark = landmark ? 'main' : 'div';
  return (
    <Landmark className="w-full max-w-[1320px] px-5 pt-5 pb-[90px] sm:px-8">
      <RunHeader
        heading={heading}
        tree={tree}
        team={team}
        locale={locale}
        shareSubject={shareSubjectForSession(sessionId, heading.title)}
        runIds={runIds}
        asH1={landmark}
      />
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
              <MessageBlock key={message.id} message={message} team={team} />
            ))}
            {assistantIsWorking ? (
              <PendingAssistant name={heading.title} strings={strings} locale={locale} />
            ) : null}
            {blocked.length === 0 ? null : (
              <BlockedNotice blocked={blocked} strings={blockedStrings(locale)} />
            )}
            {failure === null ? null : (
              <FailureNotice failure={failure} strings={strings} locale={locale} />
            )}
          </div>
          {approval}
          {filesEnabled ? (
            <RunOutputs runIds={runIds} settled={!runIsLive} locale={locale} />
          ) : null}
          <FollowUpComposer
            followUp={followUp}
            state={state}
            sessionId={sessionId}
            filesEnabled={filesEnabled}
            strings={strings}
            locale={locale}
          />
          {/* Diagnostics are secondary to the conversation and remain collapsed by default. */}
          <details lang={locale} className="group mt-5 border-t border-border pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-[7px] text-[12.5px] text-muted before:text-[10px] before:content-['▸'] group-open:before:content-['▾'] hover:text-text-2 [&::-webkit-details-marker]:hidden">
              {strings.technicalDetails}
              <span className="font-normal text-muted">{strings.technicalDetailsHint}</span>
            </summary>
            <div className="pt-3">
              <TechnicalPanels technical={technical} strings={strings} />
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
    </Landmark>
  );
}

function RunHeader({
  heading,
  tree,
  team,
  locale,
  shareSubject,
  runIds,
  asH1,
}: {
  readonly heading: Run['heading'];
  readonly tree: RunViewTree | undefined;
  readonly team: TeamLinks;
  readonly locale: VersionsLocale;
  readonly shareSubject: ShareSubject | null;
  readonly runIds: readonly string[];
  readonly asH1: boolean;
}) {
  const Heading = asH1 ? 'h1' : 'h2';
  return (
    <div className="mx-auto mb-8 flex max-w-[900px] items-center gap-4 border-b border-border pb-4">
      <div className="min-w-0">
        <Heading className="truncate text-[17px] font-semibold">{heading.title}</Heading>
        {heading.subtitle === '' ? null : (
          <div className="mt-0.5 truncate text-[12px] text-muted">{heading.subtitle}</div>
        )}
        {tree === undefined || tree.parentRunId === null ? null : (
          <div className="mt-0.5 text-[12px] text-text-2" data-testid="run-parent">
            {team.strings.partOfTeamRun}
            {' · '}
            <Link
              href={runHref(tree.parentRunId)}
              className="text-accent no-underline hover:underline"
            >
              {team.strings.openLeadRun}
            </Link>
          </div>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {shareSubject === null ? null : <ShareDialog subject={shareSubject} runIds={runIds} />}
        {heading.status === null ? null : <StatusBadge badge={heading.status} locale={locale} />}
        {heading.actions.map((action) => (
          <UnbuiltButton key={action.id} action={action} />
        ))}
      </div>
    </div>
  );
}

function FollowUpComposer({
  followUp,
  state,
  sessionId,
  filesEnabled,
  strings,
  locale,
}: {
  readonly followUp: Run['followUp'];
  readonly state: FollowUpState;
  readonly sessionId: string | null;
  readonly filesEnabled: boolean;
  readonly strings: RunViewStrings;
  readonly locale: VersionsLocale;
}) {
  const { draft, setDraft, textareaRef, attached, setAttached, canSend, submit } = state;
  return (
    <div
      lang={locale}
      className="mt-10 flex flex-col gap-2 rounded-[18px] border border-border-strong bg-surface px-4 py-3 shadow-(--shadow)"
    >
      <textarea
        ref={textareaRef}
        aria-label={strings.followUpLabel}
        className="min-h-[52px] w-full resize-y border-0 bg-transparent p-0 text-[14.5px] leading-[1.6] text-text placeholder:text-muted focus:outline-none"
        placeholder={followUp.placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (!sendsOnEnter(event)) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {filesEnabled ? (
          <AttachControl
            sessionId={sessionId}
            files={attached}
            onAttached={(file) => setAttached((current) => [...current, file])}
            buttonClass={`${BTN} ${BTN_SM} ${BTN_GHOST}`}
            disabledClass={BTN_DISABLED}
          />
        ) : null}
        {followUp.actions
          .filter((action) => action.id !== 'attach')
          .map((action) => (
            <UnbuiltButton key={action.id} action={action} ghost small />
          ))}
        <span className="flex-1" />
        <span className="text-[12.5px] text-muted">{followUp.status}</span>
        <button
          type="button"
          disabled={!canSend}
          onClick={submit}
          className={`${BTN} ${BTN_SM} ${BTN_PRIMARY} ${
            canSend
              ? 'cursor-pointer hover:border-accent-hover hover:bg-accent-hover'
              : BTN_DISABLED
          }`}
        >
          {strings.send}
        </button>
      </div>
    </div>
  );
}
