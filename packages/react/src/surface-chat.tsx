'use client';

/**
 * The hosted surface chat (ADR-0105 slice 1; S1-17, issue #455): what `GET /p/s/<name>` renders,
 * and what a customer's page renders as `<Chat/>` from `@indx-workspace/react` (issue #623). It is
 * a chat composer of its own — a visitor's surface, not the workspace's run view, so it shows the
 * conversation and nothing of the technical stream — and it reuses the run view's model
 * (`./run-model.ts`) for the conversation and the published SDK for the transport.
 *
 * The session is opened lazily, on the first Send, through the surface's bootstrap; its
 * session-scoped token then starts each run in that session and follows its events. A `401` on a
 * start means the token expired: the chat opens the session once more and sends again. That send
 * path is `./surface-chat-send.ts`; its state is `useConversation()` (`./use-conversation.ts`),
 * which a page may use without this component.
 *
 * Look, layout and parts (ADR-0108 rungs ① and ②; S1-18, issue #456): the surface's definition
 * sets the frame (`./layout.tsx`), the theme's style and language (`./theme.ts`, `./locale.ts`)
 * and the parts it shows (`./parts.tsx`). A suggested prompt is sent through the same `send()` as
 * a typed message. An `Escape` pressed inside the widget's frame asks the loader to close the
 * panel (`./surface-chat-embed.ts`). The message list, a message, the composer and a tool result
 * are replaceable through `components`; each receives the props its exported type declares.
 *
 * History, the switcher, feedback, the full trace and tool results (ADR-0108 SD10; issue #540):
 * on mount the chat resumes the agent the visitor last talked to and replays its stored runs
 * (`./history.ts`, kept in `localStorage` only with `parts.history`); the switcher changes agent
 * and restores that agent's conversation; each run's tool steps show before its first answer and
 * its feedback buttons after its last. Tool steps are folded in the surface's own model, so the
 * run view's model stays the one conversation model of both chats.
 *
 * The composer (the form and the disclaimer) sits in the frame's `footer`, outside the scrolling
 * message list, so it stays in view however long the transcript or however tall the `notice` row
 * above the header (issue #558).
 *
 * A conversation that reached its surface's turn limit (`429 surface_turn_limit_reached`, issue
 * #622) says so and closes its composer; its stored session is forgotten, so switching agent or
 * reloading starts another.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';

import { AssistantProse } from './assistant-prose.js';
import type { Message, RunFailureNotice } from './run-model.js';
import { SurfaceFrame } from './layout.js';
import { requestEmbedClose } from './surface-chat-embed.js';
import { surfaceStrings, type SurfaceStrings } from './locale.js';
import {
  AgentSwitcher,
  FeedbackButtons,
  SuggestedPrompts,
  SurfaceDisclaimer,
  SurfaceGreeting,
  SurfaceHeader,
  ToolResult,
  ToolTrace,
  type ToolResultProps,
} from './parts.js';
import {
  answerPlacement,
  messageParagraphs,
  pendingTurn,
  visibleSurfaceFailure,
  type SurfaceTurn,
} from './surface-chat-model.js';
import { SURFACE_DEFAULTS, surfaceThemeStyle } from './theme.js';
import { useConversation, type UseConversationOptions } from './use-conversation.js';

/** The transcript's container; `children` are the messages. */
export interface MessageListProps {
  readonly children: ReactNode;
}

/** One message of the transcript, with its run's tools before it and its feedback after it. */
export interface MessageProps {
  readonly message: Message;
  /** The tool trace and results of the run this message is the first answer of; else `null`. */
  readonly tools: ReactNode;
  /** The feedback buttons of the run this message is the last answer of; else `null`. */
  readonly feedback: ReactNode;
}

/** The message box and its Send button. */
export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Send `value`; the chat trims it and clears the box. */
  readonly onSubmit: () => void;
  /** The conversation is restoring, sending or ended: nothing can be typed or sent. */
  readonly disabled: boolean;
  /** Whether a Send now would send: not `disabled`, and `value` is not blank. */
  readonly canSend: boolean;
  /** The message box's accessible name, in the surface's language. */
  readonly label: string;
  readonly sendLabel: string;
}

/** The parts `<Chat/>` draws that a page may replace. Each one left out is the default. */
export interface ChatComponents {
  readonly MessageList?: ComponentType<MessageListProps>;
  readonly Message?: ComponentType<MessageProps>;
  readonly Composer?: ComponentType<ComposerProps>;
  readonly ToolResult?: ComponentType<ToolResultProps>;
}

export interface ChatProps extends UseConversationOptions {
  /** A row above the header, such as the deployment's runtime banner (#558). */
  readonly notice?: ReactNode;
  readonly components?: ChatComponents;
}

const NO_DEFINITION: Partial<SurfaceDefinition> = {};

interface TurnToolsProps {
  readonly turn: SurfaceTurn;
  readonly surface: Partial<SurfaceDefinition>;
  readonly strings: SurfaceStrings;
  readonly Result: ComponentType<ToolResultProps>;
}

/** One run's tool trace, then each finished step's result the surface names a component for. */
function TurnTools({ turn, surface, strings, Result }: TurnToolsProps): ReactNode {
  const toolResults = surface.toolResults ?? {};
  return (
    <>
      <ToolTrace
        mode={surface.parts?.toolTrace ?? SURFACE_DEFAULTS.toolTrace}
        steps={turn.tools}
        strings={strings}
      />
      {turn.tools.map((step) =>
        step.output === null || step.isError || !Object.hasOwn(toolResults, step.name) ? null : (
          <Result key={step.id} output={step.output} component={toolResults[step.name] ?? 'text'} />
        ),
      )}
    </>
  );
}

function TranscriptList({ children }: MessageListProps): ReactNode {
  return (
    <ol className="aw-transcript" aria-live="polite">
      {children}
    </ol>
  );
}

function TranscriptMessage({ message, tools, feedback }: MessageProps): ReactNode {
  return (
    <li className={message.kind === 'user' ? 'aw-message aw-message-user' : 'aw-message'}>
      <div className="aw-speaker">{message.speaker.name}</div>
      {tools}
      {messageParagraphs(message).map((paragraph, index) =>
        message.kind === 'user' ? (
          <p key={index} className="aw-paragraph">
            {paragraph}
          </p>
        ) : (
          <AssistantProse key={index} text={paragraph} />
        ),
      )}
      {feedback}
    </li>
  );
}

/**
 * Enter sends and Shift+Enter adds a newline (BH061-036). An Enter that confirms an IME
 * composition (Japanese input: `isComposing`, or keyCode 229 in Safari) never sends.
 */
export function sendsOnEnter(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean; readonly keyCode: number };
}): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

function SurfaceComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSend,
  label,
  sendLabel,
}: ComposerProps): ReactNode {
  return (
    <form
      className="aw-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        aria-label={label}
        className="aw-input"
        rows={2}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (sendsOnEnter(event)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button type="submit" className="aw-send" disabled={!canSend}>
        {sendLabel}
      </button>
    </form>
  );
}

interface FailureNoticeProps {
  readonly failure: RunFailureNotice;
  readonly environment: 'local' | undefined;
  readonly strings: SurfaceStrings;
}

/** The run's failure as this page may show it (issue #661). */
function FailureNotice({ failure, environment, strings }: FailureNoticeProps): ReactNode {
  const shown = visibleSurfaceFailure(failure, environment, strings);
  const hidden = shown.code === null && failure.code !== null;
  useEffect(() => {
    // The widget hides a model-setup failure from the visitor; whoever runs the page reads it here.
    if (hidden) console.error(`${failure.code ?? 'error'}: ${failure.message}`);
  }, [hidden, failure]);
  return (
    <div className="aw-failure" role="alert">
      {shown.code === null ? null : <span className="aw-mono">{shown.code}: </span>}
      {shown.message}
    </div>
  );
}

export function Chat({ notice, components = {}, ...options }: ChatProps): ReactNode {
  const conversation = useConversation(options);
  const [draft, setDraft] = useState('');
  const {
    MessageList = TranscriptList,
    Message: MessagePart = TranscriptMessage,
    Composer = SurfaceComposer,
    ToolResult: Result = ToolResult,
  } = components;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      requestEmbedClose(event, window);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const surface = options.definition ?? NO_DEFINITION;
  const locale = surface.theme?.locale ?? SURFACE_DEFAULTS.locale;
  const strings = surfaceStrings(locale);
  const { agentName, agents, status, runStatus, failure, rated, failedRatings } = conversation;
  const locked = status === 'restoring' || status === 'sending';
  const closed = status !== 'idle';

  const onSubmit = (): void => {
    const prompt = draft.trim();
    if (prompt === '' || locked) return;
    setDraft('');
    conversation.send(prompt);
  };

  const layout = surface.layout ?? SURFACE_DEFAULTS.layout;
  const greeting = surface.parts?.greeting;
  const prompts = surface.parts?.suggestedPrompts;
  const disclaimer = surface.parts?.disclaimer;
  const empty = conversation.messages.length === 0;
  const placement = answerPlacement(conversation.turns);
  const pending = pendingTurn(conversation.turns);

  return (
    <SurfaceFrame
      layout={layout}
      style={surfaceThemeStyle(surface.theme)}
      lang={locale}
      surfaceName={options.surface}
      notice={notice}
      header={
        <>
          <SurfaceHeader logo={surface.theme?.logo} title={surface.title} agentName={agentName} />
          {agents.length > 1 ? (
            <AgentSwitcher
              agents={agents}
              current={agentName}
              label={strings.agentSwitcherLabel}
              disabled={locked}
              onSwitch={conversation.switchAgent}
            />
          ) : null}
        </>
      }
      footer={
        <>
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={onSubmit}
            disabled={closed}
            canSend={!closed && draft.trim() !== ''}
            label={strings.messageLabel(agentName)}
            sendLabel={strings.send}
          />
          {disclaimer === undefined ? null : (
            <SurfaceDisclaimer text={disclaimer} label={strings.disclaimerLabel} />
          )}
        </>
      }
    >
      {empty && greeting !== undefined ? <SurfaceGreeting text={greeting} /> : null}
      {empty && prompts !== undefined ? (
        <SuggestedPrompts
          prompts={prompts}
          label={strings.suggestedPromptsLabel}
          disabled={locked}
          onPick={conversation.send}
        />
      ) : null}
      <MessageList>
        {conversation.messages.map((message) => {
          const opens = placement.first.get(message.id);
          const closes = placement.last.get(message.id);
          return (
            <MessagePart
              key={message.id}
              message={message}
              tools={
                opens === undefined ? null : (
                  <TurnTools turn={opens} surface={surface} strings={strings} Result={Result} />
                )
              }
              feedback={
                surface.parts?.feedback === true && closes !== undefined ? (
                  <FeedbackButtons
                    rated={rated[closes.runId] ?? null}
                    failed={failedRatings.has(closes.runId)}
                    strings={strings}
                    onRate={(rating) => {
                      conversation.rate(closes.runId, rating);
                    }}
                  />
                ) : null
              }
            />
          );
        })}
      </MessageList>
      {pending === null ? null : (
        <TurnTools turn={pending} surface={surface} strings={strings} Result={Result} />
      )}
      {runStatus === null ? null : (
        <div className="aw-run-status" role="status">
          {runStatus.label}
        </div>
      )}
      {failure === null ? null : (
        <FailureNotice failure={failure} environment={options.environment} strings={strings} />
      )}
    </SurfaceFrame>
  );
}
