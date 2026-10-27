/**
 * Use case 8, the meeting minutes and action-item agent: the definition passes the contract, the
 * date script and the task tracker do their jobs, and the backend drafts minutes, then registers
 * the action items one run and one approval at a time, so only what a person approved is written.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  toolServerKey,
} from '@indx-workspace/contracts/tool-connectors';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { toolDefinitionsOf } from '@indx-workspace/sdk/define';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GALLERY_WORKSPACE_ID, identityEnv, signedHeaders } from '../harness/identity.ts';
import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { openapiGateway, operationsOf, type OpenApiDocument } from '../harness/openapi-gateway.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import {
  scriptedWorkspace,
  type ScriptAnswer,
  type ScriptContext,
} from '../harness/scripted-workspace.ts';
import {
  draftMinutes,
  draftMinutesFromRun,
  DraftWroteToTracker,
  MinutesFormatError,
  readMeeting,
  TRANSCRIPT_TRIGGER,
  registerItems,
  decideTask,
  type Registration,
  type TaskAwaitingApproval,
  type TaskItem,
  type TrackerTask,
} from './backend/minutes.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
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
const asPerson = async (subject: string) => ({
  headers: await signedHeaders({ key: IDENTITY_KEY, connectorId: CONNECTOR_ID, subject }),
});

/** The headers the platform sends the tracker's API for a run started with `subject`. */
const asPersonAtTracker = async (subject: string) => ({
  headers: await signedHeaders({ key: TRACKER_KEY, connectorId: TRACKER_ID, subject }),
});

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

// ---------- tests ----------

describe('meeting minutes agent', () => {
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
      tools: { permissionMode: 'default', autoApprove: ['mcp__agent-workspace__run_skill_script'] },
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['task-tracker', 'tracker'],
      skills: ['gijiroku-format'],
      files: [{ path: 'transcripts', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('`createTask` を絶対に呼ばない');
    // The tracker tool admits the one write, createTask, so compose makes it requireApproval.
    expect(toolDefinitionsOf(agentDefinition)).toMatchObject([
      { kind: 'openapi', name: 'tracker', allow: ['operationId:createTask'] },
    ]);
    const selected = selectAllowedOperations(trackerTool.allow, operationsOf(document));
    expect(selected.refusals).toStrictEqual([]);
    expect(
      toolApprovalRules(
        toolServerKey('tracker'),
        selected.admitted.map((operation) => ({ name: operation.operationId, method: 'POST' })),
      ),
    ).toStrictEqual(['mcp__tracker__createTask']);
    const surfaces = agent?.body.surfaces ?? [];
    expect(surfaces.map((surface) => surface.name)).toStrictEqual(['minutes']);
    expect(surfaces[0]?.layout).toBe('page');
    expect(surfaces[0]?.toolResults).toStrictEqual({ list_tasks: 'table' });
    const skill = project.skills.find((entry) => entry.name === 'gijiroku-format');
    expect(skill?.files.map((file) => file.path).sort()).toStrictEqual([
      'SKILL.md',
      'scripts/dates.d.mts',
      'scripts/dates.mjs',
    ]);
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: false,
      runCommands: true,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(4);
    expect(cases.some((entry) => entry.expect.contains?.includes('担当未定'))).toBe(true);
    expect(cases.some((entry) => entry.expect.notContains?.includes('TASK-'))).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the date script resolves relative Japanese dates against the meeting date', async () => {
    // 2026-10-02 is a Friday; 2026-10-05 the Monday after.
    const friday = '2026-10-02';
    const cases: readonly [string, string, string | null][] = [
      ['今日', friday, '2026-10-02'],
      ['明日', friday, '2026-10-03'],
      ['明後日', friday, '2026-10-04'],
      ['来週金曜', friday, '2026-10-09'],
      ['来週の金曜くらいまでに', friday, '2026-10-09'],
      ['今週金曜日', '2026-10-05', '2026-10-09'],
      ['来週金曜', '2026-10-05', '2026-10-16'],
      ['再来週の月曜', friday, '2026-10-12'],
      ['週明け', friday, '2026-10-05'],
      ['月末', friday, '2026-10-31'],
      ['来月末', '2026-01-15', '2026-02-28'],
      ['来月10日', friday, '2026-11-10'],
      ['来月31日', friday, null], // November has 30 days
      ['3営業日後', friday, '2026-10-07'], // Mon 5, Tue 6, Wed 7
      ['３営業日後', friday, '2026-10-07'], // full-width digit
      ['5日後', friday, '2026-10-07'],
      ['12月28日', friday, '2026-12-28'],
      ['1月4日', friday, '2027-01-04'], // already past this year: next year
      ['2026/11/30', friday, '2026-11-30'],
      ['なるべく早く', friday, null],
      ['次回まで', friday, null],
    ];
    for (const [expression, base, expected] of cases) {
      expect(resolveDate(expression, base), `${expression} from ${base}`).toBe(expected);
    }
    expect(resolveDate('3営業日後', friday, { holidays: ['2026-10-05'] })).toBe('2026-10-08');
    expect(() => resolveDate('明日', '10/2')).toThrow('YYYY-MM-DD');

    // As the skill runs it inside a run: a command, JSON on stdout.
    const { stdout } = await run(process.execPath, [DATES, friday, '来週金曜', '近いうちに']);
    expect(JSON.parse(stdout)).toStrictEqual([
      { expression: '来週金曜', date: '2026-10-09' },
      { expression: '近いうちに', date: null },
    ]);
    await expect(run(process.execPath, [DATES, '2026-02-30', '明日'])).rejects.toMatchObject({
      code: 2,
    });
  });

  it('the agent creates a task only after the call is approved, and the tracker refuses a bad owner or date', async () => {
    const { tracker, api, file } = await startTracker();
    expect(await tracker.tools()).toStrictEqual(['list_members', 'list_tasks']);
    expect(await trackerGateway(api).tools()).toStrictEqual(['createTask']);
    const as = await asPerson(CLERK);
    const atTracker = await asPersonAtTracker(CLERK);
    const roster = await tracker.callJson<Roster>('list_members', {}, as);
    expect(roster.members.map((member) => member.name)).toContain('鈴木 一郎');
    expect(roster.guests.map((guest) => guest.name)).toStrictEqual(['木村 浩二']);

    const item = {
      title: 'ライン3 段取り替え試行計画の作成',
      assignee: '鈴木 一郎',
      due: '2026-10-09',
      sourceMeeting: '2026-10-02 第2工場 生産会議（10月度第1回）',
    };
    // Not approved: refused by the platform, and the tracker is never dialled.
    expect(await trackerGateway(api).call('createTask', { body: item }, atTracker)).toStrictEqual({
      text: 'approval_required',
      isError: true,
    });
    // An approval is for those arguments only: an item edited on the way is another call.
    expect(
      await trackerGateway(api, [approvalOf(item)]).call(
        'createTask',
        { body: { ...item, due: '2026-10-16' } },
        atTracker,
      ),
    ).toStrictEqual({ text: 'approval_required', isError: true });
    expect(api.requests).toHaveLength(0);

    // Approved but wrong: the tracker's own checks refuse an owner off the roster or a bad date.
    const refusal = async (body: Record<string, unknown>): Promise<string> => {
      const result = await trackerGateway(api, [approvalOf(body)]).call(
        'createTask',
        { body },
        atTracker,
      );
      expect(result.isError).toBe(true);
      return result.text;
    };
    expect(await refusal({ ...item, assignee: '担当未定' })).toContain('unknown assignee');
    expect(await refusal({ ...item, assignee: '鈴木さん' })).toContain('unknown assignee');
    expect(await refusal({ ...item, assignee: '木村 浩二' })).toContain('unknown assignee');
    expect(await refusal({ ...item, due: '来週金曜' })).toContain('YYYY-MM-DD');
    expect(await refusal({ ...item, due: '2026-02-30' })).toContain('YYYY-MM-DD');
    expect(await tracker.callJson('list_tasks', {}, as)).toStrictEqual([]);

    // Approved: exactly one task, with the body that was approved.
    const approved = trackerGateway(api, [approvalOf(item)]);
    const created = await approved.callJson<Created>('createTask', { body: item }, atTracker);
    expect(created).toMatchObject({
      created: true,
      task: {
        id: 'TASK-0001',
        assignee: '鈴木 一郎',
        department: '製造部 第2製造課',
        createdBy: CLERK,
        status: '未対応',
      },
    });
    // A retried run does not duplicate the task.
    const again = await approved.callJson<Created>('createTask', { body: item }, atTracker);
    expect(again).toMatchObject({ created: false, task: { id: 'TASK-0001' } });

    const stored = JSON.parse(await readFile(file, 'utf8')) as TrackerTask[];
    expect(stored.map((task) => task.id)).toStrictEqual(['TASK-0001']);
    expect(await tracker.callJson('list_tasks', { assignee: '山本 真理子' }, as)).toStrictEqual([]);
    expect(api.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/tasks',
      body: item,
    });

    // No credential, no write; no asserted caller, no write.
    const anonymous = await approved.call('createTask', { body: item });
    expect(anonymous.isError).toBe(true);
  });

  it('refuses members and tasks of another department by the asserted subject, not by prompt text', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const clerk = await asPerson(CLERK);
    const lead = await asPerson(DEV_LEAD);
    const item = {
      title: 'ライン3 段取り替え試行計画の作成',
      assignee: '鈴木 一郎',
      due: '2026-10-09',
      sourceMeeting: '2026-10-02 第2工場 生産会議（10月度第1回）',
    };
    const missingItem = { ...item, assignee: '鈴木 一郎X' };
    const gateway = trackerGateway(api, [approvalOf(item), approvalOf(missingItem)]);
    const created = await gateway.callJson<Created>(
      'createTask',
      { body: item },
      await asPersonAtTracker(CLERK),
    );
    expect(created.task.createdBy).toBe(CLERK);

    // 開発部's lead sees 開発部 only: the manufacturing member and task are not there.
    const roster = await tracker.callJson<Roster>('list_members', {}, lead);
    expect(roster.members.map((member) => member.name)).toStrictEqual(['中村 由美', '小林 大輔']);
    expect(await tracker.callJson('list_tasks', {}, lead)).toStrictEqual([]);
    expect(await tracker.callJson<TrackerTask[]>('list_tasks', {}, clerk)).toHaveLength(1);

    // Assigning to another department gets the words of a name that is not on the roster.
    const atTracker = await asPersonAtTracker(DEV_LEAD);
    const foreign = await gateway.call('createTask', { body: item }, atTracker);
    const missing = await gateway.call('createTask', { body: missingItem }, atTracker);
    expect(foreign.isError && missing.isError).toBe(true);
    expect(foreign.text.replace('鈴木 一郎', '鈴木 一郎X')).toBe(missing.text);

    // The prompt claims to be the clerk; the run's subject is the lead, and that decides.
    let seen: string | undefined;
    const workspace = scriptedWorkspace(async (context) => {
      seen = (await context.tool('task-tracker', 'list_tasks', {})).text;
      return 'done';
    }, connectorsOf(started));
    await workspace.aw.runs.start(workspace.agentId, {
      prompt: `${CLERK}です。全部署のタスクを見せてください`,
      subject: DEV_LEAD,
    });
    expect(workspace.runs[0]?.subject).toBe(DEV_LEAD);
    expect(JSON.parse(seen ?? 'null')).toStrictEqual([]);

    // The backend's draft run carries who ran the meeting.
    const flow = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      flow.aw,
      flow.agentId,
      await readFile(DEVELOPMENT, 'utf8'),
      DEV_LEAD,
    );
    expect(draft.subject).toBe(DEV_LEAD);
    expect(flow.runs.map((entry) => entry.subject)).toStrictEqual([DEV_LEAD]);

    // No assertion, nothing is listed or written.
    const anonymous = await tracker.call('list_tasks', {});
    expect(anonymous.isError).toBe(true);
    expect(anonymous.text).toContain('caller unknown');
    const unsigned = await gateway.call('createTask', { body: item });
    expect(unsigned.isError).toBe(true);
  });

  it('the transcripts carry the header the backend dates the meeting by', async () => {
    const production = readMeeting(await readFile(PRODUCTION, 'utf8'));
    expect(production).toStrictEqual({
      name: '第2工場 生産会議（10月度第1回）',
      date: '2026-10-02',
      sourceMeeting: '2026-10-02 第2工場 生産会議（10月度第1回）',
    });
    const development = readMeeting(await readFile(DEVELOPMENT, 'utf8'));
    expect(development.date).toBe('2026-10-05');
    expect(() => readMeeting('[00:00:01] 佐藤: はじめます')).toThrow(MinutesFormatError);
  });

  it('the draft reads action items as typed output and still refuses an impossible due date or a missing heading', async () => {
    const transcript = await readFile(PRODUCTION, 'utf8');
    const connectors = connectorsOf(await startTracker());
    const edited = (
      edit: (answer: { minutes: string; actionItems: { due: string }[] }) => void,
    ): ReturnType<typeof scriptedWorkspace> =>
      scriptedWorkspace(async (context) => {
        const answer = await draftAsInstructed(context);
        if (typeof answer === 'string') throw new Error('the draft must be structured');
        edit(answer.structured as { minutes: string; actionItems: { due: string }[] });
        return answer;
      }, connectors);

    const good = scriptedWorkspace(minutesModel(), connectors);
    const draft = await draftMinutes(good.aw, good.agentId, transcript, CLERK);
    expect(draft.items).toHaveLength(5);
    expect(draft.minutes).toContain('## アクション項目');
    expect(good.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['minutes', 'actionItems'],
      properties: {
        actionItems: {
          type: 'array',
          items: { required: ['no', 'title', 'assignee', 'due', 'evidence'] },
        },
      },
    });

    // 2026-02-30 has the shape of a date and is not a day.
    const impossible = edited((answer) => {
      const [first] = answer.actionItems;
      if (first !== undefined) first.due = '2026-02-30';
    });
    await expect(
      draftMinutes(impossible.aw, impossible.agentId, transcript, CLERK),
    ).rejects.toThrow('due must be YYYY-MM-DD');

    const headless = edited((answer) => {
      answer.minutes = answer.minutes.replace('## 決定事項', '## 決まったこと');
    });
    await expect(draftMinutes(headless.aw, headless.agentId, transcript, CLERK)).rejects.toThrow(
      MinutesFormatError,
    );

    // Nothing in the answer's text is parsed: a table with no structured items is a failed run.
    const silent = scriptedWorkspace(async (context) => {
      const answer = await draftAsInstructed(context);
      return typeof answer === 'string' ? answer : answer.text;
    }, connectors);
    await expect(draftMinutes(silent.aw, silent.agentId, transcript, CLERK)).rejects.toThrow(
      RunDidNotComplete,
    );
  });

  it('each action item pauses on its own createTask and writes nothing; once approved the continuation creates it under the asking clerk and the next item is offered', async () => {
    const started = await startTracker();
    const { tracker, api, file } = started;
    const workspace = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    expect(draft.minutes).toContain('- 日時: 2026-10-02（金）10:00〜10:45');
    expect(draft.minutes).toContain('佐藤 健一 部長、鈴木 一郎 課長、山本 真理子 主任');
    expect(draft.items.map((item) => [item.assignee, item.due])).toStrictEqual([
      ['山本 真理子', '2026-10-31'],
      ['鈴木 一郎', '2026-10-09'],
      ['高橋 翔太', '2026-10-07'],
      ['伊藤 美咲', '2026-10-05'],
      ['担当未定', '2026-11-10'],
    ]);
    expect(draft.unassigned.map((item) => item.no)).toStrictEqual([5]);
    const sourceMeeting = '2026-10-02 第2工場 生産会議（10月度第1回）';

    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });
    // What the person is asked to approve is the first item, exactly; nothing is written yet.
    expect(first.item).toStrictEqual({
      title: '打痕不良の原因分析（搬送シュート・治具の切り分け）',
      assignee: '山本 真理子',
      due: '2026-10-31',
    });
    expect(first.exact).toBe(true);
    expect(first.runId).toBe(workspace.runs[1]?.id);
    expect(first.sessionId).toBe(draft.sessionId);
    expect(first.call).toStrictEqual({
      toolName: 'mcp__tracker__createTask',
      canonicalCall: approvalOf({ ...first.item, sourceMeeting }),
    });
    expect(api.requests).toHaveLength(0);
    expect(await tracker.callJson('list_tasks', {}, await asPerson(CLERK))).toStrictEqual([]);

    // Approving it creates that task and offers the second.
    const second = await decideTask(workspace.aw, first, { approve: true });
    if (!('item' in second)) throw new Error('the second item was not offered');
    expect(second.item.assignee).toBe('鈴木 一郎');
    expect(api.requests).toHaveLength(1);

    const { offered, registration } = await decideAll(workspace.aw, second, () => ({
      approve: true,
    }));
    expect(offered.map((item) => item.assignee)).toStrictEqual([
      '鈴木 一郎',
      '高橋 翔太',
      '伊藤 美咲',
    ]);
    expect(registration).toMatchObject({
      status: 'registered',
      missing: [],
      unexpected: [],
      refused: [],
      sessionId: draft.sessionId,
    });
    expect(registration.tasks.map((task) => [task.id, task.assignee, task.due])).toStrictEqual([
      ['TASK-0001', '山本 真理子', '2026-10-31'],
      ['TASK-0002', '鈴木 一郎', '2026-10-09'],
      ['TASK-0003', '高橋 翔太', '2026-10-07'],
      ['TASK-0004', '伊藤 美咲', '2026-10-05'],
    ]);
    // Every run, the continuations included, ran in the draft's session for the asking clerk, so
    // the tracker records the clerk, not whoever approved.
    expect(new Set(workspace.runs.map((entry) => entry.sessionId))).toStrictEqual(
      new Set([draft.sessionId]),
    );
    expect(new Set(workspace.runs.map((entry) => entry.subject))).toStrictEqual(new Set([CLERK]));
    const stored = JSON.parse(await readFile(file, 'utf8')) as Created['task'][];
    expect(stored.map((task) => task.createdBy)).toStrictEqual([CLERK, CLERK, CLERK, CLERK]);
  });

  it('a rejection skips the item: its continuation creates nothing and the next item is offered', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const workspace = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });

    const { offered, registration } = await decideAll(workspace.aw, first, (item) =>
      item.assignee === '鈴木 一郎' || item.assignee === '伊藤 美咲'
        ? { approve: false, comment: 'もう済んでいます' }
        : { approve: true },
    );
    expect(offered.map((item) => item.assignee)).toStrictEqual([
      '山本 真理子',
      '鈴木 一郎',
      '高橋 翔太',
      '伊藤 美咲',
    ]);
    expect(registration).toMatchObject({ status: 'registered', missing: [], unexpected: [] });
    expect(registration.tasks.map((task) => task.assignee)).toStrictEqual([
      '山本 真理子',
      '高橋 翔太',
    ]);
    expect(api.requests).toHaveLength(2);
    // The comment reached the agent as the continuation's prompt.
    const prompts = workspace.runs.map((entry) => entry.prompt);
    expect(prompts.filter((prompt) => prompt === 'rejected: もう済んでいます')).toHaveLength(2);
  });

  it('a rejection whose continuation proposes the item again offers that new pause', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const model = minutesModel();
    let asked: Record<string, unknown> = {};
    let revised = false;
    // A model that answers the first rejection with a revised createTask for the same item.
    const workspace = scriptedWorkspace(async (context) => {
      const json = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
      if (json !== undefined) asked = JSON.parse(json) as Record<string, unknown>;
      if (context.prompt.startsWith('rejected') && !revised) {
        revised = true;
        await context.tool('tracker', 'createTask', { body: { ...asked, due: '2026-11-30' } });
        return '期限を直して登録しました。';
      }
      return model(context);
    }, connectorsOf(started));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });

    const again = await decideTask(workspace.aw, first, {
      approve: false,
      comment: '期限が違います',
    });
    if (!('item' in again)) throw new Error('the revised call was not offered');
    expect(again.item).toStrictEqual(first.item);
    expect(again.exact).toBe(false);
    expect(again.call.canonicalCall).toContain('2026-11-30');
    expect(again.runId).not.toBe(first.runId);
    expect(again.rest).toStrictEqual(first.rest);
    expect(api.requests).toHaveLength(0);

    const next = await decideTask(workspace.aw, again, { approve: false });
    if (!('item' in next)) throw new Error('the next item was not offered');
    expect(next.item.assignee).toBe('鈴木 一郎');
    expect(api.requests).toHaveLength(0);
  });

  it('an approved continuation that proposes the identical createTask again is never approvable', async () => {
    const started = await startTracker();
    const { tracker } = started;
    const model = minutesModel();
    let asked: Record<string, unknown> = {};
    // A continuation that proposes the very same createTask again.
    const workspace = scriptedWorkspace(async (context) => {
      const json = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
      if (json !== undefined) asked = JSON.parse(json) as Record<string, unknown>;
      if (context.prompt.startsWith('rejected')) {
        await context.tool('tracker', 'createTask', { body: asked });
        return '登録しました。';
      }
      return model(context);
    }, connectorsOf(started));
    // Today's engine refuses any further gated call in an approved continuation; stand in for one
    // that pauses on it instead, by answering the approval with a continuation that holds no
    // approved call (so the identical createTask pauses).
    const { runs } = workspace.aw;
    vi.spyOn(runs, 'approve').mockImplementation(async (runId, input) => runs.reject(runId, input));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });
    expect(first.exact).toBe(true);

    const again = await decideTask(workspace.aw, first, { approve: true });
    if (!('item' in again)) throw new Error('the repeated call was not offered');
    expect(again.item).toStrictEqual(first.item);
    expect(again.exact).toBe(false);
    expect(again.progress.approved).toStrictEqual([first.item]);
    await expect(decideTask(workspace.aw, again, { approve: true })).rejects.toThrow(
      /not the item/u,
    );
  });

  it('an unowned item is never offered, even when every offered item is declined', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const workspace = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });
    const { offered, registration } = await decideAll(workspace.aw, first, () => ({
      approve: false,
    }));
    expect(offered.map((item) => item.assignee)).toStrictEqual([
      '山本 真理子',
      '鈴木 一郎',
      '高橋 翔太',
      '伊藤 美咲',
    ]);
    expect(registration).toMatchObject({ status: 'registered', tasks: [] });
    expect(api.requests).toHaveLength(0);
    await expect(
      registerItems(workspace.aw, workspace.agentId, {
        draft: { ...draft, items: draft.unassigned },
        readTracker: readTrackerOf(tracker),
      }),
    ).rejects.toThrow('no action item');
  });

  it('a run that changes the item pauses on the changed call, and the backend will not approve it', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const honest = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      honest.aw,
      honest.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    // A model that moves the date of the item it was asked to register.
    const wayward = scriptedWorkspace(async (context) => {
      const asked = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1] ?? '{}';
      const body = JSON.parse(asked) as Record<string, unknown>;
      await context.tool('tracker', 'createTask', { body: { ...body, due: '2026-10-16' } });
      return '登録しました。';
    }, connectorsOf(started));

    const awaiting = await registerItems(wayward.aw, wayward.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });
    expect(awaiting.exact).toBe(false);
    expect(awaiting.call.canonicalCall).toContain('2026-10-16');
    await expect(decideTask(wayward.aw, awaiting, { approve: true })).rejects.toThrow(
      'not the item',
    );
    expect(wayward.runs).toHaveLength(1); // no continuation was started
    expect(api.requests).toHaveLength(0);
    expect(
      await readTrackerOf(tracker)('2026-10-02 第2工場 生産会議（10月度第1回）'),
    ).toStrictEqual([]);
  });

  it('a recording rides on the draft run as an attachment, and a recording-less draft sends none', async () => {
    const workspace = scriptedWorkspace(minutesModel(), connectorsOf(await startTracker()));
    const transcript = await readFile(PRODUCTION, 'utf8');
    const recordingId = 'a0000000-0000-4000-8000-000000000005';

    await draftMinutes(workspace.aw, workspace.agentId, transcript, CLERK, {
      fileId: recordingId,
    });
    await draftMinutes(workspace.aw, workspace.agentId, transcript, CLERK);

    const starts = workspace.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: recordingId }]);
    expect(starts[0]?.prompt).toContain('Transcript of');
    expect(starts[1]).not.toHaveProperty('attachments');
  });

  it('the draft keeps a guest owner, an unowned item and an unspoken date as they were said', async () => {
    const started = await startTracker();
    const { tracker } = started;
    const workspace = scriptedWorkspace(minutesModel(), connectorsOf(started));
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(DEVELOPMENT, 'utf8'),
      CLERK,
    );
    expect(draft.minutes).toContain('株式会社ミナト金型 木村 浩二 様');
    expect(draft.items.map((item) => [item.assignee, item.due])).toStrictEqual([
      ['小林 大輔', '2026-10-06'],
      ['株式会社ミナト金型 木村 浩二 様', '2026-10-09'],
      ['渡辺 隆', '2026-11-10'],
      ['担当未定', '期限未定'],
    ]);
    expect(draft.unassigned.map((item) => item.no)).toStrictEqual([4]);
    expect(draft.undated.map((item) => item.no)).toStrictEqual([4]);

    // The unowned, undated item is never offered. The guest's is: the tracker, which knows no such
    // member, refuses the approved call, and the backend says so. The other two are declined.
    const first = await registerItems(workspace.aw, workspace.agentId, {
      draft,
      readTracker: readTrackerOf(tracker),
    });
    const { offered, registration } = await decideAll(workspace.aw, first, (item) => ({
      approve: item.assignee.startsWith('株式会社'),
    }));
    expect(offered.map((item) => item.assignee)).toStrictEqual([
      '小林 大輔',
      '株式会社ミナト金型 木村 浩二 様',
      '渡辺 隆',
    ]);
    expect(registration.status).toBe('mismatch');
    expect(registration.missing.map((item) => item.assignee)).toStrictEqual([
      '株式会社ミナト金型 木村 浩二 様',
    ]);
    expect(registration.refused[0]?.reason).toContain('unknown assignee');
  });

  it('the backend refuses a draft whose run called createTask', async () => {
    const started = await startTracker();
    const { tracker, api } = started;
    const workspace = scriptedWorkspace(async (context) => {
      const draftAnswer = await draftAsInstructed(context);
      if (typeof draftAnswer === 'string') throw new Error('the draft must be structured');
      // The model "helpfully" registers an item during the draft. Nobody approved the call, so
      // the run pauses on it, nothing is written, and the backend discards the draft.
      await context.tool('tracker', 'createTask', {
        body: {
          title: 'ライン3 段取り替え試行計画の作成',
          assignee: '鈴木 一郎',
          due: '2026-10-09',
          sourceMeeting: '2026-10-02 第2工場 生産会議（10月度第1回）',
        },
      });
      return { ...draftAnswer, text: `${draftAnswer.text}\n\n登録しました。` };
    }, connectorsOf(started));
    const draft = draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
      CLERK,
    );
    await expect(draft).rejects.toThrow(DraftWroteToTracker);
    await expect(draft).rejects.toThrow('0 accepted by the tracker');
    expect(await tracker.callJson('list_tasks', {}, await asPerson(CLERK))).toStrictEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  it('a Graph transcript notification starts the typed draft run, and a duplicate starts nothing', async () => {
    const { tracker } = await startTracker();
    // The notification names no transcript; the agent reads it from its `transcripts` files.
    const transcript = await readFile(PRODUCTION, 'utf8');
    const workspace = scriptedWorkspace(
      (context) =>
        draftAsInstructed({
          ...context,
          prompt: `会議日（相対日付の基準日）: 2026-10-02\n${context.prompt}\n${transcript}`,
        }),
      { 'task-tracker': { id: CONNECTOR_ID, session: tracker, identityKey: IDENTITY_KEY } },
    );
    const created = await workspace.aw.triggers.create({
      ...TRANSCRIPT_TRIGGER,
      agentId: workspace.agentId,
    });
    if (!('firePath' in created)) throw new Error('a webhook trigger answers its fire path');
    // What Graph posts to the subscription's notificationUrl: a resource path, not the transcript.
    const notification = {
      value: [
        {
          id: 'notification-0001',
          subscriptionId: 'subscription-0001',
          changeType: 'created',
          resource: "communications/onlineMeetings('MSo1')/transcripts('VCNf')",
          resourceData: { id: 'VCNf' },
        },
      ],
    };

    const first = await workspace.fire(created.firePath, notification, {
      idempotencyKey: 'notification-0001',
    });
    const duplicate = await workspace.fire(created.firePath, notification, {
      idempotencyKey: 'notification-0001',
    });
    expect(first.status).toBe(202);
    expect(duplicate.run?.id).toBe(first.run?.id);
    expect(workspace.runs).toHaveLength(1);
    expect(workspace.runs[0]?.prompt).toContain("transcripts('VCNf')");
    expect(workspace.runs[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: ['minutes', 'actionItems'],
    });

    // A notification has no person behind it, so the trigger's subject is the caller (ADR-0156):
    // the tracker, which scopes by caller, accepts the run, and its draft validates.
    expect(created.trigger.subject).toBe(CLERK);
    expect(workspace.runs[0]?.subject).toBe(CLERK);
    const draft = await draftMinutesFromRun(workspace.aw, first.run?.id ?? '', CLERK);
    expect(draft.subject).toBe(CLERK);
    expect(draft.meeting.date).toBe('2026-10-02');
    expect(draft.items.length).toBeGreaterThan(0);
    expect(draft.unassigned.length).toBeGreaterThan(0);
  });
});
