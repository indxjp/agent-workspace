/**
 * Use case 10, the quality defect and past-trouble (過去トラ) analysis agent: the definition passes
 * the contract under a confidential policy ceiling, the QMS API answers like a quality system
 * should, the eight-d skill's script checks a draft, and the backend turns a run into an 8D draft
 * whose every Q-number, 4M count and recurrence flag it has checked.
 *
 * The QMS is an `openapiTool()`, so the project ships no MCP server: a gateway double
 * (`../harness/openapi-gateway.ts`, which lists what it assumes) plays the platform's tool gateway
 * against a loopback fake QMS (`./qms/fake-qms.mjs`). A Claude run names its tools
 * `mcp__qms__searchDefects` and so on; the backend matches them by the `__<operation>` suffix.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  readXlsx,
  writeXlsx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  policyWidenings,
  type EffectivePolicyConfiguration,
} from '@indx-workspace/contracts/policy-ceiling';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
  TOOL_OPERATION_NAME_PATTERN,
} from '@indx-workspace/contracts/tool-connectors';
import {
  defineAgent,
  mcp,
  skill,
  toAgentVersionBody,
  toolDefinitionsOf,
  type DefinedAgent,
} from '@indx-workspace/sdk/define';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GALLERY_WORKSPACE_ID, signedHeaders } from '../harness/identity.ts';
import {
  isToolMethod,
  openapiGateway,
  operationsOf,
  type OpenApiDocument,
} from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import {
  analyseDefect,
  decideCase,
  DraftNotReady,
  InvalidDefectReport,
  type CaseOutcome,
  type CauseStats,
  type DefectAwaiting,
  type NewDefect,
  type NoMatch,
  type PastCase,
} from './backend/analyse.ts';
import { checkEightD, parseEightD } from './skills/eight-d/scripts/eightd.mjs';
import agentDefinition from './agents/quality-defect.ts';
import { PFMEA_SHEETS, writePfmea } from './data/fmea-workbook.ts';
import { startFakeQms, type FakeQms } from './qms/fake-qms.mjs';
import surfaceDefinition from './surfaces/qa.ts';
import { qms as qmsTool } from './tools/qms.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'skills', 'eight-d', 'scripts', 'eightd.mjs');
const SAMPLE = path.join(DIR, 'skills', 'eight-d', 'examples', '8d-sample.md');
const FMEA = path.join(DIR, 'data', 'fmea', 'press-pfmea.xlsx');
const OOXML_SCRIPT = path.join(
  DIR,
  '..',
  '..',
  '..',
  'packages',
  'skills-office',
  'office-reader',
  'scripts',
  'ooxml.mjs',
);
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000010';
const QMS_TOKEN = 'qms-test-token';
const SECRET = 'gallery-qms-secret-0123456789';
// Who entered the defect: both are in `data/access.json`; the second may see プレス cases only.
const QA_LEAD = '吉田 恒一';
const PRESS_ENGINEER = '松田 隆';
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

const document = JSON.parse(
  readFileSync(path.join(DIR, 'apis', 'qms.openapi.json'), 'utf8'),
) as OpenApiDocument;
const qmsGateway = (token: string | null = QMS_TOKEN, approvedToolCalls: readonly string[] = []) =>
  openapiGateway({
    document,
    allow: qmsTool.allow,
    baseUrl: qms.url,
    token,
    serverKey: toolServerKey('qms'),
    approvedToolCalls,
  });
/** The gateway as it is once the DR approved exactly this `createCase` body. */
const approvedCreate = (body: Record<string, unknown>) =>
  qmsGateway(QMS_TOKEN, [canonicalCall('mcp__qms__createCase', { body })]);

/** The headers the platform sends the QMS for a run started with `subject`. */
const asPerson = async (subject: string) => ({
  headers: await signedHeaders({ key: SECRET, connectorId: CONNECTOR_ID, subject }),
});

let qms: FakeQms;
let project: GalleryProject;
const registrations = (): number => qms.requests.filter((entry) => entry.method === 'POST').length;

beforeAll(async () => {
  qms = await startFakeQms({
    token: QMS_TOKEN,
    identity: { key: SECRET, audience: CONNECTOR_ID, workspace: GALLERY_WORKSPACE_ID },
  });
  project = await loadGalleryProject(DIR, {
    'agents/quality-defect.ts': agentDefinition,
    'surfaces/qa.ts': surfaceDefinition,
  });
});
afterAll(async () => {
  await qms.close();
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

/**
 * What the agent returns for a draft: the report, and the parts `eightd.mjs` printed when it ran the
 * script on that report (here the same script, run in-process).
 */
function answerOf(report: string): ScriptAnswer {
  const { title, sections, whys, claims, rootCause, causeCode, fourM } = parseEightD(report);
  const draft = { title, sections, whys, claims, rootCause, causeCode, fourM };
  return { text: report, structured: { report, draft } };
}

const NOT_FOUND =
  '類似する過去トラは見つかりませんでした。品質保証課で新規不具合として登録してください。';

/** A scripted workspace with the QMS tool; its write is gated by the gateway's own rules, as compose merges them. */
const qualityWorkspace = (script: (context: ScriptContext) => Promise<ScriptAnswer | string>) =>
  scriptedWorkspace(script, {
    qms: { id: CONNECTOR_ID, session: qmsGateway(), identityKey: SECRET },
  });

/** The backend's pause for `defect`, which the test expects to be approvable. */
async function pausedOn(
  workspace: ReturnType<typeof qualityWorkspace>,
  defect: NewDefect = BURR,
  subject: string = QA_LEAD,
): Promise<DefectAwaiting> {
  const outcome = await analyseDefect(workspace.aw, workspace.agentId, defect, subject);
  if (outcome.status !== 'awaiting_approval') {
    throw new Error(`nothing to approve: ${outcome.status}`);
  }
  return outcome;
}

/** The outcome of a decision the test expects to be a registration. */
function registeredOf(outcome: CaseOutcome): Extract<CaseOutcome, { status: 'registered' }> {
  if (outcome.status !== 'registered') throw new Error(`not registered: ${outcome.status}`);
  return outcome;
}

/** The backend's answer for a run that ended without asking the DR for anything. */
async function endedOn(
  workspace: ReturnType<typeof qualityWorkspace>,
  defect: NewDefect = BURR,
): Promise<Extract<Awaited<ReturnType<typeof analyseDefect>>, { status: 'ended' }>> {
  const outcome = await analyseDefect(workspace.aw, workspace.agentId, defect, QA_LEAD);
  if (outcome.status !== 'ended') throw new Error(`the run did not end: ${outcome.status}`);
  return outcome;
}

/** The `createCase` body a model fills in from the case it read and the report it wrote. */
function registrationOf(
  input: { phenomenon: string; partNo: string; lot: string; process: string; count: string },
  best: Defect,
  report: string,
): Record<string, unknown> {
  return {
    title: input.phenomenon,
    partNo: input.partNo,
    process: input.process,
    lot: input.lot,
    count: Number.parseInt(input.count, 10),
    cause: best.whys.at(-1),
    causeCode: best.causeCode,
    fourM: best.fourM,
    whys: best.whys,
    countermeasure: best.countermeasure,
    horizontalDeployment: best.horizontalDeployment,
    report,
  };
}

/** A registration for BURR whose 8D report a test supplies: for scripts that write their own draft. */
const registrationFor = (report: string): Record<string, unknown> => ({
  title: BURR.phenomenon,
  partNo: BURR.partNo,
  process: BURR.process,
  lot: BURR.lot,
  count: BURR.count,
  cause: '金型の摩耗',
  causeCode: '金型摩耗',
  fourM: '機械',
  whys: ['バリが出た', '刃先が丸くなった', '研磨周期が長い'],
  countermeasure: '研磨周期をショット数で管理する',
  horizontalDeployment: '同型の金型に展開する',
  report,
});

/**
 * What a model following `agents/quality-defect.md` does: search by phenomenon and process (then
 * without the process), read the best cases, take the 4M line from causeStats, write the 8D and
 * ask the DR to register it with `createCase` (the gated call, where the run stops). After a
 * rejection it revises the draft from the DR's comment and asks again; after an approval it makes
 * the same call, which now runs, and answers the draft. The decisions are scripted; every tool
 * result is the real server's.
 */
function followInstructions(): (context: ScriptContext) => Promise<ScriptAnswer> {
  const conversations = new Map<string, { prompt: string; comment: string | undefined }>();
  return async (context) => {
    const rejected = /^rejected: (.+)$/su.exec(context.prompt)?.[1];
    const earlier = conversations.get(context.sessionId);
    const prompt = earlier === undefined ? context.prompt : earlier.prompt;
    const comment = rejected ?? earlier?.comment;
    conversations.set(context.sessionId, { prompt, comment });
    const input = {
      phenomenon: field(prompt, '現象'),
      partNo: field(prompt, '品番'),
      lot: field(prompt, 'ロット'),
      process: field(prompt, '工程'),
      count: field(prompt, '発生数'),
    };
    let args: Record<string, unknown> = { q: input.phenomenon, process: input.process };
    let hits = JSON.parse((await context.tool('qms', 'searchDefects', args)).text) as
      PastCase[] | NoMatch;
    if (!Array.isArray(hits)) {
      args = { q: input.phenomenon };
      hits = JSON.parse((await context.tool('qms', 'searchDefects', args)).text) as
        PastCase[] | NoMatch;
    }
    // No match: paste the server's sentence and stop, as the first rule says.
    if (!Array.isArray(hits))
      return { text: hits.message, structured: { report: hits.message, draft: null } };
    const first = hits.find((hit) => hit.partNo === input.partNo) ?? hits[0];
    if (first === undefined) throw new Error('searchDefects returned an empty array');
    const best = JSON.parse(
      (await context.tool('qms', 'getDefect', { qNo: first.id })).text,
    ) as Defect;
    const stats = JSON.parse(
      (await context.tool('qms', 'causeStats', { ...args, groupBy: '4m' })).text,
    ) as CauseStats;
    const extra = comment === undefined ? '' : `（DR指摘反映: ${comment}）`;
    const report = draftOf(input, best, hits, stats, extra);
    await context.tool('qms', 'createCase', { body: registrationOf(input, best, report) });
    return answerOf(report);
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
    // unattended run cannot answer an approval prompt. The one write, registering the case as a
    // 過去トラ, is the call the DR decides (ADR-0145), and it is not a file write. The agent names
    // no gate of its own: `createCase` is gated because the tool admits it by operation id.
    expect(policy.tools.deny).not.toContain('Bash');
    expect(policy.tools.autoApprove).toStrictEqual(['mcp__agent-workspace__run_skill_script']);
    expect(policy.requireApproval ?? []).toStrictEqual([]);
    expect(definition?.resources).toMatchObject({
      connectors: ['qms'],
      skills: ['office-reader', 'eight-d'],
      files: [{ path: 'fmea', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('causeStats');
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
      toolResults: { searchDefects: 'table' },
    });
    expect(project.skills.map((entry) => entry.name).sort()).toStrictEqual([
      'eight-d',
      'office-reader',
    ]);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(
      project.skills
        .find((entry) => entry.name === 'eight-d')
        ?.files.map((file) => file.path)
        .sort(),
    ).toStrictEqual([
      'SKILL.md',
      'examples/8d-sample.md',
      'scripts/eightd.d.mts',
      'scripts/eightd.mjs',
    ]);
  });

  it('the FMEA is an Excel workbook that office-reader reads back as fmea-workbook.ts has it (GALLERY_WRITE=1 regenerates it)', async () => {
    if (process.env['GALLERY_WRITE'] === '1') writePfmea(FMEA);
    expect(readXlsx(await readFile(FMEA))).toEqual(readXlsx(writeXlsx({ sheets: PFMEA_SHEETS })));
    expect(existsSync(path.join(DIR, 'data', 'fmea', 'press-pfmea.md'))).toBe(false);

    // The agent's own call: the skill script under the permission model, no shell.
    const { stdout } = await run(process.execPath, [
      '--permission',
      `--allow-fs-read=${path.dirname(FMEA)}`,
      OOXML_SCRIPT,
      'xlsx',
      FMEA,
    ]);
    const [sheet] = (JSON.parse(stdout) as { sheets: { name: string; rows: unknown[][] }[] })
      .sheets;
    const header = sheet?.rows.findIndex((row) => row[0] === 'No.') ?? -1;
    expect(sheet?.rows[header]).toContain('関連過去トラ');
    const burr = sheet?.rows.find((row) => row[0] === 'P-03-01');
    expect(burr).toContain('パンチ刃先摩耗によるクリアランス拡大');
    expect(burr).toContain('Q-1003, Q-1011, Q-1042');

    const instructions = project.agents[0]?.body.definition.agent.instructions ?? '';
    expect(instructions).toContain('ooxml.mjs');
    expect(instructions).toContain('fmea/press-pfmea.xlsx');
  });

  it('the policy ceiling keeps defect data inside: no network, one tool, a budget', () => {
    const policy = project.project.policy;
    expect(policy?.permissions).toStrictEqual({ writeFiles: false, unrestrictedNetwork: false });
    expect(policy?.limits).toStrictEqual({ maxTurns: 20, maxBudgetUsd: 1.5 });
    expect(policy?.tools).toStrictEqual(['qms']);
    expect(policy?.promotion?.minEvalScore).toBe(0.9);

    const agent = project.agents[0]?.definition;
    if (agent === undefined) throw new Error('no agent');
    expect(policyWidenings(effectiveOf(agent), policy)).toStrictEqual([]);

    // Someone adds web search "to compare with industry cases": the ceiling refuses every part.
    const widened = defineAgent({
      ...agent,
      permissions: { ...agent.permissions, unrestrictedNetwork: true },
      tools: [qmsTool, mcp('web-search')],
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

  it('the agent finds past cases through the QMS API and ships no MCP server', async () => {
    // The QMS is an openapiTool(): the definition holds no MCP server, the project no connector.
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);
    expect(project.project.connectors ?? {}).toStrictEqual({});
    expect(readFileSync(path.join(DIR, 'agent-workspace.yaml'), 'utf8')).not.toMatch(
      /^connectors:/mu,
    );
    const agentDefinition = project.agents[0]?.definition;
    if (agentDefinition === undefined) throw new Error('no agent');
    const [definition] = toolDefinitionsOf(agentDefinition);
    expect(definition).toStrictEqual({
      kind: 'openapi',
      name: 'qms',
      spec: 'apis/qms.openapi.json',
      allow: ['GET /defects', 'GET /defects/*', 'operationId:createCase'],
      auth: 'bearer',
      credential: { secret: 'QMS_TOKEN' },
      identity: { secret: 'QMS_IDENTITY_SECRET' },
    });

    // A run reads through the tool's reads, in this order, then stops on the one write.
    const workspace = qualityWorkspace(followInstructions());
    const before = registrations();
    const paused = await pausedOn(workspace);
    expect(paused.toolCalls.map((call) => call.name)).toStrictEqual([
      'mcp__qms__searchDefects',
      'mcp__qms__getDefect',
      'mcp__qms__causeStats',
      'mcp__qms__createCase',
    ]);
    expect(paused.call.toolName).toBe('mcp__qms__createCase');
    // Every call carried who entered the defect; the write has not reached the QMS.
    expect(workspace.runs[0]?.subject).toBe(QA_LEAD);
    expect(qms.requests.filter((entry) => entry.method === 'GET').length).toBeGreaterThan(0);
    expect(registrations()).toBe(before);
  });

  it('the QMS tool admits the three reads and the one write, createCase', () => {
    // `*` is one segment: `GET /defects/*` admits /defects/stats and /defects/{qNo}, not /defects.
    const selected = selectAllowedOperations(qmsTool.allow, operationsOf(document));
    expect(selected.refusals).toStrictEqual([]);
    expect(selected.admitted.map((operation) => operation.operationId)).toStrictEqual([
      'searchDefects',
      'createCase',
      'causeStats',
      'getDefect',
    ]);
    for (const operation of selected.admitted) {
      expect(operation.operationId).toMatch(TOOL_OPERATION_NAME_PATTERN);
    }
    // Compose adds exactly this rule to `requireApproval`: the write, and no read.
    expect(
      toolApprovalRules(
        toolServerKey('qms'),
        selected.admitted.flatMap((operation) =>
          isToolMethod(operation.method)
            ? [{ name: operation.operationId, method: operation.method }]
            : [],
        ),
      ),
    ).toStrictEqual(['mcp__qms__createCase']);
  });

  it('the agent registers the case in the QMS only after the call is approved', async () => {
    const body = registrationFor('# 8D');
    const as = await asPerson(QA_LEAD);
    const before = registrations();

    // Not approved: the gateway refuses and the QMS is never dialled.
    expect(await qmsGateway().call('createCase', { body }, as)).toStrictEqual({
      text: 'approval_required',
      isError: true,
    });
    expect(registrations()).toBe(before);

    // Approved: the canonical call registers exactly one case, carrying the body and the subject.
    const approved = approvedCreate(body);
    const { qNo } = await approved.callJson<{ qNo: string }>('createCase', { body }, as);
    expect(qNo).toMatch(/^Q-\d{4}$/u);
    expect(qms.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/defects',
      body,
      by: QA_LEAD,
    });
    expect(registrations()).toBe(before + 1);

    // An approval is for those arguments only: another count is another call.
    const changed = await approved.call('createCase', { body: { ...body, count: 1 } }, as);
    expect(changed).toStrictEqual({ text: 'approval_required', isError: true });
    expect(registrations()).toBe(before + 1);
  });

  it('the QMS finds similar cases, counts 4M deterministically, and refuses bad input', async () => {
    const as = await asPerson(QA_LEAD);
    const gateway = qmsGateway();
    expect(await gateway.tools()).toStrictEqual([
      'searchDefects',
      'createCase',
      'causeStats',
      'getDefect',
    ]);

    const burrs = await gateway.callJson<PastCase[]>(
      'searchDefects',
      { q: 'バリ', process: 'プレス' },
      as,
    );
    expect(burrs.map((hit) => hit.id).sort()).toStrictEqual([
      'Q-1003',
      'Q-1011',
      'Q-1019',
      'Q-1042',
      'Q-1061',
    ]);
    // 品番 filters by prefix and ignores case; full-width input is normalised by the index.
    const family = await gateway.callJson<PastCase[]>(
      'searchDefects',
      { q: 'ﾊﾞﾘ', partNo: 'brk-2205' },
      as,
    );
    expect(family.map((hit) => hit.id).sort()).toStrictEqual(['Q-1019', 'Q-1061']);

    const record = await gateway.callJson<Defect>('getDefect', { qNo: 'q-1011' }, as);
    expect(record).toMatchObject({
      id: 'Q-1011',
      causeCode: '金型摩耗',
      fourM: '機械',
      recurred: '有',
    });
    expect(record.citation).toBe('〔過去トラ Q-1011〕');
    expect(record.whys.length).toBeGreaterThanOrEqual(3);

    const press = { q: 'バリ', process: 'プレス', groupBy: '4m' };
    const stats = await gateway.callJson<CauseStats>('causeStats', press, as);
    expect(stats.fourM).toStrictEqual({ 人: 1, 機械: 2, 材料: 1, 方法: 1 });
    expect(stats.line).toBe('4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）');
    expect(await gateway.callJson('causeStats', press, as)).toStrictEqual(stats);
    const paint = await gateway.callJson<CauseStats>(
      'causeStats',
      { q: '塗装ムラ', process: '塗装' },
      as,
    );
    expect(paint.line).toBe('4M集計: 人 1件 / 機械 0件 / 材料 1件 / 方法 2件（類似 4件）');

    // Nothing above the coverage threshold: an explicit noMatch and the exact answer to paste.
    const none = await gateway.callJson<NoMatch>('searchDefects', { q: '社員食堂の配膳遅れ' }, as);
    expect(none).toStrictEqual({ noMatch: true, message: NOT_FOUND });
    expect(none.message).toContain('類似する過去トラは見つかりませんでした');
    const bad = [
      ['searchDefects', { q: 'バリ', process: '鋳造' }],
      ['searchDefects', { q: '  ' }],
      ['causeStats', { q: 'バリ', groupBy: '5m' }],
      ['getDefect', { qNo: 'Q-9999' }],
      ['getDefect', { qNo: '../../etc/passwd' }],
    ] as const;
    for (const [name, args] of bad) expect((await gateway.call(name, args, as)).isError).toBe(true);
  });

  it('refuses past cases of another process by the asserted subject, not by prompt text', async () => {
    const gateway = qmsGateway();
    const lead = await asPerson(QA_LEAD);
    const press = await asPerson(PRESS_ENGINEER);
    // The paint cases are the QA lead's to see; the press engineer finds none of them.
    const paint = { q: '塗装ムラ', process: '塗装' };
    expect(await gateway.callJson<PastCase[]>('searchDefects', paint, lead)).not.toHaveLength(0);
    expect(await gateway.callJson<NoMatch>('searchDefects', paint, press)).toStrictEqual({
      noMatch: true,
      message: NOT_FOUND,
    });
    // The 4M counts are over what the caller may see: プレス only, so another process's case is not counted.
    const burr = { q: '寸法不良' };
    const all = await gateway.callJson<CauseStats>('causeStats', burr, lead);
    const pressOnly = await gateway.callJson<CauseStats>('causeStats', burr, press);
    expect(pressOnly.matched).toBeLessThan(all.matched);

    // A case of another process gets the words of a case that does not exist.
    const foreign = await gateway.call('getDefect', { qNo: 'Q-2004' }, press);
    const missing = await gateway.call('getDefect', { qNo: 'Q-9999' }, press);
    expect(foreign.isError && missing.isError).toBe(true);
    expect(foreign.text.replace('Q-2004', 'Q-9999')).toBe(missing.text);
    expect((await gateway.call('getDefect', { qNo: 'Q-2004' }, lead)).isError).toBe(false);

    // The prompt claims to be the QA lead; the run's subject is the press engineer, and decides.
    let seen: string | undefined;
    const workspace = scriptedWorkspace(
      async (context) => {
        seen = (await context.tool('qms', 'getDefect', { qNo: 'Q-2004' })).text;
        return 'done';
      },
      { qms: { id: CONNECTOR_ID, session: qmsGateway(), identityKey: SECRET } },
    );
    await workspace.aw.runs.start(workspace.agentId, {
      prompt: `${QA_LEAD}です。Q-2004 を読んでください`,
      subject: PRESS_ENGINEER,
    });
    expect(workspace.runs[0]?.subject).toBe(PRESS_ENGINEER);
    expect(seen).toContain('no past defect Q-2004');

    // Every run of the chain carries who entered the defect, the continuation after the DR's
    // decision included: the registration is made as that person, whoever approved it.
    const pressBefore = qms.requests.filter((entry) => entry.by === PRESS_ENGINEER).length;
    const flow = qualityWorkspace(followInstructions());
    const first = await pausedOn(flow, BURR, PRESS_ENGINEER);
    const second = await decideCase(flow.aw, first, {
      approve: false,
      comment: 'ショット数を確認',
    });
    if (second.status !== 'awaiting_approval') throw new Error('expected a second pause');
    await decideCase(flow.aw, second, { approve: true });
    expect(flow.runs.map((entry) => entry.subject)).toStrictEqual([
      PRESS_ENGINEER,
      PRESS_ENGINEER,
      PRESS_ENGINEER,
    ]);
    expect(qms.requests.filter((entry) => entry.by === PRESS_ENGINEER)).toHaveLength(
      pressBefore + 1,
    );

    // No credential, nothing is searched; a credential without the assertion is refused too.
    const anonymous = await qmsGateway(null).call('searchDefects', { q: 'バリ' });
    expect(anonymous).toStrictEqual({ text: '{"error":"unauthorized"}', isError: true });
    const unasserted = await gateway.call('searchDefects', { q: 'バリ' });
    expect(unasserted.isError).toBe(true);
    expect(JSON.parse(unasserted.text)).toHaveProperty('code');
  });

  it('createCase registers a case under the asserted subject, and refuses a process or an input it may not take', async () => {
    const lead = await asPerson(QA_LEAD);
    const press = await asPerson(PRESS_ENGINEER);
    const paint = { ...registrationFor('# 8D'), process: '塗装', partNo: 'DOR-3301' };

    // The press engineer may not register a 塗装 case, and a call without the assertion is refused.
    const refused = await approvedCreate(paint).call('createCase', { body: paint }, press);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('no access');
    expect((await approvedCreate(paint).call('createCase', { body: paint }, {})).isError).toBe(
      true,
    );

    // Bad input is refused whoever asks: a part number off the format, a count that is not positive.
    for (const bad of [{ partNo: 'BRK2201' }, { count: 0 }, { fourM: '天候' }, { title: ' ' }]) {
      const body = { ...registrationFor('# 8D'), ...bad };
      const result = await approvedCreate(body).call('createCase', { body }, lead);
      expect(result.isError).toBe(true);
    }

    // A case the caller may see is registered, gets the next number, and is then readable.
    const body = registrationFor('# 8D');
    const registered = await approvedCreate(body).callJson<{ qNo: string; citation: string }>(
      'createCase',
      { body },
      press,
    );
    expect(registered.qNo).toMatch(/^Q-\d{4}$/u);
    expect(registered.citation).toContain(registered.qNo);
    const record = await qmsGateway().callJson<Defect>('getDefect', { qNo: registered.qNo }, press);
    expect(record).toMatchObject({
      id: registered.qNo,
      partNo: 'BRK-2201',
      process: 'プレス',
      causeCode: '金型摩耗',
      recurred: '無',
    });
    const next = await approvedCreate(body).callJson<{ qNo: string }>('createCase', { body }, lead);
    expect(Number(next.qNo.slice(2))).toBe(Number(registered.qNo.slice(2)) + 1);
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

  it('the backend pauses on registering the case with a checked 8D draft, and flags the recurrence of a recurring cause', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const result = await pausedOn(workspace);

    // The run waits on the registration: the DR reads the draft, and nothing is in the database yet.
    expect(result.call.toolName).toBe('mcp__qms__createCase');
    expect(result.registration).toMatchObject({
      title: 'バリ',
      partNo: 'BRK-2201',
      process: 'プレス',
      count: 48,
      causeCode: '金型摩耗',
    });
    expect(result.registration.report).toBe(result.answer);
    expect((await workspace.aw.runs.get(result.runId)).status).toBe('awaiting_approval');

    expect(workspace.runs[0]?.prompt).toContain('現象: バリ\n品番: BRK-2201');
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['report', 'draft'],
      properties: {
        draft: {
          anyOf: [
            { required: expect.arrayContaining(['sections', 'whys', 'claims']) as unknown },
            { type: 'null' },
          ],
        },
      },
    });
    expect(result.draft?.valid).toBe(true);
    expect(result.draft?.whys.length).toBeGreaterThanOrEqual(3);
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
    const workspace = qualityWorkspace(followInstructions());
    const result = await pausedOn(workspace, {
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
    const workspace = qualityWorkspace(async (context) => {
      await context.tool('qms', 'searchDefects', { q: 'バリ', process: 'プレス' });
      await context.tool('qms', 'causeStats', { q: 'バリ', process: 'プレス', groupBy: '4m' });
      const sample = await readFile(SAMPLE, 'utf8');
      const report = sample
        .replace('機械 2件', '機械 3件')
        .replace('〔過去トラ Q-1042〕。\n\n## D6', '〔過去トラ Q-3002〕。\n\n## D6');
      await context.tool('qms', 'createCase', { body: registrationFor(report) });
      return answerOf(report);
    });
    const result = await pausedOn(workspace);
    expect(result.draft?.valid).toBe(true);
    expect(result.unverifiedCases).toStrictEqual(['Q-3002']);
    expect(result.fourM).toMatchObject({
      status: 'mismatch',
      computed: ['4M集計: 人 1件 / 機械 2件 / 材料 1件 / 方法 1件（類似 5件）'],
    });
    expect(result.readyForReview).toBe(false);
    expect(result.findings).toHaveLength(2);
  });

  it('the backend refuses an incomplete defect report before starting a run', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const attempt = analyseDefect(
      workspace.aw,
      workspace.agentId,
      {
        ...BURR,
        partNo: 'BRK2201',
        process: '鋳造' as NewDefect['process'],
        count: 0,
      },
      QA_LEAD,
    );
    await expect(attempt).rejects.toBeInstanceOf(InvalidDefectReport);
    await expect(attempt).rejects.toMatchObject({ fields: ['partNo', 'process', 'count'] });
    expect(workspace.runs).toHaveLength(0);
  });

  it('the backend reports no similar case honestly and does not put it on the DR agenda', async () => {
    const script = followInstructions();
    const used: string[] = [];
    const workspace = qualityWorkspace((context) =>
      script({
        ...context,
        tool: (connector, tool, args) => {
          used.push(tool);
          return context.tool(connector, tool, args);
        },
      }),
    );
    const result = await endedOn(workspace, {
      phenomenon: '配膳遅れ',
      partNo: 'CAF-0001',
      lot: 'なし',
      process: '組立',
      count: 1,
    });
    expect(result.answer).toBe(NOT_FOUND);
    // The run stopped at the searches: no case read, no 4M counted.
    expect(used).toStrictEqual(['searchDefects', 'searchDefects']);
    expect(result.matched).toStrictEqual([]);
    expect(result.recurrence.recurring).toBe(false);
    expect(result.readyForReview).toBe(false);
    expect(result.draft).toBeNull();
    expect(result.findings).toStrictEqual(['8D下書きがない（類似する過去トラが見つからなかった）']);
  });

  it('the backend checks the structure a run returns, and a report with no structure fails the run', async () => {
    // The agent returns a draft whose parts break the format: no D6, an uncited なぜ, two なぜ.
    const broken = qualityWorkspace(async () => {
      const sample = await readFile(SAMPLE, 'utf8');
      return answerOf(
        sample
          .replace(/^## D6[\s\S]*?(?=^## D7)/mu, '')
          .replace(/^(- なぜ2:.*?)〔過去トラ[^〕]*〕/mu, '$1')
          .replace(/^- なぜ3:.*$/mu, ''),
      );
    });
    const checked = await endedOn(broken);
    expect(checked.draft?.issues.map((issue) => issue.code)).toStrictEqual([
      'missing_section',
      'shallow_whys',
      'uncited_claim',
    ]);
    expect(checked.readyForReview).toBe(false);

    // A report without the structure is not a draft the backend can check: the platform fails it.
    const bare = qualityWorkspace(() => readFile(SAMPLE, 'utf8'));
    await expect(analyseDefect(bare.aw, bare.agentId, BURR, QA_LEAD)).rejects.toBeInstanceOf(
      RunDidNotComplete,
    );
  });

  it('checkEightD gives the same verdict on a parsed structure as parseEightD on its text', async () => {
    const parsed = parseEightD(await readFile(SAMPLE, 'utf8'));
    const { cites, issues, valid, ...structure } = parsed;
    expect(checkEightD(structure)).toStrictEqual({ ...structure, cites, issues, valid });
    expect(
      checkEightD({
        ...structure,
        sections: structure.sections.filter((section) => section.id !== 'D6'),
        whys: structure.whys.slice(0, 2),
        claims: [...structure.claims, { text: '- 出典のない主張', cites: [] }],
      }).issues.map((issue) => issue.code),
    ).toStrictEqual(['missing_section', 'shallow_whys', 'uncited_claim']);
    // A structure that leaves the whys out of `claims` still has them checked.
    expect(
      checkEightD({
        ...structure,
        whys: structure.whys.map((why) => ({ ...why, cites: [] })),
        claims: [],
      }).issues.map((issue) => issue.code),
    ).toStrictEqual(['uncited_claim', 'uncited_claim', 'uncited_claim']);
  });

  it('the backend checks every field of a structured draft that disagrees with itself', async () => {
    // A model can fill the parts separately: a Q-number no tool returned only in the whys and the
    // D4 prose, no claims, an uncited root cause.
    const workspace = qualityWorkspace(async (context) => {
      await context.tool('qms', 'searchDefects', { q: 'バリ', process: 'プレス' });
      const report = await readFile(SAMPLE, 'utf8');
      const { title, sections, whys, rootCause, causeCode, fourM } = parseEightD(report);
      const draft = {
        title,
        sections: sections.map((section) =>
          section.id === 'D4'
            ? { ...section, body: 'なぜ1: 〔過去トラ Q-9999〕', cites: [] }
            : { ...section, cites: [] },
        ),
        whys: whys.map((why) => ({ ...why, cites: ['Q-9999'] })),
        claims: [],
        rootCause: rootCause === null ? null : { ...rootCause, cites: [] },
        causeCode,
        fourM,
      };
      return { text: report, structured: { report, draft } };
    });
    const result = await endedOn(workspace);
    expect(result.unverifiedCases).toContain('Q-9999');
    expect(result.draft?.issues.map((issue) => issue.code)).toContain('uncited_claim');
    expect(result.readyForReview).toBe(false);
  });

  it('the backend pauses on registering the case, and approving it registers the case under the same subject', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const lead = await asPerson(QA_LEAD);
    const before = registrations();

    // The DR reads the draft; nothing is in the QMS while the run waits.
    const awaiting = await pausedOn(workspace);
    expect(awaiting.status).toBe('awaiting_approval');
    expect(awaiting.readyForReview).toBe(true);
    expect(workspace.runs).toHaveLength(1);
    expect(registrations()).toBe(before);

    // The DR approves; the continuation is the same session and subject, and makes the same call.
    const outcome = registeredOf(await decideCase(workspace.aw, awaiting, { approve: true }));
    expect(workspace.runs[1]).toMatchObject({
      prompt: 'approved',
      sessionId: workspace.runs[0]?.sessionId,
      subject: QA_LEAD,
      approvedToolCalls: [{ toolName: 'mcp__qms__createCase' }],
    });
    expect(outcome.sessionId).toBe(awaiting.sessionId);
    expect(outcome.answer).toBe(awaiting.answer);
    expect(outcome.registration).toStrictEqual(awaiting.registration);
    expect(outcome.caseId).toMatch(/^Q-\d{4}$/u);
    expect(registrations()).toBe(before + 1);
    expect(qms.requests.at(-1)).toMatchObject({ method: 'POST', by: QA_LEAD });

    // The number is the QMS's, and the case is now a 過去トラ the next search reads.
    const record = await qmsGateway().callJson<Defect>('getDefect', { qNo: outcome.caseId }, lead);
    expect(record).toMatchObject({
      partNo: 'BRK-2201',
      process: 'プレス',
      causeCode: '金型摩耗',
      fourM: '機械',
    });
  });

  it('a DR comment rejects the registration, and the revised 8D pauses again', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const before = registrations();
    const first = await pausedOn(workspace);
    const comment = '暫定対策に金型の研磨後ショット数の確認を加えること';

    const second = await decideCase(workspace.aw, first, { approve: false, comment });
    expect(workspace.runs[1]).toMatchObject({
      prompt: `rejected: ${comment}`,
      sessionId: first.sessionId,
      approvedToolCalls: [],
    });
    if (second.status !== 'awaiting_approval')
      throw new Error(`expected a pause: ${second.status}`);
    expect(second.runId).not.toBe(first.runId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.draft?.sections.find((section) => section.id === 'D3')?.body).toContain(
      '研磨後ショット数',
    );
    // The revised draft is checked again, and still nothing is registered.
    expect(second.readyForReview).toBe(true);
    expect((await workspace.aw.runs.get(second.runId)).status).toBe('awaiting_approval');
    expect(registrations()).toBe(before);

    // Approving the revised 8D registers that one.
    const outcome = registeredOf(await decideCase(workspace.aw, second, { approve: true }));
    expect(outcome.registration.report).toContain('研磨後ショット数');
    expect(registrations()).toBe(before + 1);
  });

  it('a second decision on the same run is refused with 409 run_not_awaiting_approval', async () => {
    const workspace = qualityWorkspace(followInstructions());
    const awaiting = await pausedOn(workspace);
    registeredOf(await decideCase(workspace.aw, awaiting, { approve: true }));

    // The paused run was decided once; a second decision finds nothing to decide.
    await expect(decideCase(workspace.aw, awaiting, { approve: true })).rejects.toMatchObject({
      status: 409,
      code: 'run_not_awaiting_approval',
    });
    await expect(
      decideCase(workspace.aw, awaiting, { approve: false, comment: 'やはり直す' }),
    ).rejects.toMatchObject({ status: 409, code: 'run_not_awaiting_approval' });
    expect(workspace.runs).toHaveLength(2);
  });

  it('the backend does not let the DR approve a draft that failed its checks, a blank rejection, or a registration of another part', async () => {
    // A draft with no D6 is paused on like any other, but its approval is refused with the findings.
    const broken = qualityWorkspace(async (context) => {
      const sample = await readFile(SAMPLE, 'utf8');
      const report = sample.replace(/^## D6[\s\S]*?(?=^## D7)/mu, '');
      await context.tool('qms', 'createCase', { body: registrationFor(report) });
      return answerOf(report);
    });
    const awaiting = await pausedOn(broken);
    expect(awaiting.readyForReview).toBe(false);
    await expect(decideCase(broken.aw, awaiting, { approve: true })).rejects.toBeInstanceOf(
      DraftNotReady,
    );
    // Nothing was decided: the run is still paused, and a rejection needs the DR's words.
    await expect(
      decideCase(broken.aw, awaiting, { approve: false, comment: ' ' }),
    ).rejects.toMatchObject({
      fields: ['comment'],
    });
    expect(broken.runs).toHaveLength(1);
    expect((await broken.aw.runs.get(awaiting.runId)).status).toBe('awaiting_approval');

    // A registration of another part than the one QA entered is not shown to the DR as this defect's.
    const other = qualityWorkspace(async (context) => {
      const report = await readFile(SAMPLE, 'utf8');
      await context.tool('qms', 'createCase', {
        body: { ...registrationFor(report), partNo: 'ASY-6001' },
      });
      return answerOf(report);
    });
    const refused = await analyseDefect(other.aw, other.agentId, BURR, QA_LEAD);
    expect(refused).toMatchObject({
      status: 'refused',
      problems: ['partNo が入力した不具合と違う'],
    });
  });
});
