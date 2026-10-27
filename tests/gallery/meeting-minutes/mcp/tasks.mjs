/* global process */ // The root ESLint config declares no environment globals.
// task-tracker: the task tracker's reads, as an MCP server. It stands in for Backlog, Planner or
// Jira; in production these handlers call that service's API. Two tools:
//
//   list_members                                   → who can be assigned, by exact name
//   list_tasks  { sourceMeeting?, assignee? }      → the tracker's tasks
//
// Registering a task is not here: it is the tracker's `POST /tasks`, an `openapiTool()`
// (`tools/tracker.ts`, served by `tracker/fake-tracker.mjs` in the tests), which the platform runs
// only for a call a person approved. The two share TASKS_FILE, the tracker's tasks as a JSON file.
//
// Who may see whom (ADR-0142). The connector opts in with `identity: { secret }`, so each call
// carries the signed person who ran the meeting; `data/access.json` maps that `sub` to the
// departments they cover. list_members and list_tasks show only members of those departments (a
// prefix of the roster's department).
//
// Storage: TASKS_FILE (a JSON file, read on every call), otherwise no tasks. MEMBERS_FILE overrides
// the roster.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuse, scopeOf, serveTools } from '../../shared/mcp-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS_FILE = process.env.MEMBERS_FILE ?? path.join(HERE, '..', 'data', 'members.json');
const TASKS_FILE = process.env.TASKS_FILE;

const ACCESS_FILE = process.env.ACCESS_FILE ?? path.join(HERE, '..', 'data', 'access.json');

const roster = JSON.parse(readFileSync(MEMBERS_FILE, 'utf8'));
const ACCESS = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'));
const assignable = roster.members.filter((member) => member.assignable);

/** The assignable members in the departments the asserted caller covers. */
function visibleMembers(context) {
  const { departments } = scopeOf(context, ACCESS);
  return assignable.filter((member) =>
    departments.some((department) => member.department.startsWith(department)),
  );
}

/** The tracker's tasks as its API holds them now: another process registers them. */
function readTasks() {
  if (TASKS_FILE === undefined || !existsSync(TASKS_FILE)) return [];
  const parsed = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${TASKS_FILE} must hold a JSON array of tasks`);
  return parsed;
}

function optional(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') refuse(`${key} must be a string`);
  return value.trim();
}

serveTools({
  name: 'task-tracker',
  tools: [
    {
      name: 'list_members',
      description:
        '担当者として登録できる社内メンバー（氏名・部署・役職）と社外ゲストを返す。担当はここの氏名をそのまま使う。',
      inputSchema: { type: 'object', properties: {} },
      handler: (_args, context) => ({
        organization: roster.organization,
        members: visibleMembers(context).map(({ name, department, title }) => ({
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
      handler: (args, context) => {
        const visible = new Set(visibleMembers(context).map((member) => member.name));
        const sourceMeeting = optional(args, 'sourceMeeting');
        const assignee = optional(args, 'assignee');
        return readTasks().filter(
          (task) =>
            visible.has(task.assignee) &&
            (sourceMeeting === undefined || task.sourceMeeting === sourceMeeting) &&
            (assignee === undefined || task.assignee === assignee),
        );
      },
    },
  ],
});
