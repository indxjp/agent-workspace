/* global process */ // The root ESLint config declares no environment globals.
// task-tracker: a task tracker that accepts writes, as an MCP server. It stands in for Backlog,
// Planner or Jira; in production these handlers call that service's API.
//
// Why your own server: `openapiTool()` reaches HTTP APIs read-only (GET and HEAD; probe
// `openapi-write`), so registering a task needs a tool you host. Four tools:
//
//   list_members                                   → who can be assigned, by exact name
//   list_tasks  { sourceMeeting?, assignee? }      → the tracker's tasks
//   create_task { title, assignee, due, sourceMeeting, approval }
//                                                  → the created task, or a refusal
//
// create_task refuses, with a reason the agent can read:
// - an assignee not on the roster (a guest, a nickname, 担当未定) — never a guess;
// - a due date that is not a real YYYY-MM-DD;
// - a missing or wrong approval token (see ./approval.mjs). Without APPROVAL_SECRET the server
//   accepts no writes at all: it fails closed.
// Registering the same meeting, title and assignee twice returns the existing task with
// `created: false`, so a retried run does not duplicate it (runs.start has no idempotency key).
//
// Storage: TASKS_FILE (a JSON file) when set, otherwise memory. MEMBERS_FILE overrides the roster.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuse, serveTools, text } from '../../shared/mcp-server.mjs';
import { verifyApproval } from './approval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS_FILE = process.env.MEMBERS_FILE ?? path.join(HERE, '..', 'data', 'members.json');
const TASKS_FILE = process.env.TASKS_FILE;
const APPROVAL_SECRET = process.env.APPROVAL_SECRET;

const roster = JSON.parse(readFileSync(MEMBERS_FILE, 'utf8'));
const assignable = new Map(
  roster.members.filter((member) => member.assignable).map((member) => [member.name, member]),
);

let tasks = TASKS_FILE !== undefined && existsSync(TASKS_FILE) ? readTasks(TASKS_FILE) : [];

function readTasks(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must hold a JSON array of tasks`);
  return parsed;
}

function save() {
  if (TASKS_FILE === undefined) return;
  const draft = `${TASKS_FILE}.tmp`;
  writeFileSync(draft, `${JSON.stringify(tasks, null, 2)}\n`);
  renameSync(draft, TASKS_FILE); // replace in one step so a reader never sees half a file
}

/** A real calendar date written YYYY-MM-DD. */
function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function optional(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') refuse(`${key} must be a string`);
  return value.trim();
}

function createTask(args) {
  const title = text(args, 'title');
  const assignee = text(args, 'assignee');
  const due = text(args, 'due');
  const sourceMeeting = text(args, 'sourceMeeting');
  if (title.length > 120) refuse('title must be at most 120 characters');
  if (!assignable.has(assignee)) {
    refuse(
      `unknown assignee "${assignee}": use a full name from list_members exactly. ` +
        'If the meeting named no owner, do not register the item; ask the person to assign it.',
    );
  }
  if (!isIsoDate(due)) refuse(`due must be a real date written YYYY-MM-DD, got "${due}"`);
  if (APPROVAL_SECRET === undefined || APPROVAL_SECRET === '') {
    refuse('this tracker accepts no writes: APPROVAL_SECRET is not configured');
  }
  const item = { sourceMeeting, title, assignee, due };
  if (!verifyApproval(APPROVAL_SECRET, item, args.approval)) {
    refuse(
      'not approved: create_task needs the approval token the backend issued for exactly this ' +
        'title, assignee, due and sourceMeeting. Register only approved items, unchanged.',
    );
  }

  const existing = tasks.find(
    (task) =>
      task.sourceMeeting === sourceMeeting && task.title === title && task.assignee === assignee,
  );
  if (existing !== undefined) return { created: false, task: existing };

  const task = {
    id: `TASK-${String(tasks.length + 1).padStart(4, '0')}`,
    title,
    assignee,
    department: assignable.get(assignee).department,
    due,
    sourceMeeting,
    status: '未対応',
  };
  tasks = [...tasks, task];
  save();
  return { created: true, task };
}

serveTools({
  name: 'task-tracker',
  tools: [
    {
      name: 'list_members',
      description:
        '担当者として登録できる社内メンバー（氏名・部署・役職）と社外ゲストを返す。担当はここの氏名をそのまま使う。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({
        organization: roster.organization,
        members: [...assignable.values()].map(({ name, department, title }) => ({
          name,
          department,
          title,
        })),
        guests: roster.guests,
      }),
    },
    {
      name: 'list_tasks',
      description:
        'タスクトラッカーの登録済みタスクを返す。sourceMeeting や assignee で絞り込める。',
      inputSchema: {
        type: 'object',
        properties: { sourceMeeting: { type: 'string' }, assignee: { type: 'string' } },
      },
      handler: (args) => {
        const sourceMeeting = optional(args, 'sourceMeeting');
        const assignee = optional(args, 'assignee');
        return tasks.filter(
          (task) =>
            (sourceMeeting === undefined || task.sourceMeeting === sourceMeeting) &&
            (assignee === undefined || task.assignee === assignee),
        );
      },
    },
    {
      name: 'create_task',
      description:
        '承認済みのアクション項目を1件タスク登録する。approval にはバックエンドが渡した承認トークンをそのまま入れる。' +
        '議事録の下書き中は呼ばない。担当未定・期限未定の項目は登録できない。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          assignee: { type: 'string', description: 'list_members の氏名（敬称なし）' },
          due: { type: 'string', description: 'YYYY-MM-DD' },
          sourceMeeting: { type: 'string', description: '議事録の会議名と日付' },
          approval: { type: 'string' },
        },
        required: ['title', 'assignee', 'due', 'sourceMeeting', 'approval'],
      },
      handler: createTask,
    },
  ],
});
