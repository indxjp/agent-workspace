'use client';

import type { RunStatus } from '@indx-workspace/contracts/runs';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import { badgeForRunStatus, withStatus, type Run } from '@indx-workspace/react/run-model';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paused } from './home-chat-approval';
import { followRunInto, speakerForAgent } from './home-chat-live';
import type { ComposerAgent } from './model';

export interface HomeChatRunInputs {
  readonly initialRun: Run | null;
  readonly agent: ComposerAgent | null;
  readonly follow: { readonly runId: string; readonly nonce: number } | undefined;
  readonly onAgentEvent: ((event: AgentEvent, runId?: string) => void) | undefined;
}

/** What the screen shows of the run: the transcript, the session it belongs to and a paused call. */
export interface HomeChatRunView {
  readonly started: Run | null;
  readonly activeSessionId: string | null;
  readonly sessionRunIds: readonly string[];
  readonly deciding: boolean;
  readonly paused: Paused | null;
  readonly followContinuation: (runId: string, status: RunStatus) => void;
  readonly setDeciding: (deciding: boolean) => void;
  readonly closePaused: () => void;
}

/** What sending a message needs to start, and keep track of, a run. */
export interface HomeChatRunControl {
  readonly setStarted: (run: Run | null) => void;
  readonly applyToRun: (update: (current: Run) => Run) => void;
  readonly handleAgentEvent: (event: AgentEvent, runId?: string) => void;
  readonly restartRunController: () => AbortController;
  readonly abortRun: () => void;
  readonly clearPaused: () => void;
  readonly currentSessionId: () => string | null;
  /** Remembers a follow-up run's session and adds its run to the chat's runs. */
  readonly noteRunStarted: (sessionId: string, runId: string) => void;
  /** Remembers the first run's session; it is the only run of the chat so far. */
  readonly noteFirstRunStarted: (sessionId: string, runId: string) => void;
  /** Forgets the session and runs of the previous chat. */
  readonly resetRunTracking: () => void;
}

/** The run this screen shows, the stream that feeds it, and the approval a paused run waits on. */
export function useHomeChatRun({ initialRun, agent, follow, onAgentEvent }: HomeChatRunInputs): {
  readonly view: HomeChatRunView;
  readonly control: HomeChatRunControl;
} {
  const [started, setStarted] = useState<Run | null>(initialRun);
  const [deciding, setDeciding] = useState(false);
  const [paused, setPaused] = useState<Paused | null>(null);
  const tracking = useSessionTracking();
  const stream = useRunStream();
  const { restartRunController } = stream;

  const applyToRun = useCallback((update: (current: Run) => Run) => {
    setStarted((current) => (current === null ? current : update(current)));
  }, []);

  const closePaused = useCallback(
    () => setPaused((current) => (current === null ? current : { ...current, closed: true })),
    [],
  );
  const clearPaused = useCallback(() => setPaused(null), []);

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

  const followIntoTranscript = useCallback(
    (runId: string, speakerName: string) => {
      const { signal } = restartRunController();
      tracking.addRunId(runId);
      const abort = followRunInto(
        runId,
        speakerForAgent(speakerName),
        applyToRun,
        undefined,
        handleAgentEvent,
      );
      signal.addEventListener('abort', abort, { once: true });
    },
    [applyToRun, handleAgentEvent, restartRunController, tracking.addRunId],
  );

  const followedNonce = useRef(follow?.nonce);

  useEffect(() => {
    if (follow === undefined || agent === null || follow.nonce === followedNonce.current) return;
    followedNonce.current = follow.nonce;
    followIntoTranscript(follow.runId, agent.name);
  }, [agent, follow, followIntoTranscript]);

  const followContinuation = useCallback(
    (runId: string, status: RunStatus) => {
      setPaused(null);
      // The continuation is live from the 202 on: shown as queued or running, the follow-up waits.
      applyToRun((run) => withStatus(run, badgeForRunStatus(status)));
      if (agent === null) return;
      followIntoTranscript(runId, agent.name);
    },
    [agent, applyToRun, followIntoTranscript],
  );

  return {
    view: {
      started,
      activeSessionId: tracking.activeSessionId,
      sessionRunIds: tracking.sessionRunIds,
      deciding,
      paused,
      followContinuation,
      setDeciding,
      closePaused,
    },
    control: {
      setStarted,
      applyToRun,
      handleAgentEvent,
      restartRunController,
      abortRun: stream.abortRun,
      clearPaused,
      currentSessionId: tracking.currentSessionId,
      noteRunStarted: tracking.noteRunStarted,
      noteFirstRunStarted: tracking.noteFirstRunStarted,
      resetRunTracking: tracking.reset,
    },
  };
}

/** The one stream this screen follows; starting another, or leaving the screen, ends it. */
function useRunStream() {
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const restartRunController = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    return controllerRef.current;
  }, []);

  const abortRun = useCallback(() => controllerRef.current?.abort(), []);

  return { restartRunController, abortRun };
}

/** The session the chat runs in, and the runs it has started, kept in step for stale-closure-free reads. */
function useSessionTracking() {
  const sessionIdRef = useRef<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionRunIds, setSessionRunIds] = useState<readonly string[]>([]);

  const rememberSession = useCallback((sessionId: string | null) => {
    sessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, []);

  const addRunId = useCallback((runId: string) => {
    setSessionRunIds((current) => [...current, runId]);
  }, []);

  const noteRunStarted = useCallback(
    (sessionId: string, runId: string) => {
      rememberSession(sessionId);
      addRunId(runId);
    },
    [addRunId, rememberSession],
  );

  const noteFirstRunStarted = useCallback(
    (sessionId: string, runId: string) => {
      rememberSession(sessionId);
      setSessionRunIds([runId]);
    },
    [rememberSession],
  );

  const reset = useCallback(() => {
    rememberSession(null);
    setSessionRunIds([]);
  }, [rememberSession]);

  const currentSessionId = useCallback(() => sessionIdRef.current, []);

  return {
    activeSessionId,
    sessionRunIds,
    addRunId,
    noteRunStarted,
    noteFirstRunStarted,
    reset,
    currentSessionId,
  };
}
