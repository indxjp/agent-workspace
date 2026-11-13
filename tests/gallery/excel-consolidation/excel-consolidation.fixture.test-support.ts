import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';
import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import agentDefinition from './agents/excel-consolidation.ts';
import { type AccessList, type MappingPlan } from './backend/consolidate.ts';
import { type Report } from './skills/excel-consolidate/scripts/consolidate.mjs';
import surfaceDefinition from './surfaces/planning.ts';

export const DIR = path.dirname(fileURLToPath(import.meta.url));

const OOXML = path.join(
  DIR,
  ...['..', '..', '..', 'packages', 'skills-office', 'office-reader', 'scripts', 'ooxml.mjs'],
);

export const CONSOLIDATE = path.join(
  DIR,
  'skills',
  'excel-consolidate',
  'scripts',
  'consolidate.mjs',
);

export const PLAN = JSON.parse(
  readFileSync(path.join(DIR, 'data', 'mapping-plan.json'), 'utf8'),
) as MappingPlan;

export const DATA = path.join(DIR, 'data');

export const ACCESS = JSON.parse(
  readFileSync(path.join(DATA, 'access.json'), 'utf8'),
) as AccessList;

export const BRANCH_FOLDERS = [
  '共通',
  '東京支店',
  '大阪支店',
  '名古屋営業所',
  '札幌営業所',
  '福岡支店',
];

export const search = createFileSearch({ root: DATA, grants: BRANCH_FOLDERS });

const builtins: BuiltinTools = { search_files: search.call };

export const PLANNER = '田村 恵';

export const SAPPORO_MANAGER = '佐々木 誠';

export const REQUEST = '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して';

export const run = promisify(execFile);

export interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

export const FIRST_QUERIES = ['機器 保守', '日付 区分'];

export let work: string;

export let project: GalleryProject;

beforeAll(async () => {
  // The run's working directory: the granted folders, and `outputs/` to write in.
  work = mkdtempSync(path.join(tmpdir(), 'consolidate-work-'));
  cpSync(DATA, work, { recursive: true });
  mkdirSync(path.join(work, 'outputs'));
  project = await loadGalleryProject(DIR, {
    'agents/excel-consolidation.ts': agentDefinition,
    'surfaces/planning.ts': surfaceDefinition,
  });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

export async function node(script: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [script, ...args], {
    cwd: work,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function consolidate(plan: MappingPlan): Promise<Report> {
  writeFileSync(path.join(work, 'outputs', 'plan.json'), JSON.stringify(plan));
  const books = new Set(plan.layouts.flatMap((layout) => layout.files));
  await node(CONSOLIDATE, [
    'apply',
    'outputs/plan.json',
    ...books,
    '--out',
    'outputs/applied.json',
  ]);
  const compared = await node(CONSOLIDATE, [
    'compare',
    'outputs/applied.json',
    plan.from,
    plan.to,
    '--out',
    'outputs/report.json',
  ]);
  return JSON.parse(compared) as Report;
}

async function workbookOf(report: Report): Promise<Buffer> {
  writeFileSync(path.join(work, 'outputs', 'report.json'), JSON.stringify(report));
  await node(CONSOLIDATE, ['sheet', 'outputs/report.json', '--out', 'outputs/book.json']);
  await node(OOXML, ['write', 'outputs/book.json', 'outputs/consolidated.xlsx']);
  return readFileSync(path.join(work, 'outputs', 'consolidated.xlsx'));
}

const yen = (value: number): string => `${value.toLocaleString('ja-JP')}円`;

const signed = (value: number, text: string): string =>
  value > 0 ? `+${text}` : value < 0 ? `△${text.replace('-', '')}` : text;

export function explain(report: Report): string {
  const { total, branches, from, to } = report.comparison;
  const month = Number(to.slice(5));
  const lines = [...branches]
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff))
    .map(
      (entry) =>
        `- ${entry.branch}: ${yen(entry.current)}（前月比 ${signed(entry.diff, yen(entry.diff))}、${signed(entry.diff, `${String(entry.pct)}%`)}）`,
    );
  const top = report.rows
    .filter((row) => row.branch === '東京' && row.month === to)
    .sort((left, right) => right.amount - left.amount)[0];
  return [
    `${String(month)}月の拠点別売上は合計 ${yen(total.current)} で、前月（${from}）の ${yen(total.previous)} から ${yen(total.diff)}（${String(total.pct)}%）増えました。`,
    ...lines,
    `東京の伸びは機器の大口案件（${top?.['@src'].amount ?? ''}、${yen(top?.amount ?? 0)}）によるものです。`,
    `小計・合計・注記の ${String(report.skipped.length)} 行は集計から除外しました。`,
  ].join('\n');
}

export const planWrite = (plan: unknown): Record<string, unknown> => ({
  file_path: 'outputs/plan.json',
  content: JSON.stringify(plan, null, 2),
});

export function followInstructions(
  rewrite: (explanation: string, report: Report) => [string, unknown] = (text, report) => [
    text,
    report,
  ],
  /** The report the workbook is built from; `null` writes none. */
  book: ((report: Report) => Report) | null = (report) => report,
  /** The plan to write for the prompt the run got: the first request, or `rejected: <comment>`. */
  plans: (prompt: string) => unknown = () => PLAN,
) {
  return async (context: ScriptContext): Promise<ScriptAnswer> => {
    const decided = /^(approved|rejected)/u.test(context.prompt);
    // A continuation continues the session: the agent already knows what it found.
    if (!decided) {
      const found = new Set<string>();
      for (const query of FIRST_QUERIES) {
        const result = await context.builtin('search_files', { query });
        for (const hit of JSON.parse(result.text) as Hit[]) found.add(hit.path);
      }
      // One inspect call over every workbook: its `unit` per sheet is what the plan's `unit` says.
      await node(CONSOLIDATE, ['inspect', ...found]);
    }
    const plan = plans(context.prompt);
    await context.native('Write', planWrite(plan));
    const confirmed = plan as MappingPlan;
    const report = await consolidate(confirmed);
    if (book !== null)
      context.write(`consolidated-${confirmed.to}.xlsx`, await workbookOf(book(report)));
    const [explanation, structuredReport] = rewrite(explain(report), report);
    return {
      text: explanation,
      structured: { explanation, report: structuredReport },
    };
  };
}

const claudeEngine =
  typeof agentDefinition.engine === 'object' && agentDefinition.engine.id === 'claude-agent-sdk'
    ? agentDefinition.engine
    : undefined;

export const workspaceFor = (script: (context: ScriptContext) => Promise<ScriptAnswer>) =>
  scriptedWorkspace(script, {}, builtins, { requireApproval: claudeEngine?.requireApproval });

export const pathsOf = (result: { readonly text: string }): string[] =>
  (JSON.parse(result.text) as Hit[]).map((hit) => hit.path);
