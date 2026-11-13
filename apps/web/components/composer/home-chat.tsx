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
  NarrowingPicker,
  BTN_SM,
  BTN_PRIMARY,
  BTN_DISABLED,
} from './home-chat-controls';
import { useHomeChatState } from './use-home-chat';
import { ResumedHistoryList } from './resumed-history';
import { composerStrings } from './composer-messages';

export type { ComposerAgents, HomeChatProps } from './home-chat-types';

export { followRunInto } from './home-chat-live';

export { ComposerChips } from './home-chat-controls';

export function HomeChat(props: HomeChatProps) {
  const { recent, agent: lockedAgent, prefill, approval, filesEnabled = true } = props;
  const locale = props.locale ?? 'en';
  const strings = composerStrings(locale);
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
          {strings.heading}
        </Heading>
        <div className="mt-2 mb-[26px] text-center text-[13.5px] text-muted">
          {strings.intro(filesEnabled)}
        </div>
        {props.resume?.kind === 'continue' && props.resume.history !== undefined ? (
          <ResumedHistoryList
            history={props.resume.history}
            userName={props.user?.name ?? ''}
            agentName={agent?.name ?? ''}
          />
        ) : null}
        {props.resume === undefined ? null : (
          <p
            role={props.resume.kind === 'continue' ? 'status' : 'alert'}
            className="mb-3 rounded-(--radius-sm) border border-border bg-surface-2 px-3.5 py-2.5 text-[13.5px] text-text-2"
          >
            {props.resume.notice}
          </p>
        )}

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
            aria-label={strings.inputLabel}
            className="min-h-[68px] w-full resize-y rounded-(--radius-sm) border-0 bg-transparent p-0 text-[15px] leading-[1.6] text-text placeholder:text-muted focus:outline-none"
            placeholder={strings.inputPlaceholder}
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
              strings={strings}
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
                label={strings.modelLabel}
                models={drivableModels}
                value={modelOverride}
                onChange={setModelOverride}
                inheritLabel={strings.modelInherit}
                ariaDescribedBy="composer-model-inheritance-line"
              />
            )}
            <ProjectPicker
              projects={projects}
              projectId={projectId}
              setProjectId={setProjectId}
              strings={strings}
            />
            <AgentPicker
              lockedAgent={lockedAgent}
              agent={agent}
              list={list}
              projectId={projectId}
              open={open}
              setOpen={setOpen}
              chooseAgent={chooseAgent}
              strings={strings}
            />

            {filesEnabled ? (
              <NarrowingPicker
                kind="files"
                label={strings.filesPicker}
                agent={agent}
                session={session}
                open={open}
                setOpen={setOpen}
                onToggle={toggle}
                empty={strings.noFilesListed}
                listedNote={strings.filesListedNote}
                availableHeading={strings.availableToAgent}
                footer={
                  <Link className={PLINK} href="/files">
                    {strings.upload}
                  </Link>
                }
              />
            ) : null}

            <NarrowingPicker
              kind="connectors"
              label={strings.connectorsPicker}
              agent={agent}
              session={session}
              open={open}
              setOpen={setOpen}
              onToggle={toggle}
              empty={strings.noConnectorsListed}
              availableHeading={strings.availableToAgent}
              footer={strings.pickersNarrow}
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
              {strings.send}
            </button>
          </div>
          <RunTargetNotice agent={agent} projectId={projectId} overrideEntry={overrideEntry} />
          <ModelUnavailableNotice unavailable={catalogUnavailable} />
        </div>

        <RecentSessions recent={recent} strings={strings} />
      </div>
    </Landmark>
  );
}
