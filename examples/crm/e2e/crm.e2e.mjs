/* global process, URL */
/**
 * examples/crm's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`. Each journey's browser signs in through the app's own `/sign-in`, completing `aw dev`'s
 * development issuer's form as the bootstrap Owner (`APPS_E2E_OWNER_*`), so the app holds that
 * person's `awo_live_` token and the agent panel starts runs as them (ADR-0161, issue #2075). The
 * app's API is called with the lane's person token for the same Owner (`APPS_E2E_PERSON_TOKEN`).
 * The lane runs them in English and in Japanese (`APPS_E2E_LOCALE`), with `app/theme.ts` set to
 * each; every assertion uses that language's words.
 *
 * The scripted model (`model-script.json`) answers the enrichment prompt with the structured
 * company and title, and the sales assistant's panel prompt with a deal_list call.
 *
 * "One platform run per created contact" is the stack's word, not the app's: the run list is read
 * from Agent Workspace's own `GET /api/runs?agent=`. The person token admits no run route
 * (ADR-0083), so it is read in the console, signed in there as the same bootstrap Owner.
 *
 * This file imports only `@playwright/test` and Node's own modules, so the app still reaches
 * nothing outside itself.
 */
import { randomBytes } from 'node:crypto';

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
const LOCALE = required('APPS_E2E_LOCALE');

/** The words the journeys look for: the portal's own (`app/strings.ts`) and the app kit's. */
const WORDS = {
  en: {
    save: 'Save',
    edit: 'Edit',
    agent: 'Agent',
    salesAssistant: 'Sales assistant',
    prompt: 'What should the agent do with this record?',
    send: 'Send',
    openRun: 'Open run of step classify in Agent Workspace',
    signIn: 'Sign in',
  },
  ja: {
    save: '保存',
    edit: '編集',
    agent: 'エージェント',
    salesAssistant: '営業アシスタント',
    prompt: 'このレコードについてエージェントに依頼する内容',
    send: '送信',
    openRun: 'ランを開く：ステップ classify（Agent Workspace）',
    signIn: 'サインイン',
  },
};

/** @param {import('@playwright/test').Page} page */
async function wordsOf(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', LOCALE);
  if (LOCALE !== 'en' && LOCALE !== 'ja') throw new Error(`the lane set ${LOCALE}`);
  return WORDS[LOCALE];
}

const auth = { authorization: `Bearer ${PERSON_TOKEN}` };
const unique = () => randomBytes(4).toString('hex');

/** A record made through the app's own route, as the person. */
async function created(request, plural, data) {
  const response = await request.post(`${APP_URL}/api/${plural}`, { headers: auth, data });
  expect(response.status(), `POST /api/${plural}`).toBe(201);
  return response.json();
}

/** The person's principal id: `GET /api/me` is a route the person token is admitted on. */
async function me(request) {
  const response = await request.get(`${PLATFORM_URL}/api/me`, { headers: auth });
  expect(response.status()).toBe(200);
  return (await response.json()).principalId;
}

async function openDeal(request, stage) {
  const name = `Example renewal ${unique()}`;
  const amount = { amount: '1200000', currency: 'JPY' };
  await created(request, 'deals', { name, amount, stage, owner: await me(request) });
  return name;
}

/** The app's request as the person, answered `200`. */
async function appJson(request, route) {
  const response = await request.get(`${APP_URL}${route}`, { headers: auth });
  expect(response.status(), route).toBe(200);
  return response.json();
}

/**
 * The sales assistant's runs since `from` in Agent Workspace's own run list, read in the console
 * as the bootstrap Owner (see the header).
 *
 * @param {import('@playwright/test').Browser} browser @param {string} from
 */
async function platformRunsSince(browser, from) {
  const context = await browser.newContext({ baseURL: PLATFORM_URL });
  try {
    const owner = await context.newPage();
    await owner.goto('/signin');
    await owner.getByLabel('Email').fill(OWNER_EMAIL);
    await owner.getByLabel('Password').fill(OWNER_PASSWORD);
    await owner.getByRole('button', { name: 'Sign in' }).click();
    await owner.waitForURL((url) => !url.pathname.startsWith('/signin'));
    const agents = await (await context.request.get('/api/agents')).json();
    const agent = agents.agents.find((/** @type {any} */ each) => each.name === 'sales-assistant');
    expect(agent, 'aw dev synced agents/sales-assistant.ts').toBeDefined();
    const query = new URLSearchParams({ agent: agent.id, from, limit: '100' });
    const runs = await context.request.get(`/api/runs?${query.toString()}`);
    expect(runs.status()).toBe(200);
    return (await runs.json()).runs;
  } finally {
    await context.close();
  }
}

test.use({ baseURL: APP_URL });

/**
 * Sign the browser in through the app's `/sign-in` and the development issuer's form (in the
 * browser's English) as the bootstrap Owner; the app then holds the Owner's `awo_live_` token.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/sign-in');
  const words = await wordsOf(page);
  await page.getByRole('main').getByRole('link', { name: words.signIn }).click();
  await page.waitForURL((url) => url.pathname === '/authorize');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Local console password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin === new URL(APP_URL).origin && url.pathname === '/');
});

test('J3: a member opens a deal on the board and works with the agent', async ({
  page,
  request,
}) => {
  const name = await openDeal(request, 'qualified');
  await page.goto('/deals');
  const words = await wordsOf(page);
  await page.getByRole('listitem', { name: 'Qualified' }).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Beside the deal, the person asks the sales assistant, which reads the deals as them.
  await page.getByLabel(words.agent, { exact: true }).selectOption({ label: words.salesAssistant });
  await page.getByLabel(words.prompt).fill(`e2e-crm-sales-assistant: where is ${name}?`);
  await page.getByRole('button', { name: words.send, exact: true }).click();
  await expect(page.getByText('The sales assistant read the deals as you.')).toBeVisible({
    timeout: 150_000,
  });
});

test('signature: a new contact is enriched by a recipe', async ({ browser, page, request }) => {
  const from = new Date().toISOString();
  const domain = `${unique()}.example.co.jp`;
  const contact = await created(request, 'contacts', {
    name: 'Aiko Tanaka',
    email: `aiko@${domain}`,
    owner: await me(request),
  });

  // The person sees the contact linked to the company the recipe found or created.
  await page.goto(`/contacts/${contact.id}`);
  const words = await wordsOf(page);
  const company = page.locator('a[href^="/companys/"]');
  await expect(async () => {
    await page.reload();
    await expect(company).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 150_000 });
  await company.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Example K.K.' })).toBeVisible();
  await expect(page.getByText(domain)).toBeVisible();

  // The recipe run, whose classify step links to the run that produced the link.
  const { items } = await appJson(request, '/api/recipes/runs?recipe=enrich-contact');
  const since = items.filter((/** @type {any} */ run) => run.createdAt >= from);
  expect(since.map((/** @type {any} */ run) => run.status)).toStrictEqual(['completed']);
  const { steps } = await appJson(request, `/api/recipes/runs/${since[0].id}`);
  const classify = steps.find((/** @type {any} */ step) => step.key === 'classify');
  expect(classify?.status).toBe('completed');
  await page.goto(`/recipes/${since[0].id}`);
  await expect(page.getByRole('link', { name: words.openRun })).toHaveAttribute(
    'href',
    new RegExp(`run=${classify.runId}$`, 'u'),
  );

  // Exactly one platform run for the one contact: that classify step's, run once.
  const runs = await platformRunsSince(browser, from);
  expect(runs.map((/** @type {any} */ run) => [run.id, run.status])).toStrictEqual([
    [classify.runId, 'completed'],
  ]);
});

test('signature: a deal moves on the board', async ({ page, request }) => {
  const name = await openDeal(request, 'qualified');
  await page.goto('/deals');
  const words = await wordsOf(page);
  const column = (label) => page.getByRole('listitem', { name: label, exact: true });
  await column('Qualified').getByRole('link', { name }).click();
  await page.getByRole('link', { name: words.edit, exact: true }).click();
  await page.getByLabel('Stage').selectOption('proposal');
  await page.getByRole('button', { name: words.save, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  await page.goto('/deals');
  await expect(column('Proposal').getByRole('link', { name })).toBeVisible();
  await page.reload();
  await expect(column('Proposal').getByRole('link', { name })).toBeVisible();
  await expect(column('Qualified').getByRole('link', { name })).toHaveCount(0);
});
