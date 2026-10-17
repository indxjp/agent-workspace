/**
 * The minutes app's backend: draft the minutes in one run, let a person approve the action items,
 * and register exactly those items in a second run of the same conversation.
 *
 * Two runs, because a run cannot stop half-way for a person to approve and then carry on (probe
 * `run-approval`). Run 1 drafts; the backend refuses the draft if the agent tried to write to the
 * tracker. The person edits and approves items in your UI. Run 2, in the same `sessionId`, is given
 * only the approved items, each signed with an approval token (`../mcp/approval.mjs`) the tracker
 * checks, so nothing unapproved or edited on the way can be written. Afterwards the backend reads
 * the tracker itself and reports anything missing or unexpected.
 *
 * Action items come back inside the minutes' text (no output schema; probe `run-output-schema`),
 * so `parseActionItems` reads them from the minutes: the fenced ```json action-items block the
 * skill asks for, or, when the model left it out, the アクション項目 table.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';
import { approvalToken } from '../mcp/approval.mjs';
import { parseIsoDate } from '../skills/gijiroku-format/scripts/dates.mjs';

export const OWNER_UNKNOWN = '担当未定';
export const DUE_UNKNOWN = '期限未定';

/** The headings the house format requires, in order. */
export const REQUIRED_HEADINGS = ['## 議題', '## 決定事項', '## 継続課題', '## アクション項目'];
const REQUIRED_FIELDS = ['会議名', '日時', '場所', '出席者'];

export interface ActionItem {
  readonly no: number;
  readonly title: string;
  /** A roster name, a guest written 「会社名 氏名 様」, or 担当未定. */
  readonly assignee: string;
  /** YYYY-MM-DD or 期限未定. */
  readonly due: string;
  readonly evidence: string;
}

export interface Meeting {
  readonly name: string;
  /** The meeting's date, YYYY-MM-DD: the base every relative date resolves against. */
  readonly date: string;
  /** How the tracker groups this meeting's tasks: `2026-10-02 第2工場 生産会議（…）`. */
  readonly sourceMeeting: string;
}

export interface Draft {
  readonly meeting: Meeting;
  readonly minutes: string;
  readonly items: readonly ActionItem[];
  /** Where the items were read from: the JSON block, or the table when the block was missing. */
  readonly itemsFrom: 'json' | 'table';
  /** Items the person must give an owner (or drop) before approving. */
  readonly unassigned: readonly ActionItem[];
  /** Items the person must give a due date (or drop) before approving. */
  readonly undated: readonly ActionItem[];
  readonly sessionId: string;
}

/** An item as the person approved it, possibly edited: a real owner and a real date. */
export interface ApprovedItem {
  readonly title: string;
  readonly assignee: string;
  readonly due: string;
}

export interface TrackerTask {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly due: string;
  readonly sourceMeeting: string;
}

export interface Registration {
  /** `registered` only when the tracker holds exactly the approved items for this meeting. */
  readonly status: 'registered' | 'mismatch';
  readonly tasks: readonly TrackerTask[];
  /** Approved items the tracker does not hold after the run. */
  readonly missing: readonly ApprovedItem[];
  /** Tasks for this meeting the person did not approve. */
  readonly unexpected: readonly TrackerTask[];
  /** create_task calls the tracker refused, with its reason. */
  readonly refused: readonly { readonly input: unknown; readonly reason: string }[];
  readonly answer: string;
  readonly sessionId: string;
}

export class MinutesFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MinutesFormatError';
  }
}

/** Run 1 called `create_task`. The draft is discarded, whether or not the tracker accepted it. */
export class DraftWroteToTracker extends Error {
  public constructor(public readonly calls: readonly ToolCall[]) {
    super(
      `the draft run called create_task ${String(calls.length)} time(s); the draft is refused ` +
        `(${String(calls.filter((call) => !call.isError).length)} accepted by the tracker)`,
    );
    this.name = 'DraftWroteToTracker';
  }
}

/** The approved list cannot be registered as given; nothing was sent to the agent. */
export class ApprovalRejected extends Error {
  public constructor(public readonly reasons: readonly string[]) {
    super(`approval rejected: ${reasons.join('; ')}`);
    this.name = 'ApprovalRejected';
  }
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
const isDue = (value: string): boolean => value === DUE_UNKNOWN || parseIsoDate(value) !== null;
const keyOf = (item: ApprovedItem): string =>
  `${item.title}\u0000${item.assignee}\u0000${item.due}`;

/** Read 会議名 and 日時 from a transcript's header (Teams text export or a Zoom VTT NOTE). */
export function readMeeting(transcript: string): Meeting {
  const name = /^会議名[:：]\s*(.+)$/mu.exec(transcript)?.[1]?.trim();
  const when = /^日時[:：]\s*(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/mu.exec(transcript);
  if (name === undefined || when === null) {
    throw new MinutesFormatError(
      'the transcript has no 会議名 or 日時 line to date the meeting by',
    );
  }
  const date = `${when[1] ?? ''}-${(when[2] ?? '').padStart(2, '0')}-${(when[3] ?? '').padStart(2, '0')}`;
  if (parseIsoDate(date) === null) throw new MinutesFormatError(`日時 is not a date: ${date}`);
  return { name, date, sourceMeeting: `${date} ${name}` };
}

function itemFrom(value: unknown, where: string): ActionItem {
  if (typeof value !== 'object' || value === null)
    throw new MinutesFormatError(`${where}: not an object`);
  const record = value as Record<string, unknown>;
  const field = (key: string): string => {
    const found = record[key];
    if (typeof found !== 'string' || found.trim() === '') {
      throw new MinutesFormatError(`${where}: ${key} must be a non-empty string`);
    }
    return found.trim();
  };
  const no = record['no'];
  if (typeof no !== 'number' || !Number.isInteger(no) || no < 1) {
    throw new MinutesFormatError(`${where}: no must be a positive integer`);
  }
  const due = field('due');
  if (!isDue(due))
    throw new MinutesFormatError(
      `${where}: due must be YYYY-MM-DD or ${DUE_UNKNOWN}, got "${due}"`,
    );
  const evidence = record['evidence'];
  return {
    no,
    title: field('title'),
    assignee: field('assignee'),
    due,
    evidence: typeof evidence === 'string' ? evidence.trim() : '',
  };
}

function itemsFromJson(minutes: string): ActionItem[] | null {
  const block = /```json action-items\s*\n([\s\S]*?)\n```/u.exec(minutes)?.[1];
  if (block === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    throw new MinutesFormatError('the action-items block is not valid JSON');
  }
  if (!Array.isArray(parsed))
    throw new MinutesFormatError('the action-items block must be an array');
  return parsed.map((value, index) => itemFrom(value, `action-items[${String(index)}]`));
}

function itemsFromTable(minutes: string): ActionItem[] {
  const section = minutes.split(/^## アクション項目\s*$/mu)[1]?.split(/^## /mu)[0];
  if (section === undefined)
    throw new MinutesFormatError('the minutes have no ## アクション項目 section');
  const rows = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/u.test(line))
    .slice(1) // the header row
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  return rows.map((cells, index) =>
    itemFrom(
      {
        no: Number(cells[0]),
        title: cells[1],
        assignee: cells[2],
        due: cells[3],
        evidence: cells[4] ?? '',
      },
      `アクション項目 row ${String(index + 1)}`,
    ),
  );
}

/**
 * The action items in `minutes`: the ```json action-items block when there is one, else the
 * アクション項目 table. When both are present they must agree on each item's owner and date,
 * because the person approves what the table shows and the backend registers what the JSON says.
 */
export function parseActionItems(minutes: string): { items: ActionItem[]; from: 'json' | 'table' } {
  const fromJson = itemsFromJson(minutes);
  if (fromJson === null) return { items: itemsFromTable(minutes), from: 'table' };
  if (/^## アクション項目\s*$/mu.test(minutes)) {
    const table = itemsFromTable(minutes);
    const differs = (item: ActionItem): boolean => {
      const row = table.find((candidate) => candidate.no === item.no);
      return row === undefined || row.assignee !== item.assignee || row.due !== item.due;
    };
    if (table.length !== fromJson.length || fromJson.some(differs)) {
      throw new MinutesFormatError('the アクション項目 table and the action-items block disagree');
    }
  }
  return { items: fromJson, from: 'json' };
}

function checkFormat(minutes: string): void {
  const missing = [
    ...REQUIRED_FIELDS.filter((field) => !new RegExp(`^- ${field}[:：]`, 'mu').test(minutes)),
    ...REQUIRED_HEADINGS.filter((heading) => !new RegExp(`^${heading}\\s*$`, 'mu').test(minutes)),
  ];
  if (missing.length > 0) {
    throw new MinutesFormatError(`the minutes are missing: ${missing.join(', ')}`);
  }
}

/** Run 1: draft the minutes from `transcript`. Writes nothing; refuses a draft that tried to. */
export async function draftMinutes(
  aw: AgentWorkspaceClient,
  agentId: string,
  transcript: string,
): Promise<Draft> {
  const meeting = readMeeting(transcript);
  const prompt = [
    `議事録の下書きを作成してください。会議日（相対日付の基準日）: ${meeting.date}`,
    `sourceMeeting: ${meeting.sourceMeeting}`,
    '--- 文字起こし ---',
    transcript,
  ].join('\n');
  const reading = await runAndRead(aw, agentId, { prompt });
  const writes = reading.toolCalls.filter((call) => toolIs(call.name, 'create_task'));
  if (writes.length > 0) throw new DraftWroteToTracker(writes);

  checkFormat(reading.answer);
  const { items, from } = parseActionItems(reading.answer);
  return {
    meeting,
    minutes: reading.answer,
    items,
    itemsFrom: from,
    unassigned: items.filter((item) => item.assignee === OWNER_UNKNOWN),
    undated: items.filter((item) => item.due === DUE_UNKNOWN),
    sessionId: reading.run.sessionId,
  };
}

function checkApproved(approved: readonly ApprovedItem[]): void {
  const reasons: string[] = [];
  if (approved.length === 0) reasons.push('nothing was approved');
  const seen = new Set<string>();
  approved.forEach((item, index) => {
    const at = `item ${String(index + 1)} (${item.title})`;
    if (item.title.trim() === '') reasons.push(`${at}: no title`);
    if (item.assignee.trim() === '' || item.assignee === OWNER_UNKNOWN) {
      reasons.push(`${at}: give it an owner before approving`);
    }
    if (parseIsoDate(item.due) === null) reasons.push(`${at}: due must be YYYY-MM-DD`);
    if (seen.has(keyOf(item))) reasons.push(`${at}: approved twice`);
    seen.add(keyOf(item));
  });
  if (reasons.length > 0) throw new ApprovalRejected(reasons);
}

/**
 * Run 2: register `approved` in the same conversation, then check the tracker holds exactly them.
 *
 * `secret` signs each item (the tracker server holds the same secret as `APPROVAL_SECRET`);
 * `readTracker` is your read of the tracker's API for one meeting, so the result reflects the
 * tracker, not what the agent says it did.
 *
 * @throws {ApprovalRejected} before any run when an item has no owner, no real date, or repeats.
 */
export async function registerApproved(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: {
    readonly draft: Pick<Draft, 'meeting' | 'sessionId'>;
    readonly approved: readonly ApprovedItem[];
    readonly secret: string;
    readonly readTracker: (sourceMeeting: string) => Promise<readonly TrackerTask[]>;
  },
): Promise<Registration> {
  const { draft, approved, secret, readTracker } = input;
  checkApproved(approved);
  const { sourceMeeting } = draft.meeting;
  const signed = approved.map((item) => ({
    title: item.title,
    assignee: item.assignee,
    due: item.due,
    sourceMeeting,
    approval: approvalToken(secret, { ...item, sourceMeeting }),
  }));
  const prompt = [
    '承認済みのアクション項目を登録してください。次の JSON の項目だけを、値を変えずに create_task で登録してください。',
    '```json',
    JSON.stringify(signed, null, 2),
    '```',
  ].join('\n');
  const reading = await runAndRead(aw, agentId, { prompt, sessionId: draft.sessionId });

  const refused = reading.toolCalls
    .filter((call) => toolIs(call.name, 'create_task') && call.isError)
    .map((call) => ({ input: call.input, reason: call.output ?? '' }));
  const tasks = await readTracker(sourceMeeting);
  const held = new Set(tasks.map(keyOf));
  const wanted = new Set(approved.map(keyOf));
  const missing = approved.filter((item) => !held.has(keyOf(item)));
  const unexpected = tasks.filter((task) => !wanted.has(keyOf(task)));
  return {
    status: missing.length === 0 && unexpected.length === 0 ? 'registered' : 'mismatch',
    tasks,
    missing,
    unexpected,
    refused,
    answer: reading.answer,
    sessionId: reading.run.sessionId,
  };
}
