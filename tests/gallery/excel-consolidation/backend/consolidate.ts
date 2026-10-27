/**
 * Corporate planning's backend: one run with the excel-consolidation agent, and a person's approval
 * in the middle of it (ADR-0145).
 *
 * Every run starts for the signed-in person with `fileScope`: the branch folders that
 * person may see in `data/access.json`. The agent's built-in `search_files` and its sandbox then
 * cover those folders only. A person with no folder gets no run at all (an empty scope is invalid).
 *
 * The agent finds the branch workbooks, inspects them and writes its mapping plan to
 * `outputs/plan.json` with `Write`, which the agent definition holds for approval
 * (`requireApproval`). The run stops there, `awaiting_approval`, and `proposePlan` reads the plan
 * from the pending call. The backend validates it before a person sees it: every workbook the agent
 * found is either mapped or excluded with a reason, nothing is mapped that was not found, every
 * required field has a column, and every unit and date format is stated, not left to a guess.
 *
 * The approval is bound to that exact call. `approvePlan` lets the agent write the plan the person
 * saw and nothing else, and the continuation (same session) runs the script and explains. The
 * backend does not take the explanation on trust. It recomputes every total and change from the
 * script's rows, checks each row's `@src` points into a planned file, and refuses an explanation
 * that quotes a number the script did not produce. `rejectPlan` sends the person's comment back;
 * the agent writes a revised plan, which pauses again.
 *
 * The run asks for structured output (`ReportAnswerSchema`), so the report is not parsed out of the
 * agent's prose; the checks above are what the backend still owns. The consolidated workbook is the
 * agent's own file: it writes `outputs/consolidated-<to>.xlsx`, the backend collects it with
 * `runs.outputs` and `files.download`, and accepts it only when its sheets hold what the (already
 * checked) report does.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  pendingCall,
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
} from '../../shared/run-answer.ts';
import { readXlsx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  workbookSpec,
  type DateFormat,
  type Layout,
  type Report,
  type Unit,
} from '../skills/excel-consolidate/scripts/consolidate.mjs';

export interface MappingPlan {
  readonly from: string;
  readonly to: string;
  readonly layouts: readonly Layout[];
  readonly excluded: readonly { readonly file: string; readonly reason: string }[];
}

/** One line of the plan as the person confirming it sees it. */
export interface PlanLine {
  readonly file: string;
  readonly branch: string;
  readonly sheet: string;
  readonly headerRows: string;
  readonly columns: string;
  readonly unit: Unit;
  readonly dateFormat: DateFormat;
}

export interface PlanProposal {
  /** The paused run: the person's decision goes to it. */
  readonly runId: string;
  readonly sessionId: string;
  /** The signed-in person the run is for. */
  readonly subject: string;
  /** The folders the run was scoped to; the continuation keeps the same grants. */
  readonly fileScope: readonly string[];
  /** The `.xlsx` paths `search_files` returned during the run. */
  readonly found: readonly string[];
  readonly plan: MappingPlan | null;
  readonly lines: readonly PlanLine[];
  /** Why the plan cannot be shown for approval; empty when it can. */
  readonly problems: readonly string[];
}

export interface Consolidation {
  readonly status: 'accepted' | 'refused';
  readonly explanation: string;
  readonly report: Report;
  /** The workbook the agent wrote to `outputs/`, as the run returns it; `null` when it wrote none. */
  readonly workbook: { readonly name: string; readonly bytes: Uint8Array } | null;
  /** Totals or changes the agent's report states that its own rows do not add up to. */
  readonly mismatches: readonly string[];
  /** Numbers the explanation quotes that appear nowhere in the script's output. */
  readonly ungrounded: readonly string[];
  readonly sessionId: string;
}

/** Who may see which top-level folders of the file store: `data/access.json`. */
export type AccessList = Readonly<Record<string, { readonly folders: readonly string[] }>>;

/** The person has no folder they may search; no run was started. */
export class NoAccessibleFiles extends Error {
  public constructor(subject: string) {
    super(`${subject} may not see any branch folder, so no run was started`);
    this.name = 'NoAccessibleFiles';
  }
}

/** The `fileScope` for `subject`: the folders they may see, refused when there are none. */
export function fileScopeFor(subject: string, access: AccessList): string[] {
  const folders = access[subject]?.folders ?? [];
  if (folders.length === 0) throw new NoAccessibleFiles(subject);
  return [...folders];
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const nonEmpty = (what: string) => z.string().min(1).describe(what);
const column = (what: string) =>
  z
    .string()
    .regex(/^[A-Z]{1,3}$/u)
    .describe(`${what}の列（A、B、AA のような英大文字）`);
const month = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/u)
    .describe(`${what}（YYYY-MM）`);

/** A workbook layout as the agent reads it. A unit or date format it cannot state is `null`, never a guess. */
const LayoutSchema = z.object({
  branch: nonEmpty('拠点名'),
  files: z.array(nonEmpty('ファイルのパス（search_files が返したもの）')).min(1),
  sheet: nonEmpty('シート名'),
  headerRows: z.array(z.number().int().min(1)).min(1).describe('見出し行（1始まり）'),
  columns: z.object({
    date: column('日付'),
    category: column('区分'),
    amount: column('金額'),
  }),
  unit: z.enum(['円', '千円', '百万円']).nullable().describe('金額の単位。明示できなければ null'),
  dateFormat: z
    .enum(['wareki', 'ymd', 'serial'])
    .nullable()
    .describe('日付の形式。明示できなければ null'),
  skip: z.array(nonEmpty('除外する行の先頭文字列')).optional().describe('小計・合計・注記など'),
});

export const MappingPlanSchema = z.object({
  from: month('前月'),
  to: month('今月'),
  layouts: z.array(LayoutSchema).min(1),
  excluded: z
    .array(z.object({ file: nonEmpty('除外するファイル'), reason: nonEmpty('除外する理由') }))
    .describe('集計に使わないブック。なければ空配列'),
});

const ChangeSchema = z.object({
  previous: z.number(),
  current: z.number(),
  diff: z.number(),
  pct: z.number().nullable(),
});

/** The script's `compare` output, as the agent pastes it. */
export const ReportSchema = z.object({
  branches: z.array(z.string()),
  rows: z.array(
    z.object({
      branch: z.string(),
      date: z.string(),
      month: z.string(),
      category: z.string().nullable(),
      amount: z.number(),
      raw: z.object({ amount: z.number(), unit: z.enum(['円', '千円', '百万円']) }),
      '@src': z.object({ date: z.string(), category: z.string(), amount: z.string() }),
    }),
  ),
  totals: z.record(z.string(), z.record(z.string(), z.number())),
  skipped: z.array(z.object({ src: z.string(), reason: z.string(), text: z.string() })),
  comparison: z.object({
    from: z.string(),
    to: z.string(),
    branches: z.array(ChangeSchema.extend({ branch: z.string() })),
    total: ChangeSchema,
  }),
}) satisfies z.ZodType<Report>;

/** The run's answer once the plan is approved: the script's report, unchanged, and the explanation written from it. */
export const ReportAnswerSchema = z.object({
  explanation: z.string().describe('スクリプトの出力だけから書いた説明'),
  report: ReportSchema.describe('report.json の内容そのまま。数値を書き換えない'),
});

/**
 * Check a plan the agent proposed against the workbooks it found. Returns the plan only when
 * there is no problem: a plan with a problem is never shown as ready to confirm. The schema has
 * settled the shape; what is left is what it cannot say.
 */
export function validatePlan(
  value: z.output<typeof MappingPlanSchema>,
  found: readonly string[],
): { plan: MappingPlan | null; problems: string[] } {
  const problems: string[] = [];
  const { from, to, excluded } = value;
  if (from >= to) problems.push('from は to より前の月にする');
  const layouts: Layout[] = [];
  value.layouts.forEach(({ unit, dateFormat, skip, ...layout }, index) => {
    const at = `layouts[${String(index)}]`;
    if (unit === null) problems.push(`${at}: 単位（unit）が明示されていない`);
    if (dateFormat === null) problems.push(`${at}: 日付の形式（dateFormat）が明示されていない`);
    if (unit !== null && dateFormat !== null)
      layouts.push({ ...layout, ...(skip === undefined ? {} : { skip }), unit, dateFormat });
  });

  // Every found workbook is accounted for exactly once, and nothing unfound is mapped.
  const named = [
    ...value.layouts.flatMap((layout) => layout.files),
    ...excluded.map((e) => e.file),
  ];
  for (const file of found) {
    const count = named.filter((name) => name === file).length;
    if (count === 0) problems.push(`${file} が計画にも除外にもない`);
    if (count > 1) problems.push(`${file} が計画に2回以上ある`);
  }
  for (const file of new Set(named)) {
    if (!found.includes(file)) problems.push(`${file} は search_files が返していない`);
  }

  if (problems.length > 0) return { plan: null, problems };
  return { plan: { from, to, layouts, excluded }, problems };
}

function linesOf(plan: MappingPlan): PlanLine[] {
  return plan.layouts.flatMap((layout) =>
    layout.files.map((file) => ({
      file,
      branch: layout.branch,
      sheet: layout.sheet,
      headerRows: layout.headerRows.join('–'),
      columns: `日付 ${layout.columns.date} / 区分 ${layout.columns.category} / 金額 ${layout.columns.amount}`,
      unit: layout.unit,
      dateFormat: layout.dateFormat,
    })),
  );
}

/**
 * The monthly run as a schedule trigger (ADR-0144): 09:00 JST on the 1st. A schedule prompt is
 * fixed text (it may not hold `{{body}}`), so the month is the agent's to work out from the files.
 * It asks for the report (`outputSchema`, ADR-0154) and stops at the plan's `Write` for approval. A
 * schedule run has no signed-in person, so the trigger names one as its `subject` (ADR-0156): the
 * planner who owns the monthly close, as your access list knows them. A trigger cannot carry a
 * `fileScope`, so the run searches every folder the agent is granted; {@link proposePlanFromRun}
 * refuses a plan that names a file outside that planner's folders.
 */
export const MONTHLY_TRIGGER = {
  kind: 'schedule',
  name: 'monthly-branch-sales',
  prompt: '先月と今月の拠点別売上を集計して、前月からの増減を説明して',
  cron: '0 9 1 * *',
  timezone: 'Asia/Tokyo',
  outputSchema: ReportAnswerSchema,
  subject: '田村 恵',
} as const;

/** The plan's file, which the agent saves with `Write` and the definition holds for approval. */
const PLAN_FILE = 'outputs/plan.json';

/**
 * Ask for the plan and validate it before anyone is asked to approve it. The run stops at the
 * agent's `Write` of the plan; the person decides with {@link approvePlan} or {@link rejectPlan}.
 */
export async function proposePlan(
  aw: AgentWorkspaceClient,
  agentId: string,
  request: string,
  /** The signed-in person asking, from the planning desk's own session; their folders scope the run. */
  subject: string,
  access: AccessList,
): Promise<PlanProposal> {
  const fileScope = fileScopeFor(subject, access);
  return proposalFrom(
    await untilApproval(
      runAndRead(aw, agentId, { prompt: request, subject, fileScope }, ReportAnswerSchema),
    ),
    subject,
    fileScope,
    [],
  );
}

/**
 * Turn 1 of a run the monthly trigger started: read it and validate its plan as {@link proposePlan}
 * does. `subject` is the trigger's own. The run carried no `fileScope`, so a file it found outside
 * the folders `subject` may see makes the plan unconfirmable; turn 2 runs with their scope.
 */
export async function proposePlanFromRun(
  aw: AgentWorkspaceClient,
  runId: string,
  subject: string,
  access: AccessList,
): Promise<PlanProposal> {
  const fileScope = fileScopeFor(subject, access);
  const proposal = proposalFrom(
    await untilApproval(readRun(aw, runId, ReportAnswerSchema)),
    subject,
    fileScope,
    [],
  );
  const outside = proposal.found.filter(
    (file) => !fileScope.some((folder) => file === folder || file.startsWith(`${folder}/`)),
  );
  if (outside.length === 0) return proposal;
  return {
    ...proposal,
    plan: null,
    lines: [],
    problems: [
      ...proposal.problems,
      ...outside.map((file) => `${file} は ${subject} の閲覧範囲外`),
    ],
  };
}

/** The pause a plan run must reach; a run that finished without asking was never held at the gate. */
async function untilApproval(
  reading: Promise<{ readonly run: { readonly id: string } }>,
): Promise<AwaitingApproval> {
  try {
    const { run } = await reading;
    throw new Error(`run ${run.id} finished without stopping for the plan's approval`);
  } catch (error) {
    if (error instanceof RunAwaitingApproval) return error.pending;
    throw error;
  }
}

function proposalFrom(
  paused: AwaitingApproval,
  subject: string,
  fileScope: readonly string[],
  known: readonly string[],
): PlanProposal {
  const found = [
    ...new Set([
      ...known,
      ...paused.toolCalls
        .filter(
          (call) => toolIs(call.name, 'search_files') && !call.isError && call.output !== null,
        )
        .flatMap((call) => {
          const parsed: unknown = JSON.parse(call.output ?? '[]');
          return Array.isArray(parsed)
            ? parsed.flatMap((hit) => (isRecord(hit) && isText(hit['path']) ? [hit['path']] : []))
            : [];
        })
        .filter((file) => file.toLowerCase().endsWith('.xlsx')),
    ]),
  ].sort();
  const { plan, problems } = readPlan(paused, found);
  return {
    runId: paused.runId,
    sessionId: paused.sessionId,
    subject,
    fileScope,
    found,
    plan,
    lines: plan === null ? [] : linesOf(plan),
    problems,
  };
}

/** The plan in the call the run is paused on; a call that is not the plan's file is a problem. */
function readPlan(
  paused: AwaitingApproval,
  found: readonly string[],
): { plan: MappingPlan | null; problems: string[] } {
  const { name, input } = pendingCall(paused.call);
  const content = input['content'];
  if (name !== 'Write' || input['file_path'] !== PLAN_FILE || typeof content !== 'string') {
    return { plan: null, problems: [`${name} が ${PLAN_FILE} 以外を書こうとして止まった`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { plan: null, problems: [`${PLAN_FILE} が JSON ではない`] };
  }
  const parsed = MappingPlanSchema.safeParse(json);
  if (!parsed.success) {
    return {
      plan: null,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  return validatePlan(parsed.data, found);
}

/** The person said no: the agent writes a revised plan from the comment, and the run pauses again. */
export async function rejectPlan(
  aw: AgentWorkspaceClient,
  proposal: PlanProposal,
  comment: string,
): Promise<PlanProposal> {
  const { run } = await aw.runs.reject(proposal.runId, { comment });
  return proposalFrom(
    await untilApproval(readRun(aw, run.id, ReportAnswerSchema)),
    proposal.subject,
    proposal.fileScope,
    proposal.found,
  );
}

// ---------- after the approval: the checks on the report ----------

const percent = (diff: number, previous: number): number | null =>
  previous === 0 ? null : Math.round((diff / previous) * 1000) / 10;

/**
 * Recompute every total and change from the report's own rows, and check each row came from a
 * planned file and sheet. Returns what disagrees; an empty list means the report is consistent.
 */
export function recompute(report: Report, plan: MappingPlan): string[] {
  const mismatches: string[] = [];
  const { from, to } = report.comparison;
  if (from !== plan.from || to !== plan.to)
    mismatches.push(`比較月が計画（${plan.from}→${plan.to}）と違う: ${from}→${to}`);

  const sheets = new Map(
    plan.layouts.flatMap((layout) => layout.files.map((file) => [file, layout.sheet] as const)),
  );
  const sums = new Map<string, number>();
  for (const row of report.rows) {
    const [file = '', sheet = ''] = row['@src'].amount.split('!');
    if (sheets.get(file) !== sheet)
      mismatches.push(`${row['@src'].amount} は計画したファイル・シートではない`);
    const key = `${row.month}|${row.branch}`;
    sums.set(key, (sums.get(key) ?? 0) + row.amount);
  }

  const check = (label: string, stated: number | null, actual: number | null): void => {
    if (stated !== actual)
      mismatches.push(`${label}: 報告 ${String(stated)}、再計算 ${String(actual)}`);
  };
  let previousTotal = 0;
  let currentTotal = 0;
  for (const entry of report.comparison.branches) {
    const previous = sums.get(`${from}|${entry.branch}`) ?? 0;
    const current = sums.get(`${to}|${entry.branch}`) ?? 0;
    previousTotal += previous;
    currentTotal += current;
    check(`${entry.branch} ${from}`, entry.previous, previous);
    check(`${entry.branch} ${to}`, entry.current, current);
    check(`${entry.branch} 差額`, entry.diff, current - previous);
    check(`${entry.branch} 増減率`, entry.pct, percent(current - previous, previous));
  }
  const { total } = report.comparison;
  check(`合計 ${from}`, total.previous, previousTotal);
  check(`合計 ${to}`, total.current, currentTotal);
  check('合計 差額', total.diff, currentTotal - previousTotal);
  check('合計 増減率', total.pct, percent(currentTotal - previousTotal, previousTotal));
  return mismatches;
}

const round = (value: number): number => Math.round(Math.abs(value) * 10) / 10;

/** Every number the script's output holds, as absolute values, plus the dates' parts and counts. */
function groundedNumbers(report: Report): Set<number> {
  const numbers = new Set<number>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') numbers.add(round(value));
    else if (typeof value === 'string' && /^\d{4}-\d{2}(-\d{2})?$/u.test(value))
      for (const part of value.split('-')) numbers.add(Number(part));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  walk(report);
  numbers.add(report.rows.length);
  numbers.add(report.skipped.length);
  numbers.add(report.comparison.branches.length);
  return numbers;
}

/**
 * The numbers in `text` that the script did not produce. Cell references (`file!sheet!D5`) are
 * addresses, not figures, and are ignored; 万 and 億 are read as multipliers, so 「280万円」 is
 * grounded by 2,800,000.
 */
export function ungroundedNumbers(text: string, report: Report): string[] {
  const grounded = groundedNumbers(report);
  // A percentage must be one of the script's rates, not merely a number it printed somewhere:
  // 25.0% is not grounded by a sale dated the 25th.
  const rates = new Set(
    [...report.comparison.branches, report.comparison.total].flatMap((change) =>
      change.pct === null ? [] : [round(change.pct)],
    ),
  );
  const prose = text.normalize('NFKC').replace(/[^\s`「」()]+![^\s`「」()]+![A-Z]+\d+/gu, '');
  return [...prose.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(万|億)?(%)?/gu)]
    .filter((match) => {
      const base = Number(`${(match[1] ?? '').replaceAll(',', '')}${match[2] ?? ''}`);
      const scale = match[3] === '億' ? 100_000_000 : match[3] === '万' ? 10_000 : 1;
      const value = round(base * scale);
      return match[4] === undefined ? !grounded.has(value) : !rates.has(value);
    })
    .map((match) => match[0]);
}

/** Whether the workbook's sheets hold the cells the report's own rows and comparison give. */
function sameCells(bytes: Uint8Array, report: Report): boolean {
  const trim = (rows: readonly (readonly unknown[])[]): unknown[][] =>
    rows.map((row) => {
      const cells = [...row];
      while (cells.at(-1) === null || cells.at(-1) === undefined) cells.pop();
      return cells;
    });
  // The workbook is the agent's file: one that does not open does not match the report.
  let written: ReturnType<typeof readXlsx>['sheets'];
  try {
    written = readXlsx(Buffer.from(bytes)).sheets;
  } catch {
    return false;
  }
  const expected = workbookSpec(report).sheets;
  return (
    written.length === expected.length &&
    expected.every((sheet, index) => {
      const actual = written[index];
      return (
        actual?.name === sheet.name &&
        JSON.stringify(trim(actual.rows)) === JSON.stringify(trim(sheet.rows))
      );
    })
  );
}

/**
 * The person approved `proposal`'s plan. The continuation may write exactly the plan they saw; the
 * agent then runs the script and explains. Accept the explanation only if the report adds up and
 * every number it quotes is the script's.
 */
export async function approvePlan(
  aw: AgentWorkspaceClient,
  proposal: PlanProposal,
): Promise<Consolidation> {
  const { plan } = proposal;
  if (plan === null)
    throw new Error(`the plan was not approvable: ${proposal.problems.join('; ')}`);
  const { run } = await aw.runs.approve(proposal.runId);
  const reading = await readRun(aw, run.id, ReportAnswerSchema);
  const { explanation, report } = reading.output;
  const sessionId = reading.run.sessionId;
  const mismatches = recompute(report, plan);
  const ungrounded = ungroundedNumbers(explanation, report);
  const name = `consolidated-${plan.to}.xlsx`;
  const written = (await aw.runs.outputs(reading.run.id)).find((file) => file.name === name);
  const downloaded = written === undefined ? null : await aw.files.download(written.path);
  const workbook = downloaded?.kind === 'file' ? { name, bytes: downloaded.bytes } : null;
  // A report that adds up is the reference; a workbook is compared with it only then.
  if (mismatches.length === 0) {
    if (workbook === null) mismatches.push(`outputs/${name} がない`);
    else if (!sameCells(workbook.bytes, report)) mismatches.push(`${name} の内容が報告と違う`);
  }
  return {
    status: mismatches.length === 0 && ungrounded.length === 0 ? 'accepted' : 'refused',
    explanation,
    report,
    workbook,
    mismatches,
    ungrounded,
    sessionId,
  };
}
