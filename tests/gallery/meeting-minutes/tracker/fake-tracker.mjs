#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company's task tracker (Backlog, Planner, Jira), serving
// `apis/tracker.openapi.json` on loopback. The tests start it; for a local demo:
//
//   TRACKER_TOKEN=dev-token IDENTITY_SECRET=... IDENTITY_AUDIENCE=<tool-id> IDENTITY_WORKSPACE=<workspace-id> \
//     TASKS_FILE=./tasks.json PORT=8789 node tracker/fake-tracker.mjs
//
// `mcp/tasks.mjs` (list_members, list_tasks) reads the same TASKS_FILE, so the tasks this server
// registers are the tasks that one lists.
//
// The checks are the tracker's own rules, not the agent's: the caller (the signed `x-aw-identity`,
// ADR-0142) must be in `data/access.json`; the assignee must be an assignable member of a department
// that caller covers, and one who is not gets the same answer whether they are on the roster or not;
// `due` must be a real YYYY-MM-DD. Registering the same meeting, title and assignee twice returns the
// existing task with `created: false`, so a retried run does not duplicate it. Whether a person
// approved the call is not decided here: `createTask` is a write, so the platform runs it only for an
// approved call.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IDENTITY_ASSERTION_HEADER, verifyIdentity } from '@indx-workspace/sdk';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const BASE_PATH = '/api/v1';

const readBody = async (request) => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

/** A real calendar date written YYYY-MM-DD. */
function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Start the fake tracker. Resolves with its base URL (ending in `/api/v1`), the `requests` it
 * received (method, path and parsed body) and a `close()`. `identity` verifies the caller:
 * `{ key, audience, workspace }`, `key` a string or a list while it rotates. `tasksFile` persists
 * the tasks as a JSON array, for another process to read.
 */
export function startFakeTracker({
  token,
  identity,
  tasksFile,
  port = 0,
  membersFile = path.join(DATA_DIR, 'members.json'),
  accessFile = path.join(DATA_DIR, 'access.json'),
}) {
  const roster = JSON.parse(readFileSync(membersFile, 'utf8'));
  const access = JSON.parse(readFileSync(accessFile, 'utf8'));
  const assignable = roster.members.filter((member) => member.assignable);
  let tasks =
    tasksFile !== undefined && existsSync(tasksFile)
      ? JSON.parse(readFileSync(tasksFile, 'utf8'))
      : [];
  const requests = [];

  const save = () => {
    if (tasksFile === undefined) return;
    const draft = `${tasksFile}.tmp`;
    writeFileSync(draft, `${JSON.stringify(tasks, null, 2)}\n`);
    renameSync(draft, tasksFile); // replace in one step so a reader never sees half a file
  };

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://tracker.invalid');
    const entry = { method: request.method, path: url.pathname };
    requests.push(entry);
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== `${BASE_PATH}/tasks`) {
      send(404, { error: 'no such route' });
      return;
    }
    const caller = await verifyIdentity(
      request.headers[IDENTITY_ASSERTION_HEADER] ?? '',
      identity.key,
      new Date(),
      { audience: identity.audience, workspace: identity.workspace },
    );
    if (!caller.ok) {
      send(401, { code: caller.code });
      return;
    }
    if (!Object.hasOwn(access, caller.payload.sub)) {
      send(403, { error: 'no access: this caller is not registered for this tracker' });
      return;
    }
    let input;
    try {
      input = JSON.parse(await readBody(request));
    } catch {
      send(400, { error: 'the body must be JSON' });
      return;
    }
    entry.body = input;
    const { title, assignee, due, sourceMeeting } = input ?? {};
    for (const [field, value] of Object.entries({ title, assignee, due, sourceMeeting })) {
      if (!filled(value)) {
        send(422, { error: `${field} must be a non-empty string` });
        return;
      }
    }
    if (title.trim().length > 120) {
      send(422, { error: 'title must be at most 120 characters' });
      return;
    }
    const { departments } = access[caller.payload.sub];
    const member = assignable.find(
      (candidate) =>
        candidate.name === assignee.trim() &&
        departments.some((department) => candidate.department.startsWith(department)),
    );
    if (member === undefined) {
      send(422, {
        error:
          `unknown assignee "${assignee.trim()}": use a full name from list_members exactly. ` +
          'If the meeting named no owner, do not register the item; ask the person to assign it.',
      });
      return;
    }
    if (!isIsoDate(due.trim())) {
      send(422, { error: `due must be a real date written YYYY-MM-DD, got "${due.trim()}"` });
      return;
    }

    const existing = tasks.find(
      (task) =>
        task.sourceMeeting === sourceMeeting.trim() &&
        task.title === title.trim() &&
        task.assignee === member.name,
    );
    if (existing !== undefined) {
      send(200, { created: false, task: existing });
      return;
    }
    const task = {
      id: `TASK-${String(tasks.length + 1).padStart(4, '0')}`,
      title: title.trim(),
      assignee: member.name,
      department: member.department,
      due: due.trim(),
      sourceMeeting: sourceMeeting.trim(),
      createdBy: caller.payload.sub,
      status: '未対応',
    };
    tasks = [...tasks, task];
    save();
    send(201, { created: true, task });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tracker = await startFakeTracker({
    token: process.env.TRACKER_TOKEN ?? 'dev-token',
    identity: {
      key: (process.env.IDENTITY_SECRET ?? '').split(','),
      audience: process.env.IDENTITY_AUDIENCE ?? '',
      workspace: process.env.IDENTITY_WORKSPACE ?? '',
    },
    tasksFile: process.env.TASKS_FILE,
    port: Number(process.env.PORT ?? 8789),
  });
  process.stdout.write(`fake tracker on ${tracker.url}\n`);
}
