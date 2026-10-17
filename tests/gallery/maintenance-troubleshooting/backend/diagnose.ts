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
 * (b) each answer holds exactly one numbered step (手順N：), or the escalation phrase, or a
 *     resolution, never a list of steps to race through;
 * (c) each step cites a source, and every citation is one a tool returned in that run — the same
 *     check as the manual-search backend, with `parseCitations`;
 * and a resolution is real only when `log_resolution` succeeded in that run.
 *
 * A flagged turn is returned with its violations, not hidden: the tablet shows it with a warning
 * to ask the shift leader. The backend also escalates by itself when a session runs past
 * `maxSteps`, so "keep trying" has a hard end that does not depend on the model.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { parseCitations, type Citation } from '../../shared/citations.ts';
import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';

export const SAFETY_MARK = '【安全】';
export const ESCALATION_PHRASE = '熟練者に引き継ぎます';
export const RESOLUTION_MARK = '【解決】';

const STEP = /手順\s*([0-9０-９]+)\s*[:：]/gu;
const MESSAGE_MAX = 500;
const TECHNICIAN_MAX = 40;

export type TurnKind = 'step' | 'escalation' | 'resolution';

export type Violation =
  /** The session's first answer does not say to stop the machine and apply LOTO. */
  | 'missing-safety'
  /** Neither a step, nor the escalation phrase, nor a resolution. */
  | 'no-step'
  /** More than one 手順N： in one answer, or a step next to an escalation or resolution. */
  | 'multiple-steps'
  /** The step's paragraph has no 〔…〕 source. */
  | 'uncited-step'
  /** A 〔…〕 that no tool returned in this run. */
  | 'unverified-citation'
  /** 手順N： where N is not the previous step plus one. */
  | 'step-out-of-order'
  /** 【解決】 without a successful log_resolution call in the same run. */
  | 'resolution-not-logged'
  /** log_resolution recorded someone other than the signed-in technician. */
  | 'log-technician-mismatch';

export interface LoggedResolution {
  readonly id: string;
  readonly machineId: string;
  readonly cause: string;
  readonly action: string;
  readonly technician: string;
}

export interface TurnInspection {
  readonly kind: TurnKind | null;
  /** The step number this answer gives, or null when it gives none. */
  readonly step: number | null;
  readonly citations: readonly Citation[];
  readonly unverified: readonly Citation[];
  readonly logged: LoggedResolution | null;
  readonly violations: readonly Violation[];
}

export interface DiagnosisTurn extends TurnInspection {
  readonly sessionId: string;
  readonly runId: string;
  /** What the technician typed for this turn. */
  readonly message: string;
  readonly answer: string;
  /** True when the turn passed every check and may be shown without a warning. */
  readonly ok: boolean;
}

export type SessionStatus = 'diagnosing' | 'escalated' | 'resolved';

export interface Escalation {
  /** `agent`: the agent wrote the escalation phrase; `step-limit`: the backend stopped it. */
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

export type DiagnosisErrorCode = 'invalid_input' | 'unknown_session' | 'session_closed';

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
  /** Called once when a session is escalated, by the agent or by the step limit. */
  readonly notifyExpert?: (session: DiagnosisSession) => void | Promise<void>;
}

export interface DiagnosisDesk {
  readonly start: (input: { technician: string; message: string }) => Promise<DiagnosisTurn>;
  readonly reply: (sessionId: string, message: string) => Promise<DiagnosisTurn>;
  readonly session: (sessionId: string) => DiagnosisSession;
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

function requireText(value: string, what: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '' || [...trimmed].length > max) {
    throw new DiagnosisError('invalid_input', `${what} must be 1 to ${String(max)} characters`);
  }
  return trimmed;
}

function asLogged(call: ToolCall): LoggedResolution | null {
  if (call.output === null) return null;
  try {
    const parsed = JSON.parse(call.output) as Partial<LoggedResolution> & { logged?: unknown };
    if (
      parsed.logged !== true ||
      typeof parsed.id !== 'string' ||
      typeof parsed.machineId !== 'string' ||
      typeof parsed.cause !== 'string' ||
      typeof parsed.action !== 'string' ||
      typeof parsed.technician !== 'string'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      machineId: parsed.machineId,
      cause: parsed.cause,
      action: parsed.action,
      technician: parsed.technician,
    };
  } catch {
    return null;
  }
}

/** The paragraph that starts at `index`: up to the next blank line, or the end. */
function paragraphAt(answer: string, index: number): string {
  const rest = answer.slice(index);
  const end = /\n\s*\n/u.exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

/**
 * Check one answer against the rules above. Pure: what the agent said, what its tools returned in
 * the run, and what the session knows (first turn or not, the last step, the technician).
 */
export function inspectTurn(input: {
  readonly answer: string;
  readonly toolCalls: readonly ToolCall[];
  readonly first: boolean;
  readonly previousStep: number;
  readonly technician: string;
}): TurnInspection {
  const { answer, toolCalls } = input;
  const violations: Violation[] = [];

  if (input.first && !(/停止/u.test(answer) && /LOTO|ロックアウト/u.test(answer))) {
    violations.push('missing-safety');
  }

  const steps = [...answer.matchAll(STEP)];
  const resolving = answer.includes(RESOLUTION_MARK);
  const escalating = answer.includes(ESCALATION_PHRASE);
  const kind: TurnKind | null = resolving
    ? 'resolution'
    : escalating
      ? 'escalation'
      : steps.length > 0
        ? 'step'
        : null;
  if (kind === null) violations.push('no-step');
  if (steps.length > 1 || (kind !== 'step' && steps.length > 0)) violations.push('multiple-steps');

  const [first] = steps;
  const step = first?.[1] === undefined ? null : Number(first[1].normalize('NFKC'));
  if (kind === 'step' && first !== undefined) {
    if (parseCitations(paragraphAt(answer, first.index)).length === 0) {
      violations.push('uncited-step');
    }
    if (step !== input.previousStep + 1) violations.push('step-out-of-order');
  }

  const returned = new Set(
    toolCalls
      .filter((call) => !call.isError && call.output !== null)
      .flatMap((call) => parseCitations(call.output ?? '').map((citation) => citation.raw)),
  );
  const citations = parseCitations(answer);
  const unverified = citations.filter((citation) => !returned.has(citation.raw));
  if (unverified.length > 0) violations.push('unverified-citation');

  let logged: LoggedResolution | null = null;
  if (kind === 'resolution') {
    const call = toolCalls.find((each) => toolIs(each.name, 'log_resolution') && !each.isError);
    logged = call === undefined ? null : asLogged(call);
    if (logged === null) violations.push('resolution-not-logged');
    else if (logged.technician !== input.technician) violations.push('log-technician-mismatch');
  }

  return { kind, step, citations, unverified, logged, violations };
}

interface SessionState {
  readonly sessionId: string;
  readonly technician: string;
  status: SessionStatus;
  readonly turns: DiagnosisTurn[];
  escalation: Escalation | null;
  lastStep: number;
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
    const stepLine = turn.answer
      .split('\n')
      .find((line) => /手順\s*[0-9０-９]+\s*[:：]/u.test(line));
    lines.push(`- ${stepLine?.trim() ?? `手順${String(turn.step)}`}`);
    const next = state.turns[index + 1];
    if (next !== undefined) lines.push(`  → 結果: ${next.message}`);
  });
  return lines.join('\n');
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
  const maxSteps = options.maxSteps ?? 6;
  const sessions = new Map<string, SessionState>();

  async function escalate(state: SessionState, reason: Escalation['reason']): Promise<void> {
    state.status = 'escalated';
    state.escalation = { reason, summary: summaryOf(state) };
    await options.notifyExpert?.(snapshot(state));
  }

  async function turn(
    state: SessionState | null,
    technician: string,
    message: string,
  ): Promise<{ state: SessionState; turn: DiagnosisTurn }> {
    // The agent's grants are per agent, not per person, so the backend names the signed-in
    // technician in the prompt and checks that the log records the same person.
    const prompt = state === null ? `［対応者: ${technician}］${message}` : message;
    const reading = await runAndRead(aw, agentId, {
      prompt,
      sessionId: state?.sessionId ?? null,
    });
    const current: SessionState = state ?? {
      sessionId: reading.run.sessionId,
      technician,
      status: 'diagnosing',
      turns: [],
      escalation: null,
      lastStep: 0,
    };
    const inspection = inspectTurn({
      answer: reading.answer,
      toolCalls: reading.toolCalls,
      first: state === null,
      previousStep: current.lastStep,
      technician,
    });
    const result: DiagnosisTurn = {
      ...inspection,
      sessionId: current.sessionId,
      runId: reading.run.id,
      message,
      answer: reading.answer,
      ok: inspection.violations.length === 0,
    };
    current.turns.push(result);
    if (result.step !== null) current.lastStep = result.step;

    if (result.kind === 'escalation') {
      await escalate(current, 'agent');
    } else if (result.kind === 'resolution' && result.logged !== null) {
      current.status = 'resolved';
    } else if (result.kind === 'step' && (result.step ?? 0) > maxSteps) {
      await escalate(current, 'step-limit');
    }
    return { state: current, turn: result };
  }

  return {
    async start(input) {
      const technician = requireText(input.technician, 'technician', TECHNICIAN_MAX);
      const message = requireText(input.message, 'message', MESSAGE_MAX);
      const { state, turn: first } = await turn(null, technician, message);
      sessions.set(state.sessionId, state);
      return first;
    },
    async reply(sessionId, rawMessage) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
      if (state.status !== 'diagnosing') {
        throw new DiagnosisError('session_closed', `this session is ${state.status}`);
      }
      const message = requireText(rawMessage, 'message', MESSAGE_MAX);
      return (await turn(state, state.technician, message)).turn;
    },
    session(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
      return snapshot(state);
    },
  };
}
