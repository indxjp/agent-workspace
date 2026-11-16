/* global process */
/**
 * examples/store's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`, in English and in Japanese (`APPS_E2E_LOCALE`, with `app/theme.ts` set to each; every
 * assertion uses that language's words). The visitor is anonymous: the shelf, the filters, an agent's
 * detail page and its tabs, the sign-up gate of the Try tab, /platform, /privacy and /contact. `aw
 * dev` has no email sender and no challenge provider, so the gate and the forms end at a message that it is
 * not available yet, which is what they must say until a provider is chosen. The sign-in and the chat that follows
 * it are the Try tab's own journeys and are not in this file.
 *
 * The accessibility check is role-and-name: each screen has one banner, main and contentinfo, one h1,
 * the page language, and every control is named. This file imports only `@playwright/test`.
 */
import { expect, test } from '@playwright/test';

const LOCALE = process.env['APPS_E2E_LOCALE'] ?? '';
const APP_URL = process.env['APPS_E2E_APP_URL'] ?? '';
if (APP_URL === '')
  throw new Error('APPS_E2E_APP_URL is not set: run these journeys with node tests/apps/lane.mjs');
if (LOCALE !== 'en' && LOCALE !== 'ja') throw new Error(`the lane set APPS_E2E_LOCALE=${LOCALE}`);

/** The words each journey looks for. A live entry, an app entry and a coming-soon one. */
const WORDS = {
  en: {
    live: { slug: 'ringi-review', name: 'Ringi review agent', area: 'Finance & accounting' },
    app: { slug: 'crm-sales', name: 'CRM with sales assistant' },
    soon: { slug: 'close', name: 'Month-end close' },
    tryIt: 'Try it',
    customize: 'Install & customize',
    code: 'Under the hood',
    company: 'Company name',
    tone: 'Tone',
    brief: 'Brief',
    talk: 'Talk to us about this setup',
    github: 'View source on GitHub',
    send: 'Send',
    notify: 'Notify me',
    notAvailable: 'not available yet',
    planned: 'Planned ·',
    tryNow: 'Try now',
    scripted: 'Verified with the scripted model',
    recorded: 'Recorded with the scripted model',
    search: 'Search agents',
    other: 'Japanese',
    otherName: '日本語',
    privacy: 'Privacy notice',
  },
  ja: {
    live: { slug: 'ringi-review', name: '稟議レビュー', area: '財務・経理' },
    app: { slug: 'crm-sales', name: '営業アシスタント付きCRM' },
    soon: { slug: 'close', name: '月次決算サポート' },
    tryIt: '試す',
    customize: '導入とカスタマイズ',
    code: '仕組み',
    company: '会社名',
    tone: '口調',
    brief: '簡潔',
    talk: 'この内容で相談する',
    github: 'GitHub でソースを見る',
    send: '送信する',
    notify: '公開を通知してもらう',
    notAvailable: 'まだ使えません',
    planned: '計画 ·',
    tryNow: '今すぐ試せる',
    scripted: '台本どおりのモデルで検証済み',
    recorded: '台本どおりのモデルで録画',
    search: 'エージェントを検索',
    other: '英語',
    otherName: 'English',
    privacy: 'プライバシー通知',
  },
};
const words = WORDS[LOCALE];

test.use({ baseURL: APP_URL });

/** @param {import('@playwright/test').Page} page */
async function openTab(page, name) {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

test('J1: a visitor finds an agent on the shelf and reaches the sign-up gate', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const shelf = page.getByRole('region', { name: words.live.area });
  await shelf.getByRole('link', { name: words.live.name }).click();
  await expect(page).toHaveURL(/\/agents\/ringi-review$/u);
  await expect(page.getByRole('heading', { level: 1, name: words.live.name })).toBeVisible();

  await openTab(page, words.tryIt);
  await expect(page).toHaveURL(/#try$/u);
  const gate = page.getByTestId('try-gate');
  await expect(gate).toBeVisible();
  // Without consent the gate refuses on the page, and nothing is sent.
  await gate.locator('input[name="email"]').fill('visitor@example.com');
  await gate.getByRole('button').click();
  await expect(gate.getByRole('alert')).toBeVisible();
  await expect(gate.locator('input[name="consent"]')).not.toBeChecked();
  await expect(gate.getByRole('link', { name: words.privacy })).toHaveAttribute('href', '/privacy');
  // With consent the platform is asked; `aw dev` has no sender, so the answer is "not available yet".
  await gate.locator('input[name="consent"]').check();
  await gate.getByRole('button').click();
  await expect(page.getByTestId('try-gate-message')).toBeVisible();
  await expect(page.getByTestId('try-gate-message')).not.toBeEmpty();
});

test('filters: the shelf follows ?cat, ?status and ?q in the address', async ({ page }) => {
  await page.goto('/?cat=finance&status=live');
  await expect(
    page
      .getByRole('region', { name: words.live.area })
      .getByRole('link', { name: words.live.name }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: words.soon.name })).toHaveCount(0);

  await page.goto('/?status=soon&cat=finance');
  await expect(page.getByRole('link', { name: words.soon.name })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: words.live.area })
      .getByRole('link', { name: words.live.name }),
  ).toHaveCount(0);

  await page.goto('/?q=zzzzzzzz');
  await expect(page.getByRole('status')).toBeVisible();
  await page
    .getByRole('link', { name: LOCALE === 'ja' ? '絞り込みを解除' : 'Clear the filters' })
    .click();
  await expect(page).toHaveURL(/\/$/u);

  // The search box in the header sends the visitor to the same address.
  await page.getByRole('searchbox', { name: words.search }).fill('ringi');
  await page.getByRole('searchbox', { name: words.search }).press('Enter');
  await expect(page).toHaveURL(/\?q=ringi$/u);
  await expect(page.getByRole('link', { name: words.live.name }).first()).toBeVisible();
});

test('customize: the preview follows the choices and ends at a prefilled enquiry', async ({
  page,
}) => {
  await page.goto(`/agents/${words.live.slug}#customize`);
  await expect(page.getByRole('tab', { name: words.customize })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const reply = page.getByTestId('preview-reply');
  const before = await reply.innerText();
  await page.getByLabel(words.company).fill('Acme KK');
  await page.getByLabel(words.tone).selectOption({ label: words.brief });
  await expect(reply).toContainText('Acme KK');
  expect(await reply.innerText()).not.toBe(before);

  await page.getByRole('link', { name: words.talk }).click();
  await expect(page).toHaveURL(/\/contact\?entry=ringi-review&setup=/u);
  await expect(
    page.getByRole('list', { name: LOCALE === 'ja' ? '相談の対象' : 'What this is about' }),
  ).toContainText('Acme KK');

  const form = page.getByTestId('lead-form');
  await form.getByRole('button', { name: words.send }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await form.locator('input[name="email"]').fill('visitor@example.com');
  await form.locator('textarea[name="message"]').fill('We would like to try this setup.');
  await form.locator('input[name="consent"]').check();
  await form.getByRole('button', { name: words.send }).click();
  await expect(page.getByTestId('lead-message')).toContainText(words.notAvailable);
});

test('under the hood: a live entry links to GitHub and a coming-soon one does not', async ({
  page,
}) => {
  await page.goto(`/agents/${words.live.slug}#code`);
  await expect(page.getByRole('link', { name: words.github })).toHaveAttribute(
    'href',
    /\/tree\/main\/tests\/gallery\/ringi-review$/u,
  );
  await expect(page.getByText('defineAgent').first()).toBeVisible();

  await page.goto(`/agents/${words.app.slug}#code`);
  await expect(page.getByRole('progressbar')).toBeVisible();

  await page.goto(`/agents/${words.soon.slug}`);
  await expect(page.getByRole('tab', { name: words.code })).toHaveCount(0);
  await expect(page.getByRole('link', { name: words.github })).toHaveCount(0);
  await openTab(page, LOCALE === 'ja' ? '近日公開' : 'Coming soon');
  const form = page.getByTestId('lead-form');
  await form.getByRole('button', { name: words.notify }).click();
  await expect(form.getByRole('alert')).toBeVisible();
});

test('pages: /platform marks no claim planned, /privacy names its processors, /contact has a form', async ({
  page,
}) => {
  await page.goto('/platform');
  await expect(page.locator('[data-claim="runRecorded"]')).toBeVisible();
  await expect(page.locator('[data-claim="runRecorded"]')).not.toContainText(words.planned);
  await expect(page.locator('[data-claim="noInternet"]')).not.toContainText(words.planned);
  await expect(page.locator('[data-claim="person"]')).not.toContainText(words.planned);
  // "Every run is in the audit log" is not stated: the audit log records changes, not runs (spec 04).
  await expect(page.locator('[data-claim="audit"]')).toHaveCount(0);
  await expect(page.getByText('Anthropic').first()).toBeVisible();

  await page.goto('/privacy');
  await expect(page.getByText('Google Cloud').first()).toBeVisible();
  await expect(page.getByText('Anthropic').first()).toBeVisible();
  await expect(page.getByTestId('lead-retention')).not.toBeEmpty();
  await expect(page.getByTestId('demo-retention')).not.toBeEmpty();

  await page.goto('/contact');
  await expect(page.getByTestId('lead-form')).toBeVisible();
});

test('language: the switch at top right changes the page and remembers it', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page
    .getByRole('group', { name: LOCALE === 'ja' ? '言語' : 'Language' })
    .getByRole('button', { name: words.otherName })
    .click();
  await expect(page.locator('html')).not.toHaveAttribute('lang', LOCALE);
  expect((await context.cookies()).some((cookie) => cookie.name === 'store_lang')).toBe(true);
  await page.goto('/platform');
  await expect(page.locator('html')).not.toHaveAttribute('lang', LOCALE);
});

test('accessibility: every screen has landmarks, one h1, a language and named controls', async ({
  page,
}) => {
  const screens = [
    '/',
    `/agents/${words.live.slug}`,
    `/agents/${words.soon.slug}`,
    '/platform',
    '/privacy',
    '/contact',
  ];
  for (const screen of screens) {
    await page.goto(screen);
    await expect(page.locator('html'), screen).toHaveAttribute('lang', LOCALE);
    await expect(page.getByRole('banner'), screen).toHaveCount(1);
    await expect(page.getByRole('main'), screen).toHaveCount(1);
    await expect(page.getByRole('contentinfo'), screen).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 }), screen).toHaveCount(1);
    await expect(page.getByRole('searchbox', { name: words.search }), screen).toBeVisible();
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('input:not([type="hidden"]), textarea, select, button')]
        .filter((control) => {
          const element = /** @type {HTMLInputElement} */ (control);
          const name =
            element.getAttribute('aria-label') ??
            element.labels?.[0]?.textContent ??
            element.textContent ??
            '';
          return name.trim() === '';
        })
        .map((control) => control.outerHTML.slice(0, 80)),
    );
    expect(unnamed, `${screen}: controls with no name`).toEqual([]);
  }
  // The detail page's tabs: one tablist, exactly one selected tab and one visible panel.
  await page.goto(`/agents/${words.live.slug}`);
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByText(words.tryNow).first()).toBeVisible();
  // The home page: every live card says how it was verified (scripted until a real run passes),
  // and the featured chat is a recording that says how it was made.
  await page.goto('/');
  await expect(page.getByText(words.scripted).first()).toBeVisible();
  await expect(page.getByTestId('try-recording').getByText(words.recorded)).toBeVisible();
});
