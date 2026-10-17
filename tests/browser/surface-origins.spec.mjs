/* global URL, fetch */

/**
 * A surface embedded on two origins — issue #622, PR 1b.
 *
 * The control plane lists `http://127.0.0.1:<a>` in a surface's `allowedOrigins`, and a one-tag
 * host page is served from that origin and from `http://localhost:<b>`, which is not listed. What
 * only a browser can show is asserted here; the server's answers are pinned in
 * `apps/web/server/surfaces/public/{conditions,handlers}.test.ts`, `apps/web/proxy.test.ts` and
 * the PostgreSQL-backed `surface-sessions.integration.test.ts`:
 *
 * - **allowed:** the page's `frame-ancestors` lets the widget's frame render, and a direct
 *   `POST /p/s/<name>/sessions` from that origin (a preflighted JSON body) is readable, because the
 *   preflight and the answer both name the origin;
 * - **refused:** the same frame is blocked by `frame-ancestors`, so the chat never renders and
 *   opens no session, and the same direct `POST` is refused by the browser's CORS check.
 *
 * The deployment under test is `next start` on loopback without the local runtime's flag, so only
 * the allowed-origin branch admits anything. `playwright.config.ts` gives it a `RUNNER_URL` nobody
 * answers, because the surface routes are installed only with a runtime. Its surface's agent has no model connection, so the
 * session the allowed origin asks for may be refused by the run preflight (`422`); that refusal is
 * still an answer the page can read, which is what CORS decides.
 */
import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, signInAsBootstrapAdmin } from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no surface can be pushed.',
);

/** Unique per run and per Playwright project, so parallel workers never share a surface. */
function unique(testInfo) {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gu, '-');
  return `${project}-${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`;
}

/**
 * A host page on its own loopback port, with nothing on it but the one-tag snippet. Answers the
 * server and the origin a browser sees it under (`host` names it, the socket is 127.0.0.1).
 */
async function hostPage(host, snippet) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><title>Shop</title><h1>Shop</h1>${snippet}</html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, origin: `http://${host}:${String(port)}` };
}

/** Create an agent whose version 1 serves surface `name` to `allowedOrigins` (C9 points `local`). */
async function pushSurface(page, agentName, name, allowedOrigins) {
  const created = await page.evaluate(
    async (input) => {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          version: {
            summary: 'Embed on a shop',
            via: 'api',
            body: {
              definition: {
                apiVersion: 'agentworkspace.dev/v1',
                kind: 'AgentDefinition',
                agent: {
                  name: input.agentName,
                  instructions: 'Answer shop visitors.',
                  permissions: {
                    readFiles: false,
                    writeFiles: false,
                    runCommands: false,
                    unrestrictedNetwork: false,
                  },
                  model: null,
                  modelConnectionName: null,
                  runtimeProfileName: null,
                },
                policy: {
                  engine: 'claude-agent-sdk',
                  tools: {
                    base: 'claude_code_preset',
                    autoApprove: [],
                    deny: [],
                    permissionMode: 'default',
                    allowDangerouslySkipPermissions: false,
                  },
                  skills: { mode: 'all' },
                  limits: { maxTurns: null, maxBudgetUsd: null },
                },
                policySource: 'stored',
                resources: { files: [], skills: [], connectors: [] },
              },
              surfaces: [
                { name: input.name, agent: input.agentName, allowedOrigins: input.allowedOrigins },
              ],
            },
          },
        }),
      });
      return { status: response.status, text: await response.text() };
    },
    { agentName, name, allowedOrigins },
  );
  expect(created.status, created.text).toBe(201);
}

/** A direct `POST /p/s/<name>/sessions` from the page's own origin: its status, or `rejected`. */
function postSession(page, url) {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { status: response.status, body: await response.text() };
    } catch {
      return 'rejected';
    }
  }, url);
}

test('a surface opens on its allowed origin and is refused on another', async ({
  page,
  baseURL,
}, testInfo) => {
  const id = unique(testInfo);
  const name = `origins-${id}`;
  const base = new URL(baseURL ?? 'http://127.0.0.1:3000').origin;
  const snippet = `<script src="${base}/p/s/${name}/widget.js" async></script>`;
  const allowed = await hostPage('127.0.0.1', snippet);
  const refused = await hostPage('localhost', snippet);
  try {
    await signInAsBootstrapAdmin(page, credentials);
    await pushSurface(page, `Shop desk ${id}`, name, [allowed.origin]);
    const sessionsUrl = `${base}/p/s/${name}/sessions`;
    const frameSelector = `iframe[data-aw-surface-frame="${name}"]`;

    const sessionPosts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === sessionsUrl) {
        sessionPosts.push(request.headers()['origin'] ?? null);
      }
    });

    // Allowed: the frame renders the chat, and the bootstrap's answer is readable cross-origin.
    await page.goto(allowed.origin);
    await page.locator(`button[data-aw-surface-launcher="${name}"]`).click();
    await expect(page.frameLocator(frameSelector).locator('form textarea')).toBeVisible();
    const fromAllowed = await postSession(page, sessionsUrl);
    expect(fromAllowed).not.toBe('rejected');
    expect(fromAllowed.status, fromAllowed.body).not.toBe(403);
    expect(fromAllowed.status, fromAllowed.body).not.toBe(404);

    // Refused: the page's `frame-ancestors` does not name this origin, so the frame stays empty.
    // The loader appends its (hidden) frame as the page loads, so the frame's request is made by
    // `goto`, before the launcher is pressed; listen for it first.
    sessionPosts.length = 0;
    const framed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/p/s/${name}`,
    );
    await page.goto(refused.origin);
    await page.locator(`button[data-aw-surface-launcher="${name}"]`).click();
    const csp = (await framed).headers()['content-security-policy'] ?? '';
    expect(csp).toBe(`frame-ancestors 'self' ${allowed.origin}`);
    // The response arrived and the browser blocked it; nothing in the frame ever renders.
    await page.waitForTimeout(1_000);
    await expect(page.frameLocator(frameSelector).locator('form textarea')).toHaveCount(0);
    expect(sessionPosts).toEqual([]);
    await expect(postSession(page, sessionsUrl)).resolves.toBe('rejected');
  } finally {
    allowed.server.close();
    refused.server.close();
  }
});
