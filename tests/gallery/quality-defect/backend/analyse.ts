/**
 * The quality system's backend call: hand a new defect to the quality-defect agent and get back an
 * 8D draft that has been checked before anyone at the design review (DR) reads it, and registered
 * as a 過去トラ only when the DR approves it.
 *
 * One run chain. The agent searches, reads, counts, writes the 8D and ends it (D8) by calling
 * `createCase` with the report. That call is gated (ADR-0145), so the run pauses on it and
 * nothing is registered: `analyseDefect` answers the pause with the checked draft. The DR decides
 * with `decideCase`: approving starts a continuation under the same `subject` (ADR-0157) that makes
 * the same call and registers the case; rejecting with the DR's comment sends it back to the agent,
 * and the revised 8D pauses again. A run that ends without a draft (no similar case) never pauses.
 *
 * Three checks turn a fluent draft into one a reviewer can trust:
 *
 * 1. **Format** — the eight-d skill's checks (`checkEightD` in `eightd.mjs`, imported through its
 *    `.d.mts`): D1–D8 present, a なぜなぜ chain at least three deep, every D4 claim cited. The
 *    paused call carries the report, which the skill's own parser (`parseEightD`) splits into parts;
 *    a run that ends returns the parts as structured output (`EightDAnswerSchema`). `draft` is
 *    `null` when the agent writes no draft (no match).
 * 2. **Grounding** — every 〔過去トラ Q-xxxx〕 the draft cites must be a case `searchDefects` or
 *    `getDefect` returned in this run, and the quoted 4M counts must equal a `causeStats` result
 *    of this run. A model can write a plausible Q-number or a plausible 「機械 3件」; neither passes.
 * 3. **Recurrence** — computed here, not taken from the prose: a matched past case with the same
 *    原因区分 whose 再発有無 is 有 marks the defect as a recurrence (再発) for the DR agenda.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  pendingCall,
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type RunReading,
  type ToolCall,
} from '../../shared/run-answer.ts';
import {
  checkEightD,
  citedCases,
  FOUR_M,
  parseEightD,
  type EightDDraft,
  type EightDStructure,
  type FourM,
} from '../skills/eight-d/scripts/eightd.mjs';

export const PROCESSES = ['プレス', '溶接', '塗装', '組立'] as const;
export type Process = (typeof PROCESSES)[number];

/** What QA enters for a new defect. */
export interface NewDefect {
  readonly phenomenon: string;
  readonly partNo: string;
  readonly lot: string;
  readonly process: Process;
  readonly count: number;
  /** Free-text detail: dimensions, where on the part, what has been checked already. */
  readonly detail?: string;
}

/** A past case as `searchDefects` returns it. */
export interface PastCase {
  readonly id: string;
  readonly partNo: string;
  readonly process: string;
  readonly phenomenon: string;
  readonly causeCode: string;
  readonly fourM: FourM;
  readonly recurred: '有' | '無';
}

/** What `searchDefects` returns when no past case matches: the answer to give, word for word. */
export interface NoMatch {
  readonly noMatch: true;
  readonly message: string;
}

export interface CauseStats {
  readonly matched: number;
  readonly fourM: Readonly<Record<FourM, number>>;
  readonly line: string;
}

export type FourMCheck =
  | { readonly status: 'verified'; readonly stats: CauseStats }
  | { readonly status: 'mismatch'; readonly quoted: string; readonly computed: readonly string[] }
  | { readonly status: 'missing' };

const caseId = z.string().regex(/^Q-\d{4}$/u);
const cites = z.array(caseId).describe('引用した過去トラ番号（Q-1234）');

/** The draft split into the parts `checkEightD` checks: what `eightd.mjs` prints for a draft. */
export const EightDStructureSchema = z.object({
  title: z.string().nullable(),
  sections: z.array(
    z.object({
      id: z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']),
      title: z.string(),
      body: z.string(),
      cites,
    }),
  ),
  whys: z.array(z.object({ depth: z.number().int(), text: z.string(), cites })),
  claims: z
    .array(z.object({ text: z.string(), cites }))
    .describe('D4 の各なぜ・箇条書き・根本原因の行'),
  rootCause: z.object({ text: z.string(), cites }).nullable(),
  causeCode: z.string().nullable().describe('D4 の原因区分'),
  fourM: z
    .object({
      counts: z.partialRecord(z.enum(['人', '機械', '材料', '方法']), z.number().int()),
      total: z.number().int().nullable(),
      line: z.string(),
    })
    .nullable()
    .describe('D4 の 4M集計の行。causeStats の結果をそのまま写す'),
}) satisfies z.ZodType<EightDStructure>;

/** What a run returns: the report a person reads, and its parts. `draft` is null for no match. */
export const EightDAnswerSchema = z.object({
  report: z.string().min(1).describe('8Dレポートの全文。類似する過去トラがないときは定型文だけ'),
  draft: EightDStructureSchema.nullable().describe(
    '`eightd.mjs` が返す構造。8Dを書かなかったとき（類似なし）は null',
  ),
});

/** What the checks say about a draft; the same whether the run paused on it or ended with it. */
interface Assessment {
  readonly answer: string;
  /** The checked draft; null when the agent wrote none (no similar past case). */
  readonly draft: EightDDraft | null;
  /** Past cases the agent's searches returned in this run, by id. */
  readonly matched: readonly PastCase[];
  /** Q-numbers the draft cites that no tool returned in this run. */
  readonly unverifiedCases: readonly string[];
  readonly fourM: FourMCheck;
  /** Matched cases with the draft's 原因区分; `recurring` when one of them recurred (再発有無 = 有). */
  readonly recurrence: {
    readonly causeCode: string | null;
    readonly sameCause: readonly string[];
    readonly recurredCases: readonly string[];
    readonly recurring: boolean;
  };
  /** True when the draft passes all three checks and may go on the DR agenda. */
  readonly readyForReview: boolean;
  /** Why it is not ready, one line each, for the reviewer. */
  readonly findings: readonly string[];
}

/** A run that ended without asking for a registration: no similar case, or a draft nobody can approve. */
export interface DefectAnalysis extends Assessment {
  readonly status: 'ended';
  readonly sessionId: string;
}

const caseSchema = z.object({
  title: z.string().min(1),
  partNo: z.string(),
  process: z.enum(PROCESSES),
  lot: z.string(),
  count: z.number().int(),
  cause: z.string().min(1),
  causeCode: z.string().min(1),
  fourM: z.enum(['人', '機械', '材料', '方法']),
  whys: z.array(z.string().min(1)).min(1),
  countermeasure: z.string().min(1),
  horizontalDeployment: z.string().min(1),
  report: z.string().min(1),
});

/** What `createCase` is called with: the case as the QMS will hold it as a 過去トラ. */
export type CaseRegistration = z.infer<typeof caseSchema>;

/** The paused call's input: an OpenAPI tool takes the request body as `body`. */
const createCaseInput = z.object({ body: caseSchema });

/** The run paused on registering the case; decide it with {@link decideCase}. */
export interface DefectAwaiting extends Assessment, AwaitingApproval {
  /** The call the DR approves, validated: the 8D report and the fields registered with it. */
  readonly registration: CaseRegistration;
  readonly defect: NewDefect;
}

export interface CaseRegistered {
  readonly status: 'registered';
  /** The 過去トラ number the QMS gave the case. */
  readonly caseId: string;
  readonly registration: CaseRegistration;
  readonly answer: string;
  readonly sessionId: string;
}

export interface CaseRefused {
  readonly status: 'refused';
  readonly problems: readonly string[];
  /** The run the refusal is about; one still paused can be rejected with `runs.reject`. */
  readonly runId: string;
  readonly sessionId: string;
}

export type CaseOutcome = DefectAwaiting | DefectAnalysis | CaseRegistered | CaseRefused;

/** The safe error the quality system shows when the entered defect is not usable. */
export class InvalidDefectReport extends Error {
  public constructor(public readonly fields: readonly string[]) {
    super(`invalid defect report: ${fields.join(', ')}`);
    this.name = 'InvalidDefectReport';
  }
}

/** The safe error when a DR approval is asked for a draft whose checks failed. */
export class DraftNotReady extends Error {
  public constructor(public readonly findings: readonly string[]) {
    super(`draft not ready: ${findings.join(', ')}`);
    this.name = 'DraftNotReady';
  }
}

const PART_NO = /^[A-Z]{3}-\d{4}$/u;

function validate(input: NewDefect): void {
  const bad: string[] = [];
  const filled = (value: unknown, max: number): boolean =>
    typeof value === 'string' && value.trim() !== '' && value.length <= max;
  if (!filled(input.phenomenon, 100)) bad.push('phenomenon');
  if (typeof input.partNo !== 'string' || !PART_NO.test(input.partNo)) bad.push('partNo');
  if (!filled(input.lot, 40)) bad.push('lot');
  if (!(PROCESSES as readonly string[]).includes(input.process)) bad.push('process');
  if (!Number.isInteger(input.count) || input.count < 1) bad.push('count');
  if (input.detail !== undefined && !filled(input.detail, 2000)) bad.push('detail');
  if (bad.length > 0) throw new InvalidDefectReport(bad);
}

/** The prompt the agent sees: the fields QA entered, one per line, nothing else. */
export function promptOf(input: NewDefect): string {
  return [
    '新規不具合の8Dレポート下書きを作成してください。',
    `現象: ${input.phenomenon}`,
    `品番: ${input.partNo}`,
    `ロット: ${input.lot}`,
    `工程: ${input.process}`,
    `発生数: ${String(input.count)}個`,
    ...(input.detail === undefined ? [] : [`詳細: ${input.detail}`]),
  ].join('\n');
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

function outputsOf<T>(calls: readonly ToolCall[], tool: string): T[] {
  return calls
    .filter((call) => toolIs(call.name, tool) && !call.isError && call.output !== null)
    .map((call) => JSON.parse(call.output ?? 'null') as T);
}

function checkFourM(draft: EightDStructure, computed: readonly CauseStats[]): FourMCheck {
  if (draft.fourM === null) return { status: 'missing' };
  const quoted = draft.fourM;
  const same = computed.find(
    (stats) =>
      FOUR_M.every((key) => quoted.counts[key] === stats.fourM[key]) &&
      (quoted.total === null || quoted.total === stats.matched),
  );
  return same === undefined
    ? { status: 'mismatch', quoted: quoted.line, computed: computed.map((stats) => stats.line) }
    : { status: 'verified', stats: same };
}

/**
 * Run the agent on `input` and check its draft. The agent's `createCase` call is gated, so the
 * answer is the pause with the checked draft, to be decided with {@link decideCase}; nothing is
 * registered yet. A run with no similar past case ends `ended` with no draft; a pause on anything
 * but this defect's registration comes back `refused`.
 *
 * @throws {InvalidDefectReport} before any run when the entered defect is incomplete.
 */
export async function analyseDefect(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: NewDefect,
  /** The signed-in person entering the defect, from the QA page's own session; the QMS scopes by it. */
  subject: string,
  sessionId?: string,
): Promise<DefectAwaiting | DefectAnalysis | CaseRefused> {
  validate(input);
  return untilPause(
    runAndRead(
      aw,
      agentId,
      { prompt: promptOf(input), subject, sessionId: sessionId ?? null },
      EightDAnswerSchema,
    ),
    input,
  );
}

const registeredSchema = z.object({ qNo: z.string().regex(/^Q-\d+$/u) });

/**
 * The DR decided the paused registration. Rejecting (with the DR's comment) starts a continuation
 * that revises the 8D, so the answer is the next pause, checked again. Approving starts the
 * continuation that registers the case under the same person; the number the QMS returned is
 * the proof, and a call the QMS refused comes back `refused`.
 *
 * @throws {InvalidDefectReport} when a rejection has no comment.
 * @throws {DraftNotReady} when approving a draft whose checks failed.
 */
export async function decideCase(
  aw: AgentWorkspaceClient,
  awaiting: DefectAwaiting,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<CaseOutcome> {
  const comment = decision.comment?.trim();
  if (!decision.approve) {
    if (comment === undefined || comment === '' || comment.length > 4000) {
      throw new InvalidDefectReport(['comment']);
    }
    const { run } = await aw.runs.reject(awaiting.runId, { comment });
    return untilPause(readRun(aw, run.id, EightDAnswerSchema), awaiting.defect);
  }
  if (!awaiting.readyForReview) throw new DraftNotReady(awaiting.findings);
  const { run } = await aw.runs.approve(awaiting.runId, comment === undefined ? {} : { comment });
  const reading = await readRun(aw, run.id, EightDAnswerSchema);
  const done = { answer: reading.output.report, sessionId: reading.run.sessionId };
  const registered = outputsOf<unknown>(reading.toolCalls, 'createCase')
    .map((output) => registeredSchema.safeParse(output))
    .find((parsed) => parsed.success);
  if (registered === undefined) {
    const call = reading.toolCalls.find((entry) => toolIs(entry.name, 'createCase'));
    return {
      status: 'refused',
      problems: [call?.output ?? 'createCase が実行されていません'],
      runId: reading.run.id,
      sessionId: done.sessionId,
    };
  }
  return {
    status: 'registered',
    caseId: registered.data.qNo,
    registration: awaiting.registration,
    ...done,
  };
}

/** Read a run that should pause on the registration: the next pause, a run that ended, or a refusal. */
async function untilPause(
  reading: Promise<RunReading<z.output<typeof EightDAnswerSchema>>>,
  defect: NewDefect,
): Promise<DefectAwaiting | DefectAnalysis | CaseRefused> {
  try {
    const done = await reading;
    const draft = done.output.draft === null ? null : checkEightD(done.output.draft);
    return {
      status: 'ended',
      ...assess(done.output.report, draft, done.toolCalls, false),
      sessionId: done.run.sessionId,
    };
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return awaitingFrom(error.pending, defect);
  }
}

/** The registration in the call the run is paused on, checked before the DR is asked to approve it. */
function awaitingFrom(paused: AwaitingApproval, defect: NewDefect): DefectAwaiting | CaseRefused {
  const refuse = (problems: string[]): CaseRefused => ({
    status: 'refused',
    problems,
    runId: paused.runId,
    sessionId: paused.sessionId,
  });
  const { name, input } = pendingCall(paused.call);
  if (!toolIs(name, 'createCase')) return refuse([`${name} が createCase ではなく止まった`]);
  const parsed = createCaseInput.safeParse(input);
  if (!parsed.success) {
    return refuse(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }
  const registration = parsed.data.body;
  const differing = (['partNo', 'process', 'lot', 'count'] as const).filter(
    (key) => registration[key] !== defect[key],
  );
  if (differing.length > 0) return refuse(differing.map((key) => `${key} が入力した不具合と違う`));
  return {
    ...paused,
    ...assess(registration.report, parseEightD(registration.report), paused.toolCalls, true),
    registration,
    defect,
  };
}

/** The three checks on a draft and what the run's tools returned; `asked` is whether it paused for the DR. */
function assess(
  report: string,
  draft: EightDDraft | null,
  toolCalls: readonly ToolCall[],
  asked: boolean,
): Assessment {
  const matched = new Map<string, PastCase>();
  // A search with no match returns `{ noMatch: true, message }`, not an array.
  for (const hits of outputsOf<PastCase[] | NoMatch>(toolCalls, 'searchDefects')) {
    if (Array.isArray(hits)) for (const hit of hits) matched.set(hit.id, hit);
  }
  const returned = new Set([
    ...matched.keys(),
    ...outputsOf<{ id: string }>(toolCalls, 'getDefect').map((record) => record.id),
  ]);
  // A case named only in the report text counts too: the reviewer reads the report, not the structure.
  const cited = [...new Set([...(draft?.cites ?? []), ...citedCases(report)])];
  const unverifiedCases = cited.filter((id) => !returned.has(id));
  const fourM: FourMCheck =
    draft === null
      ? { status: 'missing' }
      : checkFourM(draft, outputsOf<CauseStats>(toolCalls, 'causeStats'));

  const causeCode = draft?.causeCode ?? null;
  const sameCause = [...matched.values()].filter(
    (hit) => causeCode !== null && hit.causeCode === causeCode,
  );
  const recurredCases = sameCause.filter((hit) => hit.recurred === '有').map((hit) => hit.id);

  const findings =
    draft === null
      ? ['8D下書きがない（類似する過去トラが見つからなかった）']
      : [
          ...draft.issues.map((issue) => issue.message),
          ...unverifiedCases.map((id) => `${id} はこの実行で検索・参照されていない`),
          ...(fourM.status === 'missing' ? ['4M集計の行がない'] : []),
          ...(fourM.status === 'mismatch'
            ? [`4M集計が causeStats と一致しない: ${fourM.quoted}`]
            : []),
          ...(asked ? [] : ['DR の承認を求めていない（createCase を呼んでいない）']),
        ];
  return {
    answer: report,
    draft,
    matched: [...matched.values()],
    unverifiedCases,
    fourM,
    recurrence: {
      causeCode,
      sameCause: sameCause.map((hit) => hit.id).sort(),
      recurredCases: recurredCases.sort(),
      recurring: recurredCases.length > 0,
    },
    readyForReview: findings.length === 0,
    findings,
  };
}
