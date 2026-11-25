import { canonicalCall } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { RECORDS_PER_ANSWER } from '../../../apps/web/server/demo/provision/limits.ts';
import { recordsStandIns } from './records-stand-in.ts';

const TASK = {
  title: '[ONB-01] アカウントの発行',
  assignee: '情報システム部 宍戸 圭',
  due: '2026-12-01',
};
const OTHER = { title: '[ONB-02] PCと機器の準備', assignee: '情報システム部 宍戸 圭' };

/** The onboarding stand-in, and its calls as the engine makes them once `approved` are approved. */
function onboarding() {
  const tasks = recordsStandIns('onboarding')['onboarding-tasks'];
  if (tasks === undefined) throw new Error('onboarding has no records stand-in');
  const approve = (args: Record<string, unknown>) =>
    canonicalCall('mcp__onboarding-tasks__create_task', args);
  return {
    create: (args: Record<string, unknown>, approved = [approve(args)]) =>
      tasks.session.call('create_task', args, { approvedToolCalls: approved }),
    list: async (args: Record<string, unknown> = {}) => {
      const result = await tasks.session.call('list_tasks', args);
      expect(result.isError).toBe(false);
      return JSON.parse(result.text) as { id: string; title: string }[];
    },
    call: (tool: string) => tasks.session.call(tool, {}),
  };
}

describe('a recording’s records stand-in', () => {
  it('stands in for exactly the connectors of an entry that keep a write', () => {
    expect(Object.keys(recordsStandIns('onboarding'))).toEqual(['onboarding-tasks']);
    expect(Object.keys(recordsStandIns('incident'))).toEqual(['tracker']);
    expect(Object.keys(recordsStandIns('account-requests'))).toEqual(['account-requests-grants']);
    // meeting-minutes' connectors keep nothing; budget has none.
    expect(recordsStandIns('meeting-minutes')).toEqual({});
    expect(recordsStandIns('budget')).toEqual({});
  });

  it('keeps an approved write as a record of its kind and answers its read with it, newest first', async () => {
    const desk = onboarding();
    expect(await desk.list()).toEqual([]);
    const first = await desk.create(TASK);
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toEqual({
      demoOnly: true,
      tool: 'create_task',
      recorded: true,
      record: { id: 'task-1', kind: 'task', ...TASK },
    });
    await desk.create(OTHER);
    expect((await desk.list()).map((task) => task.id)).toEqual(['task-2', 'task-1']);
    // Narrowed as the provisioned stand-in narrows: text, a field, a limit.
    expect((await desk.list({ query: 'onb-01' })).map((task) => task.id)).toEqual(['task-1']);
    expect((await desk.list({ title: OTHER.title.toUpperCase() })).map((t) => t.id)).toEqual([
      'task-2',
    ]);
    expect((await desk.list({ owner: 'nobody', query: '' })).length).toBe(2);
    expect((await desk.list({ limit: 1 })).map((task) => task.id)).toEqual(['task-2']);
    expect((await desk.list({ limit: 0 })).length).toBe(2);
    expect(RECORDS_PER_ANSWER).toBeGreaterThan(2);
  });

  it('keeps an approved call once: the same call again answers what was kept for it', async () => {
    const desk = onboarding();
    const first = await desk.create(TASK);
    const again = await desk.create(TASK);
    expect(again).toEqual(first);
    expect((await desk.list()).map((task) => task.id)).toEqual(['task-1']);
    // A refused call is answered the same way again, and still keeps nothing.
    const invalid = { title: '', assignee: 'x' };
    expect(await desk.create(invalid)).toEqual(await desk.create(invalid));
    expect((await desk.list()).length).toBe(1);
  });

  it('refuses a write nobody approved and keeps nothing', async () => {
    const desk = onboarding();
    const unasked = await desk.create(TASK, []);
    expect(unasked.isError).toBe(true);
    expect(JSON.parse(unasked.text)).toEqual({
      demoOnly: true,
      tool: 'create_task',
      recorded: false,
      code: 'demo_write_not_recorded',
    });
    // An approval of other arguments does not cover this call.
    const other = await desk.create(OTHER, [
      canonicalCall('mcp__onboarding-tasks__create_task', TASK),
    ]);
    expect(other.isError).toBe(true);
    expect(await desk.list()).toEqual([]);
  });

  it('refuses arguments that are not a record of its kind, naming the fields', async () => {
    const desk = onboarding();
    const refused = await desk.create({ title: '', assignee: 'x', extra: 1 });
    expect(refused.isError).toBe(true);
    const answer = JSON.parse(refused.text) as { code: string; issues: { path: string }[] };
    expect(answer.code).toBe('demo_record_invalid');
    expect(answer.issues.map((issue) => issue.path).sort()).toEqual(['$', 'title']);
    expect(await desk.list()).toEqual([]);
  });

  it('answers a tool it does not have with an error', async () => {
    const result = await onboarding().call('delete_task');
    expect(result).toEqual({ text: 'onboarding-tasks has no tool delete_task', isError: true });
  });

  it('numbers an access change as one of its own kind', async () => {
    const grants = recordsStandIns('account-requests')['account-requests-grants'];
    const change = {
      person: '楪 奏多',
      system: '顧客管理システム',
      level: 'write',
      change: 'grant',
    };
    const result = await grants?.session.call('change_access', change, {
      approvedToolCalls: [canonicalCall('mcp__account-requests-grants__change_access', change)],
    });
    expect(JSON.parse(result?.text ?? '{}')).toMatchObject({
      recorded: true,
      record: { id: 'access-1', kind: 'access', ...change },
    });
  });

  it('refuses an entry whose recorded connector has seeded record sets it would not answer', () => {
    const set = {
      connector: 'onboarding-tasks',
      resource: 'task',
      lang: 'ja' as const,
      tools: ['list_tasks'],
      data: [],
    };
    expect(() => recordsStandIns('onboarding', [set])).toThrow(
      "onboarding: onboarding-tasks has 1 seeded record sets, which the recording's records stand-in does not answer yet",
    );
    // A set of another connector is not this stand-in's to answer.
    expect(Object.keys(recordsStandIns('onboarding', [{ ...set, connector: 'other' }]))).toEqual([
      'onboarding-tasks',
    ]);
  });
});
