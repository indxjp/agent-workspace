import { readFile } from 'node:fs/promises';

import { expect, it, vi } from 'vitest';

import { scriptedWorkspace } from '../harness/scripted-workspace.ts';
import { decideTask, registerItems } from './backend/minutes.ts';
import {
  approvalOf,
  asPerson,
  CLERK,
  connectorsOf,
  decideAll,
  draftProduction,
  minutesModel,
  offerFirst,
  readTrackerOf,
  type Created,
} from './meeting-minutes.fixture.test-support.ts';

export function defineApprovalCases(): void {
  it('each action item pauses on its own createTask and writes nothing; once approved the continuation creates it under the asking clerk and the next item is offered', async () => {
    const loop = await draftProduction();
    const { tracker, api, file, workspace, draft } = loop;
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

    const first = await offerFirst(loop);
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
    const loop = await draftProduction();
    const { api, workspace } = loop;
    const first = await offerFirst(loop);

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
    const model = minutesModel();
    let asked: Record<string, unknown> = {};
    let revised = false;
    // A model that answers the first rejection with a revised createTask for the same item.
    const loop = await draftProduction(async (context) => {
      const json = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
      if (json !== undefined) asked = JSON.parse(json) as Record<string, unknown>;
      if (context.prompt.startsWith('rejected') && !revised) {
        revised = true;
        await context.tool('tracker', 'createTask', { body: { ...asked, due: '2026-11-30' } });
        return '期限を直して登録しました。';
      }
      return model(context);
    });
    const { api, workspace } = loop;
    const first = await offerFirst(loop);

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
    const model = minutesModel();
    let asked: Record<string, unknown> = {};
    // A continuation that proposes the very same createTask again.
    const loop = await draftProduction(async (context) => {
      const json = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1];
      if (json !== undefined) asked = JSON.parse(json) as Record<string, unknown>;
      if (context.prompt.startsWith('rejected')) {
        await context.tool('tracker', 'createTask', { body: asked });
        return '登録しました。';
      }
      return model(context);
    });
    const { workspace } = loop;
    // Today's engine refuses any further gated call in an approved continuation; stand in for one
    // that pauses on it instead, by answering the approval with a continuation that holds no
    // approved call (so the identical createTask pauses).
    const { runs } = workspace.aw;
    vi.spyOn(runs, 'approve').mockImplementation(async (runId, input) => runs.reject(runId, input));
    const first = await offerFirst(loop);
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
    const loop = await draftProduction();
    const { tracker, api, workspace, draft } = loop;
    const first = await offerFirst(loop);
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
    const loop = await draftProduction();
    const { tracker, api, draft } = loop;
    // A model that moves the date of the item it was asked to register.
    const wayward = scriptedWorkspace(async (context) => {
      const asked = /```json\n([\s\S]*?)\n```/u.exec(context.prompt)?.[1] ?? '{}';
      const body = JSON.parse(asked) as Record<string, unknown>;
      await context.tool('tracker', 'createTask', { body: { ...body, due: '2026-10-16' } });
      return '登録しました。';
    }, connectorsOf(loop));

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
}
