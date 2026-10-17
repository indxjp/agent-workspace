/**
 * Use case 8, the meeting minutes and action-item agent: the definition passes the contract, the
 * date script and the task tracker do their jobs, and the backend's two-run flow drafts minutes,
 * waits for a person's approval between runs, and registers exactly what was approved.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import {
  ApprovalRejected,
  draftMinutes,
  DraftWroteToTracker,
  MinutesFormatError,
  parseActionItems,
  readMeeting,
  registerApproved,
  type ApprovedItem,
  type TrackerTask,
} from './backend/minutes.ts';
import { approvalToken } from './mcp/approval.mjs';
import { resolveDate, weekdayOf } from './skills/gijiroku-format/scripts/dates.mjs';
import agentDefinition from './agents/meeting-minutes.ts';
import surfaceDefinition from './surfaces/minutes.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATES = path.join(DIR, 'skills', 'gijiroku-format', 'scripts', 'dates.mjs');
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000008';
const SECRET = 'gallery-approval-secret';
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
  readonly task: TrackerTask & { readonly status: string };
}

let project: GalleryProject;
const open: McpSession[] = [];

beforeAll(async () => {
  project = await loadGalleryProject(DIR, {
    'agents/meeting-minutes.ts': agentDefinition,
    'surfaces/minutes.ts': surfaceDefinition,
  });
});
afterEach(() => {
  for (const session of open.splice(0)) session.close();
});
afterAll(() => {
  for (const session of open) session.close();
});

/** A fresh tracker writing to its own JSON file, as the backend's tests should get. */
async function startTracker(
  env: Readonly<Record<string, string>> = { APPROVAL_SECRET: SECRET },
): Promise<{ tracker: McpSession; file: string }> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'gallery-tasks-')), 'tasks.json');
  const tracker = await startMcpServer(path.join(DIR, 'mcp', 'tasks.mjs'), {
    ...env,
    TASKS_FILE: file,
  });
  open.push(tracker);
  return { tracker, file };
}

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
  /** Whether the model remembered the ```json action-items block (the dev meeting: it forgot). */
  readonly json: boolean;
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
    json: true,
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
    json: false,
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
async function draftAsInstructed(context: ScriptContext): Promise<string> {
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
  return [
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
    ...(reading.json ? ['```json action-items', JSON.stringify(items, null, 2), '```', ''] : []),
    '内容を確認し、登録する項目を承認してください。',
  ].join('\n');
}

/** What a model does on a registration request: create_task for each approved item, unchanged. */
async function registerAsInstructed(context: ScriptContext): Promise<string> {
  const block = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1] ?? '[]';
  const approved = JSON.parse(block) as Record<string, unknown>[];
  const rows: string[] = [];
  for (const item of approved) {
    const result = await context.tool('task-tracker', 'create_task', item);
    if (result.isError) {
      rows.push(`| - | ${String(item['title'])} | 登録できませんでした: ${result.text} |`);
      continue;
    }
    const { task } = JSON.parse(result.text) as Created;
    rows.push(`| ${task.id} | ${task.title} | ${task.assignee} | ${task.due} |`);
  }
  return [
    '登録しました。',
    '',
    '| ID | 内容 | 担当 | 期限 |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

const asInstructed = (context: ScriptContext): Promise<string> =>
  context.prompt.startsWith('承認済み')
    ? registerAsInstructed(context)
    : draftAsInstructed(context);

const readTrackerOf =
  (tracker: McpSession) =>
  (sourceMeeting: string): Promise<readonly TrackerTask[]> =>
    tracker.callJson<TrackerTask[]>('list_tasks', { sourceMeeting });

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
      connectors: ['task-tracker'],
      skills: ['gijiroku-format'],
      files: [{ path: 'transcripts', access: 'read' }],
    });
    expect(definition?.agent.instructions).toContain('`create_task` を絶対に呼ばない');
    const surfaces = agent?.body.surfaces ?? [];
    expect(surfaces.map((surface) => surface.name)).toStrictEqual(['minutes']);
    expect(surfaces[0]?.layout).toBe('page');
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

  it('the tracker writes only approved items for roster members with real dates', async () => {
    const { tracker, file } = await startTracker();
    expect(await tracker.tools()).toStrictEqual(['list_members', 'list_tasks', 'create_task']);
    const roster = await tracker.callJson<Roster>('list_members', {});
    expect(roster.members.map((member) => member.name)).toContain('鈴木 一郎');
    expect(roster.guests.map((guest) => guest.name)).toStrictEqual(['木村 浩二']);

    const meeting = '2026-10-02 第2工場 生産会議（10月度第1回）';
    const item = {
      title: 'ライン3 段取り替え試行計画の作成',
      assignee: '鈴木 一郎',
      due: '2026-10-09',
      sourceMeeting: meeting,
    };
    const approval = approvalToken(SECRET, item);
    const refusal = async (args: Record<string, unknown>): Promise<string> => {
      const result = await tracker.call('create_task', args);
      expect(result.isError).toBe(true);
      return result.text;
    };

    expect(await refusal({ ...item, approval: 'made-up' })).toContain('not approved');
    expect(await refusal({ ...item })).toContain('not approved');
    // An approved item edited on the way in no longer matches its token.
    expect(await refusal({ ...item, due: '2026-10-16', approval })).toContain('not approved');
    expect(await refusal({ ...item, assignee: '担当未定', approval })).toContain(
      'unknown assignee',
    );
    expect(await refusal({ ...item, assignee: '鈴木さん', approval })).toContain(
      'unknown assignee',
    );
    expect(await refusal({ ...item, assignee: '木村 浩二', approval })).toContain(
      'unknown assignee',
    );
    expect(await refusal({ ...item, due: '来週金曜', approval })).toContain('YYYY-MM-DD');
    expect(await refusal({ ...item, due: '2026-02-30', approval })).toContain('YYYY-MM-DD');
    expect(await tracker.callJson('list_tasks', {})).toStrictEqual([]);

    const created = await tracker.callJson<Created>('create_task', { ...item, approval });
    expect(created).toMatchObject({
      created: true,
      task: {
        id: 'TASK-0001',
        assignee: '鈴木 一郎',
        department: '製造部 第2製造課',
        status: '未対応',
      },
    });
    // A retried run does not duplicate the task.
    const again = await tracker.callJson<Created>('create_task', { ...item, approval });
    expect(again).toMatchObject({ created: false, task: { id: 'TASK-0001' } });

    const stored = JSON.parse(await readFile(file, 'utf8')) as TrackerTask[];
    expect(stored.map((task) => task.id)).toStrictEqual(['TASK-0001']);
    expect(await tracker.callJson('list_tasks', { assignee: '山本 真理子' })).toStrictEqual([]);

    // Without a secret configured the tracker accepts no writes at all.
    const { tracker: closed } = await startTracker({});
    expect((await closed.call('create_task', { ...item, approval })).text).toContain(
      'accepts no writes',
    );
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

  it('action items are read from the json block, or from the table when the block is missing', () => {
    const table = [
      '## アクション項目',
      '',
      '| No. | 内容 | 担当 | 期限 | 根拠（発言） |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | 図面の提出 | 小林 大輔 | 2026-10-06 | 明日中に出します |',
      '| 2 | パネル原稿 | 担当未定 | 期限未定 | 営業さんの中で |',
    ].join('\n');
    const fromTable = parseActionItems(table);
    expect(fromTable.from).toBe('table');
    expect(fromTable.items).toStrictEqual([
      {
        no: 1,
        title: '図面の提出',
        assignee: '小林 大輔',
        due: '2026-10-06',
        evidence: '明日中に出します',
      },
      {
        no: 2,
        title: 'パネル原稿',
        assignee: '担当未定',
        due: '期限未定',
        evidence: '営業さんの中で',
      },
    ]);

    const json = (items: unknown): string =>
      `${table}\n\n\`\`\`json action-items\n${JSON.stringify(items)}\n\`\`\``;
    const agreeing = fromTable.items;
    expect(parseActionItems(json(agreeing))).toStrictEqual({ items: agreeing, from: 'json' });
    expect(() =>
      parseActionItems(json([{ ...agreeing[0], due: '2026-10-07' }, agreeing[1]])),
    ).toThrow('disagree');
    expect(() => parseActionItems(table.replace('2026-10-06', '来週'))).toThrow('YYYY-MM-DD');
    expect(() => parseActionItems('```json action-items\n{ broken\n```')).toThrow('not valid JSON');
  });

  it('the two-run flow registers exactly the approved items in the same session', async () => {
    const { tracker, file } = await startTracker();
    const workspace = scriptedWorkspace(asInstructed, {
      'task-tracker': { id: CONNECTOR_ID, session: tracker },
    });

    // Run 1: the draft.
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
    );
    expect(draft.itemsFrom).toBe('json');
    expect(draft.minutes).toContain('- 日時: 2026-10-02（金）10:00〜10:45');
    expect(draft.minutes).toContain('佐藤 健一 部長、鈴木 一郎 課長、山本 真理子 主任');
    expect(draft.minutes).toContain('伊藤 美咲 さん');
    expect(draft.items.map((item) => [item.assignee, item.due])).toStrictEqual([
      ['山本 真理子', '2026-10-31'],
      ['鈴木 一郎', '2026-10-09'],
      ['高橋 翔太', '2026-10-07'],
      ['伊藤 美咲', '2026-10-05'],
      ['担当未定', '2026-11-10'],
    ]);
    expect(draft.unassigned.map((item) => item.no)).toStrictEqual([5]);
    expect(await tracker.callJson('list_tasks', {})).toStrictEqual([]);

    // The person approves in your UI: moves a Saturday deadline to Friday, assigns the unowned
    // item, and drops the calendar distribution (already done).
    const pick = (no: number): ApprovedItem => {
      const item = draft.items.find((candidate) => candidate.no === no);
      if (item === undefined) throw new Error(`no item ${String(no)}`);
      return { title: item.title, assignee: item.assignee, due: item.due };
    };
    const approved: ApprovedItem[] = [
      { ...pick(1), due: '2026-10-30' },
      pick(2),
      pick(3),
      { ...pick(5), assignee: '伊藤 美咲' },
    ];

    // Run 2: the registration, in the same conversation.
    const registration = await registerApproved(workspace.aw, workspace.agentId, {
      draft,
      approved,
      secret: SECRET,
      readTracker: readTrackerOf(tracker),
    });
    expect(registration).toMatchObject({
      status: 'registered',
      missing: [],
      unexpected: [],
      refused: [],
    });
    expect(registration.tasks.map((task) => [task.id, task.assignee, task.due])).toStrictEqual([
      ['TASK-0001', '山本 真理子', '2026-10-30'],
      ['TASK-0002', '鈴木 一郎', '2026-10-09'],
      ['TASK-0003', '高橋 翔太', '2026-10-07'],
      ['TASK-0004', '伊藤 美咲', '2026-11-10'],
    ]);
    expect(registration.sessionId).toBe(draft.sessionId);
    expect(workspace.runs.map((entry) => entry.sessionId)).toStrictEqual([
      draft.sessionId,
      draft.sessionId,
    ]);
    const starts = workspace.calls.filter((call) => call.method === 'POST');
    expect(starts.map((call) => (call.json as { sessionId?: unknown }).sessionId)).toStrictEqual([
      null,
      draft.sessionId,
    ]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(4);
  });

  it('the draft keeps a guest owner, an unowned item and an unspoken date as they were said', async () => {
    const { tracker } = await startTracker();
    const workspace = scriptedWorkspace(asInstructed, {
      'task-tracker': { id: CONNECTOR_ID, session: tracker },
    });
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(DEVELOPMENT, 'utf8'),
    );
    // The model left out the JSON block; the items come from the table.
    expect(draft.itemsFrom).toBe('table');
    expect(draft.minutes).toContain('株式会社ミナト金型 木村 浩二 様');
    expect(draft.items.map((item) => [item.assignee, item.due])).toStrictEqual([
      ['小林 大輔', '2026-10-06'],
      ['株式会社ミナト金型 木村 浩二 様', '2026-10-09'],
      ['渡辺 隆', '2026-11-10'],
      ['担当未定', '期限未定'],
    ]);
    expect(draft.unassigned.map((item) => item.no)).toStrictEqual([4]);
    expect(draft.undated.map((item) => item.no)).toStrictEqual([4]);

    // Approving the guest's item as is fails at the tracker, and the backend says so.
    const guest = draft.items[1];
    if (guest === undefined) throw new Error('no guest item');
    const registration = await registerApproved(workspace.aw, workspace.agentId, {
      draft,
      approved: [{ title: guest.title, assignee: guest.assignee, due: guest.due }],
      secret: SECRET,
      readTracker: readTrackerOf(tracker),
    });
    expect(registration.status).toBe('mismatch');
    expect(registration.missing.map((item) => item.assignee)).toStrictEqual([
      '株式会社ミナト金型 木村 浩二 様',
    ]);
    expect(registration.refused[0]?.reason).toContain('unknown assignee');
  });

  it('the backend refuses a draft whose run called create_task', async () => {
    const { tracker } = await startTracker();
    const workspace = scriptedWorkspace(
      async (context) => {
        const minutes = await draftAsInstructed(context);
        // The model "helpfully" registers an item during the draft. The tracker refuses it (no
        // approval token), and the backend discards the draft anyway.
        await context.tool('task-tracker', 'create_task', {
          title: 'ライン3 段取り替え試行計画の作成',
          assignee: '鈴木 一郎',
          due: '2026-10-09',
          sourceMeeting: '2026-10-02 第2工場 生産会議（10月度第1回）',
          approval: 'approved',
        });
        return `${minutes}\n\n登録しました。`;
      },
      { 'task-tracker': { id: CONNECTOR_ID, session: tracker } },
    );
    const draft = draftMinutes(workspace.aw, workspace.agentId, await readFile(PRODUCTION, 'utf8'));
    await expect(draft).rejects.toThrow(DraftWroteToTracker);
    await expect(draft).rejects.toThrow('0 accepted by the tracker');
    expect(await tracker.callJson('list_tasks', {})).toStrictEqual([]);
  });

  it('the backend rejects an unowned approval before any run, and reports a run that registers the wrong items', async () => {
    const { tracker } = await startTracker();
    const workspace = scriptedWorkspace(asInstructed, {
      'task-tracker': { id: CONNECTOR_ID, session: tracker },
    });
    const draft = await draftMinutes(
      workspace.aw,
      workspace.agentId,
      await readFile(PRODUCTION, 'utf8'),
    );
    const base = { draft, secret: SECRET, readTracker: readTrackerOf(tracker) };

    const unowned = registerApproved(workspace.aw, workspace.agentId, {
      ...base,
      approved: [{ title: '来客対応手順の見直し', assignee: '担当未定', due: '2026-11-10' }],
    });
    await expect(unowned).rejects.toThrow(ApprovalRejected);
    await expect(
      registerApproved(workspace.aw, workspace.agentId, {
        ...base,
        approved: [{ title: '治具の見積もり', assignee: '高橋 翔太', due: '3営業日後' }],
      }),
    ).rejects.toThrow('due must be YYYY-MM-DD');
    expect(workspace.runs).toHaveLength(1); // only the draft: nothing was sent to the agent

    // A run 2 that changes a date and adds an item nobody approved: the tracker refuses both
    // writes, and the backend's own read of the tracker reports the approved item as missing.
    const wayward = scriptedWorkspace(
      async (context) => {
        const block = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1] ?? '[]';
        const [first] = JSON.parse(block) as Record<string, unknown>[];
        await context.tool('task-tracker', 'create_task', { ...first, due: '2026-10-16' });
        await context.tool('task-tracker', 'create_task', {
          ...first,
          title: '年末年始稼働カレンダーの各課への配布',
          assignee: '伊藤 美咲',
        });
        return '登録しました。';
      },
      { 'task-tracker': { id: CONNECTOR_ID, session: tracker } },
    );
    const registration = await registerApproved(wayward.aw, wayward.agentId, {
      ...base,
      approved: [
        { title: 'ライン3 段取り替え試行計画の作成', assignee: '鈴木 一郎', due: '2026-10-09' },
      ],
    });
    expect(registration.status).toBe('mismatch');
    expect(registration.missing.map((item) => item.title)).toStrictEqual([
      'ライン3 段取り替え試行計画の作成',
    ]);
    expect(registration.refused).toHaveLength(2);
    expect(registration.tasks).toStrictEqual([]);
    expect(registration.answer).toBe('登録しました。'); // what the agent says is not what happened
  });
});
