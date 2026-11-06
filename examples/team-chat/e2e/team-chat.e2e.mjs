/* global process */
/**
 * examples/team-chat's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`, with the scripted model of `model-script.json`. The lane signs the bootstrap Owner in
 * to the console, approves a device code for a person token and hands it here: the browser holds
 * it in the app's own `aw_user_token` cookie, as the app's sign-in would (shortcut: the portal has
 * no sign-in page yet, #1510; upgrade to signing in through it when it lands).
 *
 * The lane runs them twice, with `app/theme.ts` set to `en` and then to `ja` (`APPS_E2E_LOCALE`):
 * each journey checks `<html lang>` is that language, and every assertion uses its words, the
 * app's own and the app kit's `ChannelView`'s. Locators are by role and name.
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

/** The scripted model's answer to `@helper what changed today?` (`model-script.json`). */
const HELPER_ANSWER = 'Two pull requests were merged today, and the release notes are ready.';

/**
 * How long the reply may take to reach the second browser: the helper's run on the scripted
 * model, then the channel's publish and its stream (#1518, #1519), without a reload.
 */
const REPLY_BUDGET_MS = 60_000;

/** The words the journeys look for: the app's own (`app/channels/[id]/page.tsx`) and the app kit's. */
const WORDS = {
  en: {
    open: 'Open the messages',
    messages: 'Messages',
    composer: 'Message',
    send: 'Send',
    thread: 'Thread',
    oneReply: 'Open thread, 1 reply',
  },
  ja: {
    open: 'メッセージを開く',
    messages: 'メッセージ',
    composer: 'メッセージ',
    send: '送信',
    thread: 'スレッド',
    oneReply: 'スレッドを開く（返信 1 件）',
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

test.use({ baseURL: APP_URL });

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'aw_user_token', value: PERSON_TOKEN, url: APP_URL, httpOnly: true, sameSite: 'Lax' },
  ]);
});

/** A name no other run uses, so a journey finds its own channel and messages. */
const unique = (what) => `${what} ${randomBytes(4).toString('hex')}`;

/**
 * A new public channel, made through the app's own route as the person.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 */
async function newChannel(request) {
  const name = unique('general');
  const created = await request.post(`${APP_URL}/api/channels`, {
    headers: { authorization: `Bearer ${PERSON_TOKEN}` },
    data: { name, kind: 'public' },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  return { id, name };
}

/**
 * Posts `text` with the channel's composer and waits until the list shows it.
 *
 * @param {import('@playwright/test').Page} page @param {string} text
 */
async function post(page, text) {
  const words = await wordsOf(page);
  await page.getByRole('textbox', { name: words.composer, exact: true }).fill(text);
  await page.getByRole('button', { name: words.send, exact: true }).click();
  await expect(
    page.getByRole('list', { name: words.messages, exact: true }).getByText(text),
  ).toBeVisible();
}

test('J3: a member opens a channel and posts', async ({ page, request }) => {
  const channel = await newChannel(request);

  await page.goto('/channels');
  const words = await wordsOf(page);
  await page.getByRole('link', { name: channel.name }).click();
  await expect(page.getByRole('heading', { level: 1, name: channel.name })).toBeVisible();
  await page.getByRole('link', { name: words.open, exact: true }).click();
  await page.waitForURL(`**/channels/message/${channel.id}`);

  const text = unique('Standup moves to ten');
  await post(page, text);
  await page.reload();
  await expect(
    page.getByRole('list', { name: words.messages, exact: true }).getByText(text),
  ).toBeVisible();
});

test('signature: a mention produces an agent reply in the thread', async ({ browser, request }) => {
  const channel = await newChannel(request);
  const contexts = [await browser.newContext(), await browser.newContext()];
  for (const context of contexts) {
    await context.addCookies([
      { name: 'aw_user_token', value: PERSON_TOKEN, url: APP_URL, httpOnly: true, sameSite: 'Lax' },
    ]);
  }
  try {
    const [writer, reader] = await Promise.all(contexts.map((context) => context.newPage()));
    await reader.goto(`${APP_URL}/channels/message/${channel.id}`);
    const words = await wordsOf(reader);
    await writer.goto(`${APP_URL}/channels/message/${channel.id}`);

    const mention = `@helper what changed today? (${unique('ask')})`;
    await post(writer, mention);

    // The second browser never reloads: the mention, then the helper's reply, arrive live.
    const item = reader
      .getByRole('list', { name: words.messages, exact: true })
      .getByRole('listitem')
      .filter({ hasText: mention });
    await item
      .getByRole('button', { name: words.oneReply, exact: true })
      .click({ timeout: REPLY_BUDGET_MS });
    const thread = reader.getByRole('complementary', { name: words.thread, exact: true });
    await expect(thread.getByText(HELPER_ANSWER)).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
