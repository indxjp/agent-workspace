/**
 * J3 (issue #1509): a person opens a ticket, asks the triage agent about it beside the record,
 * watches its steps, and decides the change it asks to make. Approving changes the record, which
 * the detail shows without a reload; rejecting leaves it as it was.
 *
 * Against the desk fixture (`playwright.app-kit.config.mjs`): the app kit's routes and pages on an
 * in-memory store, with a scripted Agent Workspace whose triage run pauses on
 * `ticket_update {"assignee":"Net"}`. Each test works on its own ticket, so they run in parallel.
 */
import { expect, test } from '@playwright/test';

import { expectBasicAccessibility } from '../harness.mjs';

/** The value cell of `field` in the record's field list. */
function fieldValue(page, field) {
  return page
    .locator('.aw-app-field-row')
    .filter({ has: page.locator('dt', { hasText: field }) })
    .locator('dd');
}

test('J3: ask triage about INC0042, approve its change by keyboard, and the ticket is reassigned', async ({
  page,
}) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'INC0042' })).toBeVisible();
  await expectBasicAccessibility(page);

  await page.getByRole('link', { name: 'INC0042' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'INC0042' })).toBeVisible();
  await expect(fieldValue(page, 'Assignee')).not.toHaveText('Net');
  await expectBasicAccessibility(page);

  await page.getByLabel('Agent', { exact: true }).selectOption({ label: 'Triage' });
  await page.getByLabel('What should the agent do with this record?').fill('classify and route');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByText('I would assign it to Net.')).toBeVisible();
  const trace = page.getByText('2 steps', { exact: true });
  await trace.click();
  await expect(page.getByText('reading ticket', { exact: true })).toBeVisible();
  await expect(page.getByText('searching kb_article', { exact: true })).toBeVisible();
  await expect(page.getByText('{"assignee":"Net"}', { exact: true })).toBeVisible();
  await expectBasicAccessibility(page);

  // The keyboard path: from the step list, the next stop is Approve, and Enter decides.
  const approve = page.getByRole('button', { name: 'Approve' });
  await trace.focus();
  await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Assigned INC0042 to Net.')).toBeVisible();
  await expect(fieldValue(page, 'Assignee')).toHaveText('Net');
  await expect(approve).toHaveCount(0);
});

test('J3 in Japanese: rejecting the change on INC0043 leaves the ticket unchanged', async ({
  page,
}) => {
  await page.goto('/signin?lang=ja');
  await expect(page.getByRole('heading', { level: 1, name: 'チケット' })).toBeVisible();
  await expectBasicAccessibility(page);

  await page.getByRole('link', { name: 'INC0043' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'INC0043' })).toBeVisible();
  const before = await fieldValue(page, 'Assignee').textContent();

  await page.getByLabel('エージェント', { exact: true }).selectOption({ label: 'トリアージ' });
  await page
    .getByLabel('このレコードについてエージェントに依頼する内容')
    .fill('分類して担当者を決めて');
  await page.getByRole('button', { name: '送信' }).click();

  await expect(page.getByText('承認待ち', { exact: true })).toBeVisible();
  await expectBasicAccessibility(page);
  await page.getByRole('button', { name: '却下' }).click();

  await expect(page.getByText('完了', { exact: true })).toBeVisible();
  await expect(page.getByText('INC0043 is left as it is.')).toBeVisible();
  await expect(page.getByRole('button', { name: '承認' })).toHaveCount(0);
  // Fetched again after the run completed, and still as it was.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'INC0043' })).toBeVisible();
  await expect(fieldValue(page, 'Assignee')).toHaveText(before ?? '');
});
