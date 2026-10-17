/* global URL, process, setTimeout */
/**
 * The 80-07 demo as a journey check (issue #612): push v2 while a conversation on v1 is open, and
 * the next turn still answers as v1; a new conversation answers as v2. Untimed.
 *
 * It runs inside the clean container against the `aw dev` the journey started, like
 * `origins.e2e.mjs`, on the try page (`/p/s/main/try`, which serves `local`, the pointer `aw dev`
 * moves on every save). It edits the agent file's `instructions`, and puts the file back when it
 * ends:
 *
 * 1. v1: the instructions name `<nonce>v1`. Once `aw dev` has saved it, a new conversation's first
 *    turn answers from v1. That conversation stays open.
 * 2. v2: the instructions name `<nonce>v2`. Once a new conversation answers from v2, the push has
 *    landed.
 * 3. The open v1 conversation's second turn still answers from v1.
 * 4. Issue #618: with `local` on v2, `aw eval <agent> <v1>` scores v1: its one case passes only if
 *    the answer names v1 and not v2. `evals/<agent>.yaml` is put back as it was found too.
 *
 * What a turn answered from is read off the fake Anthropic API's reply, which names the messages'
 * last `e2e-nonce-…`, or the system prompt's (the instructions) when the messages carry none
 * (`tests/generated-project/fake-anthropic.mjs`); so no prompt here carries one. It needs the fake:
 * under `run.mjs --live` the model never names a nonce.
 *
 * Each new conversation opens a visitor session, and a client may open ten a minute
 * (`apps/web/server/surfaces/public/limits.ts`), so the waits for a push to land open one at most
 * every {@link SESSION_PACE_MS}.
 *
 * Named `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { agentNameOfSource, assertNoChatFailure, openWidgetHost } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const SURFACE = 'main';
const INSTRUCTIONS_LINE = /^( {2})instructions: .*,$/mu;
const CHAT_MESSAGES = 'ol[aria-live="polite"] > li';
/** The fake's whole reply: the nonce it names is complete once its colon has streamed. */
const FAKE_REPLY = /Fake Anthropic reply(?:\.| to (e2e-nonce-[a-z0-9]+):)/u;
const PUSH_WAIT_MS = 120_000;
/** At most nine sessions in any minute, under the ten per client the surface admits. */
const SESSION_PACE_MS = 7_000;

/**
 * The rendered agent file with its one-line `instructions` replaced by `text`.
 *
 * @param {string} source @param {string} text
 */
function withInstructions(source, text) {
  if (!INSTRUCTIONS_LINE.test(source)) {
    throw new Error('the agent file has no one-line `instructions:` to edit');
  }
  return source.replace(INSTRUCTIONS_LINE, `$1instructions: '${text}',`);
}

/**
 * A new conversation: the try page in a fresh browser context, so no stored session resumes.
 *
 * @param {import('@playwright/test').Browser} browser @param {string} baseUrl
 */
async function newConversation(browser, baseUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openWidgetHost(page, baseUrl);
  await page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`).click();
  return { context, chat: page.frameLocator(`iframe[data-aw-surface-frame="${SURFACE}"]`) };
}

/**
 * Send `prompt` as the conversation's turn `turn` (from 0); the nonce the reply names, or `null`.
 *
 * @param {import('@playwright/test').FrameLocator} chat @param {string} prompt
 * @param {number} turn
 */
async function ask(chat, prompt, turn) {
  await chat.locator('form textarea').fill(prompt);
  await chat.locator('form button[type="submit"]').click();
  const reply = chat
    .locator(CHAT_MESSAGES)
    .nth(2 * turn + 1)
    .locator('p')
    .filter({ hasText: FAKE_REPLY })
    .first();
  await reply.waitFor({ state: 'visible', timeout: 120_000 });
  await assertNoChatFailure(chat);
  return FAKE_REPLY.exec(await reply.innerText())?.[1] ?? null;
}

/**
 * A new conversation whose first turn answers `version`, opening one per {@link SESSION_PACE_MS}
 * until {@link PUSH_WAIT_MS} has passed.
 *
 * @param {import('@playwright/test').Browser} browser @param {string} baseUrl
 * @param {string} version @param {import('@playwright/test').BrowserContext[]} contexts
 */
async function conversationOn(browser, baseUrl, version, contexts) {
  for (const until = Date.now() + PUSH_WAIT_MS; ;) {
    const opened = Date.now();
    const conversation = await newConversation(browser, baseUrl);
    contexts.push(conversation.context);
    if ((await ask(conversation.chat, 'Hello.', 0)) === version) return conversation;
    if (Date.now() > until) throw new Error(`no new conversation ran ${version} in time`);
    await new Promise((resolve) => setTimeout(resolve, opened + SESSION_PACE_MS - Date.now()));
  }
}

/**
 * `aw <args>` in `cwd`; its stdout, after checking it exited 0.
 *
 * @param {string} cwd @param {readonly string[]} args
 */
function aw(cwd, args) {
  const run = spawnSync('npx', ['aw', ...args], { cwd, encoding: 'utf8', timeout: 240_000 });
  if (run.status !== 0) {
    throw new Error(
      `aw ${args.join(' ')} exited ${String(run.status)}\n${run.stdout}${run.stderr}`,
    );
  }
  return run.stdout;
}

/** The number `local` points at, from `aw versions --json`. @param {string} cwd */
function localVersion(cwd) {
  /** @type {{ pointers: readonly { environment: string, number: number }[] }} */
  const list = JSON.parse(aw(cwd, ['versions', '--json']));
  const local = list.pointers.find((pointer) => pointer.environment === 'local');
  if (local === undefined) throw new Error('local points at no version');
  return local.number;
}

test('a conversation keeps its version after a push, and a new one runs the push', async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  const baseUrl = new URL(required('JOURNEY_BASE_URL')).origin;
  const nonce = required('JOURNEY_NONCE');
  const demo = required('JOURNEY_DEMO_DIR');
  const agents = path.join(demo, 'agents');
  const [agentFile, ...others] = readdirSync(agents).filter((name) => name.endsWith('.ts'));
  if (agentFile === undefined || others.length > 0) {
    throw new Error(`expected one agent file in ${agents}`);
  }
  const file = path.join(agents, agentFile);
  const original = readFileSync(file, 'utf8');
  const name = agentNameOfSource(original);
  const evalFile = path.join(demo, 'evals', `${name}.yaml`);
  const originalEvals = existsSync(evalFile) ? readFileSync(evalFile, 'utf8') : null;
  const v1 = `${nonce}v1`;
  const v2 = `${nonce}v2`;
  /** @type {import('@playwright/test').BrowserContext[]} */
  const contexts = [];
  try {
    // 1. v1, and a conversation that starts on it.
    writeFileSync(file, withInstructions(original, `Name ${v1} in every answer.`));
    const pinned = await conversationOn(browser, baseUrl, v1, contexts);
    // A conversation ran v1, so `local` points at it until v2 is written.
    const v1Number = localVersion(demo);

    // 2. v2, until a new conversation runs it.
    writeFileSync(file, withInstructions(original, `Name ${v2} in every answer.`));
    await conversationOn(browser, baseUrl, v2, contexts);

    // 3. The open conversation's next turn is still v1's.
    const next = await ask(pinned.chat, 'Hello again.', 1);
    if (next !== v1) {
      throw new Error(`the open conversation's second turn ran ${String(next)}, not ${v1}`);
    }

    // 4. With `local` on v2, evaluating v1 answers as v1 (issue #618).
    if (localVersion(demo) === v1Number) throw new Error('local still points at v1');
    mkdirSync(path.dirname(evalFile), { recursive: true });
    writeFileSync(
      evalFile,
      'cases:\n  - name: answers as v1\n    input: "Hello."\n' +
        `    expect: { contains: ["${v1}"], notContains: ["${v2}"] }\n`,
    );
    /** @type {{ version: number, passed: number, total: number, results: unknown }} */
    const evaluation = JSON.parse(aw(demo, ['eval', name, String(v1Number), '--json']));
    if (evaluation.version !== v1Number || evaluation.passed !== 1 || evaluation.total !== 1) {
      throw new Error(
        `aw eval of v${String(v1Number)} did not answer as v1: ${JSON.stringify(evaluation)}`,
      );
    }
  } finally {
    if (originalEvals === null) rmSync(evalFile, { force: true });
    else writeFileSync(evalFile, originalEvals);
    writeFileSync(file, original);
    await Promise.all(contexts.map((context) => context.close()));
  }
});
