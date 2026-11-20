'use client';

import { useCallback, useState } from 'react';
import type { ModelSelectionValue } from '../models/catalog';
import { type HomeChatProps } from './home-chat-types';
import { findAgent, selectedChips } from './model';
import {
  agentRoster,
  rememberedAgentKey,
  useAgentSession,
  useComposerDraft,
  useComposerProjects,
  useModelChoices,
  useOpenPicker,
} from './use-home-chat-agent';
import { useHomeChatRun } from './use-home-chat-run';
import { useHomeChatSending } from './use-home-chat-send';

export function useHomeChatState({
  agents,
  run = null,
  user = null,
  agent: lockedAgent,
  version,
  prefill,
  onAgentEvent,
  follow,
  resume,
  locale = 'en',
}: HomeChatProps) {
  const { list, setupAgentId, viewer, notice } = agentRoster(agents);
  const rememberedKey = rememberedAgentKey(lockedAgent !== undefined, user, viewer);
  const { session, switchAgent, toggle } = useAgentSession(
    list,
    lockedAgent,
    setupAgentId,
    rememberedKey,
  );
  const agent = session === null ? null : findAgent(list, session.agentId);
  const { draft, setDraft, composerRef } = useComposerDraft(prefill);
  const [open, setOpen] = useOpenPicker();
  const [modelOverride, setModelOverride] = useState<ModelSelectionValue>(null);
  const projectChoice = useComposerProjects();
  const { view, control } = useHomeChatRun({ initialRun: run, agent, follow, onAgentEvent });
  const { send, sendFollowUp } = useHomeChatSending({
    agent,
    user,
    session,
    draft,
    clearDraft: () => setDraft(''),
    modelOverride,
    projectId: projectChoice.projectId,
    resume,
    locale,
    version,
    rememberedKey,
    run: control,
  });

  const chooseAgent = useCallback(
    (agentId: string) => {
      switchAgent(agentId);
      setOpen(null);
      // §19.5.1 rule 4: a new session carries nothing over, including a per-run model override —
      // it named a choice for the *previous* agent's run, not a default this one inherits.
      setModelOverride(null);
    },
    [setOpen, switchAgent],
  );

  return {
    ...view,
    ...projectChoice,
    ...useModelChoices(agent, modelOverride),
    sendFollowUp,
    send,
    list,
    session,
    draft,
    setDraft,
    composerRef,
    open,
    setOpen,
    modelOverride,
    setModelOverride,
    agent,
    chooseAgent,
    toggle,
    notice,
    chips: agent === null || session === null ? [] : selectedChips(agent, session),
    canSend: agent !== null && user !== null && draft.trim() !== '',
  };
}
