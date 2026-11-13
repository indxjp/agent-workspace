import { URL } from 'node:url';
import { JourneyFailure } from './harness-failure.mjs';

/** The one surface a new project has (C4). */
const SURFACE_NAME = 'main';

/** The surface path the journey opens and the widget names. */
export function tryPath() {
  return `/p/s/${SURFACE_NAME}/try`;
}

/**
 * Opens the try page as the host page and adds the one widget tag to it, as a customer's page
 * would. The try page is the surface's own chat, so it no longer carries the tag itself; the
 * loader still serves `?environment=local` (the working draft) exactly as it did there.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} baseUrl
 */
export async function openWidgetHost(page, baseUrl) {
  await page.goto(`${baseUrl}${tryPath()}`);
  await page.addScriptTag({
    url: `${baseUrl}/p/s/${SURFACE_NAME}/widget.js?environment=local`,
  });
}

/**
 * `{ id, status }` of the `{ run: { id, status, … } }` body that starting and reading a run answer.
 *
 * @param {unknown} body @param {string} what
 */
export function runOf(body, what) {
  const run = typeof body === 'object' && body !== null && 'run' in body ? body.run : null;
  if (
    typeof run === 'object' &&
    run !== null &&
    'id' in run &&
    typeof run.id === 'string' &&
    'status' in run &&
    typeof run.status === 'string'
  ) {
    return { id: run.id, status: run.status };
  }
  throw new JourneyFailure(`${what} answered no run`);
}

/** @param {unknown} body the `201` of `POST /p/s/<name>/sessions` */
export function sessionTokenOf(body) {
  if (typeof body === 'object' && body !== null && 'token' in body) {
    if (typeof body.token === 'string' && body.token !== '') return body.token;
  }
  throw new JourneyFailure(`POST /p/s/${SURFACE_NAME}/sessions answered no token`);
}

/** The surface chat's messages (`surface-chat.tsx`): the visitor's, then the agent's. */
const CHAT_MESSAGES = 'ol[aria-live="polite"] > li';

const RUN_START_PATH = /^\/api\/agents\/[^/]+\/runs$/u;

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];

/** How long a run may take to settle after its first text shows. */
const RUN_SETTLE_MS = 120_000;

/**
 * Asks the open widget `prompt` and checks behaviour, never wording, so the fake and the real model
 * pass the same checks: the visitor's session opens (`201`), the agent's message shows text, the
 * run it started finishes `completed` (read with the session's own token), and the chat shows no
 * failure. Returns the milliseconds from Send to the agent's first text: the first-token latency
 * as the visitor sees it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').FrameLocator} chat the widget's frame, opened
 * @param {string} prompt @param {number} timeoutMs the wait for the first text
 */
export async function askWidget(page, chat, prompt, timeoutMs) {
  await chat.locator('form textarea').fill(prompt);
  /** @param {RegExp} pathname */
  const posted = (pathname) =>
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && pathname.test(new URL(response.url()).pathname),
      { timeout: timeoutMs },
    );
  const opened = posted(new RegExp(`^/p/s/${SURFACE_NAME}/sessions$`, 'u'));
  const started = posted(RUN_START_PATH);
  // A refused session starts no run; its own error is the one reported, not this wait's timeout.
  started.catch(() => undefined);
  const sent = Date.now();
  // The first Send opens the visitor's session (`POST /p/s/<name>/sessions`). A refusal there is
  // the reason no reply can come, so it is named here instead of as a timeout on the reply.
  await chat.locator('form button[type="submit"]').click();
  const session = await opened;
  if (session.status() !== 201) {
    throw new JourneyFailure(
      `POST /p/s/${SURFACE_NAME}/sessions answered ${String(session.status())}: ${await session.text()}`,
    );
  }
  const token = sessionTokenOf(await session.json());
  const start = await started;
  if (!start.ok()) {
    throw new JourneyFailure(
      `the run start answered ${String(start.status())}: ${await start.text()}`,
    );
  }
  const runId = runOf(await start.json(), 'the run start').id;
  await chat
    .locator(CHAT_MESSAGES)
    .nth(1)
    .locator('p')
    .filter({ hasText: /\S/u })
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  const firstTokenMs = Date.now() - sent;
  await waitForCompletedRun(page, runId, token);
  await assertNoChatFailure(chat);
  return firstTokenMs;
}

/** @param {import('@playwright/test').Page} page @param {string} runId @param {string} token */
async function waitForCompletedRun(page, runId, token) {
  const runUrl = new URL(`/api/runs/${runId}`, page.url()).href;
  const until = Date.now() + RUN_SETTLE_MS;
  for (;;) {
    const read = await page.request.get(runUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!read.ok())
      throw new JourneyFailure(`GET /api/runs/${runId} answered ${String(read.status())}`);
    const { status } = runOf(await read.json(), `GET /api/runs/${runId}`);
    if (TERMINAL_RUN_STATUSES.includes(status)) {
      if (status !== 'completed')
        throw new JourneyFailure(`run ${runId} finished ${status}, not completed`);
      break;
    }
    if (Date.now() > until) {
      throw new JourneyFailure(
        `run ${runId} is still ${status} ${String(RUN_SETTLE_MS / 1000)} s after its first text`,
      );
    }
    await page.waitForTimeout(500);
  }
}

/**
 * A failed turn as `surface-chat.tsx` shows it: the `role="alert"` after the messages, holding the
 * failure's code and message. Next's route announcer (an empty `role="alert"` live region) and the
 * local driver's banner are not it.
 */
const CHAT_FAILURE = 'ol[aria-live="polite"] ~ [role="alert"]';

/** The local driver's banner (`driver-banner.tsx`): an alert by design, never a turn's failure. */
const DRIVER_NOTICE_TESTID = 'driver-in-force';

/**
 * Throws, with its text, if the chat shows a failed turn. An alert with no text (a live region)
 * or the driver notice is never one.
 *
 * @param {{ locator(selector: string): { all(): Promise<readonly import('./harness.d.mts').ChatAlert[]> } }} chat
 */
export async function assertNoChatFailure(chat) {
  for (const alert of await chat.locator(CHAT_FAILURE).all()) {
    if ((await alert.getAttribute('data-testid')) === DRIVER_NOTICE_TESTID) continue;
    const text = (await alert.innerText()).trim();
    if (text !== '') throw new JourneyFailure(`the chat shows a failure: ${text}`);
  }
}
