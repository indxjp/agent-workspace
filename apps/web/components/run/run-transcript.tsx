/** The run view's transcript: messages, activity rows, and the notices that close a run. */
import Link from 'next/link';
import { AssistantProse } from '@indx-workspace/react';
import type { VersionsLocale } from '../agents/versions-messages';
import { withSetupWizardLink } from '../setup/setup-wizard-link';
import type { BlockedStrings } from './blocked-tools';
import { runRefusalReason } from './run-refusal-messages';
import { runViewStrings, type RunViewStrings } from './run-view-messages';
import { memberNameOfTool, runHref, type ChildRunLink, type MemberCall } from './run-tree-model';
import type { TeamStrings } from './team-messages';
import { Runs } from './run-view-parts';
import type {
  ActivityStep,
  BlockedTool,
  Message,
  Paragraph,
  Run,
  RunFailureNotice,
  TurnBlock,
} from '@indx-workspace/react/run-model';

/** The member calls of a run's activity rows, and the child run each one started. */
export interface TeamLinks {
  readonly matched: ReadonlyMap<string, ChildRunLink>;
  readonly strings: TeamStrings;
}

/** Every activity step that calls a tool, in transcript order. */
export function toolCallsOf(messages: Run['messages']): readonly MemberCall[] {
  return messages.flatMap((message) =>
    message.kind === 'agent'
      ? message.blocks.flatMap((block) =>
          block.kind === 'activity'
            ? block.steps.flatMap((step) =>
                step.tool === null ? [] : [{ stepId: step.id, toolName: step.tool }],
              )
            : [],
        )
      : [],
  );
}

/**
 * Why the run failed, in the conversation (issue #393). The code, when the server named one, is
 * shown apart from the sentence so a reader can tell "no runtime profile" from "the key was
 * rejected" at a glance. A Japanese reader gets the sentence for a known code in Japanese
 * (`./run-refusal-messages.ts`), marked with its language; any other sentence is the server's
 * English. The `data-testid`s are the stable hooks the generated-project E2E reads.
 */
export function FailureNotice({
  failure,
  strings = runViewStrings('en'),
  locale = 'en',
}: {
  readonly failure: RunFailureNotice;
  readonly strings?: RunViewStrings;
  readonly locale?: VersionsLocale;
}) {
  const message = runRefusalReason(failure.code, failure.message, locale);
  return (
    <div
      role="alert"
      data-testid="run-failure"
      data-failure-code={failure.code ?? ''}
      className="rounded-[10px] border border-danger bg-danger-soft px-4 py-3 text-[13.5px] text-danger"
    >
      <div lang={locale} className="flex flex-wrap items-center gap-2 font-semibold">
        {strings.didNotComplete}
        {failure.code === null ? null : (
          <code
            data-testid="run-failure-code"
            className="rounded-[6px] bg-surface px-1.5 py-0.5 font-mono text-[12px]"
          >
            {failure.code}
          </code>
        )}
      </div>
      <p
        data-testid="run-failure-message"
        lang={message === failure.message ? undefined : locale}
        className="mt-1 text-text-2 [overflow-wrap:anywhere]"
      >
        {withSetupWizardLink(message)}
      </p>
    </div>
  );
}

/**
 * The tool calls the engine refused with nobody asked (issue #2091), in the conversation: a run
 * can end "Completed" and its answer can read as if the call worked. One notice lists every
 * refused tool by name, once each.
 */
export function BlockedNotice({
  blocked,
  strings,
}: {
  readonly blocked: readonly BlockedTool[];
  readonly strings: BlockedStrings;
}) {
  const names = [...new Set(blocked.map((tool) => tool.toolName))];
  return (
    <div
      role="status"
      data-testid="run-blocked"
      className="rounded-[10px] border border-warn bg-warn-soft px-4 py-3 text-[13.5px]"
    >
      <div className="font-semibold text-warn">{strings.title}</div>
      <p className="mt-1 text-text-2 [overflow-wrap:anywhere]">
        {strings.lead}{' '}
        {names.map((name, index) => (
          <span key={name}>
            {index === 0 ? null : ', '}
            <code
              data-testid="run-blocked-tool"
              className="rounded-[6px] bg-surface px-1.5 py-0.5 font-mono text-[12px]"
            >
              {name}
            </code>
          </span>
        ))}
      </p>
      <p className="mt-1 text-text-2">{strings.explanation}</p>
    </div>
  );
}

/** One `.msg`. Total over the two arms; there is no third kind of speaker. */
export function MessageBlock({
  message,
  team,
}: {
  readonly message: Message;
  readonly team: TeamLinks;
}) {
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
              <BlockView key={index} block={block} team={team} />
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
export function PendingAssistant({
  name,
  strings,
  locale,
}: {
  readonly name: string;
  readonly strings: RunViewStrings;
  readonly locale: VersionsLocale;
}) {
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <div className="flex gap-3.5" role="status" lang={locale} aria-label={strings.working(name)}>
      <Avatar initials={initials || 'AI'} tone="agent" />
      <div className="flex min-h-8 items-center gap-2 pt-0.5 text-[13.5px] text-muted">
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border-2 border-border-strong border-t-accent [animation-duration:.8s]"
        />
        {strings.thinking}
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

/** Prose, or the activity bracket beside it. Total over {@link TurnBlock}. */
function BlockView({ block, team }: { readonly block: TurnBlock; readonly team: TeamLinks }) {
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
            <ActivityRow key={step.id} step={step} team={team} />
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
function ActivityRow({ step, team }: { readonly step: ActivityStep; readonly team: TeamLinks }) {
  const member = step.tool === null ? null : memberNameOfTool(step.tool);
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
          {member ?? step.tool}
        </span>
      )}
      {member === null ? null : (
        <MemberRunLink child={team.matched.get(step.id)} member={member} strings={team.strings} />
      )}
      <span className="ml-auto text-[12px] text-muted">{step.duration}</span>
    </div>
  );
}

/** An `agent__<name>` row's link to the child run the call started, or why there is none yet. */
function MemberRunLink({
  child,
  member,
  strings,
}: {
  readonly child: ChildRunLink | undefined;
  readonly member: string;
  readonly strings: TeamStrings;
}) {
  if (child === undefined) {
    return <span className="text-[12px] text-muted">{strings.childRunPending}</span>;
  }
  return (
    <Link
      href={runHref(child.id)}
      className="text-[12px] text-accent no-underline hover:underline"
      aria-label={`${strings.openChildRun}: ${member}`}
      data-testid="run-member-link"
    >
      {strings.openChildRun} →
    </Link>
  );
}
