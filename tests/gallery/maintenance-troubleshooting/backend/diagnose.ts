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
import { z } from 'zod';

import { parseCitations, type Citation } from '../../shared/citations.ts';
import {
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type RunReading,
  type ToolCall,
} from '../../shared/run-answer.ts';
import { fileScopeFor, loadAccess, type Access } from './scope.ts';

const STEP = /手順\s*([0-9０-９]+)\s*[:：]/gu;
const MESSAGE_MAX = 500;
const TECHNICIAN_MAX = 40;

/** What one run returns: the reply the technician reads, and the same turn as fields. */
export const TurnAnswerSchema = z.object({
  reply: z.string().min(1).describe('技術者に表示する返答の全文'),
  kind: z
    .enum(['step', 'resolution'])
    .describe(
      'step: 手順を1つ出す（熟練者に引き継ぐターンも step、step は null）／resolution: 解決して記録した',
    ),
  step: z
    .object({
      number: z.number().int().min(1).describe('手順の番号（前の手順+1）'),
      instruction: z.string().min(1).describe('技術者にやってもらう確認・作業を1つ'),
      citations: z
        .array(z.string())
        .describe('この手順の出典。〔〕の中の文字列（例: 過去トラ T-0001）'),
    })
    .nullable()
    .describe('kind が step のときの手順。それ以外は null'),
  citations: z
    .array(z.string())
    .describe('返答で使った出典すべて。〔〕の中の文字列（安全措置の出典を含む）'),
});

export type TurnAnswer = z.infer<typeof TurnAnswerSchema>;

/** What the turn was: the agent's own `kind`, or `escalation` when the run ended in a handoff. */
export type TurnKind = TurnAnswer['kind'] | 'escalation';

export type Violation =
  /** The session's first answer does not say to stop the machine and apply LOTO. */
  | 'missing-safety'
  /** A step turn that carries no step. */
  | 'no-step'
  /** More than one 手順N： in the reply, or a step next to an escalation or resolution. */
  | 'multiple-steps'
  /** The step has no 〔…〕 source. */
  | 'uncited-step'
  /** A 〔…〕 that no tool returned in this run. */
  | 'unverified-citation'
  /** 手順N： where N is not the previous step plus one. */
  | 'step-out-of-order'
  /** 【解決】 without a successful logResolution call in the same run. */
  | 'resolution-not-logged';

export interface LoggedResolution {
  readonly id: string;
  readonly machineId: string;
  readonly cause: string;
  readonly action: string;
  readonly technician: string;
}

export interface TurnInspection {
  readonly kind: TurnKind;
  /** The step number this answer gives, or null when it gives none. */
  readonly step: number | null;
  /** What the technician is asked to do in this step, or null when it gives none. */
  readonly instruction: string | null;
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

const citationsOf = (texts: readonly string[]): Citation[] =>
  texts.flatMap((text) => parseCitations(`〔${text.replace(/^〔|〕$/gu, '')}〕`));

/**
 * Check one answer against the rules above. Pure: what the agent answered, what its tools returned
 * in the run, and what the session knows (first turn or not, the last step, the technician).
 */
export function inspectTurn(input: {
  readonly answer: TurnAnswer;
  readonly toolCalls: readonly ToolCall[];
  readonly first: boolean;
  readonly previousStep: number;
  /** The reason of the run's `agent.handoff` frame, or null when the agent did not hand off. */
  readonly handoff: string | null;
}): TurnInspection {
  const { answer, toolCalls } = input;
  const { reply } = answer;
  const kind: TurnKind = input.handoff === null ? answer.kind : 'escalation';
  const violations: Violation[] = [];

  if (input.first && !(/停止/u.test(reply) && /LOTO|ロックアウト/u.test(reply))) {
    violations.push('missing-safety');
  }

  const marked = [...reply.matchAll(STEP)].length;
  if (kind === 'step' && answer.step === null) violations.push('no-step');
  if (marked > 1 || (kind !== 'step' && (answer.step !== null || marked > 0))) {
    violations.push('multiple-steps');
  }

  const step = answer.step?.number ?? null;
  if (kind === 'step' && answer.step !== null) {
    if (citationsOf(answer.step.citations).length === 0) violations.push('uncited-step');
    if (answer.step.number !== input.previousStep + 1) violations.push('step-out-of-order');
  }

  const returned = new Set(
    toolCalls
      .filter((call) => !call.isError && call.output !== null)
      .flatMap((call) => parseCitations(call.output ?? '').map((citation) => citation.raw)),
  );
  // A source named only in the reply text counts too: the schema must not be a way around the check.
  const citations = [
    ...new Map(
      [
        ...citationsOf(answer.citations),
        ...citationsOf(answer.step?.citations ?? []),
        ...parseCitations(reply),
      ].map((citation) => [citation.raw, citation] as const),
    ).values(),
  ];
  const unverified = citations.filter((citation) => !returned.has(citation.raw));
  if (unverified.length > 0) violations.push('unverified-citation');

  let logged: LoggedResolution | null = null;
  if (kind === 'resolution') {
    const call = toolCalls.find((each) => toolIs(each.name, 'logResolution') && !each.isError);
    logged = call === undefined ? null : asLogged(call);
    if (logged === null) violations.push('resolution-not-logged');
  }

  return {
    kind,
    step,
    instruction: answer.step?.instruction ?? null,
    citations,
    unverified,
    logged,
    violations,
  };
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
  const access = options.access ?? loadAccess();
  const sessions = new Map<string, SessionState>();

  async function escalate(state: SessionState, reason: Escalation['reason']): Promise<void> {
    state.status = 'escalated';
    state.escalation = { reason, summary: summaryOf(state) };
    await options.notifyExpert?.(snapshot(state));
  }

  /** Read the run `read` follows as the session's next turn, or answer the pause it ended in. */
  async function settle(
    state: SessionState | null,
    technician: string,
    message: string,
    read: () => Promise<RunReading<TurnAnswer>>,
  ): Promise<{ state: SessionState; turn: DiagnosisTurn | AwaitingApproval }> {
    const opened = (sessionId: string): SessionState =>
      state ?? {
        sessionId,
        technician,
        status: 'diagnosing',
        turns: [],
        escalation: null,
        lastStep: 0,
        awaiting: null,
      };
    let reading;
    try {
      reading = await read();
    } catch (error) {
      if (!(error instanceof RunAwaitingApproval)) throw error;
      const paused = opened(error.pending.sessionId);
      paused.awaiting = error.pending;
      return { state: paused, turn: error.pending };
    }
    const current = opened(reading.run.sessionId);
    const inspection = inspectTurn({
      answer: reading.output,
      toolCalls: reading.toolCalls,
      first: state === null,
      previousStep: current.lastStep,
      handoff: reading.handoff,
    });
    const result: DiagnosisTurn = {
      ...inspection,
      sessionId: current.sessionId,
      runId: reading.run.id,
      message,
      reply: reading.output.reply,
      handoff: reading.handoff,
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
      const state = sessions.get(sessionId);
      if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
      if (state.status !== 'diagnosing') {
        throw new DiagnosisError('session_closed', `this session is ${state.status}`);
      }
      const message = requireText(rawMessage, 'message', MESSAGE_MAX);
      return (await turn(state, state.technician, message, photo)).turn;
    },
    async approve(sessionId, decision) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
      const { awaiting } = state;
      if (awaiting === null) {
        throw new DiagnosisError('nothing_to_approve', 'this session is not waiting for approval');
      }
      const input = decision.comment === undefined ? {} : { comment: decision.comment };
      const { run } = decision.approve
        ? await aw.runs.approve(awaiting.runId, input)
        : await aw.runs.reject(awaiting.runId, input);
      state.awaiting = null;
      // What the platform tells the continuation (ADR-0145 D2.2).
      const verdict = decision.approve ? 'approved' : 'rejected';
      const message = decision.comment === undefined ? verdict : `${verdict}: ${decision.comment}`;
      return (
        await settle(state, state.technician, message, () => readRun(aw, run.id, TurnAnswerSchema))
      ).turn;
    },
    session(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) throw new DiagnosisError('unknown_session', 'no such session');
      return snapshot(state);
    },
  };
}
