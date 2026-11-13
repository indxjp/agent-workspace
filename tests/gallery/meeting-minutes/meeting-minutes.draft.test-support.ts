import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import {
  draftMinutes,
  draftMinutesFromRun,
  DraftWroteToTracker,
  MinutesFormatError,
  registerItems,
  TRANSCRIPT_TRIGGER,
} from './backend/minutes.ts';
import { RunDidNotComplete } from '../shared/run-answer.ts';
import {
  asPerson,
  CLERK,
  CONNECTOR_ID,
  connectorsOf,
  decideAll,
  DEVELOPMENT,
  draftAsInstructed,
  IDENTITY_KEY,
  minutesModel,
  PRODUCTION,
  readTrackerOf,
  startTracker,
} from './meeting-minutes.fixture.test-support.ts';

/** The draft's typed output; the entry runs it before the approval loop, as the original file did. */
export function defineDraftOutputCases(): void {
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
}

/** The draft's attachment, owners, guard and trigger; the entry runs them after the approval loop. */
export function defineDraftRunCases(): void {
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
}
