/* global document, fetch */

/**
 * The agent screen's Schedules tab through the real UI — UX-18 in #2086: add a schedule from a
 * preset, see when it runs next in its own time zone, pause and resume it, delete it, and the
 * Viewer's plain-words refusal. At phone width the tab must not scroll sideways.
 */
import { expect, test } from '@playwright/test';

import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  newMemberContext,
  signInAsBootstrapAdmin,
} from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

/** A same-origin JSON call from the page, so it carries the session cookie and the `Origin`. */
function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { method, path, body },
  );
}

async function newAgent(page, name) {
  const answer = await api(page, 'POST', '/api/agents', {
    name,
    instructions: 'Write a short morning brief.',
    modelConnectionId: null,
    model: 'claude-sonnet-4-5',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body;
}

test('adds, pauses, resumes and deletes a schedule from the agent page', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await signInAsBootstrapAdmin(page, credentials);
  const stamp = `${testInfo.project.name}-${String(Date.now())}`;
  const agent = await newAgent(page, `ux18-${stamp}`);
  const scheduleName = `morning-brief-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');

  await page.goto(`/agents/${agent.id}?tab=schedules`);
  await expect(page.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Schedules' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByText('This agent has no schedules yet.')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(scheduleName);
  await page.getByLabel('Prompt', { exact: true }).fill('Brief me on what changed overnight.');
  await page.getByLabel('Repeats').selectOption('weekdays');
  await page.getByLabel('Time zone').fill('Asia/Tokyo');
  await expect(page.getByText(/First run: .*09:00 \(Asia\/Tokyo\)/u)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('01-add-schedule-form.png') });

  await page.getByRole('button', { name: 'Add schedule' }).click();
  await expect(page.getByRole('status')).toHaveText(`Schedule ${scheduleName} added.`);
  const list = page.getByRole('list', { name: 'Schedules of this agent' });
  await expect(list.getByText(scheduleName)).toBeVisible();
  await expect(list.getByText('Every weekday (Mon–Fri) at 09:00')).toBeVisible();
  await expect(list.getByText(/09:00 \(Asia\/Tokyo\)/u)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('02-schedule-listed.png') });

  const stored = await api(page, 'GET', '/api/triggers');
  const mine = stored.body.triggers.find((each) => each.name === scheduleName);
  expect(mine).toMatchObject({
    kind: 'schedule',
    agentId: agent.id,
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Tokyo',
    enabled: true,
  });

  await page.getByRole('button', { name: `Pause ${scheduleName}` }).click();
  await expect(list.getByText('Paused', { exact: true })).toBeVisible();
  await expect(list.getByText('— (paused)')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('03-schedule-paused.png') });
  await page.getByRole('button', { name: `Resume ${scheduleName}` }).click();
  await expect(list.getByText('On', { exact: true })).toBeVisible();

  // Re-time it in place (ADR-0144 D5): no delete and add again.
  await page.getByRole('button', { name: `Change when ${scheduleName} runs` }).click();
  const change = page.getByRole('form', { name: `Change when ${scheduleName} runs` });
  await change.getByLabel('Repeats').selectOption('weekly');
  await change.getByLabel('Time zone').fill('Europe/Paris');
  await expect(change.getByText(/Next run after this change: .*\(Europe\/Paris\)/u)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('07-change-time-form.png') });
  await change.getByRole('button', { name: 'Save time' }).click();
  await expect(page.getByRole('status')).toHaveText(
    `Schedule ${scheduleName} now runs at the new time.`,
  );
  await expect(list.getByText('Every Monday at 09:00')).toBeVisible();
  await expect(list.getByText(/09:00 \(Europe\/Paris\)/u)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('08-time-changed.png') });
  const retimed = await api(page, 'GET', '/api/triggers');
  expect(retimed.body.triggers.find((each) => each.name === scheduleName)).toMatchObject({
    cron: '0 9 * * 1',
    timezone: 'Europe/Paris',
  });

  await page.getByRole('button', { name: `Delete ${scheduleName}` }).click();
  await expect(page.getByText(`Delete the schedule ${scheduleName}?`)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('04-delete-confirm.png') });
  await page
    .getByRole('group', { name: `Delete ${scheduleName}` })
    .getByRole('button', {
      name: 'Delete',
      exact: true,
    })
    .click();
  await expect(page.getByText('This agent has no schedules yet.')).toBeVisible();
  const after = await api(page, 'GET', '/api/triggers');
  expect(after.body.triggers.some((each) => each.name === scheduleName)).toBe(false);

  await expectBasicAccessibility(page);
});

test('fits a phone screen without scrolling sideways', async ({ page }, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const stamp = `${testInfo.project.name}-${String(Date.now())}-phone`;
  const agent = await newAgent(page, `ux18-${stamp}`);
  const scheduleName = `phone-${stamp}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
  const created = await api(page, 'POST', '/api/triggers', {
    kind: 'schedule',
    name: scheduleName,
    agentId: agent.id,
    prompt:
      'A long prompt that has to wrap on a narrow phone screen without pushing the page wider.',
    cron: '30 8 * * 1-5',
    timezone: 'Asia/Tokyo',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents/${agent.id}?tab=schedules`);
  await expect(page.getByText(scheduleName)).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete ${scheduleName}` })).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('05-phone-390.png'), fullPage: true });
  await page.getByRole('button', { name: `Change when ${scheduleName} runs` }).click();
  const repeats = page
    .getByRole('form', { name: `Change when ${scheduleName} runs` })
    .getByLabel('Repeats');
  await expect(repeats).toBeFocused();
  await expect(repeats).toBeInViewport();
  const editingOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(editingOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath('09-phone-390-change-time.png'),
    fullPage: true,
  });
  await api(page, 'DELETE', `/api/triggers/${created.body.trigger.id}`);
});

test('tells a Viewer who may use schedules', async ({ page, browser, baseURL }, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const stamp = `${testInfo.project.name}-${String(Date.now())}-viewer`;
  const agent = await newAgent(page, `ux18-${stamp}`);
  const email = `viewer-${stamp}@example.invalid`;
  const added = await api(page, 'POST', '/api/users', { email, name: 'Viewer', role: 'viewer' });
  expect(added.status, JSON.stringify(added.body)).toBe(201);

  const member = await newMemberContext(browser, page, email, { baseURL });
  try {
    const viewer = await member.newPage();
    await viewer.setViewportSize({ width: 1280, height: 800 });
    await viewer.goto(`/agents/${agent.id}?tab=schedules`);
    await expect(
      viewer.getByText('Only an Owner, an Admin or a Builder can see and change schedules.'),
    ).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Add schedule' })).toHaveCount(0);
    await viewer.screenshot({ path: testInfo.outputPath('06-viewer-refused.png') });
  } finally {
    await member.close();
  }
});
