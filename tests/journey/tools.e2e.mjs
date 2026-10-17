/* global console, getComputedStyle, process */
/**
 * The slice-2 exit test's browser steps (S2-08, issue #550). `run.mjs` runs one test per call,
 * picked with `--grep`, inside the clean container against the `aw dev` it started:
 *
 * - `look change` (B2): reloads `/p/s/main/try` until the launcher shows `JOURNEY_COLOUR`, the
 *   colour the journey just wrote into `surfaces/main.ts`;
 * - `tool answer` (B3a, B3b and the ceiling): asks for order `JOURNEY_NONCE`; the widget must show
 *   an answer from a `completed` run (`askWidget`), and `run.mjs` checks the orders API saw the
 *   call. It prints `journey-first-token-ms <n>` for the record.
 *
 * Like `widget.e2e.mjs`, it is named `.e2e.mjs` so the `tests` Vitest project never loads it.
 */
import { expect, test } from '@playwright/test';

import { askWidget, assertLauncherColour, openWidgetHost } from './harness.mjs';

const SURFACE = 'main';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

/** @param {import('@playwright/test').Page} page */
function launcherOf(page) {
  return page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`);
}

test('look change: the launcher shows the colour written to surfaces/main.ts', async ({ page }) => {
  const baseUrl = required('JOURNEY_BASE_URL');
  const colour = required('JOURNEY_COLOUR');
  await expect
    .poll(
      async () => {
        await openWidgetHost(page, baseUrl);
        const launcher = launcherOf(page);
        await launcher.waitFor({ state: 'visible', timeout: 30_000 });
        const css = await launcher.evaluate((element) => getComputedStyle(element).backgroundColor);
        try {
          assertLauncherColour(colour, css);
          return colour;
        } catch {
          return css;
        }
      },
      // Past B2's 60 s on purpose: run.mjs measures the block and checks the budget, so a slow
      // look change fails there with its seconds rather than here as a bare timeout.
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBe(colour);
});

test('tool answer: the widget answers with the orders tool data', async ({ page }) => {
  const baseUrl = required('JOURNEY_BASE_URL');
  const nonce = required('JOURNEY_NONCE');
  await openWidgetHost(page, baseUrl);
  const launcher = launcherOf(page);
  await expect(launcher).toBeVisible({ timeout: 60_000 });
  await launcher.click();
  const chat = page.frameLocator(`iframe[data-aw-surface-frame="${SURFACE}"]`);
  // Behaviour first (issue #609): run.mjs checks the tool's request reached the orders API, and in
  // stub mode only passes `order-data-<nonce>` (the fake's wording) to see here.
  const firstTokenMs = await askWidget(page, chat, `Please look up order ${nonce}.`, 180_000);
  console.log(`journey-first-token-ms ${String(firstTokenMs)}`);
  const expected = process.env['JOURNEY_EXPECT_TEXT'];
  if (expected !== undefined && expected !== '') {
    await expect(chat.getByText(expected)).toBeVisible({ timeout: 10_000 });
  }
});
