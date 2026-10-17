/* global URL, fetch, process */
/**
 * The 80-15 demo as a journey check (issue #622): the generated project's `surfaces/main.ts`
 * declares `allowedOrigins` for a host page's origin, the one-tag snippet on that page answers, and
 * the same snippet on a second origin is refused before a session is created. Untimed.
 *
 * It runs inside the clean container against the `aw dev` the journey started, like
 * `widget.e2e.mjs`, and serves both host pages itself: `http://127.0.0.1:<a>` (listed) and
 * `http://localhost:<b>` (not listed). It writes the list into `surfaces/main.ts`, waits for the
 * surface page's `frame-ancestors` to name it, and puts the file back when it ends.
 *
 * It then does the same from a customer's React page (issue #680): the page imports
 * `@indx-workspace/react`, which the journey installed from its registry, bundled by esbuild into
 * `/chat.js`, and renders `<Chat baseUrl="<web origin>">` at `/react` on both host servers. On the
 * listed origin the session, the run start and the event stream answer CORS and the agent's message
 * shows text; on the other the chat starts no run, and a read of a run route is refused by CORS
 * where the listed origin can read its `401`.
 *
 * `askWidget` is not reused: it reads the run back from the page's own origin, which here is the
 * host page, not the control plane. The checks are the same in kind: the session opens (`201`), the
 * run starts, the agent's message shows text, and the chat shows no failure.
 *
 * Named `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { assertNoChatFailure } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const SURFACE = 'main';
const NAME_LINE = /^(\s*)name: 'main',$/mu;

/**
 * The page a customer's React site would ship: `<Chat baseUrl>` from the published package, bundled
 * from the journey's `node_modules` by the esbuild CLI `prepareRunner` installed there. It is run,
 * not imported, because esbuild is not a dependency of this repository.
 *
 * @param {string} baseUrl
 */
function chatBundle(baseUrl) {
  const entry = `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Chat } from '@indx-workspace/react';
    createRoot(document.getElementById('root')).render(
      createElement(Chat, { surface: ${JSON.stringify(SURFACE)}, baseUrl: ${JSON.stringify(baseUrl)} }),
    );
  `;
  return execFileSync(
    path.join(process.cwd(), 'node_modules', '.bin', 'esbuild'),
    ['--bundle', '--format=esm', '--define:process.env.NODE_ENV="production"', '--log-level=error'],
    { input: entry, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * A host page on its own loopback port: the one-tag snippet everywhere, and at `/react` the page
 * that renders `<Chat>` from `bundle`; `host` is the name the browser is given for it, the socket
 * is always 127.0.0.1.
 *
 * @param {string} host @param {string} snippet @param {string} bundle
 */
async function hostPage(host, snippet, bundle) {
  const server = createServer((request, response) => {
    if (request.url === '/chat.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      request.url === '/react'
        ? '<!doctype html><html lang="en"><title>Shop</title><div id="root"></div><script type="module" src="/chat.js"></script></html>'
        : `<!doctype html><html lang="en"><title>Shop</title>${snippet}</html>`,
    );
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port to serve on');
  return { server, origin: `http://${host}:${String(address.port)}` };
}

/**
 * `surfaces/main.ts` with `allowedOrigins` set to `origins`, after its `name`.
 *
 * @param {string} source @param {readonly string[]} origins
 */
function withAllowedOrigins(source, origins) {
  if (!NAME_LINE.test(source)) throw new Error("surfaces/main.ts has no `name: 'main',` line");
  const list = origins.map((origin) => `'${origin}'`).join(', ');
  return source.replace(NAME_LINE, `$1name: 'main',\n$1allowedOrigins: [${list}],`);
}

test('the snippet answers on its allowed origin and is refused on another', async ({ page }) => {
  const baseUrl = new URL(required('JOURNEY_BASE_URL')).origin;
  const nonce = required('JOURNEY_NONCE');
  const file = path.join(required('JOURNEY_DEMO_DIR'), 'surfaces', `${SURFACE}.ts`);
  const snippet = `<script src="${baseUrl}/p/s/${SURFACE}/widget.js" async></script>`;
  const bundle = chatBundle(baseUrl);
  const allowed = await hostPage('127.0.0.1', snippet, bundle);
  const refused = await hostPage('localhost', snippet, bundle);
  const original = readFileSync(file, 'utf8');
  const sessionsUrl = `${baseUrl}/p/s/${SURFACE}/sessions`;
  const frameSelector = `iframe[data-aw-surface-frame="${SURFACE}"]`;
  /** @type {string[]} */
  const sessionPosts = [];
  /** @type {string[]} */
  const runPosts = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url() === sessionsUrl) sessionPosts.push(request.url());
    if (/^\/api\/agents\/[^/]+\/runs$/u.test(new URL(request.url()).pathname)) {
      runPosts.push(request.url());
    }
  });
  const runUrl = `${baseUrl}/api/runs/run-x`;
  /** Whether this page can read a run route's answer (a `401` for a bogus token), or CORS refuses it. */
  const readRun = () =>
    page.evaluate(
      (url) =>
        fetch(url, { headers: { authorization: 'Bearer awt_live_x' } }).then(
          () => 'read',
          () => 'refused',
        ),
      runUrl,
    );
  try {
    writeFileSync(file, withAllowedOrigins(original, [allowed.origin]));
    // `aw dev` saves and points the edit; the page's `frame-ancestors` then names the origin.
    await expect
      .poll(
        async () =>
          (await fetch(`${baseUrl}/p/s/${SURFACE}`)).headers.get('content-security-policy'),
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe(`frame-ancestors 'self' ${allowed.origin}`);

    // Allowed: the widget opens a session, starts a run and shows the agent's answer.
    await page.goto(allowed.origin);
    await page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`).click();
    const chat = page.frameLocator(frameSelector);
    await chat.locator('form textarea').fill(`Please answer ${nonce}.`);
    const opened = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url() === sessionsUrl,
    );
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/agents\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
      { timeout: 120_000 },
    );
    await chat.locator('form button[type="submit"]').click();
    const session = await opened;
    expect(session.status(), await session.text()).toBe(201);
    const start = await started;
    expect(start.ok(), await start.text()).toBe(true);
    await expect(
      chat.locator('ol[aria-live="polite"] > li').nth(1).locator('p').first(),
    ).toHaveText(/\S/u, { timeout: 120_000 });
    await assertNoChatFailure(chat);

    // Refused: the same snippet on another origin; the frame is blocked and opens no session.
    sessionPosts.length = 0;
    // The loader requests the frame during `goto`, so listen before navigating.
    const framed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/p/s/${SURFACE}`,
    );
    await page.goto(refused.origin);
    await page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`).click();
    expect((await framed).headers()['content-security-policy']).toBe(
      `frame-ancestors 'self' ${allowed.origin}`,
    );
    await page.waitForTimeout(1_000);
    await expect(page.frameLocator(frameSelector).locator('form textarea')).toHaveCount(0);
    expect(sessionPosts).toEqual([]);

    // Allowed, from a React page: `<Chat baseUrl>` opens the session, starts the run and reads its
    // event stream on the control plane's origin, each answer naming this page's origin.
    await page.goto(`${allowed.origin}/react`);
    expect(await readRun()).toBe('read');
    await page.locator('form textarea').fill(`Please answer ${nonce} from React.`);
    const reactOpened = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url() === sessionsUrl,
    );
    const reactStarted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /^\/api\/agents\/[^/]+\/runs$/u.test(new URL(response.url()).pathname),
      { timeout: 120_000 },
    );
    const reactEvents = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        /^\/api\/runs\/[^/]+\/events$/u.test(new URL(response.url()).pathname),
      { timeout: 120_000 },
    );
    await page.locator('form button[type="submit"]').click();
    const reactSession = await reactOpened;
    expect(reactSession.status(), await reactSession.text()).toBe(201);
    const reactStart = await reactStarted;
    expect(reactStart.ok(), await reactStart.text()).toBe(true);
    expect(reactStart.headers()['access-control-allow-origin']).toBe(allowed.origin);
    const events = await reactEvents;
    expect(events.status()).toBe(200);
    expect(events.headers()['access-control-allow-origin']).toBe(allowed.origin);
    await expect(
      page.locator('ol[aria-live="polite"] > li').nth(1).locator('p').first(),
    ).toHaveText(/\S/u, { timeout: 120_000 });
    await assertNoChatFailure(page);

    // Refused, from a React page on another origin: CORS stops the session and so any run.
    runPosts.length = 0;
    await page.goto(`${refused.origin}/react`);
    expect(await readRun()).toBe('refused');
    await page.locator('form textarea').fill(`Please answer ${nonce} from React.`);
    await page.locator('form button[type="submit"]').click();
    // The send was attempted and is over: the refused session open shows as the chat's failure
    // notice. Only then is "no run was started" a finding rather than a race.
    await expect(page.locator('ol[aria-live="polite"] ~ [role="alert"]')).toHaveText(/\S/u);
    expect(runPosts).toEqual([]);
  } finally {
    writeFileSync(file, original);
    allowed.server.close();
    refused.server.close();
  }
});
