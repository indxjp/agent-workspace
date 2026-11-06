'use client';

import Link from 'next/link';
import { sendsOnEnter } from '@indx-workspace/react';
import { approvalSlot, followUpWhileDeciding } from './home-chat-approval';
import { AgentPicker, ProjectPicker, RunTargetNotice, RecentSessions } from './home-chat-options';
import { screenFor } from '@indx-workspace/react/run-model';
import { RunView } from '../run/run-view';
import { type PickerKind } from './model';
import { ModelSelector, ModelUnavailableNotice } from '../models/model-selector';
import { type HomeChatProps } from './home-chat-types';
import {
  ComposerChips,
  PLINK,
  NO_FILES_LISTED,
  NO_CONNECTORS_LISTED,
  NarrowingPicker,
  BTN_SM,
  BTN_PRIMARY,
  BTN_DISABLED,
} from './home-chat-controls';
import { useHomeChatState } from './use-home-chat';

export type { ComposerAgents, HomeChatProps } from './home-chat-types';

export { followRunInto } from './home-chat-live';

export { ComposerChips } from './home-chat-controls';

export function HomeChat(props: HomeChatProps) {
  const { recent, agent: lockedAgent, prefill, approval, filesEnabled = true } = props;
  const {
    started,
    activeSessionId,
    sessionRunIds,
    sendFollowUp,
    deciding,
    paused,
    followContinuation,
    setDeciding,
    closePaused,
    list,
    session,
    draft,
    setDraft,
    composerRef,
    open,
    setOpen,
    modelOverride,
    setModelOverride,
    catalogUnavailable,
    projects,
    projectId,
    setProjectId,
    agent,
    chooseAgent,
    toggle,
    notice,
    chips,
    canSend,
    drivableModels,
    overrideEntry,
    send,
  } = useHomeChatState(props);
  const screen = screenFor(started);
  const landmark = props.landmark ?? true;
  if (screen.kind === 'run') {
    return (
      <RunView
        landmark={landmark}
        run={screen.run}
        sessionId={activeSessionId}
        runIds={sessionRunIds}
        {...followUpWhileDeciding(deciding, approval, paused, sendFollowUp)}
        prefill={prefill}
        approval={approvalSlot(approval, paused, followContinuation, setDeciding, closePaused)}
        filesEnabled={filesEnabled}
      />
    );
  }
  const Landmark = landmark ? 'main' : 'div';
  const Heading = landmark ? 'h1' : 'h2';
  return (
    <Landmark className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mx-auto max-w-[720px] pt-[8vh]">
        <Heading className="text-center text-[26px] font-semibold tracking-[-.02em]">
          What can I help with?
        </Heading>
        <div className="mt-2 mb-[26px] text-center text-[13.5px] text-muted">
          {filesEnabled
            ? 'Pick an agent, add files or connectors, and start. Everything runs in a sandbox.'
            : 'Pick an agent, add connectors, and start. Everything runs in a sandbox.'}
        </div>

        {/* The textarea draws no outline of its own, so the box shows where the caret is. */}
        <div
          data-testid="composer-box"
          className="flex flex-col gap-2 rounded-[12px] border border-border-strong bg-surface px-3.5 pt-3.5 pb-[11px] shadow-(--shadow) has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-accent-soft"
        >
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
            onKeyDown={(event) => {
              if (!sendsOnEnter(event)) return;
              event.preventDefault();
              send();
            }}
          />

          {chips.length === 0 ? null : (
            <ComposerChips
              chips={chips}
              onRemove={(chipId) => {
                const kind: PickerKind =
                  agent !== null && agent.files.some((file) => file.id === chipId)
                    ? 'files'
                    : 'connectors';
                toggle(kind, chipId);
              }}
            />
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
            <ProjectPicker projects={projects} projectId={projectId} setProjectId={setProjectId} />
            <AgentPicker
              lockedAgent={lockedAgent}
              agent={agent}
              list={list}
              projectId={projectId}
              open={open}
              setOpen={setOpen}
              chooseAgent={chooseAgent}
            />

            {filesEnabled ? (
              <NarrowingPicker
                kind="files"
                label="+ Files"
                agent={agent}
                session={session}
                open={open}
                setOpen={setOpen}
                onToggle={toggle}
                empty={NO_FILES_LISTED}
                listedNote="Only files this agent is permitted to read are listed."
                footer={
                  <Link className={PLINK} href="/files">
                    Upload
                  </Link>
                }
              />
            ) : null}

            <NarrowingPicker
              kind="connectors"
              label="+ Connectors"
              agent={agent}
              session={session}
              open={open}
              setOpen={setOpen}
              onToggle={toggle}
              empty={NO_CONNECTORS_LISTED}
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
          <RunTargetNotice agent={agent} projectId={projectId} overrideEntry={overrideEntry} />
          <ModelUnavailableNotice unavailable={catalogUnavailable} />
        </div>

        <RecentSessions recent={recent} />
      </div>
    </Landmark>
  );
}
