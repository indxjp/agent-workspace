/**
 * The shop-floor tablet's backend: a multi-turn diagnosis session around the
 * maintenance-troubleshooting agent.
 *
 * The technician's first message starts a session; every reply continues it with the same
 * `sessionId`, so the agent remembers what was already ruled out. The skill asks the agent to
 * behave; this file checks that it did, on every turn, because a junior technician standing at a
 * press is the last person who should have to judge whether an instruction is sound:
 *
 * (a) the first answer of a session tells them to stop the machine and lock it out (停止・LOTO);
 * (b) each answer is exactly one step, or an escalation, or a resolution, never a list of steps to
 *     race through;
 * (c) each step cites a source, and every citation is one a tool returned in that run — the same
 *     check as the manual-search backend, with `parseCitations`;
 * and a resolution is real only when `logResolution` succeeded in that run: it is a write, so the
 * platform runs it only for a call the technician approved. A turn whose run pauses on that call
 * answers {@link AwaitingApproval} with the run id, and the session stays open until
 * {@link DiagnosisDesk.approve}: `runs.approve` starts a continuation that logs the resolution for
 * the same technician (the platform forwards the paused run's subject, ADR-0157), and that
 * continuation is read as the next typed turn. A rejection logs nothing; its comment goes back to
 * the session as the next message.
 *
 * The signed-in technician is the run's `subject`: the maintenance system verifies it (ADR-0142)
 * and records that name on a resolution, so the backend neither writes the name into the prompt nor
 * checks the log for it. What they may search is the run's `fileScope`, computed from the access
 * list (`./scope.ts`); a technician with nothing to see is refused before any run starts, because a
 * run without a scope would search every granted file.
 *
 * Every run asks for structured output (`TurnAnswerSchema`): the kind of turn, the step and its
 * sources arrive as fields, so the backend reads no marks out of the text. It checks what a schema
 * cannot: that the first turn says stop-and-LOTO, that the step number follows the last one, that
 * every source is one a tool returned, and that a resolution was logged.
 *
 * An escalation is the agent calling `handoff_to_person` (`engine.handoff`): the run's
 * `agent.handoff` frame makes the turn an escalation, whatever else the agent wrote.
 *
 * A flagged turn is returned with its violations, not hidden: the tablet shows it with a warning
 * to ask the shift leader. The backend also escalates by itself when a session runs past
 * `maxSteps`, so "keep trying" has a hard end that does not depend on the model.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import {
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type RunReading,
} from '../../shared/run-answer.ts';
import {
  inspectTurn,
  TurnAnswerSchema,
  type TurnAnswer,
  type TurnInspection,
} from './inspect-turn.ts';
import { fileScopeFor, loadAccess, type Access } from './scope.ts';

export {
  inspectTurn,
  TurnAnswerSchema,
  type LoggedResolution,
  type TurnAnswer,
  type TurnInspection,
  type TurnKind,
  type Violation,
} from './inspect-turn.ts';

const MESSAGE_MAX = 500;
const TECHNICIAN_MAX = 40;
const DEFAULT_MAX_STEPS = 6;

export interface DiagnosisTurn extends TurnInspection {
  readonly sessionId: string;
  readonly runId: string;
  /** What the technician typed for this turn. */
  readonly message: string;
  readonly reply: string;
  /** The reason of the run's `agent.handoff` frame, or null when the agent did not hand off. */
  readonly handoff: string | null;
  /** True when the turn passed every check and may be shown without a warning. */
  readonly ok: boolean;
}

export type SessionStatus = 'diagnosing' | 'escalated' | 'resolved';

export interface Escalation {
  /** `agent`: the agent handed the session to the expert; `step-limit`: the backend stopped it. */
  readonly reason: 'agent' | 'step-limit';
  /** What the expert reads: who, what was reported, which steps were tried and what came back. */
  readonly summary: string;
}

export interface DiagnosisSession {
  readonly sessionId: string;
  readonly technician: string;
  readonly status: SessionStatus;
  readonly turns: readonly DiagnosisTurn[];
  readonly escalation: Escalation | null;
}

export type DiagnosisErrorCode =
  'invalid_input' | 'unknown_session' | 'session_closed' | 'no_access' | 'nothing_to_approve';

/** The only error the desk throws on its own; its message is safe to show the technician. */
export class DiagnosisError extends Error {
  public constructor(
    public readonly code: DiagnosisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosisError';
  }
}

export interface DiagnosisDeskOptions {
  /** The backend escalates by itself when a step number would exceed this. Default 6. */
  readonly maxSteps?: number;
  /** Who may search what; default `data/access.json`. */
  readonly access?: Access;
  /** Called once when a session is escalated, by the agent or by the step limit. */
  readonly notifyExpert?: (session: DiagnosisSession) => void | Promise<void>;
}

export interface DiagnosisDesk {
  /** `photo` is an uploaded file of the faulty part; the agent reads it for the next step. */
  readonly start: (input: {
    technician: string;
    message: string;
    photo?: { fileId: string };
  }) => Promise<DiagnosisTurn | AwaitingApproval>;
  readonly reply: (
    sessionId: string,
    message: string,
    photo?: { fileId: string },
  ) => Promise<DiagnosisTurn | AwaitingApproval>;
  /**
   * The technician decides the call the session's last turn paused on. The continuation is read as
   * the next turn: a resolution once the approved `logResolution` call succeeded, or another pause.
   */
  readonly approve: (
    sessionId: string,
    decision: { readonly approve: boolean; readonly comment?: string },
  ) => Promise<DiagnosisTurn | AwaitingApproval>;
  readonly session: (sessionId: string) => DiagnosisSession;
}

function requireText(value: string, what: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '' || [...trimmed].length > max) {
    throw new DiagnosisError('invalid_input', `${what} must be 1 to ${String(max)} characters`);
  }
  return trimmed;
}

interface SessionState {
  readonly sessionId: string;
  readonly technician: string;
  status: SessionStatus;
  readonly turns: DiagnosisTurn[];
  escalation: Escalation | null;
  lastStep: number;
  /** The call the last turn paused on; cleared by the decision. */
  awaiting: AwaitingApproval | null;
}

const snapshot = (state: SessionState): DiagnosisSession => ({
  sessionId: state.sessionId,
  technician: state.technician,
  status: state.status,
  turns: [...state.turns],
  escalation: state.escalation,
});

function summaryOf(state: SessionState): string {
  const lines = [`対応者: ${state.technician}`, `最初の報告: ${state.turns[0]?.message ?? ''}`];
  state.turns.forEach((turn, index) => {
    if (turn.kind !== 'step') return;
    lines.push(`- 手順${String(turn.step)}：${turn.instruction ?? ''}`);
    const next = state.turns[index + 1];
    if (next !== undefined) lines.push(`  → 結果: ${next.message}`);
  });
  const handoff = state.turns.at(-1)?.handoff ?? null;
  if (handoff !== null) lines.push(`引継ぎ理由: ${handoff}`);
  return lines.join('\n');
}

type ReadTurn = () => Promise<RunReading<TurnAnswer>>;

interface Settled {
  readonly state: SessionState;
  readonly turn: DiagnosisTurn | AwaitingApproval;
}

/** What a turn does to its session: nothing, close it as resolved, or escalate it for a reason. */
type StatusChange =
  | { readonly status: 'diagnosing' | 'resolved' }
  | { readonly status: 'escalated'; readonly reason: Escalation['reason'] };

/** A new session for `technician`, under the id the platform gave its first run. */
const openSession = (sessionId: string, technician: string): SessionState => ({
  sessionId,
  technician,
  status: 'diagnosing',
  turns: [],
  escalation: null,
  lastStep: 0,
  awaiting: null,
});

/** What the platform tells the continuation of a decision (ADR-0145 D2.2). */
function decisionMessage(decision: {
  readonly approve: boolean;
  readonly comment?: string;
}): string {
  const verdict = decision.approve ? 'approved' : 'rejected';
  return decision.comment === undefined ? verdict : `${verdict}: ${decision.comment}`;
}

/** Pure: what `turn` does to its session, with the backend's own stop past `maxSteps`. */
function statusAfter(turn: DiagnosisTurn, maxSteps: number): StatusChange {
  if (turn.kind === 'escalation') return { status: 'escalated', reason: 'agent' };
  if (turn.kind === 'resolution' && turn.logged !== null) return { status: 'resolved' };
  if (turn.kind === 'step' && (turn.step ?? 0) > maxSteps) {
    return { status: 'escalated', reason: 'step-limit' };
  }
  return { status: 'diagnosing' };
}

/** The checked turn a run's reading is, in a session that is at `previousStep`. */
function diagnosisTurn(
  reading: RunReading<TurnAnswer>,
  sessionId: string,
  turn: { readonly message: string; readonly first: boolean; readonly previousStep: number },
): DiagnosisTurn {
  const inspection: TurnInspection = inspectTurn({
    answer: reading.output,
    toolCalls: reading.toolCalls,
    first: turn.first,
    previousStep: turn.previousStep,
    handoff: reading.handoff,
  });
  return {
    ...inspection,
    sessionId,
    runId: reading.run.id,
    message: turn.message,
    reply: reading.output.reply,
    handoff: reading.handoff,
    ok: inspection.violations.length === 0,
  };
}

async function escalate(
  state: SessionState,
  reason: Escalation['reason'],
  notifyExpert: DiagnosisDeskOptions['notifyExpert'],
): Promise<void> {
  state.status = 'escalated';
  state.escalation = { reason, summary: summaryOf(state) };
  await notifyExpert?.(snapshot(state));
}

interface DeskRules {
  readonly maxSteps: number;
  readonly notifyExpert: DiagnosisDeskOptions['notifyExpert'];
}

/** Read the run `read` follows as the session's next turn, or answer the pause it ended in. */
async function settleTurn(
  rules: DeskRules,
  state: SessionState | null,
  turn: { readonly technician: string; readonly message: string; readonly read: ReadTurn },
): Promise<Settled> {
  let reading;
  try {
    reading = await turn.read();
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    const paused = state ?? openSession(error.pending.sessionId, turn.technician);
    paused.awaiting = error.pending;
    return { state: paused, turn: error.pending };
  }
  const current = state ?? openSession(reading.run.sessionId, turn.technician);
  const result = diagnosisTurn(reading, current.sessionId, {
    message: turn.message,
    first: state === null,
    previousStep: current.lastStep,
  });
  current.turns.push(result);
  if (result.step !== null) current.lastStep = result.step;

  const next = statusAfter(result, rules.maxSteps);
  if (next.status === 'escalated') {
    await escalate(current, next.reason, rules.notifyExpert);
  } else if (next.status === 'resolved') {
    current.status = 'resolved';
  }
  return { state: current, turn: result };
}

/**
 * A diagnosis desk over `agentId`. Sessions live in memory here; a production desk keeps the same
 * state in its database, keyed by the session id.
 */
export function createDiagnosisDesk(
  aw: AgentWorkspaceClient,
  agentId: string,
  options: DiagnosisDeskOptions = {},
): DiagnosisDesk {
  const rules: DeskRules = {
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    notifyExpert: options.notifyExpert,
  };
  const access = options.access ?? loadAccess();
  const sessions = new Map<string, SessionState>();

  const sessionOf = (sessionId: string): SessionState => {
    const state = sessions.get(sessionId);
    if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
    return state;
  };
  const settle = (
    state: SessionState | null,
    technician: string,
    message: string,
    read: ReadTurn,
  ): Promise<Settled> => settleTurn(rules, state, { technician, message, read });

  async function turn(
    state: SessionState | null,
    technician: string,
    message: string,
    photo?: { fileId: string },
  ): Promise<{ state: SessionState; turn: DiagnosisTurn | AwaitingApproval }> {
    const fileScope = fileScopeFor(access, technician);
    if (fileScope.length === 0) {
      throw new DiagnosisError(
        'no_access',
        'this technician has no trouble log or manual to search',
      );
    }
    return settle(state, technician, message, () =>
      runAndRead(
        aw,
        agentId,
        {
          prompt: message,
          subject: technician,
          fileScope,
          sessionId: state?.sessionId ?? null,
          ...(photo === undefined ? {} : { attachments: [{ fileId: photo.fileId }] }),
        },
        TurnAnswerSchema,
      ),
    );
  }

  return {
    async start(input) {
      const technician = requireText(input.technician, 'technician', TECHNICIAN_MAX);
      const message = requireText(input.message, 'message', MESSAGE_MAX);
      const { state, turn: first } = await turn(null, technician, message, input.photo);
      sessions.set(state.sessionId, state);
      return first;
    },
    async reply(sessionId, rawMessage, photo) {
      const state = sessionOf(sessionId);
      if (state.status !== 'diagnosing') {
        throw new DiagnosisError('session_closed', `this session is ${state.status}`);
      }
      const message = requireText(rawMessage, 'message', MESSAGE_MAX);
      return (await turn(state, state.technician, message, photo)).turn;
    },
    async approve(sessionId, decision) {
      const state = sessionOf(sessionId);
      const { awaiting } = state;
      if (awaiting === null) {
        throw new DiagnosisError('nothing_to_approve', 'this session is not waiting for approval');
      }
      const input = decision.comment === undefined ? {} : { comment: decision.comment };
      const { run } = decision.approve
        ? await aw.runs.approve(awaiting.runId, input)
        : await aw.runs.reject(awaiting.runId, input);
      state.awaiting = null;
      const message = decisionMessage(decision);
      return (
        await settle(state, state.technician, message, () => readRun(aw, run.id, TurnAnswerSchema))
      ).turn;
    },
    session(sessionId) {
      return snapshot(sessionOf(sessionId));
    },
  };
}
