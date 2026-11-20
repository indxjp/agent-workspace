'use client';

import {
  beginRun,
  failureNoticeFrom,
  userMessage,
  withFailure,
  withMessage,
  withStatus,
  type RunOpening,
  type Speaker,
} from '@indx-workspace/react/run-model';
import { useCallback, useRef } from 'react';
import { browserClient } from '../../lib/browser-client';
import type { ModelSelectionValue } from '../models/catalog';
import { composerStrings } from './composer-messages';
import { speakerForAgent, nextControlFrameId, runAgentAndFollow } from './home-chat-live';
import type { HomeChatProps } from './home-chat-types';
import { rememberAgent } from './use-home-chat-agent';
import type { HomeChatRunControl } from './use-home-chat-run';
import {
  chatTitleFrom,
  projectStartRefusal,
  type ComposerAgent,
  type ComposerSession,
} from './model';
import { historyMessages, withEarlierMessages } from './resumed-history';

export interface HomeChatSendInputs {
  readonly agent: ComposerAgent | null;
  readonly user: Speaker | null;
  readonly session: ComposerSession | null;
  readonly draft: string;
  readonly clearDraft: () => void;
  readonly modelOverride: ModelSelectionValue;
  readonly projectId: string | null;
  readonly resume: HomeChatProps['resume'];
  readonly locale: NonNullable<HomeChatProps['locale']>;
  readonly version: number | undefined;
  readonly rememberedKey: string | null;
  readonly run: HomeChatRunControl;
}

function openingFor(agent: ComposerAgent, locale: HomeChatSendInputs['locale']): RunOpening {
  return {
    heading: { title: agent.name, subtitle: '', status: null, actions: [] },
    followUp: {
      placeholder: composerStrings(locale).followUpPlaceholder,
      actions: [],
      status: agent.sandbox,
    },
  };
}

/** A new chat is titled by its first message, so the sidebar's recent chats can name it. */
function titleChatFrom(sessionId: string, text: string): void {
  const title = chatTitleFrom(text);
  if (title === null) return;
  // A convenience: a refused or failed rename leaves the agent's name as the label.
  void browserClient()
    .sessions.update(sessionId, { title })
    .catch(() => undefined);
}

/** The transcript a chat opens with: the first message, below the earlier ones of a continued chat. */
function openingRun(inputs: HomeChatSendInputs, agent: ComposerAgent, user: Speaker, text: string) {
  const { session, resume, locale } = inputs;
  const first = beginRun(
    openingFor(agent, locale),
    userMessage(`m${session === null ? 0 : session.key}-1`, user, text),
  );
  // UX-05 step 2: a continued chat keeps its earlier messages above the new one.
  const earlier =
    resume?.kind === 'continue'
      ? historyMessages(resume.history, user, speakerForAgent(agent.name))
      : [];
  return earlier.length === 0 ? first : withEarlierMessages(first, earlier);
}

/** Shows why the chat could not be started, on the transcript it opened with. */
function showRefusal(
  run: HomeChatRunControl,
  refusal: NonNullable<ReturnType<typeof projectStartRefusal>>,
): void {
  run.applyToRun((current) =>
    withFailure(
      withStatus(current, { label: `Cannot run · ${refusal.code}`, tone: 'danger', dot: false }),
      failureNoticeFrom(refusal.reason, refusal.code),
    ),
  );
}

/** Sending the first message of a chat, and the follow-ups after it. */
export function useHomeChatSending(inputs: HomeChatSendInputs) {
  const { agent, user, modelOverride, projectId, version, run } = inputs;
  // RF-502: the files picked in "+ Files" when the chat was sent. Every run of this chat, follow-ups
  // included, is narrowed to them (`fileScope`); empty keeps all of the agent's grants.
  const fileScopeRef = useRef<readonly string[]>([]);

  const sendFollowUp = useCallback(
    (text: string, attachments: readonly string[]) => {
      // A null session id means the previous attempt never reached a started run — the server
      // then opens a fresh session for this message. Refusing here instead would swallow text the
      // composer has already cleared and the transcript has already shown as sent.
      if (agent === null || user === null) return;
      run.clearPaused();
      run.applyToRun((current) =>
        withFailure(
          withStatus(
            withMessage(current, userMessage(nextControlFrameId('user-follow-up'), user, text)),
            null,
          ),
          null,
        ),
      );
      runAgentAndFollow({
        agentId: agent.id,
        prompt: text,
        modelOverride,
        sessionId: run.currentSessionId(),
        projectId,
        assistant: speakerForAgent(agent.name),
        apply: run.applyToRun,
        signal: run.restartRunController().signal,
        onStarted: run.noteRunStarted,
        attachments,
        fileScope: fileScopeRef.current,
        onEvent: run.handleAgentEvent,
        version: version ?? null,
      });
    },
    [agent, modelOverride, projectId, run, user, version],
  );

  const send = () => {
    if (agent === null || user === null) return;
    const text = inputs.draft.trim();
    if (text === '') return;
    // Only picks this agent still offers; a session never holds anything else (`offeredBy`).
    const offered = new Set(agent.files.map((file) => file.id));
    fileScopeRef.current = (inputs.session?.files ?? []).filter((path) => offered.has(path));

    run.setStarted(openingRun(inputs, agent, user, text));
    inputs.clearDraft();
    rememberAgent(inputs.rememberedKey, agent.id);

    // A previous run's stream, if this session somehow still had one open, is no longer this
    // screen's business the moment a new one starts.
    run.abortRun();
    run.resetRunTracking();
    // A project's session is opened before the run starts; one that cannot run is not opened.
    const refusal = projectStartRefusal(agent, projectId, modelOverride !== null);
    if (refusal !== null) {
      showRefusal(run, refusal);
      return;
    }
    const resumeSessionId = inputs.resume?.kind === 'continue' ? inputs.resume.sessionId : null;
    runAgentAndFollow({
      agentId: agent.id,
      prompt: text,
      modelOverride,
      sessionId: resumeSessionId,
      projectId,
      assistant: speakerForAgent(agent.name),
      apply: run.applyToRun,
      signal: run.restartRunController().signal,
      onStarted: (sessionId, runId) => {
        run.noteFirstRunStarted(sessionId, runId);
        if (resumeSessionId === null) titleChatFrom(sessionId, text);
      },
      attachments: [],
      fileScope: fileScopeRef.current,
      onEvent: run.handleAgentEvent,
      version: version ?? null,
    });
  };

  return { send, sendFollowUp };
}
