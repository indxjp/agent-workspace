/**
 * Use case 10, the quality defect and past-trouble (過去トラ) analysis agent: the definition passes
 * the contract under a confidential policy ceiling, the defect database answers like a quality
 * system should, the eight-d skill's script checks a draft, and the backend turns a run into an 8D
 * draft whose every Q-number, 4M count and recurrence flag it has checked.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  policyWidenings,
  type EffectivePolicyConfiguration,
} from '@indx-workspace/contracts/policy-ceiling';
import {
  defineAgent,
  mcp,
  skill,
  toAgentVersionBody,
  type DefinedAgent,
} from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import {
  analyseDefect,
  InvalidDefectReport,
  reviseAfterReview,
  type CauseStats,
  type NewDefect,
  type NoMatch,
  type PastCase,
} from './backend/analyse.ts';
import { parseEightD } from './skills/eight-d/scripts/eightd.mjs';
import agentDefinition from './agents/quality-defect.ts';
import surfaceDefinition from './surfaces/qa.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'skills', 'eight-d', 'scripts', 'eightd.mjs');
const SAMPLE = path.join(DIR, 'skills', 'eight-d', 'examples', '8d-sample.md');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000010';
const run = promisify(execFile);

interface Defect extends PastCase {
  readonly whys: readonly string[];
  readonly countermeasure: string;
  readonly horizontalDeployment: string;
  readonly citation: string;
}

const BURR: NewDefect = {
  phenomenon: 'バリ',
  partNo: 'BRK-2201',
  lot: 'L260928-2',
  process: 'プレス',
  count: 48,
  detail: 'せん断面のバリ高さ0.25mm（規格0.1mm以下）',
};

let db: McpSession;
let project: GalleryProject;

beforeAll(async () => {
  db = await startMcpServer(path.join(DIR, 'mcp', 'defect-db.mjs'));
  project = await loadGalleryProject(DIR, {
    'agents/quality-defect.ts': agentDefinition,
    'surfaces/qa.ts': surfaceDefinition,
  });
});
afterAll(() => {
  db.close();
});

const field = (prompt: string, name: string): string =>
  new RegExp(`^${name}: (.+)$`, 'mu').exec(prompt)?.[1]?.trim() ?? '';

/** The draft a model following the skill writes from what the tools returned. */
function draftOf(
  input: { phenomenon: string; partNo: string; lot: string; process: string; count: string },
  best: Defect,
  matched: readonly PastCase[],
  stats: CauseStats,
  extra = '',
): string {
  const same = matched.filter((hit) => hit.causeCode === best.causeCode);
  const recurred = same.filter((hit) => hit.recurred === '有');
  const cite = (ids: readonly string[]): string => `〔過去トラ ${ids.join('、')}〕`;
  const whys = best.whys.map((why, index) => `- なぜ${String(index + 1)}: ${why}${best.citation}`);
  return [
    `# 8Dレポート（下書き）: ${input.partNo} ${input.phenomenon} ${input.lot}`,
    '## D1 チーム編成',
    `- 品質保証課（${input.process}担当）、製造係長、保全、生産技術。`,
    '## D2 問題の記述',
    `- ${input.partNo} の${input.phenomenon}。${input.process}工程、ロット ${input.lot}、発生数 ${input.count}。`,
    '## D3 暫定対策',
    `- 同ロットと前後ロットを全数選別する${best.citation}。${extra}`,
    '## D4 根本原因（なぜなぜ分析）',
    `原因区分: ${best.causeCode}`,
    stats.line,
    ...whys,
    `- 根本原因: ${best.whys.at(-1) ?? ''}${cite(same.map((hit) => hit.id))}`,
    '## D5 恒久対策の選定',
    `- ${best.countermeasure}${best.citation}`,
    '## D6 恒久対策の実施と効果確認',
    '- 実施後3か月、抜き取り測定で効果を確認する。',
    '## D7 再発防止（水平展開・FMEA反映）',
    ...(recurred.length > 0
      ? [`- 再発: ${cite(recurred.map((hit) => hit.id))}と同一原因（${best.causeCode}）。`]
      : []),
    `- ${best.horizontalDeployment}${best.citation}`,
    '## D8 完了と振り返り',
    '- DR で承認後、過去トラとして登録する。',
  ].join('\n');
}

const NOT_FOUND =
  '類似する過去トラは見つかりませんでした。品質保証課で新規不具合として登録してください。';

/**
 * What a model following `agents/quality-defect.md` does: search by phenomenon and process (then
 * without the process), read the best cases, take the 4M line from cause_stats, write the 8D. The
 * decisions are scripted; every tool result is the real server's.
 */
function followInstructions(): (context: ScriptContext) => Promise<string> {
  const conversations = new Map<string, string>();
  return async (context) => {
    const comment = /^DR指摘: (.+)$/mu.exec(context.prompt)?.[1];
    const prompt =
      comment === undefined ? context.prompt : (conversations.get(context.sessionId) ?? '');
    conversations.set(context.sessionId, prompt);
    const input = {
      phenomenon: field(prompt, '現象'),
      partNo: field(prompt, '品番'),
      lot: field(prompt, 'ロット'),
      process: field(prompt, '工程'),
      count: field(prompt, '発生数'),
    };
    let args: Record<string, unknown> = { query: input.phenomenon, process: input.process };
    let hits = JSON.parse((await context.tool('defect-db', 'search_defects', args)).text) as
      PastCase[] | NoMatch;
    if (!Array.isArray(hits)) {
      args = { query: input.phenomenon };
      hits = JSON.parse((await context.tool('defect-db', 'search_defects', args)).text) as
        PastCase[] | NoMatch;
    }
    // No match: paste the server's sentence and stop, as the first rule says.
    if (!Array.isArray(hits)) return hits.message;
    const first = hits.find((hit) => hit.partNo === input.partNo) ?? hits[0];
    if (first === undefined) throw new Error('search_defects returned an empty array');
    const best = JSON.parse(
      (await context.tool('defect-db', 'get_defect', { id: first.id })).text,
    ) as Defect;
    const stats = JSON.parse(
      (await context.tool('defect-db', 'cause_stats', args)).text,
    ) as CauseStats;
    const extra = comment === undefined ? '' : `（DR指摘反映: ${comment}）`;
    return draftOf(input, best, hits, stats, extra);
  };
}

function effectiveOf(agent: DefinedAgent): EffectivePolicyConfiguration {
  const { definition } = toAgentVersionBody(agent, { instructions: 'x' });
  return {
    permissions: definition.agent.permissions,
    limits: {
      maxTurns: definition.policy?.limits.maxTurns ?? null,
      maxBudgetUsd: definition.policy?.limits.maxBudgetUsd ?? null,
    },
    engine: 'claude-agent-sdk',
    model: null,
    tools: definition.resources.connectors,
  };
}

describe('quality defect and past-trouble analysis agent', () => {
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
    // No web tools reach a run of this agent, whatever the model asks for.
    const policy = definition?.policy;
    if (policy?.engine !== 'claude-agent-sdk') throw new Error('expected a Claude policy');
    expect(policy.tools.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
    // ...and Bash stays denied; run_skill_script runs the eight-d script and is pre-approved: an
    // unattended run cannot answer an approval prompt.
    expect(policy.tools.deny).not.toContain('Bash');
    expect(policy.tools.autoApprove).toStrictEqual(['mcp__agent-workspace__run_skill_script']);
    expect(definition?.resources).toMatchObject({
      connectors: ['defect-db'],
      skills: ['eight-d'],
      files: [{ path: 'fmea', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('cause_stats');
    // The no-match answer is the first rule, exclusive, and the eval's exact sentence.
    const instructions = definition?.agent.instructions ?? '';
    expect(instructions).toContain(NOT_FOUND);
    expect(instructions.indexOf(NOT_FOUND)).toBeLessThan(instructions.indexOf('手順:'));
    expect(instructions).toContain('他のツールを呼ばず');
    expect(instructions).toContain('`noMatch: true`');
    const [surface] = agent?.body.surfaces ?? [];
    expect(surface).toMatchObject({
      name: 'qa',
      layout: 'page',
      parts: { toolTrace: 'full', feedback: true },
    });
    expect(project.skills.map((entry) => entry.name)).toStrictEqual(['eight-d']);
    expect(project.skills[0]?.files.map((file) => file.path).sort()).toStrictEqual([
      'SKILL.md',
      'examples/8d-sample.md',
      'scripts/eightd.d.mts',
      'scripts/eightd.mjs',
    ]);
  });

  it('the policy ceiling keeps defect data inside: no network, one connector, a budget', () => {
    const policy = project.project.policy;
    expect(policy?.permissions).toStrictEqual({ writeFiles: false, unrestrictedNetwork: false });
    expect(policy?.limits).toStrictEqual({ maxTurns: 20, maxBudgetUsd: 1.5 });
    expect(policy?.tools).toStrictEqual(['defect-db']);
    expect(policy?.promotion?.minEvalScore).toBe(0.9);

    const agent = project.agents[0]?.definition;
    if (agent === undefined) throw new Error('no agent');
    expect(policyWidenings(effectiveOf(agent), policy)).toStrictEqual([]);

    // Someone adds web search "to compare with industry cases": the ceiling refuses every part.
    const widened = defineAgent({
      ...agent,
      permissions: { ...agent.permissions, unrestrictedNetwork: true },
      tools: [mcp('defect-db'), mcp('web-search')],
      skills: [skill('eight-d')],
      limits: { maxTurns: 16, maxBudgetUsd: 5 },
    });
    expect(policyWidenings(effectiveOf(widened), policy)).toStrictEqual([
      'permissions.unrestrictedNetwork',
      'limits.maxBudgetUsd',
      'tool:web-search',
    ]);
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(5);
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔過去トラ'))).toBe(true);
    expect(cases.some((entry) => entry.expect.judge !== undefined)).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
  });

  it('the defect database finds similar cases, counts 4M deterministically, and refuses bad input', async () => {
    expect(await db.tools()).toStrictEqual(['search_defects', 'get_defect', 'cause_stats']);

    const burrs = await db.callJson<PastCase[]>('search_defects', {
      query: 'バリ',
      process: 'プレス',
    });
    expect(burrs.map((hit) => hit.id).sort()).toStrictEqual([
      'Q-1003',
      'Q-1011',
      'Q-1019',
      'Q-1042',
      'Q-1061',
    ]);
    // 品番 filters by prefix and ignores case; full-width input is normalised by the index.
    const family = await db.callJson<PastCase[]>('search_defects', {
      query: 'ﾊﾞﾘ',
      partNo: 'brk-2205',
    });
    expect(family.map((hit) => hit.id).sort()).toStrictEqual(['Q-1019', 'Q-1061']);

    const record = await db.callJson<Defect>('get_defect', { id: 'q-1011' });
    expect(record).toMatchObject({
      id: 'Q-1011',
      causeCode: '金型摩耗',
      fourM: '機械',
      recurred: '有',
    });
    expect(record.citation).toBe('〔過去トラ Q-1011〕');
    expect(record.whys.length).toBeGreaterThanOrEqual(3);

    const stats = await db.callJson<CauseStats>('cause_stats', {
      query: 'バリ',
      process: 'プレス',
    });
    expect(stats.fourM).toStrictEqual({ 人: 1, 機械: 2, 材料: 1, 方法: 1 });
    expect(stats.line).toBe('4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）');
    expect(await db.callJson('cause_stats', { query: 'バリ', process: 'プレス' })).toStrictEqual(
      stats,
    );
    const paint = await db.callJson<CauseStats>('cause_stats', {
      query: '塗装ムラ',
      process: '塗装',
    });
    expect(paint.line).toBe('4M集計: 人 1件 / 機械 0件 / 材料 1件 / 方法 2件（類似 4件）');

    // Nothing above the coverage threshold: an explicit noMatch and the exact answer to paste.
    const none = await db.callJson<NoMatch>('search_defects', { query: '社員食堂の配膳遅れ' });
    expect(none).toStrictEqual({ noMatch: true, message: NOT_FOUND });
    expect(none.message).toContain('類似する過去トラは見つかりませんでした');
    expect((await db.call('search_defects', { query: 'バリ', process: '鋳造' })).isError).toBe(
      true,
    );
    expect((await db.call('search_defects', { query: '  ' })).isError).toBe(true);
    expect((await db.call('get_defect', { id: 'Q-9999' })).isError).toBe(true);
    expect((await db.call('get_defect', { id: '../../etc/passwd' })).isError).toBe(true);
  });

  it('the eight-d script validates a draft from the command line, as the agent runs it', async () => {
    const good = await run(process.execPath, [SCRIPT, SAMPLE]);
    const parsed = JSON.parse(good.stdout) as ReturnType<typeof parseEightD>;
    expect(parsed.valid).toBe(true);
    expect(parsed.sections.map((section) => section.id)).toStrictEqual([
      'D1',
      'D2',
      'D3',
      'D4',
      'D5',
      'D6',
      'D7',
      'D8',
    ]);
    expect(parsed.whys.map((why) => why.depth)).toStrictEqual([1, 2, 3]);
    expect(parsed.causeCode).toBe('金型摩耗');
    expect(parsed.fourM?.counts).toStrictEqual({ 人: 1, 機械: 2, 材料: 1, 方法: 1 });

    const bad = [
      '## D1 チーム',
      '## D2 問題',
      '## D3 暫定',
      '## D4 根本原因',
      '- なぜ1: パンチが摩耗した〔過去トラ Q-1003〕',
      '- なぜ2: 研磨が遅れた',
      '## D5 対策',
      '## D5 対策（再掲）',
      '## D7 水平展開',
      '## D8 完了',
    ].join('\n');
    const failed = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [SCRIPT, '--text', bad], (error, stdout) => {
        resolve({ code: error === null ? 0 : (error.code as number | null), stdout });
      });
    });
    expect(failed.code).toBe(1);
    const result = JSON.parse(failed.stdout) as ReturnType<typeof parseEightD>;
    expect(result.issues.map((issue) => issue.code)).toStrictEqual([
      'duplicate_section',
      'missing_section',
      'shallow_whys',
      'missing_root_cause',
      'uncited_claim',
    ]);
  });

  it('the skeleton in the agent instructions, filled in, passes the checker on the first try', async () => {
    const instructions = await readFile(path.join(DIR, 'agents', 'quality-defect.md'), 'utf8');
    const skeleton = (/```md\n([\s\S]*?)```/u.exec(instructions)?.[1] ?? '').replace(
      /^ {3}/gmu,
      '',
    );
    const filled = skeleton
      .replace(/^(原因区分: ).*$/mu, '$1金型摩耗')
      .replace(/^(4M集計: ).*$/mu, '$1人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）')
      .replace(/^(- (?:なぜ\d|根本原因): )…/gmu, '$1理由')
      .replace(/^(## D[1-35-8].*)$/gmu, '$1\n\n- 本文');
    const parsed = parseEightD(filled.replaceAll('Q-xxxx', 'Q-1003'));
    expect(parsed.issues).toStrictEqual([]);
    expect(parsed.valid).toBe(true);
  });

  it('the eight-d parser reads full-width numbering and a multi-case citation', () => {
    const draft = parseEightD(
      [
        '## Ｄ１ チーム',
        '## D2 問題',
        '## D3 暫定',
        '## D4 根本原因',
        '原因区分：金型摩耗',
        '4M集計：人 0件 / 機械 2件 / 材料 0件 / 方法 0件（類似 2件）',
        '- なぜ１：摩耗〔過去トラ Ｑ-１００３〕',
        '- なぜ２：研磨遅れ〔過去トラ Q-1003、Q-1011〕',
        '- なぜ３：管理なし〔過去トラ Q-1011〕',
        '- 根本原因：仕組みがない〔過去トラ Q-1011〕',
        '## D5 a',
        '## D6 b',
        '## D8 d',
        '## D7 c',
      ].join('\n'),
    );
    expect(draft.sections[0]?.id).toBe('D1');
    expect(draft.whys.map((why) => why.depth)).toStrictEqual([1, 2, 3]);
    expect(draft.cites).toStrictEqual(['Q-1003', 'Q-1011']);
    expect(draft.fourM).toMatchObject({ counts: { 機械: 2 }, total: 2 });
    expect(draft.issues.map((issue) => issue.code)).toStrictEqual(['section_order']);
  });

  it('the backend returns a checked 8D draft and flags the recurrence of a recurring cause', async () => {
    const workspace = scriptedWorkspace(followInstructions(), {
      'defect-db': { id: CONNECTOR_ID, session: db },
    });
    const result = await analyseDefect(workspace.aw, workspace.agentId, BURR);

    expect(workspace.runs[0]?.prompt).toContain('現象: バリ\n品番: BRK-2201');
    expect(result.draft.valid).toBe(true);
    expect(result.draft.whys.length).toBeGreaterThanOrEqual(3);
    expect(result.unverifiedCases).toStrictEqual([]);
    expect(result.fourM).toMatchObject({
      status: 'verified',
      stats: { fourM: { 人: 1, 機械: 2, 材料: 1, 方法: 1 } },
    });
    expect(result.recurrence).toStrictEqual({
      causeCode: '金型摩耗',
      sameCause: ['Q-1003', 'Q-1011'],
      recurredCases: ['Q-1003', 'Q-1011'],
      recurring: true,
    });
    expect(result.answer).toContain('再発: 〔過去トラ Q-1003、Q-1011〕');
    expect(result.readyForReview).toBe(true);
    expect(result.findings).toStrictEqual([]);
  });

  it('the backend does not flag recurrence when the matched same-cause case never recurred', async () => {
    const workspace = scriptedWorkspace(followInstructions(), {
      'defect-db': { id: CONNECTOR_ID, session: db },
    });
    const result = await analyseDefect(workspace.aw, workspace.agentId, {
      phenomenon: 'ブローホール',
      partNo: 'ASY-6001',
      lot: 'L261002-1',
      process: '溶接',
      count: 22,
    });
    expect(result.recurrence).toStrictEqual({
      causeCode: '設備設定ずれ',
      sameCause: ['Q-2038'],
      recurredCases: [],
      recurring: false,
    });
    expect(result.readyForReview).toBe(true);
  });

  it('the backend holds back a draft that cites an unread case or miscounts the 4M', async () => {
    const workspace = scriptedWorkspace(
      async (context) => {
        await context.tool('defect-db', 'search_defects', { query: 'バリ', process: 'プレス' });
        await context.tool('defect-db', 'cause_stats', { query: 'バリ', process: 'プレス' });
        const sample = await readFile(SAMPLE, 'utf8');
        return sample
          .replace('機械 2件', '機械 3件')
          .replace('〔過去トラ Q-1042〕。\n\n## D6', '〔過去トラ Q-3002〕。\n\n## D6');
      },
      { 'defect-db': { id: CONNECTOR_ID, session: db } },
    );
    const result = await analyseDefect(workspace.aw, workspace.agentId, BURR);
    expect(result.draft.valid).toBe(true);
    expect(result.unverifiedCases).toStrictEqual(['Q-3002']);
    expect(result.fourM).toMatchObject({
      status: 'mismatch',
      computed: ['4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）'],
    });
    expect(result.readyForReview).toBe(false);
    expect(result.findings).toHaveLength(2);
  });

  it('the backend refuses an incomplete defect report before starting a run', async () => {
    const workspace = scriptedWorkspace(followInstructions(), {
      'defect-db': { id: CONNECTOR_ID, session: db },
    });
    const attempt = analyseDefect(workspace.aw, workspace.agentId, {
      ...BURR,
      partNo: 'BRK2201',
      process: '鋳造' as NewDefect['process'],
      count: 0,
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidDefectReport);
    await expect(attempt).rejects.toMatchObject({ fields: ['partNo', 'process', 'count'] });
    expect(workspace.runs).toHaveLength(0);
  });

  it('the backend reports no similar case honestly and does not put it on the DR agenda', async () => {
    const script = followInstructions();
    const used: string[] = [];
    const workspace = scriptedWorkspace(
      (context) =>
        script({
          ...context,
          tool: (connector, tool, args) => {
            used.push(tool);
            return context.tool(connector, tool, args);
          },
        }),
      { 'defect-db': { id: CONNECTOR_ID, session: db } },
    );
    const result = await analyseDefect(workspace.aw, workspace.agentId, {
      phenomenon: '配膳遅れ',
      partNo: 'CAF-0001',
      lot: 'なし',
      process: '組立',
      count: 1,
    });
    expect(result.answer).toBe(NOT_FOUND);
    // The run stopped at the searches: no case read, no 4M counted.
    expect(used).toStrictEqual(['search_defects', 'search_defects']);
    expect(result.matched).toStrictEqual([]);
    expect(result.recurrence.recurring).toBe(false);
    expect(result.readyForReview).toBe(false);
    expect(result.draft.issues.filter((issue) => issue.code === 'missing_section')).toHaveLength(8);
  });

  it('a DR comment goes back as a follow-up turn and the revised draft is checked again', async () => {
    const workspace = scriptedWorkspace(followInstructions(), {
      'defect-db': { id: CONNECTOR_ID, session: db },
    });
    const first = await analyseDefect(workspace.aw, workspace.agentId, BURR);
    const revised = await reviseAfterReview(
      workspace.aw,
      workspace.agentId,
      first.sessionId,
      '暫定対策に金型の研磨後ショット数の確認を加えること',
    );
    expect(revised.sessionId).toBe(first.sessionId);
    expect(workspace.runs.map((entry) => entry.sessionId)).toStrictEqual([
      first.sessionId,
      first.sessionId,
    ]);
    expect(workspace.runs[1]?.prompt).toMatch(/^DR指摘: 暫定対策に/u);
    expect(revised.draft.sections.find((section) => section.id === 'D3')?.body).toContain(
      '研磨後ショット数',
    );
    expect(revised.readyForReview).toBe(true);
    await expect(
      reviseAfterReview(workspace.aw, workspace.agentId, first.sessionId, '  '),
    ).rejects.toBeInstanceOf(InvalidDefectReport);
  });
});
