/* global process */
/**
 * examples/store's journeys, run by the apps lane (`tests/apps/lane.mjs`) against the app under
 * `aw dev`, in English and in Japanese (`APPS_E2E_LOCALE`, with `app/theme.ts` set to each; every
 * assertion uses that language's words). The visitor is anonymous: the shelf, the filters, an agent's
 * detail page and its sections, the sign-up gate of Try it, /platform, /privacy and /contact. `aw
 * dev` has no email sender and no challenge provider, so the gate and the forms end at a message that it is
 * not available yet, which is what they must say until a provider is chosen. The sign-in and the chat that follows
 * it are Try it's own journeys and are not in this file.
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
    verified: 'Verified with real Claude (',
    recorded: 'Recorded with the scripted model',
    search: 'Search agents',
    other: 'Japanese',
    otherName: '日本語',
    privacy: 'Privacy notice',
    contract: 'Contract review agent',
    notice: 'Get a launch notice',
    landing: { live: 'contract-review', soon: 'legal-intake' },
    sections: ['The problem', 'How it works', 'What you get', 'FAQ', 'Limits', 'Related agents'],
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
    verified: '実際のClaudeで検証済み（',
    recorded: '台本どおりのモデルで録画',
    search: 'エージェントを検索',
    other: '英語',
    otherName: 'English',
    privacy: 'プライバシー通知',
    contract: '契約書レビュー',
    notice: '公開の通知を受け取る',
    landing: { live: 'contract-review', soon: 'legal-intake' },
    sections: [
      'いまの課題',
      '処理の流れ',
      '得られるもの',
      'よくある質問',
      'しないこと',
      '同じ分野のエージェント',
    ],
  },
};
const words = WORDS[LOCALE];

test.use({ baseURL: APP_URL });

/**
 * A section of the detail page: a region named by its heading.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
const section = (page, name) => page.getByRole('region', { name, exact: true });

test('J1: a visitor finds an agent on the shelf and reaches the sign-up gate', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const shelf = page.getByRole('region', { name: words.live.area });
  await shelf.getByRole('link', { name: words.live.name }).click();
  await expect(page).toHaveURL(/\/agents\/ringi-review$/u);
  await expect(page.getByRole('heading', { level: 1, name: words.live.name })).toBeVisible();

  await page.getByRole('main').getByRole('link', { name: words.tryIt, exact: true }).click();
  await expect(page).toHaveURL(/#try$/u);
  await expect(section(page, words.tryIt)).toBeVisible();
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
  await expect(section(page, words.customize)).toBeVisible();
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
  await expect(section(page, words.code)).toHaveCount(0);
  await expect(page.getByRole('link', { name: words.github })).toHaveCount(0);
  await page.getByRole('link', { name: words.notice }).click();
  await expect(page).toHaveURL(/#notify$/u);
  const form = section(page, words.notice).getByTestId('lead-form');
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
    .getByRole('link', { name: words.otherName })
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
  // The detail page is one page of sections, each a region named by its h2: no tabs hide any.
  await page.goto(`/agents/${words.live.slug}`);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  for (const name of [words.tryIt, words.customize, words.code]) {
    await expect(section(page, name), name).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name, exact: true }), name).toHaveCount(1);
  }
  await expect(page.getByText(words.tryNow).first()).toBeVisible();
  // The home page: every live card says how it was verified (with real Claude and the date of its
  // passing R1 run, which every live entry now has), and the featured chat is a recording that
  // says how it was made.
  await page.goto('/');
  await expect(page.getByText(words.verified).first()).toBeVisible();
  await expect(page.getByTestId('try-recording').getByText(words.recorded)).toBeVisible();
});

test('landing: a live and a coming-soon page show every section of their copy', async ({
  page,
}) => {
  await page.goto(`/agents/${words.landing.live}`);
  for (const name of [...words.sections, words.tryIt, words.customize, words.code]) {
    await expect(section(page, name), name).toBeVisible();
  }
  await expect(section(page, words.notice)).toHaveCount(0);

  await page.goto(`/agents/${words.landing.soon}`);
  for (const name of [...words.sections, words.notice]) {
    await expect(section(page, name), name).toBeVisible();
  }
  for (const name of [words.tryIt, words.customize, words.code]) {
    await expect(section(page, name), name).toHaveCount(0);
  }
  // Related entries share the area: the soon page links to the live one.
  await expect(
    section(page, words.sections[5] ?? '').getByRole('link', { name: words.contract }),
  ).toBeVisible();
});

test('search and social: ?lang pages, their head, the screenshot, robots, the sitemap and the card', async ({
  page,
  context,
  request,
}) => {
  // The lane sets no STORE_PUBLIC_URL, so every URL stays relative and no host is named.
  const other = LOCALE === 'ja' ? 'en' : 'ja';
  const slug = words.landing.live;
  const href = (lang) => `/agents/${slug}?lang=${lang}`;
  await page.goto(href(other));
  await expect(page.locator('html')).toHaveAttribute('lang', other);
  const cookie = (await context.cookies()).find(({ name }) => name === 'store_lang');
  expect(cookie?.value).toBe(other);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', href(other));
  for (const lang of ['ja', 'en']) {
    await expect(page.locator(`link[rel="alternate"][hreflang="${lang}"]`)).toHaveAttribute(
      'href',
      href(lang),
    );
  }
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
    'href',
    `/agents/${slug}`,
  );
  const jsonLd = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? '',
  );
  expect(jsonLd).toMatchObject({ '@type': 'SoftwareApplication', inLanguage: other });
  const shot = page.locator('#outputs img');
  await expect(shot).toHaveAttribute('src', `/shots/${slug}.${other}.webp`);
  expect(
    await shot.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
  ).toBe(true);

  expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /api/');
  expect(await (await request.get('/robots.txt')).text()).not.toContain('Sitemap:');
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain('<loc>');
  // The cards are drawn at build time with the committed font: both languages, no cookie, and
  // nothing but a known slug and language.
  for (const lang of ['ja', 'en']) {
    const card = await request.get(`/og/${slug}/${lang}?lang=${other}&extra=1`);
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toBe('image/png');
    expect(card.headers()['set-cookie']).toBeUndefined();
  }
  expect((await request.get(`/og/${slug}/fr`)).status()).toBe(404);
  expect((await request.get('/og/no-such-agent/en')).status()).toBe(404);
});
