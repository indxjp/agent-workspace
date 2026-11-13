/**
 * The pure check of one diagnosis turn (`./diagnose.ts` explains the rules): one function per rule
 * (safety, step shape, citations, logged resolution) and {@link inspectTurn}, which runs them in
 * order.
 */
import { z } from 'zod';

import { parseCitations, type Citation } from '../../shared/citations.ts';
import type { ToolCall } from '../../shared/run-answer.ts';

const STEP = /手順\s*([0-9０-９]+)\s*[:：]/gu;

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

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

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

/** (a) The session's first answer says to stop the machine and lock it out. */
function safetyViolations(reply: string, first: boolean): Violation[] {
  return first && !(/停止/u.test(reply) && /LOTO|ロックアウト/u.test(reply))
    ? ['missing-safety']
    : [];
}

/** (b) Exactly one step on a step turn, none elsewhere; the step is cited and follows the last. */
function stepViolations(answer: TurnAnswer, kind: TurnKind, previousStep: number): Violation[] {
  const violations: Violation[] = [];
  const marked = [...answer.reply.matchAll(STEP)].length;
  if (kind === 'step' && answer.step === null) violations.push('no-step');
  if (marked > 1 || (kind !== 'step' && (answer.step !== null || marked > 0))) {
    violations.push('multiple-steps');
  }
  if (kind === 'step' && answer.step !== null) {
    if (citationsOf(answer.step.citations).length === 0) violations.push('uncited-step');
    if (answer.step.number !== previousStep + 1) violations.push('step-out-of-order');
  }
  return violations;
}

/** (c) Every source the answer names, and those no tool returned in the run. */
function checkCitations(
  answer: TurnAnswer,
  toolCalls: readonly ToolCall[],
): { citations: Citation[]; unverified: Citation[] } {
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
        ...parseCitations(answer.reply),
      ].map((citation) => [citation.raw, citation] as const),
    ).values(),
  ];
  return { citations, unverified: citations.filter((citation) => !returned.has(citation.raw)) };
}

/** The resolution a successful `logResolution` call in the run wrote, or null. */
function loggedResolution(toolCalls: readonly ToolCall[]): LoggedResolution | null {
  const call = toolCalls.find((each) => toolIs(each.name, 'logResolution') && !each.isError);
  return call === undefined ? null : asLogged(call);
}

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
  const kind: TurnKind = input.handoff === null ? answer.kind : 'escalation';
  const { citations, unverified } = checkCitations(answer, toolCalls);
  const logged = kind === 'resolution' ? loggedResolution(toolCalls) : null;
  const violations: Violation[] = [
    ...safetyViolations(answer.reply, input.first),
    ...stepViolations(answer, kind, input.previousStep),
    ...(unverified.length > 0 ? (['unverified-citation'] as const) : []),
    ...(kind === 'resolution' && logged === null ? (['resolution-not-logged'] as const) : []),
  ];

  return {
    kind,
    step: answer.step?.number ?? null,
    instruction: answer.step?.instruction ?? null,
    citations,
    unverified,
    logged,
    violations,
  };
}
