/* global fetch, process, URL */

import { expect, test } from '@playwright/test';

const requiredEnvironment = [
  'AZURE_LIVE_BASE_URL',
  'AZURE_LIVE_BOOTSTRAP_EMAIL',
  'AZURE_LIVE_BOOTSTRAP_PASSWORD',
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());

test.describe('Azure preview live deployment', () => {
  test.skip(
    missingEnvironment.length > 0,
    `requires explicit live environment configuration (${requiredEnvironment.join(', ')})`,
  );

  test('signs in and renders an authenticated screen and API', async ({ page }) => {
    const baseUrl = new URL(process.env['AZURE_LIVE_BASE_URL']);
    expect(baseUrl.protocol).toBe('https:');
    expect(baseUrl.username).toBe('');
    expect(baseUrl.password).toBe('');

    const pageProblems = [];
    page.on('pageerror', (error) => pageProblems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') pageProblems.push(`console error: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      // Navigation and Next.js prefetch cancellation are normal browser control flow.
      if (request.failure()?.errorText.includes('ERR_ABORTED')) return;
      if (new URL(request.url()).origin === baseUrl.origin) {
        pageProblems.push(
          `same-origin request failed: ${request.method()} ${new URL(request.url()).pathname}`,
        );
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === baseUrl.origin && response.status() >= 500) {
        pageProblems.push(`same-origin HTTP ${response.status()}: ${url.pathname}`);
      }
    });

    await page.goto('/signin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Workspace' })).toBeVisible();
    await page.getByLabel('Email').fill(process.env['AZURE_LIVE_BOOTSTRAP_EMAIL']);
    await page.getByLabel('Password').fill(process.env['AZURE_LIVE_BOOTSTRAP_PASSWORD']);
    await Promise.all([
      page.waitForURL((url) => url.origin === baseUrl.origin && url.pathname === '/'),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);

    await expect(
      page.getByRole('heading', { level: 1, name: 'What can I help with?' }),
    ).toBeVisible();
    await expect(page.getByLabel('Ask anything')).toBeVisible();

    const agentsApi = await page.evaluate(async () => {
      const response = await fetch('/api/agents', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      return { status: response.status, body: await response.json() };
    });
    expect(agentsApi.status).toBe(200);
    expect(agentsApi.body).toEqual(expect.objectContaining({ agents: expect.any(Array) }));
    expect(pageProblems).toEqual([]);
  });
});
