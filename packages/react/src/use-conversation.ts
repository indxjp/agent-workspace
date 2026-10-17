'use client';

/**
 * The surface chat's state, without any markup: what `<Chat/>` renders, for a page that draws its
 * own (issue #623). It is the state block the hosted chat always held, moved here; the send path
 * it drives is `./surface-chat-send.ts`, unchanged.
 *
 * On mount the conversation resumes the agent the visitor last talked to and replays its stored
 * runs (`./history.ts`). A `401` on a start opens the session once more; a `429` refusal and the
 * turn limit come back as `failure`, and at the turn limit `status` is `ended`.
 */
import { useEffect, useRef, useState } from 'react';

import type { RunFeedbackRating } from '@indx-workspace/contracts/feedback';
import type { SurfaceDefinition, SurfaceSessionResponse } from '@indx-workspace/contracts/surfaces';

import {
  readSurfaceHistory,
  selectSurfaceAgent,
  surfaceHistoryStorage,
  type SurfaceHistoryStorage,
} from './history.js';
import { surfaceStrings } from './locale.js';
import type { Message, Run, RunBadge, RunFailureNotice } from './run-model.js';
import { surfaceAgentSpeaker, type SurfaceTurn } from './surface-chat-model.js';
import {
  browserSurfaceChatTransport,
  restoreSurfaceConversation,
  sendSurfaceFeedback,
  sendSurfaceMessage,
  TURN_LIMIT_REACHED,
  type SurfaceChatDriver,
} from './surface-chat-send.js';
import { SURFACE_DEFAULTS } from './theme.js';

export interface UseConversationOptions {
  /** The surface's name, as in `/p/s/<name>`. */
  readonly surface: string;
  /** The surface's own agent. Defaults to `definition.agent`, then to the surface's name. */
  readonly agentName?: string;
  /** The surface's definition, as `defineSurface` returns it: its parts, look and language. */
  readonly definition?: SurfaceDefinition;
  /** The conversation to show first; for a server render of a transcript. */
  readonly initialRun?: Run | null;
  /** The tool steps and answers of `initialRun`'s runs; for a server render of a transcript. */
  readonly initialTurns?: readonly SurfaceTurn[];
  /** `local` when the try page frames the chat: its sessions run the working draft (#612). */
  readonly environment?: 'local';
  /**
   * The Agent Workspace to talk to, such as `https://agents.example.com` (or a proxy of it, path
   * prefix kept); defaults to the page's own origin. Until the run routes answer CORS, a page on
   * another origin reaches them through a proxy (#623).
   */
  readonly baseUrl?: string;
}

/**
 * What the conversation is doing: `restoring` while it replays a stored conversation, `sending`
 * while a message is on its way, `ended` once the surface's turn limit closed it.
 */
export type ConversationStatus = 'idle' | 'restoring' | 'sending' | 'ended';

export interface Conversation {
  readonly messages: readonly Message[];
  readonly status: ConversationStatus;
  /** The last run's status badge, such as "Running"; `null` before the first message. */
  readonly runStatus: RunBadge | null;
  /** Why the last message failed, in the surface's own language; `null` when it did not. */
  readonly failure: RunFailureNotice | null;
  /** Each run's tool steps and answers. */
  readonly turns: readonly SurfaceTurn[];
  /** Send `prompt`; ignored when it is empty or while restoring or sending. */
  readonly send: (prompt: string) => void;
  readonly rate: (runId: string, rating: RunFeedbackRating) => void;
  readonly rated: Readonly<Record<string, RunFeedbackRating>>;
  /** The runs whose rating was not sent, which may be rated again. */
  readonly failedRatings: ReadonlySet<string>;
  /** The agent this conversation talks to. */
  readonly agentName: string;
  /** The agents a visitor may talk to: the surface's own first, then the switcher's others. */
  readonly agents: readonly string[];
  /** Talk to another offered agent, restoring that agent's conversation. */
  readonly switchAgent: (agent: string) => void;
}

function offeredAgents(ownAgentName: string, definition?: SurfaceDefinition): readonly string[] {
  const others = definition?.parts?.agentSwitcher?.agents ?? [];
  return [ownAgentName, ...others.filter((agent) => agent !== ownAgentName)];
}

export function useConversation({
  surface: surfaceName,
  agentName: agentOption,
  definition,
  initialRun = null,
  initialTurns = [],
  environment,
  baseUrl,
}: UseConversationOptions): Conversation {
  checkBaseUrl(baseUrl);
  const ownAgentName = agentOption ?? definition?.agent ?? surfaceName;
  const [agentName, setAgentName] = useState(ownAgentName);
  const [run, setRun] = useState<Run | null>(initialRun);
  const [turns, setTurns] = useState<readonly SurfaceTurn[]>(initialTurns);
  const [rated, setRated] = useState<Readonly<Record<string, RunFeedbackRating>>>({});
  const [failedRatings, setFailedRatings] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const agentRef = useRef(ownAgentName);
  const runRef = useRef<Run | null>(initialRun);
  const turnsRef = useRef<readonly SurfaceTurn[]>(initialTurns);
  const sessionRef = useRef<SurfaceSessionResponse | null>(null);
  const historyRef = useRef<SurfaceHistoryStorage | null>(null);
  const feedbackSentRef = useRef(new Set<string>());
  const restoredRef = useRef(false);
  const sentRef = useRef(0);
  // Aborted on unmount, so a run still streaming when the chat closes stops with it.
  const unmountRef = useRef<AbortController | null>(null);

  const offered = offeredAgents(ownAgentName, definition);
  const strings = surfaceStrings(definition?.theme?.locale ?? SURFACE_DEFAULTS.locale);

  /** The history's storage, made on first use: `window` exists only in the browser. */
  const history = (): SurfaceHistoryStorage => {
    historyRef.current ??= surfaceHistoryStorage(
      definition?.parts?.history === true,
      () => window.localStorage,
    );
    return historyRef.current;
  };

  const driverFor = (agent: string): SurfaceChatDriver => ({
    surfaceName,
    agentName: agent,
    ownAgentName,
    assistant: surfaceAgentSpeaker(agent),
    transport: browserSurfaceChatTransport(environment, baseUrl),
    history: history(),
    session: sessionRef,
    current: () => runRef.current,
    show: (next) => {
      runRef.current = next;
      setRun(next);
    },
    showTurn: (turn) => {
      const others = turnsRef.current.filter((each) => each.runId !== turn.runId);
      turnsRef.current = [...others, turn];
      setTurns(turnsRef.current);
    },
    dropTurn: (runId) => {
      turnsRef.current = turnsRef.current.filter((each) => each.runId !== runId);
      setTurns(turnsRef.current);
    },
    feedbackSent: feedbackSentRef.current,
    strings,
  });

  /** Talk to `agent`, adding whatever its history restores to the conversation shown. */
  const restore = async (agent: string): Promise<void> => {
    agentRef.current = agent;
    setAgentName(agent);
    setRestoring(true);
    try {
      await restoreSurfaceConversation(driverFor(agent), strings.earlierMessage);
    } finally {
      setRestoring(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    unmountRef.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    // Once per page, though development's StrictMode runs an effect twice.
    if (restoredRef.current) return;
    restoredRef.current = true;
    const { agent } = readSurfaceHistory(history(), surfaceName, offered);
    void restore(agent ?? ownAgentName);
  }, []);

  const send = (prompt: string): void => {
    if (prompt === '' || busy || restoring) return;
    setBusy(true);
    sentRef.current += 1;
    // ponytail: only sends are cut on unmount; a restore replay is left to finish, because
    // StrictMode's simulated unmount would abort the once-per-page restore for good.
    void sendSurfaceMessage(
      { ...driverFor(agentRef.current), signal: unmountRef.current?.signal },
      `visitor-${String(sentRef.current)}`,
      prompt,
    ).finally(() => {
      setBusy(false);
    });
  };

  const switchAgent = (agent: string): void => {
    if (busy || restoring || agent === agentRef.current || !offered.includes(agent)) return;
    selectSurfaceAgent(history(), surfaceName, agent);
    runRef.current = null;
    setRun(null);
    turnsRef.current = [];
    setTurns([]);
    sessionRef.current = null;
    void restore(agent);
  };

  const rate = (runId: string, rating: RunFeedbackRating): void => {
    setRated((current) => ({ ...current, [runId]: rating }));
    setFailedRatings((current) => new Set([...current].filter((each) => each !== runId)));
    void sendSurfaceFeedback(driverFor(agentRef.current), runId, rating).then((outcome) => {
      if (outcome === 'problem' || outcome === 'failed') {
        // Not sent: say so, and let the visitor press again (#628).
        setRated((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => id !== runId)),
        );
        setFailedRatings((current) => new Set([...current, runId]));
      }
    });
  };

  const failure = run?.failure ?? null;
  return {
    messages: run?.messages ?? [],
    status: conversationStatus(restoring, busy, failure?.code === TURN_LIMIT_REACHED),
    runStatus: run?.heading.status ?? null,
    failure,
    turns,
    send,
    rate,
    rated,
    failedRatings,
    agentName,
    agents: offered,
    switchAgent,
  };
}

/** A configuration mistake fails loudly rather than as a silent fetch to the wrong place. */
function checkBaseUrl(baseUrl: string | undefined): void {
  if (baseUrl === undefined) return;
  let protocol: string | null = null;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // Not a URL: refused below.
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('baseUrl must be an http(s) URL, such as https://agents.example.com.');
  }
}

function conversationStatus(
  restoring: boolean,
  sending: boolean,
  ended: boolean,
): ConversationStatus {
  if (restoring) return 'restoring';
  if (sending) return 'sending';
  return ended ? 'ended' : 'idle';
}
