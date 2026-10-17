/**
 * The quality system's backend call: hand a new defect to the quality-defect agent and get back an
 * 8D draft that has been checked before anyone at the design review (DR) reads it.
 *
 * Three checks turn a fluent draft into one a reviewer can trust:
 *
 * 1. **Format** — the eight-d skill's parser (`eightd.mjs`, imported through its `.d.mts`):
 *    D1–D8 present, a なぜなぜ chain at least three deep, every D4 claim cited.
 * 2. **Grounding** — every 〔過去トラ Q-xxxx〕 the draft cites must be a case `search_defects` or
 *    `get_defect` returned in this run, and the quoted 4M counts must equal a `cause_stats` result
 *    of this run. A model can write a plausible Q-number or a plausible 「機械 3件」; neither passes.
 * 3. **Recurrence** — computed here, not taken from the prose: a matched past case with the same
 *    原因区分 whose 再発有無 is 有 marks the defect as a recurrence (再発) for the DR agenda.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';
import {
  FOUR_M,
  parseEightD,
  type EightDDraft,
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

/** A past case as `search_defects` returns it. */
export interface PastCase {
  readonly id: string;
  readonly partNo: string;
  readonly process: string;
  readonly phenomenon: string;
  readonly causeCode: string;
  readonly fourM: FourM;
  readonly recurred: '有' | '無';
}

/** What `search_defects` returns when no past case matches: the answer to give, word for word. */
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

export interface DefectAnalysis {
  readonly answer: string;
  readonly draft: EightDDraft;
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
  readonly sessionId: string;
}

/** The safe error the quality system shows when the entered defect is not usable. */
export class InvalidDefectReport extends Error {
  public constructor(public readonly fields: readonly string[]) {
    super(`invalid defect report: ${fields.join(', ')}`);
    this.name = 'InvalidDefectReport';
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

function checkFourM(draft: EightDDraft, computed: readonly CauseStats[]): FourMCheck {
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
 * Run the agent on `input` and check its draft.
 *
 * @throws {InvalidDefectReport} before any run when the entered defect is incomplete.
 */
export async function analyseDefect(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: NewDefect,
  sessionId?: string,
): Promise<DefectAnalysis> {
  validate(input);
  return checkRun(aw, agentId, promptOf(input), sessionId);
}

/**
 * Send a DR reviewer's comment back as the next turn of the same conversation, and check the
 * revised draft the same way. The DR is a meeting after the run, so nothing has to pause.
 */
export async function reviseAfterReview(
  aw: AgentWorkspaceClient,
  agentId: string,
  sessionId: string,
  comment: string,
): Promise<DefectAnalysis> {
  if (comment.trim() === '' || comment.length > 4000) throw new InvalidDefectReport(['comment']);
  return checkRun(
    aw,
    agentId,
    `DR指摘: ${comment.trim()}\n指摘を反映した8D下書き全文を出し直してください。`,
    sessionId,
  );
}

async function checkRun(
  aw: AgentWorkspaceClient,
  agentId: string,
  prompt: string,
  sessionId: string | undefined,
): Promise<DefectAnalysis> {
  const reading = await runAndRead(aw, agentId, { prompt, sessionId: sessionId ?? null });
  const draft = parseEightD(reading.answer);

  const matched = new Map<string, PastCase>();
  // A search with no match returns `{ noMatch: true, message }`, not an array.
  for (const hits of outputsOf<PastCase[] | NoMatch>(reading.toolCalls, 'search_defects')) {
    if (Array.isArray(hits)) for (const hit of hits) matched.set(hit.id, hit);
  }
  const returned = new Set([
    ...matched.keys(),
    ...outputsOf<{ id: string }>(reading.toolCalls, 'get_defect').map((record) => record.id),
  ]);
  const unverifiedCases = draft.cites.filter((id) => !returned.has(id));
  const fourM = checkFourM(draft, outputsOf<CauseStats>(reading.toolCalls, 'cause_stats'));

  const sameCause = [...matched.values()].filter(
    (hit) => draft.causeCode !== null && hit.causeCode === draft.causeCode,
  );
  const recurredCases = sameCause.filter((hit) => hit.recurred === '有').map((hit) => hit.id);

  const findings = [
    ...draft.issues.map((issue) => issue.message),
    ...unverifiedCases.map((id) => `${id} はこの実行で検索・参照されていない`),
    ...(fourM.status === 'missing' ? ['4M集計の行がない'] : []),
    ...(fourM.status === 'mismatch' ? [`4M集計が cause_stats と一致しない: ${fourM.quoted}`] : []),
  ];
  return {
    answer: reading.answer,
    draft,
    matched: [...matched.values()],
    unverifiedCases,
    fourM,
    recurrence: {
      causeCode: draft.causeCode,
      sameCause: sameCause.map((hit) => hit.id).sort(),
      recurredCases: recurredCases.sort(),
      recurring: recurredCases.length > 0,
    },
    readyForReview: findings.length === 0,
    findings,
    sessionId: reading.run.sessionId,
  };
}
