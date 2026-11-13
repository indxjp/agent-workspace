/* global process, URL */
/**
 * examples/wiki's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`. Each journey's browser signs in through the app's own `/sign-in`, completing `aw dev`'s
 * development issuer's form as the bootstrap Owner (`APPS_E2E_OWNER_*`), so the app holds that
 * person's `awo_live_` token and the page's agent panel starts runs as them (ADR-0161, issue
 * #2075). The app's API is called with the lane's person token for the same Owner
 * (`APPS_E2E_PERSON_TOKEN`), which the app admits through `/api/me`.
 *
 * The lane runs them twice, with `app/theme.ts` set to `en` and then to `ja` (`APPS_E2E_LOCALE`):
 * each journey checks `<html lang>` is that language, and every assertion uses its words, the app
 * kit's. Locators are by role and name. Each journey seeds its own space "Engineering" through the
 * app's API (`seed.mjs`), so seed data is not the app's code.
 *
 * The signature journey starts from the handbook's agent panel: "Summarize into new page" writes
 * the prompt, and the person sends it to the `writer`. The scripted model (`model-script.json`)
 * calls `page_list`, `page_get` for each of the three pages and `page_create`, through the app's
 * MCP tools as the person. The journey then sees the new page in the space's tree and checks,
 * through the app's API, that its body cites the three pages and that its first revision carries
 * the panel's run and the person, and, in Agent Workspace, that the run is the Owner's.
 *
 * This file imports only `@playwright/test` and its own seed, so the app still reaches nothing
 * outside itself.
 */
import { expect, test } from '@playwright/test';

import { ENGINEERING_PAGES, seedEngineering } from './seed.mjs';

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
const AS_PERSON = { appUrl: APP_URL, token: PERSON_TOKEN };

/** The words the journeys look for: the portal's own (`app/strings.ts`) and the app kit's. */
const WORDS = {
  en: {
    pages: 'Pages',
    title: 'Title',
    save: 'Save',
    signIn: 'Sign in',
    summarize: 'Summarize into new page',
    send: 'Send',
  },
  ja: {
    pages: 'ページ',
    title: 'タイトル',
    save: '保存',
    signIn: 'サインイン',
    summarize: '新しいページに要約',
    send: '送信',
  },
};

/**
 * The words of the language the lane set, once the page says it is in that language.
 *
 * @param {import('@playwright/test').Page} page
 */
async function wordsOf(page) {
  await expect(page.locator('html')).toHaveAttribute('lang', LOCALE);
  if (LOCALE !== 'en' && LOCALE !== 'ja') throw new Error(`the lane set ${LOCALE}`);
  return WORDS[LOCALE];
}

/**
 * GET the app's `route` as the person: its JSON body, once it answers `200`.
 *
 * @param {import('@playwright/test').APIRequestContext} request @param {string} route
 */
async function read(request, route) {
  const response = await request.get(`${APP_URL}${route}`, {
    headers: { authorization: `Bearer ${PERSON_TOKEN}` },
  });
  expect(response.status(), `GET ${route}: ${await response.text()}`).toBe(200);
  return response.json();
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

/**
 * Open the space's tree, the handbook at its top, and the handbook's place in the page's tree.
 *
 * @param {import('@playwright/test').Page} page @param {string} spaceId
 */
async function openHandbook(page, spaceId) {
  const [handbook, under] = ENGINEERING_PAGES;
  await page.goto(`/wiki?space=${encodeURIComponent(spaceId)}`);
  const words = await wordsOf(page);
  const tree = page.getByRole('tree', { name: words.pages });
  await tree.getByRole('treeitem', { name: handbook?.title }).click();
  await page.waitForURL(/\/wiki\/[0-9a-f-]{36}\?space=/u);
  await expect(page.getByRole('heading', { level: 1, name: handbook?.title })).toBeVisible();
  // The page's own tree opens the handbook, so the pages under it show.
  await tree.getByRole('treeitem', { name: handbook?.title }).click();
  await expect(tree.getByRole('treeitem', { name: under?.title })).toBeVisible();
  return { words, tree };
}

test('J3: a member opens a page and edits it', async ({ page, request }) => {
  const { spaceId, pages } = await seedEngineering(request, AS_PERSON);

  const { words, tree } = await openHandbook(page, spaceId);
  const edited = `${ENGINEERING_PAGES[0]?.title ?? ''} (edited)`;
  await page.getByLabel(words.title, { exact: true }).fill(edited);
  await page.getByRole('button', { name: words.save, exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: edited })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: edited })).toBeVisible();
  const saved = await read(request, `/api/pages/${pages[0]?.id ?? ''}`);
  expect(saved.title).toBe(edited);
});

test('signature: an agent summarizes a page tree into a new page', async ({ page, request }) => {
  const { spaceId, pages } = await seedEngineering(request, AS_PERSON);
  const [handbook] = pages;
  if (handbook === undefined) throw new Error('the seed wrote no handbook');

  // From the handbook's agent panel: "Summarize into new page" writes the writer's prompt.
  const { words, tree } = await openHandbook(page, spaceId);
  await page.getByRole('button', { name: words.summarize, exact: true }).click();
  await page.getByRole('button', { name: words.send, exact: true }).click();
  await expect(
    page.getByText('I summarized the three pages into the new page Summary.'),
  ).toBeVisible({ timeout: 150_000 });

  // The new page shows under the handbook in the tree, its body citing the three pages.
  await expect(tree.getByRole('treeitem', { name: 'Summary' })).toBeVisible();
  const { items } = await read(request, `/api/pages/children?parent=${handbook.id}`);
  const summary = items.find((/** @type {{ title: string }} */ item) => item.title === 'Summary');
  expect(summary, 'a page Summary under the handbook').toBeDefined();
  for (const source of ENGINEERING_PAGES) {
    expect(JSON.stringify(summary.blocks)).toContain(source.title);
  }

  // Its first revision is the panel's run's, written as the person who sent the prompt.
  const revisions = await read(request, `/api/pages/${String(summary.id)}/revisions`);
  const seeded = await read(request, `/api/pages/${handbook.id}/revisions`);
  expect(revisions.items).toHaveLength(1);
  const [first] = revisions.items;
  expect(first.run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  expect(first.author_principal_id).toBe(seeded.items.at(-1).author_principal_id);

  // In Agent Workspace, that run was started by the signed-in Owner, with the app's token.
  const cookies = await page.context().cookies(APP_URL);
  const signedIn = cookies.find((cookie) => cookie.name === 'aw_user_token')?.value ?? '';
  expect(signedIn.startsWith('awo_live_'), 'the app holds the sign-in token').toBe(true);
  const run = await request.get(`${PLATFORM_URL}/api/runs/${String(first.run_id)}`, {
    headers: { authorization: `Bearer ${signedIn}` },
  });
  expect(run.status()).toBe(200);
  const me = await request.get(`${PLATFORM_URL}/api/me`, {
    headers: { authorization: `Bearer ${PERSON_TOKEN}` },
  });
  expect((await run.json()).run.initiatingUserId).toBe((await me.json()).userId);
});
