/**
 * The minutes app's backend: draft the minutes in one run, then register the action items a person
 * approves, one run and one approval per item.
 *
 * Run 1 (`draftMinutes`) drafts; the backend refuses the draft if the agent tried to create a task.
 * It asks for structured output (`MinutesAnswerSchema`): the minutes and the action items arrive as
 * separate fields, so nothing is parsed out of the minutes' text. The backend still checks the
 * minutes' format and that every due date is a real date.
 *
 * Registration (`registerItems`, `decideTask`) starts, in the same `sessionId` and for the same
 * `subject`, one run per item that has an owner and a real due date (the rest is never offered).
 * Each run is asked to register exactly that item. `createTask` is a write (`../tools/tracker.ts`),
 * so the run pauses at `awaiting_approval` on that call and nothing reaches the tracker until a
 * person approves it. `decideTask` carries the decision: `runs.approve` starts the continuation that
 * creates the task for the person who asked (the platform keeps the paused run's `subject`,
 * ADR-0157), `runs.reject` starts one that creates nothing and skips the item. One approval covers
 * one call, so the next item is a new run. After the last, the backend reads the tracker itself and
 * reports anything missing or unexpected.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type RunReading,
  type ToolCall,
} from '../../shared/run-answer.ts';
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
  /** Items the person must give an owner (or drop) before approving. */
  readonly unassigned: readonly ActionItem[];
  /** Items the person must give a due date (or drop) before approving. */
  readonly undated: readonly ActionItem[];
  readonly sessionId: string;
  /** The signed-in person who ran the meeting; the registration runs start for the same person. */
  readonly subject: string;
}

/** An action item as the tracker takes it: a real owner and a real date. */
export interface TaskItem {
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
  /** Approved items the tracker does not hold at the end. */
  readonly missing: readonly TaskItem[];
  /** Tasks for this meeting the person did not approve. */
  readonly unexpected: readonly TrackerTask[];
  /** createTask calls that did not run (not approved, or the tracker refused), with the reason. */
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

/** Run 1 called `createTask`. The draft is discarded, whether or not the tracker accepted it. */
export class DraftWroteToTracker extends Error {
  public constructor(public readonly calls: readonly ToolCall[]) {
    super(
      `the draft run called createTask ${String(calls.length)} time(s); the draft is refused ` +
        `(${String(calls.filter((call) => !call.isError && call.output !== null).length)} accepted by the tracker)`,
    );
    this.name = 'DraftWroteToTracker';
  }
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
const isDue = (value: string): boolean => value === DUE_UNKNOWN || parseIsoDate(value) !== null;
const keyOf = (item: TaskItem): string => `${item.title}\u0000${item.assignee}\u0000${item.due}`;

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

/** What run 1 returns: the minutes a person reads and the action items they approve. */
export const MinutesAnswerSchema = z.object({
  minutes: z.string().describe('議事録の本文（Markdown）。アクション項目の表を含む'),
  actionItems: z
    .array(
      z.object({
        no: z.number().int().min(1).describe('アクション項目の番号（1始まり）'),
        title: z.string().min(1).describe('やること'),
        assignee: z
          .string()
          .min(1)
          .describe(
            `担当者。名簿の氏名、社外の方は「会社名 氏名 様」。決まっていなければ「${OWNER_UNKNOWN}」`,
          ),
        due: z
          .string()
          .regex(/^(\d{4}-\d{2}-\d{2}|期限未定)$/u)
          .describe(`期限。YYYY-MM-DD。決まっていなければ「${DUE_UNKNOWN}」`),
        evidence: z.string().describe('根拠になった発言'),
      }),
    )
    .describe('議事録のアクション項目の表と同じ内容'),
}) satisfies z.ZodType<{ minutes: string; actionItems: ActionItem[] }>;

function checkFormat(minutes: string): void {
  const missing = [
    ...REQUIRED_FIELDS.filter((field) => !new RegExp(`^- ${field}[:：]`, 'mu').test(minutes)),
    ...REQUIRED_HEADINGS.filter((heading) => !new RegExp(`^${heading}\\s*$`, 'mu').test(minutes)),
  ];
  if (missing.length > 0) {
    throw new MinutesFormatError(`the minutes are missing: ${missing.join(', ')}`);
  }
}

/**
 * The trigger a Microsoft Graph `callTranscript` subscription posts to (ADR-0144): its
 * `notificationUrl` is the `firePath`, and the notification id is the `Idempotency-Key`. The
 * notification carries a resource path, not the transcript. Its `outputSchema` (ADR-0154) asks the
 * run for the minutes and action items. A notification has no signed-in person behind it, so the
 * trigger names one as its `subject` (ADR-0156): the clerk who keeps this meeting's minutes, as the
 * tracker's own member list knows them. The tracker scopes by that caller on every firing.
 */
export const TRANSCRIPT_TRIGGER = {
  kind: 'webhook',
  name: 'meeting-minutes',
  prompt: [
    '会議の文字起こしが公開されました。議事録の下書きを作成してください。',
    'Microsoft Graph の変更通知:',
    '{{body}}',
  ].join('\n'),
  outputSchema: MinutesAnswerSchema,
  subject: '伊藤 美咲',
} as const;

/**
 * Run 1: draft the minutes from `transcript`. Writes nothing; refuses a draft that tried to.
 * With a `recording` (a workspace audio file), the platform transcribes it into the turn on an
 * OpenAI connection and refuses it by name on any other (`run_attachments_untranscribable`);
 * `transcript` then only needs the 会議名 and 日時 header.
 */
export async function draftMinutes(
  aw: AgentWorkspaceClient,
  agentId: string,
  transcript: string,
  /** The signed-in person asking, from the backend's own session; the tracker scopes by it. */
  subject: string,
  recording?: { readonly fileId: string },
): Promise<Draft> {
  const meeting = readMeeting(transcript);
  const prompt = [
    `議事録の下書きを作成してください。会議日（相対日付の基準日）: ${meeting.date}`,
    `sourceMeeting: ${meeting.sourceMeeting}`,
    '--- 文字起こし ---',
    transcript,
    ...(recording === undefined
      ? []
      : ['録音を添付しました。文字起こしはこの依頼の末尾の「Transcript of」に入っています。']),
  ].join('\n');
  let reading: RunReading<z.output<typeof MinutesAnswerSchema>>;
  try {
    reading = await runAndRead(
      aw,
      agentId,
      {
        prompt,
        subject,
        ...(recording === undefined ? {} : { attachments: [{ fileId: recording.fileId }] }),
      },
      MinutesAnswerSchema,
    );
  } catch (error) {
    // A draft that reached for createTask paused on it: nothing was written, and the draft is refused.
    if (error instanceof RunAwaitingApproval && toolIs(error.pending.call.toolName, 'createTask')) {
      throw new DraftWroteToTracker(
        error.pending.toolCalls.filter((call) => toolIs(call.name, 'createTask')),
      );
    }
    throw error;
  }
  return draftFrom(reading, meeting, subject);
}

/**
 * Run 1 of a notification the trigger answered: read the run and check its draft as
 * {@link draftMinutes} does. The notification carries no transcript, so the meeting is read from the
 * 会議名 and 日時 lines of the minutes themselves. `subject` is the trigger's own.
 */
export async function draftMinutesFromRun(
  aw: AgentWorkspaceClient,
  runId: string,
  subject: string,
): Promise<Draft> {
  const reading = await readRun(aw, runId, MinutesAnswerSchema);
  const meeting = readMeeting(reading.output.minutes.replace(/^- /gmu, ''));
  return draftFrom(reading, meeting, subject);
}

function draftFrom(
  reading: RunReading<z.output<typeof MinutesAnswerSchema>>,
  meeting: Meeting,
  subject: string,
): Draft {
  const writes = reading.toolCalls.filter((call) => toolIs(call.name, 'createTask'));
  if (writes.length > 0) throw new DraftWroteToTracker(writes);

  const { minutes, actionItems: items } = reading.output;
  checkFormat(minutes);
  // A pattern keeps the shape; only a calendar can say 2026-02-30 is not a day.
  const impossible = items.filter((item) => !isDue(item.due));
  if (impossible.length > 0) {
    throw new MinutesFormatError(
      `due must be YYYY-MM-DD or ${DUE_UNKNOWN}, got ${impossible.map((item) => `"${item.due}"`).join(', ')}`,
    );
  }
  return {
    meeting,
    minutes,
    items,
    unassigned: items.filter((item) => item.assignee === OWNER_UNKNOWN),
    undated: items.filter((item) => item.due === DUE_UNKNOWN),
    sessionId: reading.run.sessionId,
    subject,
  };
}

type ReadTracker = (sourceMeeting: string) => Promise<readonly TrackerTask[]>;

/** Where registration stands; it travels on each pause so {@link decideTask} can carry on. */
interface Progress {
  readonly agentId: string;
  readonly draft: Pick<Draft, 'meeting' | 'sessionId' | 'subject'>;
  readonly readTracker: ReadTracker;
  /** Items the person approved so far. */
  readonly approved: readonly TaskItem[];
  readonly refused: Registration['refused'];
  readonly answer: string;
}

/**
 * A run paused on `createTask` for `item`. `exact` says whether the paused call is that item,
 * unchanged, for this meeting (approve only then). Decide it with {@link decideTask}.
 */
export type TaskAwaitingApproval = AwaitingApproval & {
  readonly item: TaskItem;
  readonly exact: boolean;
  /** The items still to be offered after this one. */
  readonly rest: readonly TaskItem[];
  readonly progress: Progress;
};

/** An item with a real owner and a real date can be offered; the rest is never put to a person. */
const isRegistrable = (item: ActionItem): boolean =>
  item.assignee.trim() !== '' && item.assignee !== OWNER_UNKNOWN && parseIsoDate(item.due) !== null;

/**
 * Start registering the draft's action items, one run per item. Each run, in the draft's session and
 * for the draft's `subject`, is asked to register exactly that item and pauses on its `createTask`:
 * the tracker sees nothing until a person approves that call. Items without an owner or a real due
 * date are not offered. `readTracker` is your read of the tracker's API for one meeting, so the
 * final {@link Registration} reflects the tracker, not what the agent says it did.
 *
 * @throws {Error} when no action item of the draft can be registered.
 */
export async function registerItems(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: {
    readonly draft: Pick<Draft, 'meeting' | 'sessionId' | 'subject' | 'items'>;
    readonly readTracker: ReadTracker;
  },
): Promise<TaskAwaitingApproval> {
  const { draft, readTracker } = input;
  const queue = draft.items
    .filter(isRegistrable)
    .map(({ title, assignee, due }) => ({ title, assignee, due }));
  const first = await offerNext(
    aw,
    {
      agentId,
      draft: { meeting: draft.meeting, sessionId: draft.sessionId, subject: draft.subject },
      readTracker,
      approved: [],
      refused: [],
      answer: '',
    },
    queue,
  );
  if ('item' in first) return first;
  throw new Error('no action item of the draft can be registered');
}

/**
 * The person decided the paused item. Approving starts the continuation that makes the approved
 * call, so it is refused when the paused call is not the item (`exact` is false); rejecting starts
 * one that creates nothing and skips the item. Then the next item is offered or, when none is left,
 * the tracker is read and the {@link Registration} answered.
 *
 * @throws {Error} when asked to approve a call that is not the item.
 */
export async function decideTask(
  aw: AgentWorkspaceClient,
  awaiting: TaskAwaitingApproval,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<TaskAwaitingApproval | Registration> {
  if (decision.approve && !awaiting.exact) {
    throw new Error(`run ${awaiting.runId} paused on a call that is not the item`);
  }
  const input = decision.comment === undefined ? {} : { comment: decision.comment };
  const { run } = decision.approve
    ? await aw.runs.approve(awaiting.runId, input)
    : await aw.runs.reject(awaiting.runId, input);
  let reading: RunReading;
  try {
    reading = await readRun(aw, run.id);
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    // The continuation proposed the item again (a revised createTask after a rejection): offer it.
    const { progress } = awaiting;
    if (!decision.approve) return pausedOn(error.pending, awaiting.item, awaiting.rest, progress);
    // After an approval the item is already registered (or in `progress.approved`), so another
    // createTask for it, even an identical one, would register it twice: never approvable.
    return {
      ...pausedOn(error.pending, awaiting.item, awaiting.rest, {
        ...progress,
        approved: [...progress.approved, awaiting.item],
      }),
      exact: false,
    };
  }
  const done = settle(awaiting.progress, reading, decision.approve ? awaiting.item : null);
  return offerNext(aw, done, awaiting.rest);
}

/** The pause on `item`'s run; `exact` when its call is the item, unchanged, for this meeting. */
function pausedOn(
  pending: AwaitingApproval,
  item: TaskItem,
  rest: readonly TaskItem[],
  progress: Progress,
): TaskAwaitingApproval {
  const body = { ...item, sourceMeeting: progress.draft.meeting.sourceMeeting };
  return {
    ...pending,
    item,
    exact: pending.call.canonicalCall === canonicalCall(pending.call.toolName, { body }),
    rest,
    progress,
  };
}

/** Fold a settled run in: the item when it was approved, its refused createTask calls, its answer. */
function settle(progress: Progress, reading: RunReading, approved: TaskItem | null): Progress {
  return {
    ...progress,
    approved: approved === null ? progress.approved : [...progress.approved, approved],
    refused: [
      ...progress.refused,
      ...reading.toolCalls
        .filter((call) => toolIs(call.name, 'createTask') && call.isError)
        .map((call) => ({ input: call.input, reason: call.output ?? '' })),
    ],
    answer: reading.answer,
  };
}

/** Start the run for the first of `queue`, or finish when it is empty. */
async function offerNext(
  aw: AgentWorkspaceClient,
  progress: Progress,
  queue: readonly TaskItem[],
): Promise<TaskAwaitingApproval | Registration> {
  const [item, ...rest] = queue;
  if (item === undefined) return finish(progress);
  const { draft } = progress;
  const body = { ...item, sourceMeeting: draft.meeting.sourceMeeting };
  const prompt = [
    '次のアクション項目を、値を変えずに createTask で登録してください。',
    '```json',
    JSON.stringify(body, null, 2),
    '```',
  ].join('\n');
  try {
    const reading = await runAndRead(aw, progress.agentId, {
      prompt,
      subject: draft.subject,
      sessionId: draft.sessionId,
    });
    // It settled without pausing: the agent made no createTask call, so this item is not registered.
    return await offerNext(aw, settle(progress, reading, null), rest);
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return pausedOn(error.pending, item, rest, progress);
  }
}

/** Every item was decided: read the tracker and report what it holds against what was approved. */
async function finish(progress: Progress): Promise<Registration> {
  const { approved, draft } = progress;
  const tasks = await progress.readTracker(draft.meeting.sourceMeeting);
  const held = new Set(tasks.map(keyOf));
  const wanted = new Set(approved.map(keyOf));
  const missing = approved.filter((item) => !held.has(keyOf(item)));
  const unexpected = tasks.filter((task) => !wanted.has(keyOf(task)));
  return {
    status: missing.length === 0 && unexpected.length === 0 ? 'registered' : 'mismatch',
    tasks,
    missing,
    unexpected,
    refused: progress.refused,
    answer: progress.answer,
    sessionId: draft.sessionId,
  };
}
