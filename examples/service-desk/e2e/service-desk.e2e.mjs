/* global process, URL */
/**
 * examples/service-desk's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app
 * under `aw dev`, with the scripted model of `e2e/model-script.json` on the claude-agent-sdk engine
 * (closer's gated ticket_update needs it). Each journey's browser signs in through the app's own
 * `/sign-in`, completing `aw dev`'s development issuer's form as the bootstrap Owner
 * (`APPS_E2E_OWNER_*`), so the app holds that person's `awo_live_` token, and the agent panel and
 * the RecipeGraph approval start and decide runs as them (ADR-0161, issue #2075). The app's API is
 * called with the lane's person token for the same Owner (`APPS_E2E_PERSON_TOKEN`).
 *
 * The SLA sweep's slot is fired through the app's development-only `POST /api/recipes/slots` at
 * an instant two hours after the ticket's last change, past its p1 SLA (ADR-0164 T3, issue
 * #2077). The sweep acts for the member `SLA_ON_CALL_MEMBER` names, which the journey writes, as
 * the Owner's principal id, into the running copy's `.env.local` (`APPS_E2E_APP_DIR`), which
 * `next dev` loads.
 *
 * The lane runs them twice, with `app/theme.ts` set to `en` and then to `ja`
 * (`APPS_E2E_LOCALE`): each journey checks `<html lang>` and uses that language's words.
 *
 * This file imports only `@playwright/test` and Node's own modules, so the app still reaches
 * nothing outside itself.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run these journeys with node tests/apps/lane.mjs`);
  }
  return value;
}

const APP_URL = required('APPS_E2E_APP_URL');
const PLATFORM_URL = required('APPS_E2E_PLATFORM_URL');
const PERSON_TOKEN = required('APPS_E2E_PERSON_TOKEN');
const OWNER_EMAIL = required('APPS_E2E_OWNER_EMAIL');
const OWNER_PASSWORD = required('APPS_E2E_OWNER_PASSWORD');
const APP_DIR = required('APPS_E2E_APP_DIR');
const LOCALE = required('APPS_E2E_LOCALE');
const AUTH = { authorization: `Bearer ${PERSON_TOKEN}` };
/** The one call closer waits on (agents/closer.ts). */
const GATED_CALL = 'mcp__service-desk__ticket_update';
/** Past a p1 ticket's SLA, an hour (recipes/sla-rule.ts). */
const PAST_P1_SLA_MS = 2 * 60 * 60 * 1000;

/** The words the journeys look for: the app's own and the app kit's (RecipeGraph names each step's Approve). */
const WORDS = {
  en: {
    prompt: 'What should the agent do with this record?',
    send: 'Send',
    waiting: 'Waiting for a decision',
    approve: 'Approve step approve-closure',
    signIn: 'Sign in',
  },
  ja: {
    prompt: 'このレコードについてエージェントに依頼する内容',
    send: '送信',
    waiting: '判断待ち',
    approve: 'ステップ approve-closure を承認',
    signIn: 'サインイン',
  },
};

/** @param {import('@playwright/test').Page} page */
async function wordsOf(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', LOCALE);
  if (LOCALE !== 'en' && LOCALE !== 'ja') throw new Error(`the lane set ${LOCALE}`);
  return WORDS[LOCALE];
}

test.use({ baseURL: APP_URL });

/**
 * Sign the browser in through the app's `/sign-in` and the development issuer's form (in the
 * browser's English) as the bootstrap Owner. The app holds the `awo_live_` token for 300 s, so a
 * journey signs in again, from a fresh start, before a decision it makes later.
 *
 * @param {import('@playwright/test').Page} page
 */
async function signInAsOwner(page) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  const words = await wordsOf(page);
  await page.getByRole('main').getByRole('link', { name: words.signIn }).click();
  await page.waitForURL((url) => url.pathname === '/authorize');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Local console password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The home page opens the dashboard, so any page of the app but the sign-in's own.
  await page.waitForURL(
    (url) => url.origin === new URL(APP_URL).origin && !url.pathname.startsWith('/sign-in'),
  );
}

/**
 * The `awo_live_` token the app holds for the signed-in browser of `page`.
 *
 * @param {import('@playwright/test').Page} page
 */
async function signInToken(page) {
  const cookies = await page.context().cookies(APP_URL);
  const token = cookies.find((cookie) => cookie.name === 'aw_user_token')?.value ?? '';
  expect(token.startsWith('awo_live_'), 'the app holds the sign-in token').toBe(true);
  return token;
}

test.beforeEach(async ({ page }) => {
  await signInAsOwner(page);
});

/** A title no other run uses, so a journey finds its own ticket. */
const titled = (what) => `${what} ${randomBytes(4).toString('hex')}`;

/**
 * The app's JSON answer to `route` as the person, once it answers `200`.
 *
 * @param {import('@playwright/test').APIRequestContext} request @param {string} route
 */
async function appJson(request, route) {
  const response = await request.get(`${APP_URL}${route}`, { headers: AUTH });
  expect(response.status(), route).toBe(200);
  return response.json();
}

/** @param {import('@playwright/test').APIRequestContext} request */
async function ownerPrincipalId(request) {
  const me = await request.get(`${PLATFORM_URL}/api/me`, { headers: AUTH });
  expect(me.status()).toBe(200);
  return /** @type {string} */ ((await me.json()).principalId);
}

/**
 * A new p1 ticket of the signed-in person's, through the generated route.
 *
 * @param {import('@playwright/test').APIRequestContext} request @param {string} title
 */
async function createTicket(request, title) {
  const principalId = await ownerPrincipalId(request);
  const created = await request.post(`${APP_URL}/api/tickets`, {
    headers: AUTH,
    data: {
      title,
      description: [{ type: 'paragraph', text: 'Nobody can connect to the VPN.' }],
      status: 'new',
      priority: 'p1',
      requester: principalId,
      assignee: principalId,
    },
  });
  expect(created.status()).toBe(201);
  return /** @type {{ id: string, created_at: string }} */ (await created.json());
}

/** @param {import('@playwright/test').APIRequestContext} request @param {string} id */
const ticketOf = (request, id) => appJson(request, `/api/tickets/${id}`);

/**
 * Name the on-call member the SLA sweep acts for in the running copy's `.env.local`, which
 * `next dev` loads (and loads again when it changes); the copy's other lines are kept.
 *
 * @param {string} principalId
 */
function nameOnCallMember(principalId) {
  const file = path.join(APP_DIR, '.env.local');
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('SLA_ON_CALL_MEMBER='))
    : [];
  writeFileSync(file, [...kept, `SLA_ON_CALL_MEMBER=${principalId}`, ''].join('\n'));
}

/**
 * Fire sla-sweep's slot at `at` as the Owner and wait for its recipe run to end: the run's
 * detail. A run that failed before `next dev` loaded `.env.local` (`OnCallMemberMissing`) is
 * fired again a second later, which is another slot, so no ticket is escalated twice.
 *
 * @param {import('@playwright/test').APIRequestContext} request @param {number} at
 */
async function sweptAt(request, at) {
  /** @type {any} */
  let detail;
  let attempt = 0;
  await expect(async () => {
    const fired = await request.post(`${APP_URL}/api/recipes/slots`, {
      headers: AUTH,
      data: { recipe: 'sla-sweep', at: new Date(at + attempt * 1000).toISOString() },
    });
    attempt += 1;
    expect(fired.status(), await fired.text()).toBe(202);
    const { run } = await fired.json();
    await expect
      .poll(
        async () => {
          detail = await appJson(request, `/api/recipes/runs/${String(run.id)}`);
          return detail.run.status;
        },
        { timeout: 60_000 },
      )
      .toMatch(/^(?:completed|failed)$/u);
    expect(detail.run.status, String(detail.run.error)).toBe('completed');
  }).toPass({ timeout: 120_000 });
  return detail;
}

test('J3: a member triages a ticket with the agent panel', async ({ page, request }) => {
  const ticket = await createTicket(request, titled('Printer jam'));

  await page.goto(`/tickets/${ticket.id}`);
  const words = await wordsOf(page);
  await page.getByLabel(words.prompt).fill('e2e-desk-panel: lower this ticket to p2.');
  await page.getByRole('button', { name: words.send, exact: true }).click();

  // The scripted triage calls ticket_update as the person, then answers.
  await expect(page.getByText('Lowered the ticket to p2.')).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await ticketOf(request, ticket.id)).priority).toBe('p2');
});

test('signature: a ticket is triaged, escalated by the SLA sweep and closed after approval', async ({
  page,
  request,
}) => {
  nameOnCallMember(await ownerPrincipalId(request));
  const ticket = await createTicket(request, titled('VPN down'));

  // 1. triage-incident runs triage, which moves the ticket on through ticket_update.
  await expect
    .poll(async () => (await ticketOf(request, ticket.id)).status, { timeout: 120_000 })
    .toBe('in_progress');

  // 2. closer's ticket_update(status=closed) stops its run, and the recipe with it.
  /** @type {string | undefined} */
  let recipeRunId;
  await expect
    .poll(
      async () => {
        const { items } = await appJson(request, '/api/recipes/runs');
        recipeRunId = items.find(
          (/** @type {any} */ run) =>
            run.recipe === 'triage-incident' &&
            run.status === 'waiting' &&
            run.createdAt >= ticket.created_at,
        )?.id;
        return recipeRunId;
      },
      { timeout: 120_000 },
    )
    .toBeDefined();
  // Read in the signed-in browser: the step's platform run is read with the person's awo_live_
  // token, so the detail names the call it waits on.
  const waitingRun = await (
    await page.request.get(`/api/recipes/runs/${String(recipeRunId)}`)
  ).json();
  const stepOf = (/** @type {any} */ detail, /** @type {string} */ key) =>
    detail.steps.find((/** @type {any} */ step) => step.key === key);
  const waitingStep = stepOf(waitingRun, 'approve-closure');
  expect(waitingStep?.status).toBe('awaiting_approval');
  expect(waitingStep?.pendingApproval?.toolName).toBe(GATED_CALL);

  // 3. The SLA sweep's slot, two hours after the ticket's last change, escalates it: its step
  // writes the ticket in its own run and adds an internal comment.
  const triaged = await ticketOf(request, ticket.id);
  const sweep = await sweptAt(request, Date.parse(triaged.updated_at) + PAST_P1_SLA_MS);
  const escalate = stepOf(sweep, `escalate.${ticket.id}`);
  expect(escalate?.status).toBe('completed');
  const { items: comments } = await appJson(request, '/api/ticket_comments');
  const escalation = comments.find(
    (/** @type {any} */ comment) =>
      comment.ticket === ticket.id &&
      comment.internal &&
      /SLA breached/u.test(JSON.stringify(comment)),
  );
  expect(escalation, 'the sweep left an internal comment on the ticket').toBeDefined();

  // 4. The home Dashboard shows the approval waiting, until it is decided. Soft, so the journey
  // still measures the approval and the history after it; a miss fails the journey all the same.
  await signInAsOwner(page);
  const words = await wordsOf(page);
  const waiting = page.getByRole('region', { name: words.waiting });
  await expect
    .soft(waiting.getByText(GATED_CALL).first(), 'the Dashboard lists the waiting approval')
    .toBeVisible();

  // 5. The person approves in RecipeGraph, and closer's call closes the ticket.
  await page.goto(`/recipes/${String(recipeRunId)}`);
  await page.getByRole('button', { name: words.approve, exact: true }).click();
  await expect
    .poll(async () => (await ticketOf(request, ticket.id)).status, { timeout: 120_000 })
    .toBe('closed');

  // 6. The ticket's history, oldest first, shows the triage write, the escalation and the
  // closure, each an agent's write linked to its step's run. The closure is written by the run
  // that continued, in its session, the run that waited on the approval (ADR-0145).
  const decided = await appJson(request, `/api/recipes/runs/${String(recipeRunId)}`);
  const closure = stepOf(decided, 'approve-closure');
  expect(closure?.decision).toBe('approve');
  const platformRun = async (/** @type {string} */ runId) => {
    const response = await request.get(`${PLATFORM_URL}/api/runs/${runId}`, {
      headers: { authorization: `Bearer ${await signInToken(page)}` },
    });
    expect(response.status(), `GET /api/runs/${runId}`).toBe(200);
    return (await response.json()).run;
  };
  // The ticket closes on the continued run's tool call, a moment before that run settles.
  await expect
    .poll(async () => (await platformRun(closure.runId)).status, { timeout: 60_000 })
    .toBe('completed');
  const [waited, continued] = await Promise.all([
    platformRun(waitingStep.runId),
    platformRun(closure.runId),
  ]);
  expect(continued.sessionId).toBe(waited.sessionId);
  const { items: history } = await appJson(request, `/api/tickets/${ticket.id}/history`);
  const writes = history
    .filter((/** @type {any} */ row) => row.action === 'update' && row.via === 'agent')
    .map((/** @type {any} */ row) => row.run_id);
  const linked = [
    stepOf(decided, 'classify')?.runId,
    escalate?.runId,
    stepOf(decided, 'approve-closure')?.runId,
  ];
  for (const runId of linked) expect(runId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(writes.filter((/** @type {string} */ runId) => linked.includes(runId))).toStrictEqual(
    linked,
  );
});
