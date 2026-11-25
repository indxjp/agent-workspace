/**
 * ADR-0169: a records stand-in keeps an approved write in the visitor's own workspace. Run against
 * the memory world and a real PostgreSQL, with the recorder the run API is wired with.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  DEMO_RECORD_SAMPLES,
  DemoRecordWriteAnswerSchema,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';
import { describe, expect, it } from 'vitest';

import { createDemoApprovedWrites } from '../records/approved-writes';
import { converse, resultOf, toolCall, type StandInAnswer } from './stand-in.test-support';
import {
  SPEC,
  copy,
  type DemoTemplatesWorld,
  type MakeDemoTemplatesWorld,
} from './templates.contract-world';

const TASK_JA = DEMO_RECORD_SAMPLES.task.ja;
const TASK_EN = DEMO_RECORD_SAMPLES.task.en;

const RECORDS: readonly DemoSampleRecords[] = [
  {
    connector: 'tasks',
    resource: 'task',
    lang: 'ja',
    tools: ['task_list'],
    data: [{ id: 't0', title: '入館証を発行する', assignee: '総務部 鈴木' }],
  },
  {
    connector: 'tasks',
    resource: 'task',
    lang: 'en',
    tools: ['task_list'],
    data: [{ id: 't0', title: 'Issue a building pass', assignee: 'General affairs, Suzuki' }],
  },
];

const SAMPLE_TITLES = ['Issue a building pass', '入館証を発行する'];

const TASKS = {
  kind: 'declared',
  name: 'tasks',
  reads: ['task_list'],
  writes: ['task_create', 'task_notify'],
  recorded: [{ write: 'task_create', kind: 'task', read: 'task_list' }],
} as const;

/** The approved call of `tool` on the `tasks` stand-in with `input`, as a decision stores it. */
const approved = (input: unknown, server = 'tasks', tool = 'task_create') => ({
  toolName: `mcp__${server}__${tool}`,
  canonicalCall: canonicalCall(`mcp__${server}__${tool}`, input),
});

/** Two visitors' demos of one entry whose agent has the `tasks` connector. */
async function twoVisitors(make: MakeDemoTemplatesWorld, local: string) {
  const world = await make();
  const entry = world.entry(local);
  await world.seedTemplate(entry, { ...SPEC, connectors: [TASKS], records: RECORDS });
  const first = await world.newGuest();
  const second = await world.newGuest();
  await copy(world, entry, first);
  await copy(world, entry, second);
  return {
    world,
    first,
    second,
    // Both guests' workspaces are demo workspaces (the email-link binder gives them an end).
    recorder: createDemoApprovedWrites({
      connectors: world.connectorStores,
      keepsDemoWrites: () => Promise.resolve(true),
    }),
  };
}

/** The workspace's records stand-in: its id and the arguments its process runs with. */
async function standIn(
  world: DemoTemplatesWorld,
  workspaceId: string,
): Promise<{ readonly id: string; readonly args: readonly string[] }> {
  const [tasks] = await world.connectors(workspaceId);
  if (tasks === undefined || !('transport' in tasks) || tasks.transport !== 'stdio') {
    throw new Error('no records stand-in');
  }
  return { id: tasks.id, args: tasks.args ?? [] };
}

/** Run the workspace's stand-in, as the next run would, and send it `requests`. */
async function ask(
  world: DemoTemplatesWorld,
  workspaceId: string,
  requests: readonly unknown[],
): Promise<readonly StandInAnswer[]> {
  return converse(await standIn(world, workspaceId), requests);
}

const titlesOf = (answer: StandInAnswer | undefined): readonly unknown[] =>
  (resultOf(answer)['structuredContent'] as { records: { title: unknown }[] }).records.map(
    (record) => record.title,
  );

/** The kept titles first, newest first, then the two sample records in either order. */
function expectKeptFirst(answer: StandInAnswer | undefined, kept: readonly string[]): void {
  const titles = titlesOf(answer);
  expect(titles.slice(0, kept.length)).toEqual(kept);
  expect([...titles.slice(kept.length)].sort()).toEqual(SAMPLE_TITLES);
}

export function describeRecordedWrites(make: MakeDemoTemplatesWorld): void {
  describe('a records stand-in keeps an approved write (ADR-0169)', () => {
    it('shows an approved write to the next read in the same workspace, and not to another visitor', async () => {
      const { world, first, second, recorder } = await twoVisitors(make, 'kept');
      await recorder.keep({ workspaceId: first.workspaceId, calls: [approved(TASK_JA)] });

      const [write, read] = await ask(world, first.workspaceId, [
        toolCall(1, 'task_create', TASK_JA),
        toolCall(2, 'task_list'),
      ]);
      expect(DemoRecordWriteAnswerSchema.parse(resultOf(write)['structuredContent'])).toEqual({
        demoOnly: true,
        recorded: true,
        tool: 'task_create',
        record: { id: 'task-1', kind: 'task', ...TASK_JA },
      });
      expectKeptFirst(read, [TASK_JA.title]);

      const [other] = await ask(world, second.workspaceId, [toolCall(1, 'task_list')]);
      expectKeptFirst(other, []);
    });

    it('changes nothing for a write nobody approved: the stand-in refuses it and its row is as copied', async () => {
      const { world, first } = await twoVisitors(make, 'unapproved');
      const before = await standIn(world, first.workspaceId);
      const [write, read] = await ask(world, first.workspaceId, [
        toolCall(1, 'task_create', TASK_EN),
        toolCall(2, 'task_list'),
      ]);
      expect(resultOf(write)['isError']).toBe(true);
      expect(resultOf(write)['structuredContent']).toMatchObject({
        recorded: false,
        code: 'demo_write_not_recorded',
      });
      expectKeptFirst(read, []);
      expect(await standIn(world, first.workspaceId)).toEqual(before);
    });

    it('refuses invalid approved input with a typed error and keeps no record', async () => {
      const { world, first, recorder } = await twoVisitors(make, 'invalid');
      const input = { title: '', assignee: TASK_EN.assignee, due: 'next week' };
      await recorder.keep({ workspaceId: first.workspaceId, calls: [approved(input)] });
      const [write, read] = await ask(world, first.workspaceId, [
        toolCall(1, 'task_create', input),
        toolCall(2, 'task_list'),
      ]);
      expect(resultOf(write)['isError']).toBe(true);
      const answer = DemoRecordWriteAnswerSchema.parse(resultOf(write)['structuredContent']);
      expect(answer).toMatchObject({ recorded: false, code: 'demo_record_invalid' });
      expect(answer.recorded ? [] : (answer.issues ?? []).map((issue) => issue.path)).toEqual([
        'title',
        'due',
      ]);
      expectKeptFirst(read, []);
    });

    it('keeps a call named by connector id, and ignores calls to any other tool or workspace', async () => {
      const { world, first, second, recorder } = await twoVisitors(make, 'by-id');
      const tasks = await standIn(world, first.workspaceId);
      await recorder.keep({
        workspaceId: first.workspaceId,
        calls: [
          approved(TASK_EN, `connector-${tasks.id}`),
          approved({ id: 't0' }, 'tasks', 'task_notify'),
          approved(TASK_EN, 'mailer', 'task_create'),
          { toolName: 'Write', canonicalCall: canonicalCall('Write', { file_path: 'x' }) },
        ],
      });
      // The first visitor's call, decided in their own workspace, never reaches the second's.
      await recorder.keep({ workspaceId: second.workspaceId, calls: [] });
      const [read] = await ask(world, first.workspaceId, [toolCall(1, 'task_list')]);
      expectKeptFirst(read, [TASK_EN.title]);
      const [other] = await ask(world, second.workspaceId, [toolCall(1, 'task_list')]);
      expectKeptFirst(other, []);
    });
  });
}
