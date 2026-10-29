/* global fetch, Buffer */
// @story US-STO-14

/**
 * Two web servers, one database and one file root — the storage design, §07 "Two-server test".
 *
 * An in-process test cannot show what a second server sees, because both "servers" would share one
 * in-memory `withKeyLock`. Playwright starts two `next start` processes (`playwright.config.ts`);
 * this file signs in on each and talks to them through the page, so the session cookie and `Origin`
 * are the real ones.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { openRootObjectStore, workspaceFolder } from '@agent-workspace/core/storage';
import { expect, test } from '@playwright/test';
import pg from 'pg';

import { createCleanup } from '../../scripts/test-services/cleanup.mjs';
import { freePort, stopProcessGroup, waitUntil } from '../../scripts/test-services/process.mjs';
import { bootstrapAdminCredentials, secondBaseURL, signInAsBootstrapAdmin } from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

test.describe.configure({ mode: 'serial' });

/** The signed-in pages, server A first. Set in `beforeAll`, closed in `afterAll`. */
let pages = [];
let contexts = [];

test.beforeAll(async ({ browser, baseURL }) => {
  contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL: secondBaseURL() }),
  ]);
  pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) await signInAsBootstrapAdmin(page, credentials);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

/** A same-origin call from the page. `path` is sent in `x-file-path`, `body` as raw text bytes. */
function api(page, method, url, { filePath, body } = {}) {
  return page.evaluate(
    async ({ method, url, filePath, body }) => {
      const response = await fetch(url, {
        method,
        headers: {
          ...(filePath === undefined ? {} : { 'x-file-path': filePath }),
          ...(body === undefined ? {} : { 'content-type': 'text/plain' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, url, filePath, body },
  );
}

/** Upload `index`'s bytes: long enough that two writers overlap, and unmistakable if two mix. */
function uploadBody(index) {
  return `upload ${String(index)}:${String(index).repeat(64 * 1024)}`;
}

/**
 * Fire `n` concurrent uploads of `pathName`, alternating `on[0]`, `on[1]`, `on[0]`, … (the two
 * servers' pages), and return their answers in order. The assertion about who wins belongs to the
 * test that uses it.
 */
export async function raceUploads(pathName, n, on = pages) {
  const [a, b] = on;
  return Promise.all(
    Array.from({ length: n }, (_, index) =>
      api(index % 2 === 0 ? a : b, 'POST', '/api/files', {
        filePath: pathName,
        body: uploadBody(index),
      }),
    ),
  );
}

test('[US-STO-14][two-server][sdk] both servers share one catalog', async () => {
  const [a, b] = pages;
  const folder = `two-server/${randomUUID()}`;
  const path = `${folder}/a.txt`;

  const uploaded = await api(a, 'POST', '/api/files', { filePath: path, body: 'hello' });
  expect(uploaded.status, uploaded.text).toBe(201);

  const listed = await api(b, 'GET', `/api/files?path=${encodeURIComponent(folder)}`);
  expect(listed.status, listed.text).toBe(200);
  expect(JSON.parse(listed.text).files.map((file) => file.path)).toContain(path);

  const downloaded = await api(b, 'GET', `/api/files/${Buffer.from(path).toString('base64url')}`);
  expect(downloaded.status, downloaded.text).toBe(200);
  expect(downloaded.text).toBe('hello');
});

test('[US-STO-14][two-server][sdk] raceUploads answers every upload across both servers', async () => {
  const answers = await raceUploads(`two-server/${randomUUID()}/race.txt`, 4);
  expect(answers).toHaveLength(4);
  for (const { status } of answers) expect([201, 409]).toContain(status);
});

const ROUNDS = 50;
const UPLOADS_PER_ROUND = 4;
// The body a replace round starts from; no racing upload sends it.
const SEED_BODY = 'seed';

/**
 * Two `next start` processes on one fresh `file://` root. The harness servers share the CI job's
 * root with other specs; this pair is the only writer to `root`, which is what makes "objects equal
 * rows" an exact count.
 */
async function startServersOn(root, cleanup) {
  const origins = [];
  for (let server = 0; server < 2; server += 1) {
    const port = await freePort();
    const web = spawn(
      'pnpm',
      ['--filter', '@agent-workspace/web', 'exec', 'next', 'start', '-p', String(port)],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          RUNNER_URL: process.env['RUNNER_URL'] ?? 'http://127.0.0.1:9',
          AW_STORAGE_URL: pathToFileURL(root).href,
        },
      },
    );
    cleanup.add(`stop the web server on port ${String(port)}`, () => stopProcessGroup(web));
    origins.push(`http://127.0.0.1:${String(port)}`);
  }
  await Promise.all(
    origins.map((origin) =>
      waitUntil(
        `The web server at ${origin}`,
        async () => {
          try {
            return (await fetch(`${origin}/signin`)).ok;
          } catch {
            return false;
          }
        },
        120_000,
      ),
    ),
  );
  return origins;
}

/** The `files` rows of this run, one per logical path (a side-path row counts under its target). */
async function fileRowsUnder(prefix) {
  const connectionString = process.env['DATABASE_URL'];
  expect(
    connectionString,
    'DATABASE_URL must be set so the spec can read the catalog.',
  ).toBeTruthy();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select coalesce(target_path, path) as logical, status, workspace_id, object_id
         from files
        where kind = 'file' and starts_with(coalesce(target_path, path), $1)`,
      [prefix],
    );
    return rows;
  } finally {
    await client.end();
  }
}

test('[US-STO-14][two-server][sdk] two servers save one path: one wins, nothing left behind', async ({
  browser,
}) => {
  // @story US-STO-14
  test.setTimeout(300_000);
  const root = await mkdtemp(path.join(tmpdir(), 'aw-two-server-'));
  const cleanup = createCleanup();
  const raceContexts = [];
  let failures;
  try {
    const origins = await startServersOn(root, cleanup);
    raceContexts.push(
      ...(await Promise.all(origins.map((baseURL) => browser.newContext({ baseURL })))),
    );
    const racePages = await Promise.all(raceContexts.map((context) => context.newPage()));
    for (const page of racePages) await signInAsBootstrapAdmin(page, credentials);

    const prefix = `race/${randomUUID()}/`;
    const expectedPaths = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const pathName = `${prefix}${String(round)}.txt`;
      expectedPaths.push(pathName);
      // Odd rounds replace a ready file, even rounds race for a path nobody holds.
      if (round % 2 === 1) {
        const seeded = await api(racePages[0], 'POST', '/api/files', {
          filePath: pathName,
          body: SEED_BODY,
        });
        expect(seeded.status, `round ${String(round)} seed: ${seeded.text}`).toBe(201);
      }

      const answers = await raceUploads(pathName, UPLOADS_PER_ROUND, racePages);
      const winners = [];
      answers.forEach((answer, index) => {
        const label = `round ${String(round)} upload ${String(index)}: ${answer.text.slice(0, 200)}`;
        if (answer.status === 201) {
          winners.push(uploadBody(index));
          return;
        }
        expect(answer.status, label).toBe(409);
        expect(JSON.parse(answer.text).error.code, label).toBe('upload_in_progress');
      });
      expect(winners.length, `round ${String(round)} had no winner`).toBeGreaterThanOrEqual(1);

      // A reader on either server (alternating by round) sees exactly one writer's whole body, never
      // a mix or the seed.
      const downloaded = await api(
        racePages[round % 2],
        'GET',
        `/api/files/${Buffer.from(pathName).toString('base64url')}`,
      );
      expect(downloaded.status, `round ${String(round)} download`).toBe(200);
      expect(winners, `round ${String(round)} served a body no winner sent`).toContain(
        downloaded.text,
      );
    }

    // No cleanup pass runs: a row-first save leaves nothing to clean (the storage design, §07).
    const rows = await fileRowsUnder(prefix);
    expect(rows.map((row) => row.logical).sort()).toEqual([...expectedPaths].sort());
    expect(rows.map((row) => row.status)).toEqual(Array(ROUNDS).fill('ready'));
    const workspaces = [...new Set(rows.map((row) => row.workspace_id))];
    expect(workspaces).toHaveLength(1);

    const store = await openRootObjectStore({ kind: 'file', root });
    const entries = [];
    let cursor = null;
    do {
      const page = await store.listPage(`${workspaceFolder(workspaces[0])}files`, {
        ...(cursor === null ? {} : { cursor }),
      });
      entries.push(...page.entries);
      cursor = page.cursor;
    } while (cursor !== null);
    const objectIds = entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.key.slice(entry.key.lastIndexOf('/') + 1))
      .sort();
    expect(objectIds).toEqual(rows.map((row) => row.object_id).sort());
  } finally {
    await Promise.all(raceContexts.map((context) => context.close()));
    failures = await cleanup.run();
    await rm(root, { recursive: true, force: true });
  }
  expect(failures.map(({ label }) => label)).toEqual([]);
});
