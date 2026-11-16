/**
 * The recipe graph (issue #1514): a person opens the desk's recipe runs, opens the run the third
 * ticket's creation started, sees its triage step waiting for approval with a link to its run in
 * Agent Workspace, approves it by keyboard, and watches the steps complete through the graph's
 * polite live region, without a reload.
 *
 * Against the desk fixture (`playwright.app-kit.config.mjs`): `recipeRoutes` and `RecipeGraph` on
 * the in-memory recipe store, with the desk's scripted Agent Workspace, whose triage run pauses on
 * `ticket_update {"assignee":"Net"}`. The desk starts exactly one recipe run, so this is one test.
 */
import { expect, test } from '@playwright/test';

import { expectBasicAccessibility } from '../harness.mjs';

test('the recipe graph shows each step live, links to its run, and approves by keyboard', async ({
  page,
}) => {
  await page.goto('/signin');
  await page.goto('/recipes?lang=ja');
  await expect(page.getByRole('heading', { level: 1, name: 'レシピ' })).toBeVisible();
  await page.getByRole('link', { name: 'triage-incident' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'レシピの実行' })).toBeVisible();
  await expect(page.getByText('承認待ち', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ステップ triage を承認' })).toBeVisible();
  await expectBasicAccessibility(page);

  await page.goto('/recipes');
  await expect(page.getByRole('heading', { level: 1, name: 'Recipes' })).toBeVisible();
  await expect(page.getByText('Waiting for a decision', { exact: true })).toBeVisible();
  await expectBasicAccessibility(page);
  await page.getByRole('link', { name: 'triage-incident' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Recipe run' })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Steps of triage-incident' });
  await expect(steps.locator('[data-status="awaiting_approval"]')).toHaveCount(1);
  await expect(steps.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByText('{"assignee":"Net"}', { exact: true })).toBeVisible();
  const runLink = page.getByRole('link', { name: 'Open run of step triage in Agent Workspace' });
  await expect(runLink).toHaveAttribute('href', /\/runs\?run=[0-9a-f-]{36}$/u);
  await expectBasicAccessibility(page);

  // The keyboard path: from the step's run link, the next stop is Approve, and Enter decides.
  const approve = page.getByRole('button', { name: 'Approve step triage' });
  await runLink.focus();
  await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');

  const live = page.locator('[role="status"][aria-live="polite"]');
  await expect(live).toContainText('Recipe: Completed.', { timeout: 15_000 });
  await expect(steps.locator('[data-status="completed"]')).toHaveCount(2);
  await expect(steps.getByRole('heading', { level: 3, name: 'notify' })).toBeVisible();
  await expect(approve).toHaveCount(0);
  await expectBasicAccessibility(page);

  // The width of a phone: the steps stay one column, nothing scrolls sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
