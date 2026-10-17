/* global document, process */

/**
 * Shared helpers for the browser specs.
 *
 * This is a plain `.mjs` module and not a `.spec.mjs` on purpose: Playwright collects only spec and
 * test files under `testDir`, and a helper kept in a spec file would have its own `test()` calls
 * re-registered in every file that imported it and run twice.
 */
import { expect } from '@playwright/test';

/**
 * The structural accessibility floor every screen of this application is held to: one `h1`, no
 * unlabelled image, no duplicate `id`, and no interactive control without an accessible name.
 *
 * Deliberately not an axe run — this repository adds no dependency for it — and deliberately
 * structural: these are the four failures that actually recur here when a screen grows a control.
 */
export async function expectBasicAccessibility(page) {
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('img:not([alt])')).toHaveCount(0);
  const duplicateIds = await page.locator('[id]').evaluateAll((nodes) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const node of nodes) {
      if (seen.has(node.id)) duplicates.add(node.id);
      seen.add(node.id);
    }
    return [...duplicates];
  });
  expect(duplicateIds).toEqual([]);

  const unnamedControls = await page
    .locator('button, input:not([type="hidden"]), select, textarea, a[href]')
    .evaluateAll((nodes) =>
      nodes
        .filter((element) => {
          const labelledBy = element.getAttribute('aria-labelledby');
          const labelledText = labelledBy
            ? labelledBy
                .split(/\s+/u)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' ')
            : '';
          const labelText = element.labels
            ? [...element.labels].map((label) => label.textContent).join(' ')
            : '';
          return ![
            element.getAttribute('aria-label'),
            labelledText,
            labelText,
            element.textContent,
            element.value,
            element.title,
          ].some((value) => typeof value === 'string' && value.trim().length > 0);
        })
        .map((node) => node.outerHTML),
    );
  expect(unnamedControls).toEqual([]);
}

/**
 * The only account this build can sign in as.
 *
 * `apps/web/server/auth/session.ts` implements exactly one credential path — the bootstrap
 * administrator the seed inserts from `BOOTSTRAP_ADMIN` — and `POST /api/users` writes no
 * credential, because §27's schema has no column for one. A signed-in spec therefore has one
 * identity available, and it is a workspace Owner.
 *
 * `null` when the deployment under test has no bootstrap credential configured, so a spec can skip
 * with a reason instead of failing on a sign-in that was never possible.
 */
export function bootstrapAdminCredentials() {
  const email = process.env['BOOTSTRAP_ADMIN']?.trim();
  const password = process.env['BOOTSTRAP_ADMIN_PASSWORD']?.trim();
  return email && password ? { email, password } : null;
}

/** Sign in through the real form, so the spec exercises the same cookie a person would get. */
export async function signInAsBootstrapAdmin(page, credentials) {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(credentials.email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/signin/u);
}
