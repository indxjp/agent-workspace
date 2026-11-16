/**
 * The dashboard (issue #1522, J5): a person opens the desk's dashboard and sees its four lists;
 * a run starts somewhere else on the scripted Agent Workspace, and its row appears in "Running
 * now" within 1.5 seconds, without a reload, linking to its run view in the console.
 *
 * Against the desk fixture (`playwright.app-kit.config.mjs`): `dashboardRoutes` reads the desk's
 * scripted `GET /api/runs` as the signed-in person; `POST /api/desk/runs` is the fixture's test
 * hook that starts a run in `running`.
 */
import { expect, test } from '@playwright/test';

import { expectBasicAccessibility } from '../harness.mjs';

test('the dashboard shows a newly started run within 1.5 s, and its row opens the run', async ({
  page,
}) => {
  await page.goto('/signin');
  await page.goto('/dashboard?lang=ja');
  await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '実行中' })).toBeVisible();
  await expect(page.getByText('利用額の上限は設定されていません。')).toBeVisible();
  await expectBasicAccessibility(page);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  for (const name of [
    'Running now',
    'Waiting for a decision',
    'Failed in the last 24 hours',
    'Spend today',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await expect(page.getByText('No spend ceiling is configured.')).toBeVisible();
  await expectBasicAccessibility(page);

  const started = await page.request.post('/api/desk/runs');
  expect(started.status()).toBe(201);
  const { id } = await started.json();

  const running = page.getByRole('region', { name: 'Running now' });
  const row = running.getByRole('link', { name: `Open run ${id}` });
  await expect(row).toBeVisible({ timeout: 1500 });
  await expect(row).toHaveAttribute('href', new RegExp(`/runs\\?run=${id}$`, 'u'));
  await expectBasicAccessibility(page);

  // The width of a phone: each table scrolls inside its section, the page never sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
