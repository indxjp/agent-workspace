/**
 * The recorders of the `use-cases/<slug>` entries whose skill script computes the answer (budget).
 * The script really runs (`run_skill_script` in `./use-case-desk.ts`, on the entry's seeded export),
 * and the scripted model only formats what it printed: every number in the answer and in the typed
 * output is one the script printed, as the entry's instructions require. As `./use-cases.ts` says of
 * every recorder, each checks that the prompt carries the request it is scripted for.
 */
import path from 'node:path';

import { z } from 'zod';

import budgetAgent from '../../../use-cases/budget/agents/budget.ts';
import type { Script } from '../../gallery/harness/scripted-workspace.ts';
import type { Lang, Recorder } from './types.ts';
import { playUseCase } from './use-case-desk.ts';
import { carries, search } from './use-case-script.ts';

const FIGURES = z.object({
  budget: z.number().int(),
  actual: z.number().int(),
  variance: z.number().int(),
  variancePct: z.number().nullable(),
});
type Figures = z.infer<typeof FIGURES>;

/** What `analyse.mjs` prints (its `lines` are not part of the typed output). */
const ANALYSIS = z.object({
  month: z.string(),
  from: z.string(),
  threshold: z.number(),
  total: FIGURES,
  ytd: FIGURES,
  departments: z.array(FIGURES.extend({ department: z.string() })),
  trend: z.array(FIGURES.extend({ month: z.string() })),
  flagged: z.array(
    FIGURES.extend({
      department: z.string(),
      account: z.string(),
      ytd: FIGURES,
      flagged: z.boolean(),
    }),
  ),
});
type Analysis = z.infer<typeof ANALYSIS>;

/** A whole-yen amount as the skill allows it: thousands separators and a sign. */
const yen = (value: number, signed = false): string =>
  `${signed && value > 0 ? '+' : ''}${value.toLocaleString('en-US')}`;

/** A variance % as printed, with a sign; a line with no budget has none. */
const pct = (value: number | null, lang: Lang): string =>
  value === null
    ? lang === 'ja'
      ? '予算なし'
      : 'no budget'
    : `${value > 0 ? '+' : ''}${String(value)}%`;

const variance = (figures: Figures, lang: Lang): string =>
  `${yen(figures.variance, true)}${lang === 'ja' ? '円' : ' yen'} (${pct(figures.variancePct, lang)})`;

/** The answer the instructions ask for: flagged lines, department totals, then a short commentary. */
function budgetAnswer(
  analysis: Analysis,
  lang: Lang,
): { readonly text: string; readonly commentary: string } {
  // Largest variance first, as the skill says to lead.
  const flagged = [...analysis.flagged].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  const ja = lang === 'ja';
  const flaggedTable = [
    ja
      ? '| 部門 | 勘定科目 | 予算 | 実績 | 差異 | 差異率 | 累計差異 |'
      : '| Department | Account | Budget | Actual | Variance | Variance % | YTD variance |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...flagged.map(
      (line) =>
        `| ${line.department} | ${line.account} | ${yen(line.budget)} | ${yen(line.actual)} | ${yen(line.variance, true)} | ${pct(line.variancePct, lang)} | ${yen(line.ytd.variance, true)} |`,
    ),
  ].join('\n');
  const departments = [
    ja
      ? '| 部門 | 予算 | 実績 | 差異 | 差異率 |'
      : '| Department | Budget | Actual | Variance | Variance % |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...analysis.departments.map(
      (row) =>
        `| ${row.department} | ${yen(row.budget)} | ${yen(row.actual)} | ${yen(row.variance, true)} | ${pct(row.variancePct, lang)} |`,
    ),
  ].join('\n');
  const lines = flagged.map((line) =>
    line.variancePct === null
      ? ja
        ? `${line.department}の${line.account}は予算のない支出で、${yen(line.actual)}円を使っています。`
        : `${line.department} ${line.account} spent ${yen(line.actual)} yen without a budget.`
      : ja
        ? `${line.department}の${line.account}は${variance(line, lang)}で、累計では${variance(line.ytd, lang)}です。`
        : `${line.department} ${line.account} is ${variance(line, lang)}, ${variance(line.ytd, lang)} year to date.`,
  );
  const commentary = ja
    ? [
        `${analysis.month}の合計は予算${yen(analysis.total.budget)}円に対し実績${yen(analysis.total.actual)}円、差異は${variance(analysis.total, lang)}です。${analysis.from}からの累計の差異は${variance(analysis.ytd, lang)}です。`,
        ...lines,
        '差異への対応は担当者が判断してください。',
      ].join('\n')
    : [
        `In ${analysis.month} the total is ${yen(analysis.total.actual)} yen against a budget of ${yen(analysis.total.budget)} yen, ${variance(analysis.total, lang)}; from ${analysis.from} the year-to-date variance is ${variance(analysis.ytd, lang)}.`,
        ...lines,
        'A person decides what to do about the variances.',
      ].join('\n');
  const heading = ja
    ? [`予算から${String(analysis.threshold)}%以上ずれた行`, '部門別の合計', 'コメント']
    : [
        `Lines off budget by ${String(analysis.threshold)}% or more`,
        'Department totals',
        'Commentary',
      ];
  return {
    text: [
      `### ${heading[0]}`,
      '',
      flaggedTable,
      '',
      `### ${heading[1]}`,
      '',
      departments,
      '',
      `### ${heading[2]}`,
      '',
      commentary,
    ].join('\n'),
    commentary,
  };
}

/** The export each language's first prompt names, and the word the model searches for. */
const BUDGET: Readonly<
  Record<Lang, { readonly file: string; readonly month: string; readonly query: string }>
> = {
  ja: { file: '予実_2026年度上期_部門別.csv', month: '2026年9月', query: '予算' },
  en: {
    file: 'budget-actual-FY2026-H1-by-department.csv',
    month: 'September 2026',
    query: 'budget',
  },
};

export const USE_CASE_SCRIPTS: Readonly<Record<string, Recorder>> = {
  budget: (ask) => {
    const { file, month, query } = BUDGET[ask.lang];
    carries(ask, file, month);
    const model: Script = async (context) => {
      const found = (await search(context, [query])).filter((one) => path.basename(one) === file);
      const [named] = found;
      if (named === undefined) throw new Error(`budget: search found no ${file}`);
      const result = await context.builtin('run_skill_script', {
        skill: 'budget',
        script: 'analyse.mjs',
        args: [named, '--month', '2026-09'],
      });
      if (result.isError) throw new Error(`budget: analyse.mjs refused: ${result.text}`);
      const analysis = ANALYSIS.parse(JSON.parse(result.text));
      const { text, commentary } = budgetAnswer(analysis, ask.lang);
      const { month: m, from, threshold, total, ytd, departments, trend, flagged } = analysis;
      return {
        text,
        structured: {
          month: m,
          from,
          threshold,
          total,
          ytd,
          departments,
          trend,
          flagged,
          commentary,
        },
      };
    };
    return playUseCase(ask.slug, budgetAgent, model, ask);
  },
};
