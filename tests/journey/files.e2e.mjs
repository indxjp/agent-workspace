/* global console, process, setTimeout */
/**
 * The storage design's browser journey 2 (§07, issue #1687), untimed: a run with a granted file
 * shows its outputs in Files.
 *
 * Signed in as the bootstrap admin, it uploads `in/<nonce>.txt` on the Files screen, grants it
 * read-only to the demo agent (`files()` in the agent file, with `readFiles` and `writeFiles`, which
 * `aw dev` saves), and starts a run from the console with a prompt carrying `e2e-files-<nonce>`.
 * The fake Anthropic API (`fake-anthropic-tools.mjs`) answers that prompt with a `Read` of the
 * granted file and a `Write` of `outputs/out/<nonce>.md` holding its first line. Once the run has
 * completed, `/files` lists `out/<nonce>.md` under `runs/<runId>/outputs/` as `text/markdown`, no
 * staging archive is listed anywhere, and the output's bytes, downloaded through the API, carry the
 * input's first line. It needs the fake: under `run.mjs --live` the model never writes the file.
 *
 * It runs inside the clean container against the `aw dev` the journey started, like
 * `pinned.e2e.mjs`, and puts the agent file back when it ends. Named `.e2e.mjs`, not `.spec.mjs`,
 * so the `tests` Vitest project never loads it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

import { agentIdOf, agentNameOfSource } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const BASE_URL = new URL(required('JOURNEY_BASE_URL')).origin;
const DEMO_DIR = required('JOURNEY_DEMO_DIR');
const ADMIN_EMAIL = required('JOURNEY_ADMIN_EMAIL');
const ADMIN_PASSWORD = required('JOURNEY_ADMIN_PASSWORD');

const AGENT_IMPORT_LINE =
  /^import \{ (defineAgent(?:, \w+)*) \} from '(@indx-workspace\/sdk\/define)';$/mu;
const AGENT_ENGINE_LINE = /^ {2}engine: '([^'\\]+)',$/mu;
// The waits (sign-in 20 s, grant save 45 s, run 75 s, put-back save 45 s = 185 s) and the 240 s test
// timeout fit inside the 300 s exec cap in run.mjs `checkRunFiles()`; the happy path takes 30-60 s.
const SIGNIN_WAIT_MS = 20_000;
const SAVE_WAIT_MS = 45_000;
const RUN_WAIT_MS = 75_000;
const TEST_TIMEOUT_MS = 240_000;
/** A run in one of these has stopped: terminal, or paused for an approval that never comes. */
const LIVE_RUN_STATUSES = ['queued', 'running'];

/**
 * The rendered agent file granted `grant` read-only, with the file permissions a run needs to read
 * it and to leave outputs. A run is unattended, so `Write` is auto-approved: without that the engine
 * asks for a permission nobody answers, and the output is never written.
 *
 * @param {string} source a rendered `agents/<name>.ts` with no files and no permissions
 * @param {string} grant a workspace file path
 */
function grantedAgentSource(source, grant) {
  if (
    !AGENT_IMPORT_LINE.test(source) ||
    !AGENT_ENGINE_LINE.test(source) ||
    /^ {2}(?:files|permissions):/mu.test(source)
  ) {
    throw new Error('the agent file is not the renderer output without files and permissions');
  }
  return source
    .replace(AGENT_IMPORT_LINE, "import { $1, files } from '$2';")
    .replace(
      AGENT_ENGINE_LINE,
      `  engine: { id: '$1', autoApprove: ['Write'] },\n  files: [files('${grant}')],\n  permissions: { readFiles: true, writeFiles: true },`,
    );
}

/**
 * `aw <args>` in the demo project; its stdout, after checking it exited 0.
 *
 * @param {readonly string[]} args
 */
function aw(args) {
  const run = spawnSync('npx', ['aw', ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0) {
    throw new Error(
      `aw ${args.join(' ')} exited ${String(run.status)}\n${run.stdout}${run.stderr}`,
    );
  }
  return run.stdout;
}

/** Whether the version `local` points at carries `text` in its body. @param {string} text */
function localCarries(text) {
  /** @type {{ items: readonly { number: number, body: unknown }[], pointers: readonly { environment: string, number: number }[] }} */
  const list = JSON.parse(aw(['versions', '--json']));
  const local = list.pointers.find((pointer) => pointer.environment === 'local');
  const item = list.items.find((version) => version.number === local?.number);
  return item !== undefined && JSON.stringify(item.body).includes(text);
}

/**
 * Until `localCarries(text)` is `carries`, or {@link SAVE_WAIT_MS}.
 *
 * @param {string} text @param {boolean} carries @param {string} what
 */
async function untilLocal(text, carries, what) {
  for (const until = Date.now() + SAVE_WAIT_MS; localCarries(text) !== carries;) {
    if (Date.now() > until) throw new Error(`aw dev saved no version ${what} in time`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * The rows `GET /api/files` lists one level under `folder`, with the page's session.
 *
 * @param {import('@playwright/test').Page} page @param {string} folder
 * @returns {Promise<{ path: string, kind: string, contentType: string | null }[]>}
 */
async function listFolder(page, folder) {
  const response = await page.request.get(
    `${BASE_URL}/api/files?path=${encodeURIComponent(folder)}`,
  );
  expect(response.status(), `GET /api/files?path=${folder}`).toBe(200);
  /** @type {{ files: { path: string, kind: string, contentType: string | null }[] }} */
  const body = await response.json();
  return body.files;
}

/**
 * Every row under `folder` and its subfolders.
 *
 * @param {import('@playwright/test').Page} page @param {string} folder
 * @returns {Promise<{ path: string, kind: string, contentType: string | null }[]>}
 */
async function listTree(page, folder) {
  const rows = await listFolder(page, folder);
  const below = await Promise.all(
    rows.filter((row) => row.kind === 'folder').map((row) => listTree(page, row.path)),
  );
  return [...rows, ...below.flat()];
}

test('a run with a granted file shows its outputs in Files (issue #1687)', async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const nonce = `e2e-files-${randomBytes(6).toString('hex')}`;
  const firstLine = `journey input ${randomBytes(6).toString('hex')}`;
  const input = `in/${nonce}.txt`;
  const output = `out/${nonce}.md`;

  const agents = path.join(DEMO_DIR, 'agents');
  const [agentFile, ...others] = readdirSync(agents).filter((name) => name.endsWith('.ts'));
  if (agentFile === undefined || others.length > 0) {
    throw new Error(`expected one agent file in ${agents}`);
  }
  const file = path.join(agents, agentFile);
  const original = readFileSync(file, 'utf8');
  const agentId = agentIdOf(aw(['agents', 'list', '--json']), agentNameOfSource(original));

  await page.goto(`${BASE_URL}/signin`);
  const form = page.locator('form', { has: page.locator('input[name="password"]') });
  await form.locator('input[name="email"]').fill(ADMIN_EMAIL);
  await form.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => new URL(url).pathname !== '/signin', { timeout: SIGNIN_WAIT_MS });

  // The input, uploaded as a person uploads it.
  await page.goto(`${BASE_URL}/files`);
  await page.getByRole('textbox', { name: 'New folder name' }).fill('in');
  await page.getByRole('button', { name: 'Create folder here' }).click();
  await page.getByRole('button', { name: 'in/', exact: true }).click();
  await page.getByLabel('Upload a file to this folder').setInputFiles({
    name: `${nonce}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`${firstLine}\nthe second line stays in the input\n`),
  });
  await page.getByRole('button', { name: 'Upload here' }).click();
  await expect(page.getByRole('cell', { name: `${nonce}.txt`, exact: true })).toBeVisible();

  let granted = false;
  let failure;
  try {
    writeFileSync(file, grantedAgentSource(original, input));
    granted = true;
    await untilLocal(input, true, `granting ${input}`);

    // The run, started from the console with the agent the grant was saved on.
    await page.goto(`${BASE_URL}/`);
    const runTarget = page.getByTestId('composer-run-target');
    await expect(runTarget).toBeVisible();
    if ((await runTarget.getAttribute('data-agent-id')) !== agentId) {
      await page.getByTestId('composer-agent-picker').locator('summary').click();
      await page
        .locator(`[data-testid="composer-agent-option"][data-agent-id="${agentId}"]`)
        .click();
    }
    await expect(runTarget).toHaveAttribute('data-agent-id', agentId);
    await page
      .getByTestId('composer-input')
      .fill(`Copy the first line of ${input} into ${output} (${nonce}).`);
    const [started] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/api\/agents\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
      ),
      page.getByTestId('composer-send').click(),
    ]);
    /** @type {{ run?: { id?: string } }} */
    const startBody = await started.json();
    const runId = startBody.run?.id;
    expect(runId, `POST runs answered ${String(started.status())}`).toEqual(expect.any(String));

    /** @type {{ status?: string } | undefined} */
    let run;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${BASE_URL}/api/runs/${String(runId)}`);
          /** @type {{ run?: { status?: string } }} */
          const body = await response.json();
          run = body.run;
          return run?.status !== undefined && !LIVE_RUN_STATUSES.includes(run.status);
        },
        { timeout: RUN_WAIT_MS, intervals: [2_000] },
      )
      .toBe(true);
    expect(
      run?.status,
      `run ${String(runId)} ended as ${String(run?.status)}: ${JSON.stringify(run)}`,
    ).toBe('completed');

    const outputs = `runs/${String(runId)}/outputs`;
    const outputPath = `${outputs}/${output}`;

    await test.step('[US-STO-07][browser][web] run outputs appear in Files with their type; staging never does', async () => {
      // @story US-STO-07
      await page.goto(`${BASE_URL}/files?path=${encodeURIComponent(`${outputs}/out`)}`);
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: `${nonce}.md`, exact: true }) });
      await expect(
        row.or(page.getByText('This folder is empty.')),
        `/files rendered no listing of ${outputs}/out`,
      ).toBeVisible();
      const listed = await page.getByRole('row').allInnerTexts();
      expect(
        await row.count(),
        `${output} under ${outputs}; rows: ${listed.map((text) => text.replace(/\s+/gu, ' ')).join(' | ')}`,
      ).toBe(1);
      await expect(row.getByRole('cell').nth(3)).toHaveText('text/markdown');

      // This only catches a staging row leaked after promotion; the listing filter itself is covered by the catalog tests.
      // A staging row is one segment at the root (`.staging-<id>`, `application/x-tar`).
      const rows = [...(await listFolder(page, '')), ...(await listTree(page, outputs))];
      const staging = rows.filter(
        (each) =>
          each.path.endsWith('.tar') ||
          path.posix.basename(each.path).startsWith('.staging-') ||
          each.contentType === 'application/x-tar',
      );
      expect(
        staging,
        `staging rows listed; every row: ${rows.map((each) => each.path).join(', ')}`,
      ).toEqual([]);
    });

    await test.step('[US-STO-06][api][run] the agent read the granted file', async () => {
      // @story US-STO-06
      const href = await page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: `${nonce}.md`, exact: true }) })
        .getByRole('link', { name: 'Download' })
        .getAttribute('href');
      const response = await page.request.get(new URL(String(href), BASE_URL).href);
      expect(response.status(), `GET ${String(href)}`).toBe(200);
      const content = await response.text();
      expect(content, `${outputPath} holds ${JSON.stringify(content)}`).toContain(firstLine);
    });
  } catch (error) {
    failure = error;
  }
  writeFileSync(file, original);
  // The restart check compares version lists: the put-back version must be saved before it.
  try {
    if (granted) await untilLocal(input, false, 'putting the agent file back');
  } catch (putBack) {
    // Keep the body's assertion error primary; throw the put-back failure only after a clean body.
    if (failure === undefined) throw putBack;
    console.error(`put-back also failed: ${String(putBack)}`);
  }
  if (failure !== undefined) throw failure;
});
