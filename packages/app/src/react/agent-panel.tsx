'use client';
/**
 * `AgentPanel`: an agent working on one record, beside it (issue #1509). The person picks one of
 * the offered agents and says what to do; the panel starts a run about the record through the
 * app's `agentPanelRoutes`, as the person, and shows the conversation, the run's status, its tool
 * steps, and its failure in the person's words.
 *
 * When the run waits for an approval (ADR-0145), the page's `renderApproval` draws the prompt;
 * the panel sends the decision and follows the continuation. A page without one gets a notice to
 * decide in Agent Workspace and a button to check again, so the panel is never a dead end.
 *
 * Drawn in `ResourceDetail`'s `aside` slot: `aside={<AgentPanel resource={ticket} … />}`.
 * `onCompleted` lets the page fetch the record again after the agent changed it. `initialPrompt` and
 * `initialAgent` pre-fill the composer, so a page action ("Rewrite with <agent>", issue #1521)
 * opens the panel ready to send; the person still reads and sends it.
 */
import {
  MAX_PROMPT_CHARS,
  type RunApprovalCall,
  type RunApprovalDecision,
} from '@indx-workspace/contracts/runs';
import { AssistantProse, ToolTrace } from '@indx-workspace/react';
import type { RunBadge, Speaker } from '@indx-workspace/react/run-model';
import { badgeForRunStatus } from '@indx-workspace/react/run-model';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { DefinedResource } from '../resource.js';
import { agentPanelClient, type AgentPanelClient } from './agent-panel-client.js';
import {
  agentPanelReducer,
  INITIAL_AGENT_PANEL_STATE,
  isStuck,
  maySend,
  needsApprovalCall,
  type AgentPanelState,
  type FrameContext,
  type PanelRunStatus,
} from './agent-panel-model.js';
import { ResourceProblemError } from './client.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type AgentPanelStrings } from './locale.js';

/** One agent the panel offers: the name `agentPanelRoutes` knows it by, and what it reads as. */
export interface AgentPanelAgent {
  readonly name: string;
  readonly label: string;
}

/**
 * What `renderApproval` is given: the call the run waits on, whether a decision is in flight, the
 * last decision's problem in the person's words, and how to decide. The shape of `ApprovalPrompt`'s
 * props in `@indx-workspace/react` less its `strings`, so a page passes them straight on.
 */
export interface AgentPanelApprovalProps {
  readonly call: RunApprovalCall;
  readonly pending: boolean;
  readonly problem: string | null;
  readonly onDecide: (decision: RunApprovalDecision, comment: string | undefined) => void;
}

/** What {@link AgentPanelProps.onCompleted} is told: the run that completed and its agent. */
export interface AgentPanelCompletion {
  readonly runId: string;
  readonly agent: AgentPanelAgent;
}

/** The props of {@link AgentPanel}. */
export interface AgentPanelProps {
  readonly resource: DefinedResource;
  readonly recordId: string;
  /** The agents to choose from, in order; the first is chosen to begin with. */
  readonly agents: readonly AgentPanelAgent[];
  /** Draws the approval prompt; a notice to decide in Agent Workspace when not given. */
  readonly renderApproval?: ((props: AgentPanelApprovalProps) => ReactNode) | undefined;
  /**
   * Called once each time a run of the panel completes, so the page can fetch the record again;
   * told the run and the agent it was of.
   */
  readonly onCompleted?: ((completed: AgentPanelCompletion) => void) | undefined;
  /** What the prompt box holds to begin with; empty when not given. */
  readonly initialPrompt?: string | undefined;
  /** The name of the agent chosen to begin with; the first of `agents` when not given. */
  readonly initialAgent?: string | undefined;
  /** The language of the panel's words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
  /** How the tool steps show: `collapsed` (a closed list) when not given. */
  readonly toolTrace?: 'hidden' | 'collapsed' | 'full' | undefined;
  /** The client of the panel's routes; one for the page's own origin when not given. */
  readonly client?: AgentPanelClient | undefined;
}

function initialsOf(label: string): string {
  const letters = label
    .split(/\s+/u)
    .filter((word) => word !== '')
    .map((word) => [...word][0] ?? '')
    .join('');
  return [...letters].slice(0, 2).join('').toUpperCase() || '?';
}

function codeOf(error: unknown): string {
  return error instanceof ResourceProblemError ? error.code : 'other';
}

function badgeIn(strings: AgentPanelStrings): (status: PanelRunStatus) => RunBadge {
  return (status) => ({ ...badgeForRunStatus(status), label: strings.status[status] });
}

/** The conversation: the person's prompts and the agent's answers, each a text node or safe prose. */
function Transcript({
  state,
  strings,
}: {
  readonly state: AgentPanelState;
  readonly strings: AgentPanelStrings;
}): ReactNode {
  const messages = state.transcript?.messages ?? [];
  return (
    <ol className="aw-app-panel-transcript" aria-label={strings.transcriptLabel}>
      {messages.length === 0 ? <li className="aw-app-empty">{strings.emptyTranscript}</li> : null}
      {messages.map((message) => (
        <li key={message.id} className="aw-app-panel-message" data-kind={message.kind}>
          <p className="aw-app-panel-speaker">{message.speaker.name}</p>
          {message.kind === 'user' ? (
            message.paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph.map((inline) => inline.text).join('')}</p>
            ))
          ) : (
            <AssistantProse
              text={message.blocks
                .flatMap((block) =>
                  block.kind === 'prose'
                    ? block.paragraphs.map((p) => p.map((inline) => inline.text).join(''))
                    : [],
                )
                .join('\n\n')}
              className="aw-app-panel-prose"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Where the run stands: its status, its failure, and the approval it waits on. Exported for the
 * panel's tests, which draw it in each state; not part of `./react`.
 */
export function AgentPanelRunState({
  state,
  strings,
  problem,
  renderApproval,
  onDecide,
  onCheckAgain,
}: {
  readonly state: AgentPanelState;
  readonly strings: AgentPanelStrings;
  readonly problem: string | null;
  readonly renderApproval: AgentPanelProps['renderApproval'];
  readonly onDecide: AgentPanelApprovalProps['onDecide'];
  readonly onCheckAgain: () => void;
}): ReactNode {
  const failure = state.transcript?.failure ?? null;
  const awaiting = state.status === 'awaiting_approval';
  return (
    <>
      <p className="aw-app-status" role="status">
        {state.status === null ? null : (
          <span className="aw-app-badge" data-tone={badgeForRunStatus(state.status).tone}>
            {strings.status[state.status]}
          </span>
        )}
      </p>
      {failure === null ? null : (
        <div className="aw-app-alert" role="alert">
          <p className="aw-app-alert-heading">{strings.runFailed}</p>
          <p>{failure.message}</p>
        </div>
      )}
      {awaiting && state.approval !== null && renderApproval !== undefined
        ? renderApproval({
            call: state.approval,
            pending: state.phase === 'deciding',
            problem,
            onDecide,
          })
        : null}
      {isStuck(state, renderApproval !== undefined) ? (
        <div className="aw-app-panel-note" role="note">
          {awaiting ? <p>{strings.awaitingInConsole}</p> : null}
          <button type="button" className="aw-app-button" onClick={onCheckAgain}>
            {strings.checkAgain}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** The agent panel of one record. */
export function AgentPanel(props: AgentPanelProps): ReactNode {
  const { resource, recordId, agents, renderApproval, onCompleted } = props;
  const appText = appStrings(useAppLocale(props.locale));
  const strings = appText.agentPanel;
  const id = useId();
  const client = useMemo(
    () => props.client ?? agentPanelClient(resource.name, recordId),
    [props.client, resource.name, recordId],
  );
  const [state, dispatch] = useReducer(agentPanelReducer, INITIAL_AGENT_PANEL_STATE);
  const [agent, setAgent] = useState(props.initialAgent ?? agents[0]?.name ?? '');
  const [prompt, setPrompt] = useState(props.initialPrompt ?? '');
  const [checks, setChecks] = useState(0);
  const chosen = agents.find((candidate) => candidate.name === agent) ?? agents[0];
  const context: FrameContext = useMemo(
    () => ({
      agent: { initials: initialsOf(chosen?.label ?? ''), name: chosen?.label ?? '' },
      badge: badgeIn(strings),
    }),
    [chosen?.label, strings],
  );
  const you: Speaker = useMemo(
    () => ({ initials: initialsOf(strings.you), name: strings.you }),
    [strings.you],
  );

  // What a frame or the end of a stream is folded with, read when it arrives: a new context or
  // callback is not a new run to follow.
  const latest = useRef({ context, onCompleted, lastEventId: state.lastEventId });
  useEffect(() => {
    latest.current = { context, onCompleted, lastEventId: state.lastEventId };
  });
  // The agent the person sent the current conversation's prompt to, which a completion names.
  const sentTo = useRef<AgentPanelAgent | undefined>(undefined);

  const { runId, phase } = state;
  const following = phase === 'following';
  useEffect(() => {
    if (runId === null || !following) return undefined;
    const abort = new AbortController();
    void client
      .follow(runId, {
        after: latest.current.lastEventId,
        signal: abort.signal,
        onFrame: (frame) => dispatch({ type: 'frame', frame, context: latest.current.context }),
      })
      .then(async () => {
        if (abort.signal.aborted) return;
        const run = await client.get(runId);
        dispatch({ type: 'run', run, context: latest.current.context });
        const agentOfRun = sentTo.current;
        if (run.status === 'completed' && agentOfRun !== undefined) {
          latest.current.onCompleted?.({ runId, agent: agentOfRun });
        }
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) dispatch({ type: 'refused', code: codeOf(error) });
      });
    return () => abort.abort();
  }, [client, runId, following]);

  // Read the run again: for the call it waits on, and whenever the person asks to check again.
  const awaitingCall = needsApprovalCall(state);
  useEffect(() => {
    if (runId === null || phase !== 'idle' || (!awaitingCall && checks === 0)) return undefined;
    let current = true;
    client
      .get(runId)
      .then((run) => {
        if (current) dispatch({ type: 'run', run, context: latest.current.context });
      })
      .catch((error: unknown) => {
        if (current) dispatch({ type: 'refused', code: codeOf(error) });
      });
    return () => {
      current = false;
    };
  }, [client, runId, awaitingCall, phase, checks]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!maySend(state) || prompt.trim() === '' || chosen === undefined) return;
    dispatch({
      type: 'send',
      messageId: `${id}-${String(Date.now())}`,
      prompt,
      you,
      title: chosen.label,
    });
    sentTo.current = chosen;
    client
      .start(chosen.name, prompt.trim())
      .then((started) => {
        setPrompt('');
        dispatch({ type: 'started', run: started.run, context });
      })
      .catch((error: unknown) => dispatch({ type: 'refused', code: codeOf(error) }));
  };

  const onDecide = useCallback(
    (decision: RunApprovalDecision, comment: string | undefined): void => {
      if (runId === null) return;
      dispatch({ type: 'decide' });
      client
        .decide(runId, decision, comment)
        .then((decided) => dispatch({ type: 'started', run: decided.run, context }))
        .catch((error: unknown) => dispatch({ type: 'refused', code: codeOf(error) }));
    },
    [client, runId, context],
  );

  const problem = state.problem === null ? null : problemMessage(appText, state.problem);
  const sending = state.phase === 'sending';

  return (
    <section className="aw-app-panel" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="aw-app-panel-heading">
        {strings.heading}
      </h2>
      <Transcript state={state} strings={strings} />
      <ToolTrace
        mode={props.toolTrace ?? 'collapsed'}
        steps={state.tools}
        strings={{
          toolActivity: strings.toolActivity,
          toolInput: strings.toolInput,
          toolOutput: strings.toolOutput,
        }}
      />
      <AgentPanelRunState
        state={state}
        strings={strings}
        problem={problem}
        renderApproval={renderApproval}
        onDecide={onDecide}
        onCheckAgain={() => setChecks((count) => count + 1)}
      />
      {problem === null || state.phase === 'deciding' ? null : (
        <p className="aw-app-alert" role="alert">
          {problem}
        </p>
      )}
      <form className="aw-app-panel-composer" onSubmit={onSubmit}>
        <div className="aw-app-field">
          <label htmlFor={`${id}-agent`} className="aw-app-label">
            {strings.agentLabel}
          </label>
          <select
            id={`${id}-agent`}
            value={chosen?.name ?? ''}
            onChange={(event) => setAgent(event.target.value)}
          >
            {agents.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
        <div className="aw-app-field">
          <label htmlFor={`${id}-prompt`} className="aw-app-label">
            {strings.promptLabel}
          </label>
          <textarea
            id={`${id}-prompt`}
            value={prompt}
            required
            maxLength={MAX_PROMPT_CHARS}
            rows={3}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="aw-app-button aw-app-primary"
          disabled={!maySend(state) || chosen === undefined}
        >
          {sending ? strings.sending : strings.send}
        </button>
      </form>
    </section>
  );
}
