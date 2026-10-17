/* global fetch, process */
/**
 * The 80-13 demo as a journey check (issue #620), untimed: a visitor's thumbs-down in the widget
 * becomes an evaluation case that fails. The widget answers a question and the visitor rates the
 * answer down; `aw feedback <agent> --negative` lists that run; `aw eval add-case <runId> --yes`
 * writes it to `evals/<agent>.yaml`; and `aw eval` runs it and exits 1 with the case as `FAIL`.
 *
 * The widget sends no comment, so the case's judge is "Must not repeat: <answer>". The fake model
 * answers the judge with prose, which is no verdict (`judge_unparseable`); the real one under
 * `run.mjs --live` grades the same answer against "must not repeat it". Either way the case fails.
 *
 * The generated surface does not ask for ratings (`parts.feedback` is off by default), so the test
 * turns it on in `surfaces/main.ts`, as a developer would, and waits for `aw dev` to serve it.
 *
 * It runs inside the clean container against the `aw dev` the journey started, like
 * `widget.e2e.mjs`, and puts `surfaces/main.ts` and `evals/<agent>.yaml` back as it found them when
 * it ends. The agent is named on `aw feedback` because a fresh project has no `evals/` file for it
 * to default to.
 *
 * A second test (issue #665) walks the same path from the CLI alone: `aw runs start --wait`, then
 * `aw runs rate <id> --down --comment <text>` in place of the widget's button.
 *
 * Named `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

import { agentIdOf, agentNameOfSource, askWidget, openWidgetHost } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const BASE_URL = required('JOURNEY_BASE_URL');
const NONCE = required('JOURNEY_NONCE');
const DEMO_DIR = required('JOURNEY_DEMO_DIR');
const SURFACE = 'main';
const FEEDBACK_PATH = /^\/api\/runs\/([^/]+)\/feedback$/u;
const NAME_LINE = /^(\s*)name: 'main',$/mu;
const PARTS_LINE = /^(\s*)parts: \{$/mu;
/** The surface page's serialized definition asks for ratings (escaped inside the RSC payload). */
const FEEDBACK_ON = /\\?"feedback\\?":true/u;

/**
 * `surfaces/main.ts` with `parts.feedback: true`: added to the `parts` setup wrote, or as a new
 * `parts` after the surface's `name` when setup wrote none.
 *
 * @param {string} source
 */
function withFeedback(source) {
  if (PARTS_LINE.test(source)) return source.replace(PARTS_LINE, '$1parts: {\n$1  feedback: true,');
  if (!NAME_LINE.test(source)) throw new Error("surfaces/main.ts has no `name: 'main',` line");
  return source.replace(NAME_LINE, "$1name: 'main',\n$1parts: { feedback: true },");
}

/** `npx aw <args>` in the project, as the developer runs it; its exit status and output. */
function aw(/** @type {readonly string[]} */ args) {
  const result = spawnSync('npx', ['aw', ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

/** The name of the project's one agent, from `agents/<name>.ts`. */
function agentName() {
  const files = readdirSync(path.join(DEMO_DIR, 'agents')).filter((file) => file.endsWith('.ts'));
  const [file] = files;
  if (file === undefined || files.length !== 1) {
    throw new Error(`demo/agents holds ${String(files.length)} agent files, not one`);
  }
  return agentNameOfSource(readFileSync(path.join(DEMO_DIR, 'agents', file), 'utf8'));
}

test('a thumbs-down in the widget becomes an eval case that fails', async ({ page }) => {
  const name = agentName();
  const evalFile = path.join(DEMO_DIR, 'evals', `${name}.yaml`);
  const original = existsSync(evalFile) ? readFileSync(evalFile, 'utf8') : null;
  const surfaceFile = path.join(DEMO_DIR, 'surfaces', `${SURFACE}.ts`);
  const surfaceSource = readFileSync(surfaceFile, 'utf8');
  try {
    writeFileSync(surfaceFile, withFeedback(surfaceSource));
    // `aw dev` saves the edit and moves `local`; the page the try widget frames
    // (`?environment=local`) then carries `feedback: true`. The bare page serves `production`,
    // which `release.e2e.mjs` leaves pointing at an older version.
    await expect
      .poll(
        async () =>
          FEEDBACK_ON.test(
            await (await fetch(`${BASE_URL}/p/s/${SURFACE}?environment=local`)).text(),
          ),
        {
          timeout: 120_000,
          intervals: [1_000],
        },
      )
      .toBe(true);

    await openWidgetHost(page, BASE_URL);
    await page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`).click();
    const chat = page.frameLocator(`iframe[data-aw-surface-frame="${SURFACE}"]`);
    await askWidget(page, chat, `Please answer ${NONCE}.`, 120_000);

    const rated = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        FEEDBACK_PATH.test(new URL(response.url()).pathname),
    );
    await chat.getByRole('button', { name: /^(Bad answer|良くない回答)$/u }).click();
    const feedback = await rated;
    // The handler answers 204 with no body; reading one fails, so the status is the check here
    // and `aw feedback --negative` below proves the rating was stored.
    expect(feedback.status()).toBe(204);
    const runId = FEEDBACK_PATH.exec(new URL(feedback.url()).pathname)?.[1] ?? '';

    const listed = aw(['feedback', name, '--negative']);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(runId);

    // The project's starter cases (issue #698) are not this test's subject: start from no file,
    // so the run is the one case the thumbs-down added.
    rmSync(evalFile, { force: true });
    const added = aw(['eval', 'add-case', runId, '--yes']);
    expect(added.status, added.output).toBe(0);
    expect(added.output).toContain(`wrote evals/${name}.yaml`);
    expect(readFileSync(evalFile, 'utf8')).toContain(`fromRun: ${runId}`);

    const evaluated = aw(['eval', name]);
    expect(evaluated.status, evaluated.output).toBe(1);
    expect(evaluated.output).toMatch(new RegExp(`✗ run ${runId.slice(0, 8)}\\b`, 'u'));
    expect(evaluated.output).toContain('1 of 1 cases failed');
  } finally {
    writeFileSync(surfaceFile, surfaceSource);
    if (original === null) rmSync(evalFile, { force: true });
    else writeFileSync(evalFile, original);
  }
});

/**
 * Issue #665: the same path without a browser. `aw runs start --wait` answers, `aw runs rate --down`
 * rates it with a comment (the case's judge), and the rest is the widget test's.
 */
test('a thumbs-down from aw runs rate becomes an eval case that fails', () => {
  const name = agentName();
  const evalFile = path.join(DEMO_DIR, 'evals', `${name}.yaml`);
  const original = existsSync(evalFile) ? readFileSync(evalFile, 'utf8') : null;
  try {
    const agents = aw(['agents', 'list', '--json']);
    expect(agents.status, agents.output).toBe(0);
    const agentId = agentIdOf(agents.stdout, name);

    const started = aw([
      'runs',
      'start',
      agentId,
      '--prompt',
      `Please answer ${NONCE}.`,
      '--wait',
      '--json',
    ]);
    expect(started.status, started.output).toBe(0);
    const runId = String(JSON.parse(started.stdout).id);

    const rated = aw([
      'runs',
      'rate',
      runId,
      '--down',
      '--comment',
      'Must answer with exactly the word PINEAPPLE.',
    ]);
    expect(rated.status, rated.output).toBe(0);

    const listed = aw(['feedback', name, '--negative']);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(runId);

    // The project's starter cases (issue #698) are not this test's subject: start from no file,
    // so the run is the one case the thumbs-down added.
    rmSync(evalFile, { force: true });
    const added = aw(['eval', 'add-case', runId, '--yes']);
    expect(added.status, added.output).toBe(0);
    expect(readFileSync(evalFile, 'utf8')).toContain(`fromRun: ${runId}`);

    const evaluated = aw(['eval', name]);
    expect(evaluated.status, evaluated.output).toBe(1);
    expect(evaluated.output).toMatch(new RegExp(`✗ run ${runId.slice(0, 8)}\\b`, 'u'));
    expect(evaluated.output).toContain('1 of 1 cases failed');
  } finally {
    if (original === null) rmSync(evalFile, { force: true });
    else writeFileSync(evalFile, original);
  }
});
