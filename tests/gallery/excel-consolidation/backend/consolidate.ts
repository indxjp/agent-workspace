/**
 * Corporate planning's backend: a two-turn conversation with the excel-consolidation agent.
 *
 * Turn 1 (`proposePlan`): the agent finds the branch workbooks, inspects them and answers with a
 * mapping plan. The backend validates the plan before a person sees it: every workbook the agent
 * found is either mapped or excluded with a reason, nothing is mapped that was not found, every
 * required field has a column, and every unit and date format is stated, not left to a guess.
 *
 * Turn 2 (`runConfirmedPlan`, same `sessionId`): the person has confirmed, the agent runs the
 * script and explains. The backend does not take the explanation on trust. It recomputes every
 * total and change from the script's rows, checks each row's `@src` points into a planned file,
 * and refuses an explanation that quotes a number the script did not produce.
 *
 * A run has no output schema and a file the agent writes does not come back to the file store, so
 * both the plan and the report travel as one fenced ```json block in the answer.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead } from '../../shared/run-answer.ts';
import type {
  DateFormat,
  Field,
  Layout,
  Report,
  Unit,
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
  readonly sessionId: string;
  /** The agent's explanation of the plan, without the JSON block. */
  readonly explanation: string;
  /** The `.xlsx` paths `find_files` returned during the run. */
  readonly found: readonly string[];
  readonly plan: MappingPlan | null;
  readonly lines: readonly PlanLine[];
  /** Why the plan cannot be shown for confirmation; empty when it can. */
  readonly problems: readonly string[];
}

export interface Consolidation {
  readonly status: 'accepted' | 'refused';
  readonly explanation: string;
  readonly report: Report | null;
  /** Totals or changes the agent's report states that its own rows do not add up to. */
  readonly mismatches: readonly string[];
  /** Numbers the explanation quotes that appear nowhere in the script's output. */
  readonly ungrounded: readonly string[];
  readonly sessionId: string;
}

const UNITS: readonly string[] = ['円', '千円', '百万円'];
const DATE_FORMATS: readonly string[] = ['wareki', 'ymd', 'serial'];
const FIELDS: readonly Field[] = ['date', 'category', 'amount'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
const COLUMN = /^[A-Z]{1,3}$/u;

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The last ```json block of an answer, parsed, and the answer without it. */
export function splitJsonBlock(answer: string): { text: string; json: unknown } {
  const blocks = [...answer.matchAll(/```json\s*\n([\s\S]*?)```/gu)];
  const last = blocks.at(-1);
  if (last === undefined) return { text: answer.trim(), json: undefined };
  const text = (answer.slice(0, last.index) + answer.slice(last.index + last[0].length)).trim();
  try {
    return { text, json: JSON.parse(last[1] ?? '') as unknown };
  } catch {
    return { text, json: undefined };
  }
}

function layoutProblems(value: unknown, at: string): string[] {
  if (!isRecord(value)) return [`${at} is not an object`];
  const problems: string[] = [];
  if (!isText(value['branch'])) problems.push(`${at}: 拠点名（branch）がない`);
  if (!isText(value['sheet'])) problems.push(`${at}: シート名（sheet）がない`);
  const files = value['files'];
  if (!Array.isArray(files) || files.length === 0 || !files.every(isText))
    problems.push(`${at}: files が空`);
  const headerRows = value['headerRows'];
  if (
    !Array.isArray(headerRows) ||
    headerRows.length === 0 ||
    !headerRows.every((row) => Number.isInteger(row) && (row as number) >= 1)
  )
    problems.push(`${at}: 見出し行（headerRows）がない`);
  const columns = isRecord(value['columns']) ? value['columns'] : {};
  for (const field of FIELDS) {
    const column = columns[field];
    if (typeof column !== 'string' || !COLUMN.test(column))
      problems.push(`${at}: ${field} の列が割り当てられていない`);
  }
  if (typeof value['unit'] !== 'string' || !UNITS.includes(value['unit']))
    problems.push(`${at}: 単位（unit）が明示されていない`);
  if (typeof value['dateFormat'] !== 'string' || !DATE_FORMATS.includes(value['dateFormat']))
    problems.push(`${at}: 日付の形式（dateFormat）が明示されていない`);
  const skip = value['skip'];
  if (skip !== undefined && (!Array.isArray(skip) || !skip.every(isText)))
    problems.push(`${at}: skip は文字列の配列にする`);
  return problems;
}

/**
 * Check a plan the agent proposed against the workbooks it found. Returns the plan only when
 * there is no problem: a plan with a problem is never shown as ready to confirm.
 */
export function validatePlan(
  value: unknown,
  found: readonly string[],
): { plan: MappingPlan | null; problems: string[] } {
  if (!isRecord(value)) return { plan: null, problems: ['計画の JSON がない'] };
  const problems: string[] = [];
  const { from, to, layouts, excluded } = value;
  if (typeof from !== 'string' || !MONTH.test(from)) problems.push('from（前月）が YYYY-MM でない');
  if (typeof to !== 'string' || !MONTH.test(to)) problems.push('to（今月）が YYYY-MM でない');
  if (typeof from === 'string' && typeof to === 'string' && from >= to)
    problems.push('from は to より前の月にする');
  if (!Array.isArray(layouts) || layouts.length === 0) problems.push('layouts が空');
  const layoutList: unknown[] = Array.isArray(layouts) ? layouts : [];
  layoutList.forEach((layout, index) => {
    problems.push(...layoutProblems(layout, `layouts[${String(index)}]`));
  });
  const excludedList: unknown[] =
    excluded === undefined ? [] : Array.isArray(excluded) ? excluded : [null];
  for (const entry of excludedList) {
    if (!isRecord(entry) || !isText(entry['file']) || !isText(entry['reason']))
      problems.push('excluded の各項目には file と reason が要る');
  }

  // Every found workbook is accounted for exactly once, and nothing unfound is mapped.
  const mapped = layoutList.flatMap((layout) =>
    isRecord(layout) && Array.isArray(layout['files']) ? layout['files'].filter(isText) : [],
  );
  const skipped = excludedList.flatMap((entry) =>
    isRecord(entry) && isText(entry['file']) ? [entry['file']] : [],
  );
  const named = [...mapped, ...skipped];
  for (const file of found) {
    const count = named.filter((name) => name === file).length;
    if (count === 0) problems.push(`${file} が計画にも除外にもない`);
    if (count > 1) problems.push(`${file} が計画に2回以上ある`);
  }
  for (const file of new Set(named)) {
    if (!found.includes(file)) problems.push(`${file} は find_files が返していない`);
  }

  if (problems.length > 0) return { plan: null, problems };
  return {
    plan: {
      from: from as string,
      to: to as string,
      layouts: layoutList as Layout[],
      excluded: excludedList as MappingPlan['excluded'],
    },
    problems,
  };
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

/** Turn 1: ask for a plan, and validate it before anyone is asked to confirm it. */
export async function proposePlan(
  aw: AgentWorkspaceClient,
  agentId: string,
  request: string,
): Promise<PlanProposal> {
  const reading = await runAndRead(aw, agentId, { prompt: request });
  const found = [
    ...new Set(
      reading.toolCalls
        .filter((call) => toolIs(call.name, 'find_files') && !call.isError && call.output !== null)
        .flatMap((call) => {
          const parsed: unknown = JSON.parse(call.output ?? '[]');
          return Array.isArray(parsed)
            ? parsed.flatMap((hit) => (isRecord(hit) && isText(hit['path']) ? [hit['path']] : []))
            : [];
        })
        .filter((file) => file.toLowerCase().endsWith('.xlsx')),
    ),
  ].sort();
  const { text, json } = splitJsonBlock(reading.answer);
  const { plan, problems } = validatePlan(json, found);
  return {
    sessionId: reading.run.sessionId,
    explanation: text,
    found,
    plan,
    lines: plan === null ? [] : linesOf(plan),
    problems,
  };
}

// ---------- turn 2: the checks on the report ----------

const percent = (diff: number, previous: number): number | null =>
  previous === 0 ? null : Math.round((diff / previous) * 1000) / 10;

const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number';
const isChange = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['previous'] === 'number' &&
  typeof value['current'] === 'number' &&
  typeof value['diff'] === 'number' &&
  isNumberOrNull(value['pct']);
const isRow = (value: unknown): boolean =>
  isRecord(value) &&
  isText(value['branch']) &&
  isText(value['month']) &&
  typeof value['amount'] === 'number' &&
  isRecord(value['@src']) &&
  isText(value['@src']['amount']);

/** The report's shape, checked before any of it is trusted: it arrived as text in an answer. */
const isReport = (value: unknown): value is Report => {
  if (!isRecord(value) || !Array.isArray(value['rows']) || !Array.isArray(value['skipped']))
    return false;
  const comparison = value['comparison'];
  return (
    value['rows'].every(isRow) &&
    isRecord(comparison) &&
    isText(comparison['from']) &&
    isText(comparison['to']) &&
    Array.isArray(comparison['branches']) &&
    comparison['branches'].every(
      (entry) => isChange(entry) && isRecord(entry) && isText(entry['branch']),
    ) &&
    isChange(comparison['total'])
  );
};

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

/**
 * Turn 2: the person confirmed `proposal`'s plan. Continue the same session, let the agent run the
 * script and explain, and accept the explanation only if the report adds up and every number it
 * quotes is the script's.
 */
export async function runConfirmedPlan(
  aw: AgentWorkspaceClient,
  agentId: string,
  proposal: PlanProposal,
): Promise<Consolidation> {
  const { plan } = proposal;
  if (plan === null)
    throw new Error(`the plan was not confirmable: ${proposal.problems.join('; ')}`);
  const prompt = [
    '計画を確認しました。この計画のとおりに集計し、前月からの増減を説明してください。',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
  ].join('\n');
  const reading = await runAndRead(aw, agentId, { prompt, sessionId: proposal.sessionId });
  const { text, json } = splitJsonBlock(reading.answer);
  const sessionId = reading.run.sessionId;
  if (!isReport(json)) {
    return {
      status: 'refused',
      explanation: text,
      report: null,
      mismatches: ['回答にスクリプトの出力（report.json）がない'],
      ungrounded: [],
      sessionId,
    };
  }
  const mismatches = recompute(json, plan);
  const ungrounded = ungroundedNumbers(text, json);
  return {
    status: mismatches.length === 0 && ungrounded.length === 0 ? 'accepted' : 'refused',
    explanation: text,
    report: json,
    mismatches,
    ungrounded,
    sessionId,
  };
}
