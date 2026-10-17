/**
 * Use case 6, the Excel consolidation agent: the definition passes the contract, the file search
 * stays inside its root, the skill script turns five incompatible layouts into one table with a
 * source cell for every value, and the backend's two-turn flow validates the plan and refuses an
 * explanation that quotes a number the script did not compute. See `../README.md` for the tiers.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import { readXlsx, writeXlsx } from '../shared/skills/office-reader/scripts/ooxml.mjs';
import {
  proposePlan,
  runConfirmedPlan,
  splitJsonBlock,
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
import agentDefinition from './agents/excel-consolidation.ts';
import surfaceDefinition from './surfaces/planning.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OOXML = path.join(DIR, '..', 'shared', 'skills', 'office-reader', 'scripts', 'ooxml.mjs');
const CONSOLIDATE = path.join(DIR, 'skills', 'excel-consolidate', 'scripts', 'consolidate.mjs');
const PLAN = JSON.parse(
  readFileSync(path.join(DIR, 'data', 'mapping-plan.json'), 'utf8'),
) as MappingPlan;
const DATA = path.join(DIR, 'data');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000006';
const REQUEST = '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して';
const run = promisify(execFile);

interface Hit {
  readonly path: string;
  readonly localPath: string;
  readonly size: number;
  readonly modified: string;
}

let root: string;
let work: string;
let finder: McpSession;
let project: GalleryProject;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'branch-reports-'));
  work = mkdtempSync(path.join(tmpdir(), 'consolidate-work-'));
  writeBranchWorkbooks(root);
  // A link inside the root that points out of it: following it would leave the root.
  symlinkSync(tmpdir(), path.join(root, '外部リンク'));
  finder = await startMcpServer(path.join(DIR, 'mcp', 'file-finder.mjs'), { FILE_ROOT: root });
  project = await loadGalleryProject(DIR, {
    'agents/excel-consolidation.ts': agentDefinition,
    'surfaces/planning.ts': surfaceDefinition,
  });
});
afterAll(() => {
  finder.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** Run a skill script as the agent's shell would, in the folder holding the workbooks. */
async function node(script: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [script, ...args], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** office-reader, then save next to the others as `<file name>.json`, as the skill says. */
async function readWorkbook(file: string): Promise<string> {
  const json = path.join(work, `${path.basename(file)}.json`);
  writeFileSync(json, await node(OOXML, ['xlsx', file]));
  return json;
}

/** apply + compare, the way the skill's step 3 runs them. */
async function consolidate(plan: MappingPlan): Promise<Report> {
  const books = await Promise.all(plan.layouts.flatMap((layout) => layout.files).map(readWorkbook));
  const planFile = path.join(work, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const applied = path.join(work, 'applied.json');
  writeFileSync(applied, await node(CONSOLIDATE, ['apply', planFile, ...books]));
  return JSON.parse(await node(CONSOLIDATE, ['compare', applied, plan.from, plan.to])) as Report;
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

const block = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/**
 * What a model following `agents/excel-consolidation.md` does. Turn 1: search twice, read and
 * inspect every workbook, propose the plan (the one in `data/mapping-plan.json`) and stop. Turn 2:
 * run the confirmed plan through the script and explain from its output. Every tool result and
 * script output is real; `rewrite` lets a test make the model misbehave.
 */
function followInstructions(
  rewrite: (explanation: string, report: Report) => [string, unknown] = (text, report) => [
    text,
    report,
  ],
) {
  return async (context: ScriptContext): Promise<string> => {
    const confirmed = splitJsonBlock(context.prompt).json as MappingPlan | undefined;
    if (confirmed === undefined) {
      const found = new Set<string>();
      for (const query of ['売上', '月次']) {
        const result = await context.tool('file-finder', 'find_files', {
          query,
          extension: 'xlsx',
        });
        for (const hit of JSON.parse(result.text) as Hit[]) found.add(hit.path);
      }
      // One inspect call over every workbook: its `unit` per sheet is what the plan's `unit` says.
      await node(CONSOLIDATE, ['inspect', ...(await Promise.all([...found].map(readWorkbook)))]);
      return [
        '各拠点の Excel を次のように読みます。東京・名古屋・札幌は千円単位、大阪・福岡は円単位です。',
        '福岡はシート名が月ごとに違うため、月ごとに分けました。テンプレートは除外します。',
        'この計画で集計してよいですか。',
        '',
        block(PLAN),
      ].join('\n');
    }
    const report = await consolidate(confirmed);
    const [text, json] = rewrite(explain(report), report);
    return `${text}\n\n${block(json)}`;
  };
}

const workspaceFor = (script: (context: ScriptContext) => Promise<string>) =>
  scriptedWorkspace(script, { 'file-finder': { id: CONNECTOR_ID, session: finder } });

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
      .map((name) => name.normalize('NFC'));
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
      writeFiles: false,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    expect(definition?.policy).toMatchObject({
      tools: { permissionMode: 'default', autoApprove: ['Bash'] },
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['file-finder'],
      skills: ['office-reader', 'excel-consolidate'],
    });
    expect(definition?.agent.instructions).toContain('find_files');
    // Turn 1 is a few tool calls, not one pair per file, and names each branch's unit.
    expect(definition?.agent.instructions).toContain('`inspect` を1回');
    expect(definition?.agent.instructions).toContain('拠点ごとの単位');
    // The agent never opens SKILL.md, so the plan's keys must be in its own instructions.
    expect(definition?.agent.instructions).toContain('"layouts"');
    expect(definition?.agent.instructions).toContain('"excluded"');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'excel-consolidate',
      'office-reader',
    ]);
    // Each skill is uploaded as its own directory: consolidate.mjs must not reach into another.
    const consolidateSkill = project.skills.find((skill) => skill.name === 'excel-consolidate');
    const script = consolidateSkill?.files.find((file) => file.path === 'scripts/consolidate.mjs');
    const source = Buffer.from(script?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(source).not.toMatch(/from '\.\.?\//u);
    const surface = agent?.body.surfaces?.[0];
    expect(surface).toMatchObject({ name: 'planning' });
    expect(surface?.toolResults).toBeUndefined();
    expect(project.project.policy?.permissions).toMatchObject({
      runCommands: true,
      writeFiles: false,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(3);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(cases[0]?.expect.notContains).toContain('"comparison"');
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('find_files finds both months of every branch by name and refuses a folder outside the root', async () => {
    expect(await finder.tools()).toStrictEqual(['find_files']);

    const sales = await finder.callJson<Hit[]>('find_files', { query: '売上', extension: 'xlsx' });
    expect(sales.map((hit) => hit.path)).toStrictEqual([
      '共通/売上報告テンプレート.xlsx',
      '名古屋営業所/名古屋_売上_R7.4.xlsx',
      '名古屋営業所/名古屋_売上_R7.5.xlsx',
      '大阪支店/大阪 月次売上 202504.xlsx',
      '大阪支店/大阪 月次売上 202505.xlsx',
      '東京支店/東京_売上報告_2025年4月.xlsx',
      '東京支店/東京_売上報告_2025年5月.xlsx',
      '福岡支店/福岡支店売上報告（令和7年4月）.xlsx',
      '福岡支店/福岡支店売上報告（令和7年5月）.xlsx',
    ]);
    expect(sales.find((hit) => hit.path.includes('2025年5月'))?.modified).toBe(
      '2025-06-06T09:00:00.000Z',
    );
    // `localPath` is what a run opens: the same file, absolute, inside the root, ending in `path`.
    for (const hit of sales) {
      expect(path.isAbsolute(hit.localPath), hit.path).toBe(true);
      expect(hit.localPath.startsWith(`${realpathSync(root)}${path.sep}`), hit.path).toBe(true);
      expect(
        hit.localPath
          .normalize('NFC')
          .endsWith(hit.path.normalize('NFC').split('/').join(path.sep)),
      ).toBe(true);
      expect(existsSync(hit.localPath), hit.path).toBe(true);
    }
    // 札幌 calls it 月次報告: a second query is needed, as the instructions say.
    const monthly = await finder.callJson<Hit[]>('find_files', {
      query: '月次',
      extension: '.XLSX',
    });
    expect(monthly.map((hit) => hit.path)).toContain('札幌営業所/札幌_月次報告_2025-05.xlsx');
    // Full-width input and several terms; without an extension the .txt note is found too.
    const tokyo = await finder.callJson<Hit[]>('find_files', {
      query: '東京　売上',
      folder: '東京支店',
    });
    expect(tokyo.map((hit) => hit.path)).toContain('東京支店/売上報告の書き方.txt');
    expect(tokyo.map((hit) => hit.path)).not.toContain('東京支店/東京_経費精算_2025年5月.xlsx');

    for (const folder of [
      '..',
      '../..',
      '東京支店/../../',
      '外部リンク',
      root.slice(0, root.lastIndexOf('/')),
    ]) {
      const refused = await finder.call('find_files', { query: 'xlsx', folder });
      expect(refused.isError, folder).toBe(true);
    }
    expect((await finder.call('find_files', { query: '  ' })).isError).toBe(true);
    expect(await finder.callJson<Hit[]>('find_files', { query: '議事録' })).toStrictEqual([]);
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
    const books = await Promise.all(files.map(readWorkbook));
    const inspected = JSON.parse(await node(CONSOLIDATE, ['inspect', ...books])) as {
      file: string;
      sheets: { sheet: string; unit: string | null; unitFrom: string | null }[];
    }[];
    expect(inspected.map((entry) => entry.file)).toStrictEqual(
      files.map((file) => `${path.basename(file)}.json`),
    );
    for (const layout of PLAN.layouts) {
      for (const file of layout.files) {
        const entry = inspected.find((item) => item.file === `${path.basename(file)}.json`);
        const sheet = entry?.sheets.find((item) => item.sheet === layout.sheet);
        expect(sheet?.unit, `${file} ${layout.sheet}`).toBe(layout.unit);
        expect(sheet?.unitFrom, file).not.toBeNull();
      }
    }
    // 福岡 and 札幌 state it in a 単位 row, 東京 in the header; 札幌's cover sheet states nothing.
    const sheetOf = (file: string, sheet: string) =>
      inspected
        .find((item) => item.file === `${path.basename(file)}.json`)
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

  it('the backend shows a validated plan, then continues the session and accepts a grounded explanation', async () => {
    const workspace = workspaceFor(followInstructions());

    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST);
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
    expect(proposal.explanation).toContain('この計画で集計してよいですか');

    const result = await runConfirmedPlan(workspace.aw, workspace.agentId, proposal);
    expect(result.mismatches).toStrictEqual([]);
    expect(result.ungrounded).toStrictEqual([]);
    expect(result.status).toBe('accepted');
    expect(result.explanation).toContain('合計 7,920,000円');
    expect(result.explanation).toContain('東京: 2,800,000円（前月比 +500,000円、+21.7%）');
    expect(result.explanation).toContain('大阪: 2,015,000円（前月比 △245,000円、△10.8%）');
    expect(result.report?.comparison.total.diff).toBe(509_500);

    // One conversation: turn 2 continued turn 1's session, with the confirmed plan in the prompt.
    expect(result.sessionId).toBe(proposal.sessionId);
    expect(workspace.runs.map((entry) => entry.sessionId)).toStrictEqual([
      proposal.sessionId,
      proposal.sessionId,
    ]);
    expect(workspace.calls.filter((call) => call.method === 'POST')[1]?.json).toMatchObject({
      sessionId: proposal.sessionId,
    });
    expect(workspace.runs[1]?.prompt).toContain('"unit": "千円"');
  });

  it('the backend refuses a plan that leaves a workbook out or a unit unstated', async () => {
    const osaka = PLAN.layouts.find((layout) => layout.branch === '大阪');
    if (osaka === undefined) throw new Error('the plan has no 大阪 layout');
    const sloppy = {
      ...PLAN,
      layouts: PLAN.layouts
        .filter((layout) => layout.sheet !== 'R7.5')
        .map((layout) => (layout.branch === '札幌' ? { ...layout, unit: '不明' } : layout))
        .concat([{ ...osaka, branch: '神戸', files: ['神戸支店/売上.xlsx'] }]),
    };
    const workspace = workspaceFor(async (context) => {
      await context.tool('file-finder', 'find_files', { query: '売上', extension: 'xlsx' });
      await context.tool('file-finder', 'find_files', { query: '月次', extension: 'xlsx' });
      return `この計画で集計してよいですか。\n\n${block(sloppy)}`;
    });
    const proposal = await proposePlan(workspace.aw, workspace.agentId, REQUEST);
    expect(proposal.plan).toBeNull();
    expect(proposal.problems).toStrictEqual([
      'layouts[4]: 単位（unit）が明示されていない',
      '福岡支店/福岡支店売上報告（令和7年5月）.xlsx が計画にも除外にもない',
      '神戸支店/売上.xlsx は find_files が返していない',
    ]);
    await expect(runConfirmedPlan(workspace.aw, workspace.agentId, proposal)).rejects.toThrow(
      /not confirmable/u,
    );
    expect(workspace.runs).toHaveLength(1);
  });

  it('the backend refuses an explanation that quotes a number the script did not compute', async () => {
    const inflated = workspaceFor(
      followInstructions((text, report) => [
        `${text}\n東京は前月比 +25.0% と大きく伸び、約290万円になりました。`,
        report,
      ]),
    );
    const proposal = await proposePlan(inflated.aw, inflated.agentId, REQUEST);
    const result = await runConfirmedPlan(inflated.aw, inflated.agentId, proposal);
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
    const second = await runConfirmedPlan(
      tampered.aw,
      tampered.agentId,
      await proposePlan(tampered.aw, tampered.agentId, REQUEST),
    );
    expect(second.status).toBe('refused');
    expect(second.mismatches).toStrictEqual(['合計 2025-05: 報告 8000000、再計算 7920000']);
  });
});
