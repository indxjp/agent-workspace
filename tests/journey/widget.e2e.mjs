/* global console, getComputedStyle, process */
/**
 * The slice-1 exit test's last timed step (S1-19, issue #457): the widget, in the brand colour the
 * journey answered at `npm create` (not the widget's default) and the project file names, answers
 * a question. `run.mjs` runs it inside the clean container with
 * `playwright.journey.config.mjs`; the model is the fake Anthropic API on the host, or the real
 * one under `run.mjs --live` (issue #609). It prints `journey-first-token-ms <n>` for the record.
 *
 * It is named `.e2e.mjs`, not `.spec.mjs`, so that the `tests` Vitest project (which collects
 * `*.spec.mjs`) never loads it, as `tests/generated-project/generated-project.e2e.mjs` is named.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  askWidget,
  assertBrandColour,
  assertLauncherColour,
  colourOfSurfaceSource,
  openWidgetHost,
} from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const BASE_URL = required('JOURNEY_BASE_URL');
const NONCE = required('JOURNEY_NONCE');
/** The project `npm create` wrote; this test only reads it. */
const DEMO_DIR = required('JOURNEY_DEMO_DIR');
/** The colour the journey answered at `npm create`'s brand-colour question. */
const BRAND_COLOUR = required('JOURNEY_BRAND_COLOUR');
const SURFACE = 'main';

test('the widget in the brand colour answers a question', async ({ page }) => {
  const colour = colourOfSurfaceSource(
    readFileSync(path.join(DEMO_DIR, 'surfaces', `${SURFACE}.ts`), 'utf8'),
  );
  // The answered colour reached the file, and it is not the colour the widget falls back to, so
  // the launcher below can only match it if the runtime applied surfaces/main.ts's theme.
  assertBrandColour(colour, BRAND_COLOUR);

  await openWidgetHost(page, BASE_URL);
  const launcher = page.locator(`button[data-aw-surface-launcher="${SURFACE}"]`);
  await expect(launcher).toBeVisible({ timeout: 60_000 });
  assertLauncherColour(
    colour,
    await launcher.evaluate((element) => getComputedStyle(element).backgroundColor),
  );

  await launcher.click();
  const frame = page.frameLocator(`iframe[data-aw-surface-frame="${SURFACE}"]`);
  // Behaviour first (issue #609): the same checks pass for the fake and the real model; run.mjs
  // checks the fake's own reply on the host, and in stub mode only passes its wording to see here.
  const firstTokenMs = await askWidget(page, frame, `Please answer ${NONCE}.`, 120_000);
  console.log(`journey-first-token-ms ${String(firstTokenMs)}`);
  const expected = process.env['JOURNEY_EXPECT_TEXT'];
  if (expected !== undefined && expected !== '') {
    await expect(frame.getByText(expected)).toBeVisible({ timeout: 10_000 });
  }
});
