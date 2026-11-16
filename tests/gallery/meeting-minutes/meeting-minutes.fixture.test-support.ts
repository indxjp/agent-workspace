/**
 * The meeting minutes test's shared fixture: the project, a fresh tracker per test, the scripted
 * model that follows `agents/meeting-minutes.md`, and the helpers the case modules share.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { toolServerKey } from '@indx-workspace/contracts/tool-connectors';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { GALLERY_WORKSPACE_ID, headersAs, identityEnv } from '../harness/identity.ts';
import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { openapiGateway, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type Script,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  draftMinutes,
  registerItems,
  decideTask,
  type Registration,
  type TaskAwaitingApproval,
  type TaskItem,
  type TrackerTask,
} from './backend/minutes.ts';
import { resolveDate, weekdayOf } from './skills/gijiroku-format/scripts/dates.mjs';
import { startFakeTracker, type FakeTracker } from './tracker/fake-tracker.mjs';
import { tracker as trackerTool } from './tools/tracker.ts';
import agentDefinition from './agents/meeting-minutes.ts';
import surfaceDefinition from './surfaces/minutes.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATES = path.join(DIR, 'skills', 'gijiroku-format', 'scripts', 'dates.mjs');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000008';
const TRACKER_ID = '6b1c1f0e-0000-4000-8000-000000000009';
const TRACKER_TOKEN = 'tracker-test-token';
const IDENTITY_KEY = 'gallery-task-tracker-secret-0123456789';
const TRACKER_KEY = 'gallery-tracker-api-secret-0123456789';
// Who ran the meeting: both are in `data/access.json`; the second covers 開発部 only.
const CLERK = '伊藤 美咲';
const DEV_LEAD = '中村 由美';
const PRODUCTION = path.join(DIR, 'data', 'transcripts', '2026-10-02_生産会議.txt');
const DEVELOPMENT = path.join(DIR, 'data', 'transcripts', '2026-10-05_新製品開発定例.vtt');
const run = promisify(execFile);

interface Member {
  readonly name: string;
  readonly title: string;
}
interface Roster {
  readonly members: readonly Member[];
  readonly guests: readonly { readonly name: string; readonly company: string }[];
}
interface Created {
  readonly created: boolean;
  readonly task: TrackerTask & { readonly status: string; readonly createdBy: string };
}

const document = JSON.parse(
  readFileSync(path.join(DIR, 'apis', 'tracker.openapi.json'), 'utf8'),
) as OpenApiDocument;

let project: GalleryProject;
const open: McpSession[] = [];
const trackers: FakeTracker[] = [];

beforeAll(async () => {
  project = await loadGalleryProject(DIR, {
    'agents/meeting-minutes.ts': agentDefinition,
    'surfaces/minutes.ts': surfaceDefinition,
  });
});
afterEach(async () => {
  for (const session of open.splice(0)) session.close();
  await Promise.all(trackers.splice(0).map((fake) => fake.close()));
});
afterAll(async () => {
  for (const session of open) session.close();
  await Promise.all(trackers.map((fake) => fake.close()));
});

interface Started {
  /** The read tools (`mcp/tasks.mjs`). */
  readonly tracker: McpSession;
  /** The tracker's API, which `createTask` calls. */
  readonly api: FakeTracker;
  readonly file: string;
}

/** A fresh tracker, its read tools and its API sharing one JSON file, as the backend's tests should get. */
async function startTracker(): Promise<Started> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'gallery-tasks-')), 'tasks.json');
  const api = await startFakeTracker({
    token: TRACKER_TOKEN,
    identity: { key: TRACKER_KEY, audience: TRACKER_ID, workspace: GALLERY_WORKSPACE_ID },
    tasksFile: file,
  });
  trackers.push(api);
  const tracker = await startMcpServer(path.join(DIR, 'mcp', 'tasks.mjs'), {
    ...identityEnv(IDENTITY_KEY, CONNECTOR_ID),
    TASKS_FILE: file,
  });
  open.push(tracker);
  return { tracker, api, file };
}

/** The platform's gateway for the tracker tool, with the calls a person approved. */
const trackerGateway = (api: FakeTracker, approvedToolCalls: readonly string[] = []) =>
  openapiGateway({
    document,
    allow: trackerTool.allow,
    baseUrl: api.url,
    token: TRACKER_TOKEN,
    serverKey: toolServerKey('tracker'),
    approvedToolCalls,
  });

/** What a person approves: one `createTask` call, with exactly this body. */
const approvalOf = (body: Record<string, unknown>): string =>
  canonicalCall('mcp__tracker__createTask', { body });

/** The connectors a run gets: the read tools, and the tracker API behind the platform's gate. */
const connectorsOf = ({ tracker, api }: Started) => ({
  'task-tracker': { id: CONNECTOR_ID, session: tracker, identityKey: IDENTITY_KEY },
  tracker: { id: TRACKER_ID, session: trackerGateway(api), identityKey: TRACKER_KEY },
});

// ---------- the scripted model ----------

/** What a model reading the transcript extracts: who said they would do what, by when. */
interface Extracted {
  readonly title: string;
  /** A roster name, a guest's 「会社名 氏名 様」, or null when nobody took it. */
  readonly owner: string | null;
  /** The date as it was said; the script resolves it, as the skill requires. */
  readonly said: string;
  readonly evidence: string;
}
interface Reading {
  readonly agenda: readonly string[];
  readonly decisions: readonly string[];
  readonly open: readonly string[];
  readonly items: readonly Extracted[];
}

const READINGS: Readonly<Record<string, Reading>> = {
  生産会議: {
    agenda: [
      '9月度の生産実績と不良',
      'ライン3 段取り替え時間短縮',
      '年末年始の稼働計画',
      '来客対応',
    ],
    decisions: [
      'ライン3 段取り替え短縮（位置決め治具の共通化）を10月第3週（10/19の週）から試行する（佐藤部長決定）',
      '年末年始は12月29日〜1月4日を休止、12月28日は午前のみ稼働とする',
    ],
    open: ['夜勤の人員が2名不足（11月の増産に向け人事と調整中）', '打痕不良（9月 0.9%）の原因'],
    items: [
      {
        title: '打痕不良の原因分析（搬送シュート・治具の切り分け）',
        owner: '山本 真理子',
        said: '月末',
        evidence: '[00:02:05] 私の方で月末までにまとめます',
      },
      {
        title: 'ライン3 段取り替え試行計画の作成',
        owner: '鈴木 一郎',
        said: '来週の金曜くらいまでに',
        evidence: '[00:03:24] 来週金曜までに出します',
      },
      {
        title: '位置決め治具の見積もり取得（ミナト金型）',
        owner: '高橋 翔太',
        said: '3営業日後',
        evidence: '[00:03:30] 3営業日後には出せると思います',
      },
      {
        title: '年末年始稼働カレンダーの各課への配布',
        owner: '伊藤 美咲',
        said: '週明け',
        evidence: '[00:04:27] 週明けに配布します',
      },
      {
        title: '来客対応手順の見直し（安全靴・保護メガネの貸し出しを含む）',
        owner: null,
        said: '来月10日',
        evidence: '[00:05:36] 担当は次回までに決めましょう',
      },
    ],
  },
  新製品開発定例: {
    agenda: ['試作2次の結果', '量産金型', '国際ロボット展'],
    decisions: ['試作3次は歯形修正品で行う（中村課長決定）'],
    open: ['騒音 57dB（目標 55dB）', '国際ロボット展への参考出品の可否（次回判断）'],
    items: [
      {
        title: '歯形修正図面の提出',
        owner: '小林 大輔',
        said: '明日中',
        evidence: '00:00:37 修正図面を明日中に出します',
      },
      {
        title: '量産金型の改定見積書の送付',
        owner: '株式会社ミナト金型 木村 浩二 様',
        said: '今週の金曜まで',
        evidence: '00:01:33 今週の金曜までには',
      },
      {
        title: '量産金型の社内稟議',
        owner: '渡辺 隆',
        said: '来月10日',
        evidence: '00:01:45 稟議は私の方で回します',
      },
      {
        title: '展示会パネル原稿の準備',
        owner: null,
        said: 'なるべく早く',
        evidence: '00:02:41 そこは営業さんの中で決めてください',
      },
    ],
  },
};

/** The attendees line with honorifics, as the skill writes it, from the transcript's 参加者 line. */
function attendees(prompt: string, roster: Roster): string {
  const line = /^参加者[:：]\s*(.+)$/mu.exec(prompt)?.[1] ?? '';
  return line
    .split(/[,、]\s*/u)
    .map((entry) => {
      const name = entry.replace(/（.*）/u, '').trim();
      const member = roster.members.find((candidate) => candidate.name === name);
      if (member !== undefined) return `${name} ${member.title === '' ? 'さん' : member.title}`;
      const guest = roster.guests.find((candidate) => candidate.name === name);
      return guest === undefined ? `${name} 様` : `${guest.company} ${name} 様`;
    })
    .join('、');
}

/**
 * What a model following `agents/meeting-minutes.md` does on a draft request: look up the roster,
 * resolve every spoken date with the skill's script, and write the house format. Tool results are
 * the real tracker's; dates are the real script's.
 */
async function draftAsInstructed(context: ScriptContext): Promise<ScriptAnswer> {
  const roster = JSON.parse(
    (await context.tool('task-tracker', 'list_members', {})).text,
  ) as Roster;
  const base = /基準日）:\s*(\d{4}-\d{2}-\d{2})/u.exec(context.prompt)?.[1] ?? '';
  const key = Object.keys(READINGS).find((name) => context.prompt.includes(name)) ?? '';
  const reading = READINGS[key];
  if (reading === undefined) throw new Error('no scripted reading for this transcript');
  const field = (name: string): string =>
    new RegExp(`^${name}[:：]\\s*(.+)$`, 'mu').exec(context.prompt)?.[1]?.trim() ?? '';
  const items = reading.items.map((item, index) => ({
    no: index + 1,
    title: item.title,
    assignee: item.owner ?? '担当未定',
    due: resolveDate(item.said, base) ?? '期限未定',
    evidence: item.evidence,
  }));
  const [date, time] = field('日時').split(' ');
  const minutes = [
    '# 議事録',
    '',
    `- 会議名: ${field('会議名')}`,
    `- 日時: ${date ?? ''}（${weekdayOf(date ?? '')}）${time ?? ''}`,
    `- 場所: ${field('場所')}`,
    `- 出席者: ${attendees(context.prompt, roster)}`,
    '- 記録: 議事録エージェント（下書き・未承認）',
    '',
    '## 議題',
    '',
    ...reading.agenda.map((entry, index) => `${String(index + 1)}. ${entry}`),
    '',
    '## 決定事項',
    '',
    ...reading.decisions.map((entry, index) => `${String(index + 1)}. ${entry}`),
    '',
    '## 継続課題',
    '',
    ...reading.open.map((entry) => `- ${entry}`),
    '',
    '## アクション項目',
    '',
    '| No. | 内容 | 担当 | 期限 | 根拠（発言） |',
    '| --- | --- | --- | --- | --- |',
    ...items.map(
      (item) =>
        `| ${String(item.no)} | ${item.title} | ${item.assignee} | ${item.due} | ${item.evidence} |`,
    ),
    '',
    '内容を確認し、登録する項目を承認してください。',
  ].join('\n');
  return { text: minutes, structured: { minutes, actionItems: items } };
}

/**
 * What a model following `agents/meeting-minutes.md` does: draft on a draft request; on a request
 * to register one item, call `createTask` for exactly it (the run pauses there); when `approved`
 * arrives, repeat that call and report the task; on `rejected: <comment>`, create nothing.
 */
function minutesModel(): (context: ScriptContext) => Promise<ScriptAnswer> {
  let item: Record<string, unknown> | null = null;
  return async (context) => {
    const asked = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
    if (context.prompt.startsWith('次のアクション項目') && asked !== undefined) {
      item = JSON.parse(asked) as Record<string, unknown>;
    } else if (context.prompt.startsWith('rejected')) {
      return '登録しませんでした。';
    } else if (context.prompt !== 'approved') {
      return draftAsInstructed(context);
    }
    if (item === null) throw new Error('nothing to register');
    const result = await context.tool('tracker', 'createTask', { body: item });
    if (result.isError) return `登録できませんでした: ${result.text}`;
    const { task } = JSON.parse(result.text) as Created;
    return `登録しました。${task.id} ${task.title} ${task.assignee} ${task.due}`;
  };
}

/** The headers the platform sends the tracker for a run started with `subject`. */
const asPerson = headersAs({ key: IDENTITY_KEY, connectorId: CONNECTOR_ID });

/** The headers the platform sends the tracker's API for a run started with `subject`. */
const asPersonAtTracker = headersAs({ key: TRACKER_KEY, connectorId: TRACKER_ID });

const readTrackerOf =
  (tracker: McpSession, subject = CLERK) =>
  async (sourceMeeting: string): Promise<readonly TrackerTask[]> =>
    tracker.callJson<TrackerTask[]>('list_tasks', { sourceMeeting }, await asPerson(subject));

/** Decide each item offered in turn, as `decide` says, until the registration is done. */
async function decideAll(
  aw: AgentWorkspaceClient,
  first: TaskAwaitingApproval,
  decide: (item: TaskItem) => Parameters<typeof decideTask>[2],
): Promise<{ offered: TaskItem[]; registration: Registration }> {
  const offered: TaskItem[] = [];
  let step: TaskAwaitingApproval | Registration = first;
  while ('item' in step) {
    offered.push(step.item);
    step = await decideTask(aw, step, decide(step.item));
  }
  return { offered, registration: step };
}

/** The approval loop's arrange: a fresh tracker, a workspace on `script`, and the production draft. */
async function draftProduction(script: Script = minutesModel()) {
  const started = await startTracker();
  const workspace = scriptedWorkspace(script, connectorsOf(started));
  const transcript = await readFile(PRODUCTION, 'utf8');
  const draft = await draftMinutes(workspace.aw, workspace.agentId, transcript, CLERK);
  return { ...started, workspace, draft };
}
type Loop = Awaited<ReturnType<typeof draftProduction>>;

/** Register the draft's items: the first owned item is offered. */
const offerFirst = ({ tracker, workspace, draft }: Loop): Promise<TaskAwaitingApproval> =>
  registerItems(workspace.aw, workspace.agentId, { draft, readTracker: readTrackerOf(tracker) });

export {
  DATES,
  CONNECTOR_ID,
  IDENTITY_KEY,
  CLERK,
  DEV_LEAD,
  PRODUCTION,
  DEVELOPMENT,
  run,
  type Roster,
  type Created,
  document,
  project,
  startTracker,
  trackerGateway,
  approvalOf,
  connectorsOf,
  draftAsInstructed,
  minutesModel,
  asPerson,
  asPersonAtTracker,
  readTrackerOf,
  decideAll,
  draftProduction,
  offerFirst,
};
