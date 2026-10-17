/* global window */

/**
 * The driver band's × through the real UI — issue #1133.
 *
 * A component test renders once with no effects, so the dismissal surviving a reload and the
 * hydrated markup matching the server's are observable only here. The share layout at `/p/<token>`
 * carries the same dismissible band as the shell and needs no account, even for an unknown token,
 * so it is the screen this file drives. `/signin` keeps a non-dismissible band (no top bar chip).
 */
import { expect, test } from '@playwright/test';

const SHARE = '/p/notices-spec-unknown-token';
const KEY = 'aw.notice.dismissed.driver';
// A production build reports a hydration mismatch only as a minified error code (#418/#423/#425).
const HYDRATION = /hydrat|react\.dev\/errors\/(?:418|423|425)|#4(?:18|23|25)\b/iu;

test('the driver band stays dismissed across reloads and returns for another driver', async ({
  page,
}) => {
  const hydrationErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && HYDRATION.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (HYDRATION.test(String(error))) hydrationErrors.push(String(error));
  });

  await page.goto(SHARE);
  const band = page.getByTestId('driver-in-force');
  test.skip(
    (await band.count()) === 0,
    'RUNTIME_DRIVER names a configured non-local driver, which shows no band.',
  );
  await expect(band).toBeVisible();

  // The × is in the server markup, so retry until hydration has attached its handler.
  await expect(async () => {
    await band.getByRole('button', { name: 'Dismiss' }).click();
    await expect(band).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  await page.reload();
  await expect(band).toHaveCount(0);

  await page.evaluate((key) => window.localStorage.setItem(key, 'driver=another'), KEY);
  await page.reload();
  await expect(band).toBeVisible();

  expect(hydrationErrors).toEqual([]);
});
