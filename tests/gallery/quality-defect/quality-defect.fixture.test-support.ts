import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { type EffectivePolicyConfiguration } from '@indx-workspace/contracts/policy-ceiling';
import { toolServerKey } from '@indx-workspace/contracts/tool-connectors';
import { toAgentVersionBody, type DefinedAgent } from '@indx-workspace/sdk/define';
import { afterAll, beforeAll } from 'vitest';

import { GALLERY_WORKSPACE_ID, headersAs } from '../harness/identity.ts';
import { openapiGateway, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  analyseDefect,
  type CaseOutcome,
  type CauseStats,
  type DefectAwaiting,
  type NewDefect,
  type NoMatch,
  type PastCase,
} from './backend/analyse.ts';
import { parseEightD } from './skills/eight-d/scripts/eightd.mjs';
import agentDefinition from './agents/quality-defect.ts';
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
const asPerson = headersAs({ key: SECRET, connectorId: CONNECTOR_ID });

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

/** What the tools returned for a draft: the case read, every case matched, and the 4M counts. */
interface DraftEvidence {
  readonly best: Defect;
  readonly matched: readonly PastCase[];
  readonly stats: CauseStats;
}

/** The draft a model following the skill writes from what the tools returned. */
function draftOf(
  input: { phenomenon: string; partNo: string; lot: string; process: string; count: string },
  { best, matched, stats }: DraftEvidence,
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
    const report = draftOf(input, { best, matched: hits, stats }, extra);
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

export {
  DIR,
  SCRIPT,
  SAMPLE,
  FMEA,
  OOXML_SCRIPT,
  CONNECTOR_ID,
  SECRET,
  QA_LEAD,
  PRESS_ENGINEER,
  run,
  type Defect,
  BURR,
  document,
  qmsGateway,
  approvedCreate,
  asPerson,
  qms,
  project,
  registrations,
  answerOf,
  NOT_FOUND,
  qualityWorkspace,
  pausedOn,
  registeredOf,
  endedOn,
  registrationFor,
  followInstructions,
  effectiveOf,
};
