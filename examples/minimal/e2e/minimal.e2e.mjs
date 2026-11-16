/* global process */
/**
 * examples/minimal's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`. The lane signs the bootstrap Owner in to the console, approves a device code for a
 * person token and hands it here: the browser holds it in the app's own `aw_user_token` cookie,
 * as the app's sign-in would (shortcut: the portal has no sign-in page yet, #1510; upgrade to
 * signing in through it when it lands).
 *
 * The lane runs them twice, with `app/theme.ts` set to `en` and then to `ja` (`APPS_E2E_LOCALE`):
 * each journey checks `<html lang>` is that language, and every assertion uses its words, the
 * portal's own and the app kit's. Locators are by role and name.
 *
 * This file imports only `@playwright/test`, so the app still reaches nothing outside itself.
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
const PERSON_TOKEN = required('APPS_E2E_PERSON_TOKEN');
const LOCALE = required('APPS_E2E_LOCALE');

/** The words the journeys look for: the portal's own (`app/strings.ts`) and the app kit's. */
const WORDS = {
  en: { portal: 'Portal', save: 'Save', edit: 'Edit', title: 'Title', body: 'Body' },
  ja: { portal: 'ポータル', save: '保存', edit: '編集', title: 'Title', body: 'Body' },
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

test.use({ baseURL: APP_URL });

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'aw_user_token', value: PERSON_TOKEN, url: APP_URL, httpOnly: true, sameSite: 'Lax' },
  ]);
});

/** A title no other run uses, so a journey finds its own note. */
const titled = (what) => `${what} ${randomBytes(4).toString('hex')}`;

test('a member creates a note and opens it', async ({ page }) => {
  await page.goto('/notes/new');
  const words = await wordsOf(page);
  await expect(page.getByRole('navigation', { name: words.portal })).toBeVisible();
  const title = titled('A first note');

  await page.getByLabel(words.title).fill(title);
  await page.getByLabel(words.body).fill('Written in the browser.');
  await page.getByRole('button', { name: words.save, exact: true }).click();

  await page.waitForURL(/\/notes\/[0-9a-f-]{36}$/u);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.goto('/notes');
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText('Written in the browser.')).toBeVisible();
});

test('J3: a member opens a note and edits it', async ({ page, request }) => {
  const title = titled('A note to edit');
  const created = await request.post(`${APP_URL}/api/notes`, {
    headers: { authorization: `Bearer ${PERSON_TOKEN}` },
    data: { title, body: [{ type: 'paragraph', text: 'Before the edit.' }] },
  });
  expect(created.status()).toBe(201);

  await page.goto('/notes');
  const words = await wordsOf(page);
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.getByRole('link', { name: words.edit, exact: true }).click();
  const edited = `${title} (edited)`;
  await page.getByLabel(words.title).fill(edited);
  await page.getByRole('button', { name: words.save, exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: edited })).toBeVisible();
  await page.goto('/notes');
  await expect(page.getByRole('link', { name: edited })).toBeVisible();
});
