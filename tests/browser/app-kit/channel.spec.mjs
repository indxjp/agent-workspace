/**
 * The channel view (issue #1519): two people in two browsers open the desk's team chat; each
 * sees the other's message within one second, without a reload. Then one browser drops off the
 * network while a message is sent, and when it is back the message it missed appears exactly
 * once. On the way: an `@` mention is picked from the members, a reply opens the thread pane.
 *
 * Against the desk fixture (`playwright.app-kit.config.mjs`): the `message` resource is bound to
 * the `message` channel (`resourceRoutes(message, { publish })`), on the in-memory channel twin,
 * and the page is `ChannelView` keyed on the seeded room.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { expectBasicAccessibility } from '../harness.mjs';

/** A signed-in page on the channel, its list ready. */
async function openChannel(browser, lang = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/signin');
  await page.goto(`/channel${lang}`);
  return { context, page };
}

/** Sends `text` from `page`'s channel composer. */
async function send(page, text) {
  // The channel's own composer, not the thread pane's.
  const composer = page.locator('.aw-app-channel-main');
  await composer.getByLabel('Message', { exact: true }).fill(text);
  await composer.getByRole('button', { name: 'Send' }).click();
}

test('two browsers see each other within 1 s, and a reconnect delivers a missed message once', async ({
  browser,
}) => {
  const ann = await openChannel(browser);
  const bob = await openChannel(browser);
  const list = (page) => page.getByRole('list', { name: 'Messages' });
  await expect(list(ann.page)).toBeVisible();
  await expect(list(bob.page)).toBeVisible();
  await expect(list(ann.page)).toHaveAttribute('aria-live', 'polite');
  await expect(ann.page.getByText('Here now: Desk person')).toBeVisible({ timeout: 5000 });
  await expectBasicAccessibility(ann.page);

  const first = `Hello from Ann ${randomUUID().slice(0, 8)}`;
  await send(ann.page, first);
  await expect(list(bob.page).getByText(first)).toBeVisible({ timeout: 1000 });

  const second = `Hello from Bob ${randomUUID().slice(0, 8)}`;
  await send(bob.page, second);
  await expect(list(ann.page).getByText(second)).toBeVisible({ timeout: 1000 });

  // A mention is picked from the members by a named button.
  const box = ann.page.locator('.aw-app-channel-main').getByLabel('Message', { exact: true });
  await box.fill('ask @Tri');
  await ann.page.getByRole('button', { name: 'Mention Triage' }).click();
  await expect(box).toHaveValue('ask @Triage ');
  await box.fill('');

  // A reply opens in the thread pane, not in the list.
  await list(ann.page).getByRole('listitem').filter({ hasText: first }).getByRole('button').click();
  const thread = ann.page.getByRole('complementary', { name: 'Thread' });
  await expect(thread).toBeVisible();
  const reply = `Reply ${randomUUID().slice(0, 8)}`;
  await thread.getByLabel('Reply in thread').fill(reply);
  await thread.getByRole('button', { name: 'Send' }).click();
  // In the thread's replies, not the reply box, which still holds the text while it is sent.
  await expect(thread.getByRole('list', { name: 'Thread' }).getByText(reply)).toBeVisible({
    timeout: 1000,
  });
  // This test's own message: a retry's earlier ones stay in the shared channel.
  await expect(
    list(bob.page)
      .getByRole('listitem')
      .filter({ hasText: first })
      .getByRole('button', { name: 'Open thread, 1 reply' }),
  ).toBeVisible({ timeout: 1000 });
  await expectBasicAccessibility(ann.page);

  // Bob drops off the network; Ann's message reaches him once he is back, exactly once.
  await bob.context.setOffline(true);
  const missed = `While you were away ${randomUUID().slice(0, 8)}`;
  await send(ann.page, missed);
  await expect(list(ann.page).getByText(missed)).toBeVisible({ timeout: 1000 });
  await bob.page.waitForTimeout(1500);
  await bob.context.setOffline(false);
  await expect(list(bob.page).getByText(missed)).toBeVisible({ timeout: 20_000 });
  await expect(list(bob.page).getByText(missed)).toHaveCount(1);
  await expect(list(bob.page).getByText(first)).toHaveCount(1);

  await ann.context.close();
  await bob.context.close();
});

test('the channel speaks Japanese', async ({ browser }) => {
  const { context, page } = await openChannel(browser, '?lang=ja');
  await expect(page.getByRole('heading', { level: 1, name: 'チームチャット' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'メッセージ' })).toBeVisible();
  await expect(page.getByRole('button', { name: '送信' })).toBeVisible();
  await expectBasicAccessibility(page);
  await context.close();
});
