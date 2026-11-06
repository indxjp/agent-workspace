'use client';

import type { RunStatus } from '@indx-workspace/contracts/runs';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import type { Paused } from './home-chat-approval';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient } from '../../lib/browser-client';
import {
  beginRun,
  badgeForRunStatus,
  failureNoticeFrom,
  userMessage,
  withFailure,
  withMessage,
  withStatus,
  type Run,
  type RunOpening,
  type Speaker,
} from '@indx-workspace/react/run-model';
import { useComposerPrefill } from '../run/run-view';
import {
  findAgent,
  initialSession,
  lastAgentStorageKey,
  preferredAgent,
  projectStartRefusal,
  selectAgent,
  selectedChips,
  startSession,
  toggleOption,
  type ComposerAgent,
  type ComposerProject,
  type ComposerSession,
  type PickerKind,
} from './model';
import type { ModelSelectionValue } from '../models/catalog';
import { modelsDrivableBy } from '../models/engine-models';
import { useModelCatalog } from '../models/model-selector';
import { type HomeChatProps } from './home-chat-types';
import { type OpenPicker } from './home-chat-controls';
import {
  speakerForAgent,
  nextControlFrameId,
  runAgentAndFollow,
  followRunInto,
} from './home-chat-live';

function openingSession(
  list: readonly ComposerAgent[],
  locked: HomeChatProps['agent'],
  setupAgentId: string | null,
): ComposerSession | null {
  if (locked === undefined) return initialSession(list, null, setupAgentId);
  const found = findAgent(list, locked.id);
  return found === null ? null : startSession(found, 0);
}

function rememberedAgentKey(
  locked: boolean,
  user: Speaker | null,
  viewer: { readonly workspaceId: string; readonly userId: string } | null,
): string | null {
  return locked || user === null || viewer === null
    ? null
    : lastAgentStorageKey(viewer.workspaceId, viewer.userId);
}

export function useHomeChatState({
  agents,
  run = null,
  user = null,
  agent: lockedAgent,
  version,
  prefill,
  onAgentEvent,
  follow,
}: HomeChatProps) {
  const list = agents.kind === 'agents' ? agents.agents : [];

  const setupAgentId = agents.kind === 'agents' ? (agents.setupAgentId ?? null) : null;

  const viewer = agents.kind === 'agents' ? (agents.viewer ?? null) : null;

  const [session, setSession] = useState<ComposerSession | null>(() =>
    openingSession(list, lockedAgent, setupAgentId),
  );

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

  const [modelOverride, setModelOverride] = useState<ModelSelectionValue>(null);

  const catalogState = useModelCatalog();

  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];

  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];

  const [projects, setProjects] = useState<readonly ComposerProject[]>([]);

  const [projectId, setProjectId] = useState<string | null>(null);

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

  const runControllerRef = useRef<AbortController | null>(null);

  const activeSessionIdRef = useRef<string | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [sessionRunIds, setSessionRunIds] = useState<readonly string[]>([]);

  useEffect(() => {
    return () => {
      runControllerRef.current?.abort();
    };
  }, []);

  const restartRunController = useCallback(() => {
    runControllerRef.current?.abort();
    runControllerRef.current = new AbortController();
    return runControllerRef.current;
  }, []);

  const applyToRun = useCallback((update: (current: Run) => Run) => {
    setStarted((current) => (current === null ? current : update(current)));
  }, []);

  const [deciding, setDeciding] = useState(false);

  const [paused, setPaused] = useState<Paused | null>(null);

  const closePaused = useCallback(
    () => setPaused((current) => (current === null ? current : { ...current, closed: true })),
    [],
  );

  const handleAgentEvent = useCallback(
    (event: AgentEvent, runId?: string) => {
      if (event.frame === 'agent.approval.requested' && runId !== undefined) {
        setPaused({
          runId,
          call: { toolName: event.toolName, canonicalCall: event.canonicalCall },
        });
      }
      onAgentEvent?.(event, runId);
    },
    [onAgentEvent],
  );

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
      setPaused(null);
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
      runAgentAndFollow({
        agentId: agent.id,
        prompt: text,
        modelOverride: modelOverride,
        sessionId: activeSessionIdRef.current,
        projectId: projectId,
        assistant: assistant,
        apply: applyToRun,
        signal: restartRunController().signal,
        onStarted: (sessionId, runId) => {
          activeSessionIdRef.current = sessionId;
          setActiveSessionId(sessionId);
          setSessionRunIds((current) => [...current, runId]);
        },
        attachments: attachments,
        onEvent: handleAgentEvent,
        version: version ?? null,
      });
    },
    [
      agent,
      applyToRun,
      modelOverride,
      handleAgentEvent,
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
      handleAgentEvent,
    );
    signal.addEventListener('abort', abort, { once: true });
  }, [agent, applyToRun, follow, handleAgentEvent, restartRunController]);

  const followContinuation = useCallback(
    (runId: string, status: RunStatus) => {
      setPaused(null);
      // The continuation is live from the 202 on: shown as queued or running, the follow-up waits.
      applyToRun((run) => withStatus(run, badgeForRunStatus(status)));
      if (agent === null) return;
      const { signal } = restartRunController();
      setSessionRunIds((current) => [...current, runId]);
      const abort = followRunInto(
        runId,
        speakerForAgent(agent.name),
        applyToRun,
        undefined,
        handleAgentEvent,
      );
      signal.addEventListener('abort', abort, { once: true });
    },
    [agent, applyToRun, handleAgentEvent, restartRunController],
  );

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

  const notice = agents.kind === 'no-agents' ? agents.reason : '';

  const chips = agent === null || session === null ? [] : selectedChips(agent, session);

  const canSend = agent !== null && user !== null && draft.trim() !== '';

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
    runAgentAndFollow({
      agentId: agent.id,
      prompt: text,
      modelOverride: modelOverride,
      sessionId: null,
      projectId: projectId,
      assistant: speakerForAgent(agent.name),
      apply: applyToRun,
      signal: restartRunController().signal,
      onStarted: (sessionId, runId) => {
        activeSessionIdRef.current = sessionId;
        setActiveSessionId(sessionId);
        setSessionRunIds([runId]);
      },
      attachments: [],
      onEvent: handleAgentEvent,
      version: version ?? null,
    });
  };
  return {
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
  };
}
