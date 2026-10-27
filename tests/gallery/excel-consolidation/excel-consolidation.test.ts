/**
 * Use case 6, the Excel consolidation agent: the definition passes the contract, the built-in
 * `search_files` finds the workbooks inside the folders the caller's `fileScope` names, the skill
 * script reads them itself and turns five incompatible layouts into one table with a source cell for
 * every value, and the backend validates the plan the run is stopped at for approval and refuses an explanation that
 * quotes a number the script did not compute. The scripts run as `run_skill_script` runs them: no
 * shell, files written under `outputs/` only. See `../README.md` for the tiers.
 */
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OOXML_LIMITS,
  readXlsx,
  writeXlsx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';

import { createFileSearch } from '../harness/file-search.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  approvePlan,
  fileScopeFor,
  MONTHLY_TRIGGER,
  NoAccessibleFiles,
  proposePlan,
  proposePlanFromRun,
  rejectPlan,
  type AccessList,
  type MappingPlan,
} from './backend/consolidate.ts';
import { BRANCH_FILES, writeBranchWorkbooks } from './data/branch-workbooks.ts';
import {
  detectUnit,
  serialToIso,
  warekiToIso,
  ymdToIso,
  type Report,
} from './skills/excel-consolidate/scripts/consolidate.mjs';
import {
  OOXML_LIMITS as COPIED_LIMITS,
  readXlsx as readXlsxCopy,
} from './skills/excel-consolidate/scripts/xlsx.mjs';
import agentDefinition from './agents/excel-consolidation.ts';
import surfaceDefinition from './surfaces/planning.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OOXML = path.join(
  DIR,
  ...['..', '..', '..', 'packages', 'skills-office', 'office-reader', 'scripts', 'ooxml.mjs'],
);
const CONSOLIDATE = path.join(DIR, 'skills', 'excel-consolidate', 'scripts', 'consolidate.mjs');
const PLAN = JSON.parse(
  readFileSync(path.join(DIR, 'data', 'mapping-plan.json'), 'utf8'),
) as MappingPlan;
const DATA = path.join(DIR, 'data');
const ACCESS = JSON.parse(readFileSync(path.join(DATA, 'access.json'), 'utf8')) as AccessList;
// The agent's `files()` grants, and the workbooks `search_files` can reach under them.
const BRANCH_FOLDERS = ['共通', '東京支店', '大阪支店', '名古屋営業所', '札幌営業所', '福岡支店'];
const search = createFileSearch({ root: DATA, grants: BRANCH_FOLDERS });
const builtins: BuiltinTools = { search_files: search.call };
// Who is asking: both are in `data/access.json`; the second may see 札幌営業所 and 共通 only.
const PLANNER = '田村 恵';
const SAPPORO_MANAGER = '佐々木 誠';
const REQUEST = '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して';
const run = promisify(execFile);

interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

/** The two searches the instructions start with: every branch's sales sheet, and the template. */
const FIRST_QUERIES = ['機器 保守', '日付 区分'];

let work: string;
let project: GalleryProject;

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

/** Run a skill script as `run_skill_script` does: no shell, the working directory holds the granted folders. */
async function node(script: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [script, ...args], {
    cwd: work,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** apply + compare, the way the skill's step 3 runs them: the plan is written under `outputs/` first. */
async function consolidate(plan: MappingPlan): Promise<Report> {
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

/** `sheet` then `ooxml.mjs write`, the way the skill's step 3 saves the workbook under `outputs/`. */
async function workbookOf(report: Report): Promise<Buffer> {
  writeFileSync(path.join(work, 'outputs', 'report.json'), JSON.stringify(report));
  await node(CONSOLIDATE, ['sheet', 'outputs/report.json', '--out', 'outputs/book.json']);
  await node(OOXML, ['write', 'outputs/book.json', 'outputs/consolidated.xlsx']);
  return readFileSync(path.join(work, 'outputs', 'consolidated.xlsx'));
}

const yen = (value: number): string => `${value.toLocaleString('ja-JP')}円`;
const signed = (value: number, text: string): string =>
  value > 0 ? `+${text}` : value < 0 ? `△${text.replace('-', '')}` : text;

/** An explanation written only from the report, as the instructions require. */
function explain(report: Report): string {
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

/** The `Write` of the plan the agent makes, as the engine reports its input. */
const planWrite = (plan: unknown): Record<string, unknown> => ({
  file_path: 'outputs/plan.json',
  content: JSON.stringify(plan, null, 2),
});

/**
 * What a model following `agents/excel-consolidation.md` does. The first run: `search_files`
 * twice, inspect every workbook, and `Write` the plan (`data/mapping-plan.json`, or what `plans`
 * gives for the person's comment) to `outputs/plan.json`, where the engine stops it for approval.
 * After an approval it makes the same `Write`, runs the plan through the script and explains from
 * its output. Every tool result and script output is real; `rewrite` lets a test make the model
 * misbehave.
 */
function followInstructions(
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

/** A workspace whose gates are the agent definition's own, as the engine applies them. */
const workspaceFor = (script: (context: ScriptContext) => Promise<ScriptAnswer>) =>
  scriptedWorkspace(script, {}, builtins, { requireApproval: claudeEngine?.requireApproval });

const pathsOf = (result: { readonly text: string }): string[] =>
  (JSON.parse(result.text) as Hit[]).map((hit) => hit.path);

describe('excel consolidation agent', () => {
  it('ships each workbook where the harness serves it, reading back as branch-workbooks.ts (GALLERY_WRITE=1 regenerates them)', () => {
    if (process.env['GALLERY_WRITE'] === '1') {
      for (const folder of new Set(BRANCH_FILES.map((file) => file.path.split('/')[0] ?? ''))) {
        rmSync(path.join(DATA, folder), { recursive: true, force: true });
      }
      writeBranchWorkbooks(DATA);
    }
    const shippedWorkbooks = readdirSync(DATA, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.xlsx'))
      .map((name) => name.split(path.sep).join('/').normalize('NFC'));
    expect(shippedWorkbooks.toSorted()).toEqual(
      BRANCH_FILES.map((file) => file.path.normalize('NFC')).toSorted(),
    );
    for (const file of BRANCH_FILES) {
      expect(readXlsx(readFileSync(path.join(DATA, file.path))), file.path).toEqual(
        readXlsx(writeXlsx({ sheets: file.sheets })),
      );
    }
    expect(existsSync(path.join(DATA, '東京支店', '売上報告の書き方.txt'))).toBe(true);
  });

  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    // Bash runs unattended; the plan's Write waits for a person (ADR-0145).
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: [
          'mcp__agent-workspace__run_skill_script',
          'mcp__agent-workspace__search_files',
        ],
      },
      requireApproval: ['Write'],
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['office-reader', 'excel-consolidate'],
      files: BRANCH_FOLDERS.map((folder) => ({ path: folder, access: 'read' })),
    });
    expect(definition?.agent.instructions).toContain('search_files');
    expect(definition?.agent.instructions).not.toContain('find_files');
    // No shell: the scripts run through run_skill_script, and the word Bash is gone.
    expect(definition?.agent.instructions).toContain('run_skill_script');
    expect(definition?.agent.instructions).not.toMatch(/Bash/iu);
    // The plan is a few tool calls, not one pair per file, and names each branch's unit.
    expect(definition?.agent.instructions).toContain('ファイルごとに呼び出さず');
    expect(definition?.agent.instructions).toContain('拠点ごとの単位');
    expect(definition?.agent.instructions).toContain('`Write` で `outputs/plan.json`');
    // The agent never opens SKILL.md, so the plan's keys must be in its own instructions.
    expect(definition?.agent.instructions).toContain('"layouts"');
    expect(definition?.agent.instructions).toContain('"excluded"');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'excel-consolidate',
      'office-reader',
    ]);
    // Each skill is uploaded as its own directory: consolidate.mjs imports only its sibling reader.
    const consolidateSkill = project.skills.find((skill) => skill.name === 'excel-consolidate');
    const script = consolidateSkill?.files.find((file) => file.path === 'scripts/consolidate.mjs');
    const source = Buffer.from(script?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(source).not.toMatch(/from '\.\.\//u);
    expect(source).toContain("from './xlsx.mjs'");
    expect(consolidateSkill?.files.map((file) => file.path)).toContain('scripts/xlsx.mjs');
    const surface = agent?.body.surfaces?.[0];
    expect(surface).toMatchObject({ name: 'planning' });
    expect(project.project.policy?.permissions).toMatchObject({
      runCommands: true,
      writeFiles: true,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(3);
    // The first case pins the gate: the run's first move is the plan's Write, not a consolidation.
    expect(cases[0]?.expect).toMatchObject({
      awaitsApproval: true,
      tool: 'Write',
      toolInput: { file_path: 'outputs/plan.json' },
    });
    expect(cases[0]?.expect.notContains).toContain('"comparison"');
    // Every case is scored at the approval pause; without the flag each would fail run_awaiting_approval.
    expect(cases.every((c) => c.expect.awaitsApproval === true)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the agent finds the workbooks with search_files and ships no index server', async () => {
    // No connector, and no hosted server of ours.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    // The two searches the instructions start with reach both months of every branch, by the text
    // inside the workbooks, and the shared template; the expense workbook and the note stay out.
    const found = new Set<string>();
    for (const query of FIRST_QUERIES) {
      const result = await search.call({ query });
      expect(result.isError, query).toBe(false);
      for (const hit of pathsOf(result)) found.add(hit);
    }
    expect([...found].toSorted()).toStrictEqual(
      BRANCH_FILES.map((file) => file.path)
        .filter((file) => !file.includes('経費精算'))
        .toSorted(),
    );
    // A hit carries the sheet's text, so a plan can be checked against what the search showed.
    const tokyo = (
      JSON.parse((await search.call({ query: '東京支店 売上報告' })).text) as Hit[]
    ).find((hit) => hit.path === '東京支店/東京_売上報告_2025年5月.xlsx');
    expect(tokyo).toMatchObject({ page: 1 });
    expect(tokyo?.snippet).toContain('売上報告');

    expect(await search.call({ query: '議事録' })).toStrictEqual({ text: '[]', isError: false });
    expect((await search.call({ query: '？' })).isError).toBe(true);
    // Only what the agent is granted is searchable: nothing else in `data/` is.
    expect(search.searchablePaths().toSorted()).toStrictEqual(
      readdirSync(DATA, { recursive: true, encoding: 'utf8' })
        .map((name) => name.split(path.sep).join('/'))
        .filter((name) => /\.(xlsx|txt)$/u.test(name))
        .toSorted(),
    );
  });

  it('each person gets a fileScope of the branch folders they may see, and a person with none is refused before any run', async () => {
    expect(fileScopeFor(PLANNER, ACCESS)).toStrictEqual(BRANCH_FOLDERS);
    expect(fileScopeFor(SAPPORO_MANAGER, ACCESS)).toStrictEqual(['共通', '札幌営業所']);

    // What the Sapporo manager's model sees: the two searches, then a name from another branch.
    const seen: string[] = [];
    let tokyoText = '';
    const sapporoPlan: MappingPlan = {
      ...PLAN,
      layouts: PLAN.layouts.filter((layout) => layout.branch === '札幌'),
    };
    const sapporo = workspaceFor(async (context) => {
      for (const query of [...FIRST_QUERIES, '東京支店', '売上報告']) {
        const result = await context.builtin('search_files', { query });
        seen.push(...pathsOf(result));
        if (query === '東京支店') tokyoText = result.text;
      }
      await context.native('Write', planWrite(sapporoPlan));
      throw new Error('the plan should have stopped at its Write');
    });
    // The request names Tokyo and another person; the run's subject and scope decide.
    const proposal = await proposePlan(
      sapporo.aw,
      sapporo.agentId,
      `${PLANNER}です。東京支店の売上を集計して`,
      SAPPORO_MANAGER,
      ACCESS,
    );
    expect(sapporo.runs[0]).toMatchObject({
      subject: SAPPORO_MANAGER,
      fileScope: ['共通', '札幌営業所'],
    });
    expect(proposal.fileScope).toStrictEqual(['共通', '札幌営業所']);
    expect(proposal.found).toStrictEqual([
      '共通/売上報告テンプレート.xlsx',
      '札幌営業所/札幌_月次報告_2025-04.xlsx',
      '札幌営業所/札幌_月次報告_2025-05.xlsx',
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((file) => file.startsWith('共通/') || file.startsWith('札幌営業所/'))).toBe(
      true,
    );
    // Tokyo's workbooks are not just unlisted: the search finds nothing of them.
    expect(tokyoText).toBe('[]');

    // The same searches from the planner reach every branch.
    const everyone = workspaceFor(async (context) => {
      for (const query of FIRST_QUERIES)
        seen.push(...pathsOf(await context.builtin('search_files', { query })));
      return 'done';
    });
    seen.length = 0;
    await everyone.aw.runs.start(everyone.agentId, {
      prompt: REQUEST,
      subject: PLANNER,
      fileScope: fileScopeFor(PLANNER, ACCESS),
    });
    expect(new Set(seen.map((file) => file.split('/')[0]))).toStrictEqual(new Set(BRANCH_FOLDERS));

    // A scope outside the grants is refused as launch refuses it, by the search double here.
    const outside = workspaceFor((context) =>
      context.builtin('search_files', { query: '売上' }).then((result) => result.text),
    );
    await expect(
      outside.aw.runs.start(outside.agentId, {
        prompt: REQUEST,
        subject: PLANNER,
        fileScope: ['人事部'],
      }),
    ).rejects.toThrow(/run_file_scope_not_granted/u);

    // Nothing accessible, nothing started: not an unscoped run.
    const refused = workspaceFor(() => Promise.resolve('unreachable'));
    for (const access of [ACCESS, { ...ACCESS, 新人: { folders: [] } }]) {
      await expect(
        proposePlan(refused.aw, refused.agentId, REQUEST, '新人', access),
      ).rejects.toBeInstanceOf(NoAccessibleFiles);
    }
    expect(refused.runs).toHaveLength(0);
    expect(refused.calls).toHaveLength(0);
  });

  it("the skill's copy of the reader gives the built-in office-reader's results on every shipped workbook", () => {
    expect(COPIED_LIMITS).toStrictEqual(OOXML_LIMITS);
    for (const file of BRANCH_FILES) {
      const bytes = readFileSync(path.join(DATA, file.path));
      expect(readXlsxCopy(bytes), file.path).toStrictEqual(readXlsx(bytes));
    }
    const refusal = (read: (bytes: Buffer) => unknown): string => {
      try {
        read(Buffer.from('not a zip'));
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
      return '';
    };
    expect(refusal(readXlsx)).not.toBe('');
    expect(refusal(readXlsxCopy)).toBe(refusal(readXlsx));
  });

  it('the script converts 和暦, Excel serials and slashed dates by rule', () => {
    expect(warekiToIso('令和7年5月12日')).toBe('2025-05-12');
    expect(warekiToIso('令和元年5月1日')).toBe('2019-05-01');
    expect(warekiToIso('平成31年4月30日')).toBe('2019-04-30');
    expect(warekiToIso('Ｒ７.５.２')).toBe('2025-05-02');
    expect(warekiToIso('H8/2/29')).toBe('1996-02-29');
    expect(() => warekiToIso('平成31年5月1日')).toThrow(/outside the 平成 era/u);
    expect(() => warekiToIso('令和7年2月30日')).toThrow(/not a calendar date/u);
    expect(() => warekiToIso('2025/05/12')).toThrow(/not a 和暦 date/u);
    expect(serialToIso(45778)).toBe('2025-05-01');
    expect(ymdToIso('2025/5/9')).toBe('2025-05-09');
  });

  it('the script consolidates five layouts with exact totals and a source cell for every value', async () => {
    const report = await consolidate(PLAN);
    // `--out` saves what the next call reads, and stdout carries the same report.
    expect(
      JSON.parse(readFileSync(path.join(work, 'outputs', 'report.json'), 'utf8')),
    ).toStrictEqual(report);

    expect(report.totals).toStrictEqual({
      '2025-04': {
        東京: 2_300_000,
        大阪: 2_260_000,
        名古屋: 1_160_500,
        福岡: 900_000,
        札幌: 790_000,
      },
      '2025-05': {
        東京: 2_800_000,
        大阪: 2_015_000,
        名古屋: 1_330_000,
        福岡: 1_035_000,
        札幌: 740_000,
      },
    });
    expect(report.comparison.total).toStrictEqual({
      previous: 7_410_500,
      current: 7_920_000,
      diff: 509_500,
      pct: 6.9,
    });
    expect(report.comparison.branches).toStrictEqual([
      { branch: '東京', previous: 2_300_000, current: 2_800_000, diff: 500_000, pct: 21.7 },
      { branch: '大阪', previous: 2_260_000, current: 2_015_000, diff: -245_000, pct: -10.8 },
      { branch: '名古屋', previous: 1_160_500, current: 1_330_000, diff: 169_500, pct: 14.6 },
      { branch: '福岡', previous: 900_000, current: 1_035_000, diff: 135_000, pct: 15 },
      { branch: '札幌', previous: 790_000, current: 740_000, diff: -50_000, pct: -6.3 },
    ]);

    expect(report.rows).toHaveLength(22);
    expect(
      report.rows.find((row) => row.branch === '東京' && row.date === '2025-05-08'),
    ).toStrictEqual({
      branch: '東京',
      date: '2025-05-08',
      month: '2025-05',
      category: '機器',
      amount: 1_500_000,
      raw: { amount: 1500, unit: '千円' },
      '@src': {
        date: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!A5',
        category: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!B5',
        amount: '東京支店/東京_売上報告_2025年5月.xlsx!売上明細!D5',
      },
    });
    // A ※ remark in 名古屋's notes column is a real sale, not a note row.
    expect(
      report.rows.find((row) => row.branch === '名古屋' && row.date === '2025-04-25'),
    ).toMatchObject({
      amount: 210_500,
      '@src': { amount: '名古屋営業所/名古屋_売上_R7.4.xlsx!名古屋営業所!C4' },
    });
    expect(report.rows.filter((row) => row.branch === '札幌').map((row) => row.date)).toStrictEqual(
      ['2025-04-04', '2025-04-21', '2025-05-02', '2025-05-19'],
    );
    expect(report.skipped.map((entry) => entry.text)).toStrictEqual([
      '小計',
      '※ 金額は税抜',
      '小計',
      '※ 金額は税抜',
      '合計',
      '合計',
      '※ 3月分の訂正はありません',
      '(参考)前年同月',
      '合計',
      '合計',
    ]);
  });

  it('the script stops when a header contradicts the plan unit', async () => {
    const wrong: MappingPlan = {
      ...PLAN,
      layouts: PLAN.layouts.map((layout) =>
        layout.branch === '東京' ? { ...layout, unit: '円' } : layout,
      ),
    };
    const failure = (await consolidate(wrong).catch((error: unknown) => error)) as {
      code?: number;
      stderr?: string;
    };
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(
      '売上明細!D4 says 千円 (売上 / 金額（千円）) but the plan says 円',
    );
  });

  it("inspect names each sheet's unit, so turn 1 states it without reading every sheet by eye", async () => {
    const files = BRANCH_FILES.map((file) => file.path);
    const inspected = JSON.parse(await node(CONSOLIDATE, ['inspect', ...files])) as {
      file: string;
      sheets: { sheet: string; unit: string | null; unitFrom: string | null }[];
    }[];
    expect(inspected.map((entry) => entry.file)).toStrictEqual(
      files.map((file) => path.basename(file)),
    );
    for (const layout of PLAN.layouts) {
      for (const file of layout.files) {
        const entry = inspected.find((item) => item.file === path.basename(file));
        const sheet = entry?.sheets.find((item) => item.sheet === layout.sheet);
        expect(sheet?.unit, `${file} ${layout.sheet}`).toBe(layout.unit);
        expect(sheet?.unitFrom, file).not.toBeNull();
      }
    }
    // 福岡 and 札幌 state it in a 単位 row, 東京 in the header; 札幌's cover sheet states nothing.
    const sheetOf = (file: string, sheet: string) =>
      inspected
        .find((item) => item.file === path.basename(file))
        ?.sheets.find((item) => item.sheet === sheet);
    expect(sheetOf('福岡支店/福岡支店売上報告（令和7年5月）.xlsx', 'R7.5')?.unitFrom).toBe(
      'A2 単位:円',
    );
    expect(sheetOf('東京支店/東京_売上報告_2025年5月.xlsx', '売上明細')?.unitFrom).toBe(
      'D4 金額(千円)',
    );
    expect(sheetOf('札幌営業所/札幌_月次報告_2025-05.xlsx', '表紙')?.unit).toBeNull();
    expect(detectUnit({ name: 'x', merges: [], rows: [['金額(円)', '単位：千円']] })?.unit).toBe(
      '千円',
    );
    expect(detectUnit({ name: 'x', merges: [], rows: [['日付', '区分', '金額']] })).toBeNull();
  });

  it('the backend reads the plan from the paused Write, the report as typed output once it is approved, and accepts a grounded explanation', async () => {
    const workspace = workspaceFor(followInstructions());

    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    expect(proposal.problems).toStrictEqual([]);
    expect(proposal.found).toHaveLength(11);
    expect(proposal.plan).toStrictEqual(PLAN);
    expect(proposal.lines).toHaveLength(10);
    expect(proposal.lines[0]).toStrictEqual({
      file: '東京支店/東京_売上報告_2025年4月.xlsx',
      branch: '東京',
      sheet: '売上明細',
      headerRows: '3–4',
      columns: '日付 A / 区分 B / 金額 D',
      unit: '千円',
      dateFormat: 'wareki',
    });
    // The run is stopped at the plan's Write, with nothing consolidated yet.
    const paused = await workspace.aw.runs.get(proposal.runId);
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApproval?.toolName).toBe('Write');
    expect(workspace.runs).toHaveLength(1);

    const result = await approvePlan(workspace.aw, proposal);
    expect(result.mismatches).toStrictEqual([]);
    expect(result.ungrounded).toStrictEqual([]);
    expect(result.status).toBe('accepted');
    expect(result.explanation).toContain('合計 7,920,000円');
    expect(result.explanation).toContain('東京: 2,800,000円（前月比 +500,000円、+21.7%）');
    expect(result.explanation).toContain('大阪: 2,015,000円（前月比 △245,000円、△10.8%）');
    expect(result.report.comparison.total.diff).toBe(509_500);

    // One conversation: the approval's continuation is in the paused run's session, started for the
    // signed-in person, and the approval admitted the very Write the person saw.
    expect(result.sessionId).toBe(proposal.sessionId);
    // Both runs were started for the same folder scope: the continuation keeps the paused run's.
    expect(workspace.runs.map((entry) => entry.fileScope)).toStrictEqual([
      BRANCH_FOLDERS,
      BRANCH_FOLDERS,
    ]);
    expect(workspace.runs.map((entry) => entry.sessionId)).toStrictEqual([
      proposal.sessionId,
      proposal.sessionId,
    ]);
    expect(workspace.runs[0]?.subject).toBe(PLANNER);
    expect(workspace.runs[1]?.prompt).toBe('approved');
    expect(workspace.runs[1]?.approvedToolCalls).toMatchObject([{ toolName: 'Write' }]);

    // Both runs ask for the report: the platform keeps the shape across the approval (ADR-0143).
    for (const entry of workspace.runs) {
      expect(entry.outputSchema).toMatchObject({
        type: 'object',
        required: ['explanation', 'report'],
      });
    }
  });

  it('the backend returns the consolidated workbook the agent wrote', async () => {
    const workspace = workspaceFor(followInstructions());
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    const result = await approvePlan(workspace.aw, proposal);

    expect(result.status).toBe('accepted');
    expect(result.workbook?.name).toBe('consolidated-2025-05.xlsx');
    // The bytes are the agent's file, and read back as the report's own totals and source cells.
    const sheets = readXlsx(Buffer.from(result.workbook?.bytes ?? [])).sheets;
    expect(sheets.map((sheet) => sheet.name)).toStrictEqual(['明細', '前月比']);
    expect(sheets[1]?.rows.at(-1)).toStrictEqual(['合計', 7_410_500, 7_920_000, 509_500, 6.9]);
    expect(sheets[0]?.rows).toHaveLength(result.report.rows.length + 1);
    expect(sheets[0]?.rows[1]?.[4]).toBe(result.report.rows[0]?.['@src'].amount);
  });

  it('the backend refuses a run whose workbook is missing or does not match its report', async () => {
    const none = workspaceFor(followInstructions(undefined, null));
    const missing = await approvePlan(
      none.aw,
      await proposePlan(none.aw, none.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(missing).toMatchObject({ status: 'refused', workbook: null });
    expect(missing.mismatches).toStrictEqual(['outputs/consolidated-2025-05.xlsx がない']);

    // The agent wrote a workbook whose total is not the report's.
    const changed = workspaceFor(
      followInstructions(undefined, (report) => ({
        ...report,
        comparison: {
          ...report.comparison,
          total: { ...report.comparison.total, current: 8_000_000 },
        },
      })),
    );
    const other = await approvePlan(
      changed.aw,
      await proposePlan(changed.aw, changed.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(other.status).toBe('refused');
    expect(other.mismatches).toStrictEqual(['consolidated-2025-05.xlsx の内容が報告と違う']);

    // The agent wrote bytes that do not open as a workbook: a mismatch, not a crash.
    const script = followInstructions();
    const corrupt = workspaceFor((context) =>
      script({
        ...context,
        write: (name) => context.write(name, new TextEncoder().encode('not a zip')),
      }),
    );
    const unreadable = await approvePlan(
      corrupt.aw,
      await proposePlan(corrupt.aw, corrupt.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(unreadable.status).toBe('refused');
    expect(unreadable.mismatches).toStrictEqual(['consolidated-2025-05.xlsx の内容が報告と違う']);
  });

  it('the backend refuses a plan that leaves a workbook out or a unit unstated', async () => {
    const osaka = PLAN.layouts.find((layout) => layout.branch === '大阪');
    if (osaka === undefined) throw new Error('the plan has no 大阪 layout');
    const sloppy = {
      ...PLAN,
      layouts: PLAN.layouts
        .filter((layout) => layout.sheet !== 'R7.5')
        .map((layout) => (layout.branch === '札幌' ? { ...layout, unit: null } : layout))
        .concat([{ ...osaka, branch: '神戸', files: ['神戸支店/売上.xlsx'] }]),
    };
    const workspace = workspaceFor(async (context) => {
      for (const query of FIRST_QUERIES) await context.builtin('search_files', { query });
      await context.native('Write', planWrite(sloppy));
      throw new Error('the plan should have stopped at its Write');
    });
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    expect(proposal.plan).toBeNull();
    expect(proposal.problems).toStrictEqual([
      'layouts[4]: 単位（unit）が明示されていない',
      '福岡支店/福岡支店売上報告（令和7年5月）.xlsx が計画にも除外にもない',
      '神戸支店/売上.xlsx は search_files が返していない',
    ]);
    // Nothing the person could approve: the approval is refused before it reaches the run.
    await expect(approvePlan(workspace.aw, proposal)).rejects.toThrow(/not approvable/u);
    expect(workspace.runs).toHaveLength(1);
  });

  it('a rejected plan comes back revised with the person’s comment, and the revision pauses for approval again', async () => {
    const revisedPlan = {
      ...PLAN,
      layouts: PLAN.layouts.map((layout) =>
        layout.branch === '東京'
          ? { ...layout, skip: [...(layout.skip ?? []), '（参考）'] }
          : layout,
      ),
    };
    let revised = false;
    const workspace = workspaceFor(
      followInstructions(undefined, undefined, (prompt) => {
        if (prompt.startsWith('rejected')) revised = true;
        return revised ? revisedPlan : PLAN;
      }),
    );
    const first = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);

    const second = await rejectPlan(workspace.aw, first, '東京の「（参考）」行も除いてください');
    expect(workspace.runs[1]?.prompt).toBe('rejected: 東京の「（参考）」行も除いてください');
    // A rejected call is not admitted: the revision meets the gate again and waits.
    expect(workspace.runs[1]?.approvedToolCalls).toStrictEqual([]);
    expect(second.problems).toStrictEqual([]);
    expect(second.plan).toStrictEqual(revisedPlan);
    expect(second.runId).not.toBe(first.runId);
    expect(second.sessionId).toBe(first.sessionId);
    // The files found in the first run still account for the revised plan.
    expect(second.found).toStrictEqual(first.found);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');

    const result = await approvePlan(workspace.aw, second);
    expect(result.status).toBe('accepted');
    expect(workspace.runs[2]?.prompt).toBe('approved');
  });

  it('a decision on a run that is not waiting is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = workspaceFor(followInstructions());
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS);
    await approvePlan(workspace.aw, proposal);

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(approvePlan(workspace.aw, proposal)).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(rejectPlan(workspace.aw, proposal, 'やはり違う')).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend refuses a run that finished without stopping at the plan’s approval', async () => {
    const workspace = workspaceFor(async () => {
      const report = await consolidate(PLAN);
      const text = explain(report);
      return { text, structured: { explanation: text, report } };
    });
    await expect(
      proposePlan(workspace.aw, workspace.agentId, REQUEST, PLANNER, ACCESS),
    ).rejects.toThrow(/without stopping for the plan's approval/u);
  });

  it('the backend refuses an explanation that quotes a number the script did not compute', async () => {
    const inflated = workspaceFor(
      followInstructions((text, report) => [
        `${text}\n東京は前月比 +25.0% と大きく伸び、約290万円になりました。`,
        report,
      ]),
    );
    const proposal = await proposePlan(inflated.aw, inflated.agentId, REQUEST, PLANNER, ACCESS);
    const result = await approvePlan(inflated.aw, proposal);
    expect(result.status).toBe('refused');
    expect(result.ungrounded).toStrictEqual(['25.0%', '290万']);
    expect(result.mismatches).toStrictEqual([]);

    // A report whose stated total its own rows do not add up to is refused as well.
    const tampered = workspaceFor(
      followInstructions((text, report) => [
        text,
        {
          ...report,
          comparison: {
            ...report.comparison,
            total: { ...report.comparison.total, current: 8_000_000 },
          },
        },
      ]),
    );
    const second = await approvePlan(
      tampered.aw,
      await proposePlan(tampered.aw, tampered.agentId, REQUEST, PLANNER, ACCESS),
    );
    expect(second.status).toBe('refused');
    expect(second.mismatches).toStrictEqual(['合計 2025-05: 報告 8000000、再計算 7920000']);
  });

  it('the monthly schedule trigger starts the plan run when it is due, as the planner it names', async () => {
    const workspace = workspaceFor(followInstructions());
    const created = await workspace.aw.triggers.create({
      ...MONTHLY_TRIGGER,
      agentId: workspace.agentId,
    });
    // A schedule has no URL to call: the answer is the trigger and nothing else.
    expect('secret' in created).toBe(false);
    expect(created.trigger).toMatchObject({
      kind: 'schedule',
      cron: '0 9 1 * *',
      timezone: 'Asia/Tokyo',
      hasSecret: false,
    });
    expect(workspace.runs).toHaveLength(0);

    const run = await workspace.fireSchedule(created.trigger.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toBe(MONTHLY_TRIGGER.prompt);
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['explanation', 'report'],
    });

    // A schedule has no person behind it, so the trigger's subject is the caller (ADR-0156). A trigger
    // carries no fileScope: the run searches every granted branch folder, pauses on its plan, and the
    // backend checks the plan against the folders that planner may see.
    expect(created.trigger.subject).toBe(PLANNER);
    expect(workspace.runs[0]?.subject).toBe(PLANNER);
    expect(workspace.runs[0]?.fileScope).toBeNull();
    const proposal = await proposePlanFromRun(
      workspace.aw,
      run.id,
      MONTHLY_TRIGGER.subject,
      ACCESS,
    );
    expect(proposal.problems).toStrictEqual([]);
    expect(proposal.found).toHaveLength(11);
    expect(proposal.plan).toStrictEqual(PLAN);
    expect(proposal.subject).toBe(PLANNER);
    expect(proposal.fileScope).toStrictEqual(ACCESS[PLANNER]?.folders);

    // Named as a subject who may see less, the same run's plan is not confirmable.
    const narrower = await proposePlanFromRun(workspace.aw, run.id, SAPPORO_MANAGER, ACCESS);
    expect(narrower.plan).toBeNull();
    expect(narrower.problems.some((problem) => problem.includes('東京支店/'))).toBe(true);
  });
});
