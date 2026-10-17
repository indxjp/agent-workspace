/* global fetch */

/**
 * Active-member management through the real UI — issue #185.
 *
 * Everything here is a behaviour a component test cannot reach: this repository has no jsdom, so
 * effects never run in a Vitest render and no fetch, focus move or navigation is observable there.
 * What this file owns is therefore the list itself, an allowed role change, a removal, the history
 * that survives it, the Back that must not repaint it — within one workspace and across a switch to
 * another — and the dialog's keyboard contract.
 *
 * ## What this file deliberately does not do
 *
 * #185 asks for *"direct server refusal with the same unauthorized session used by the browser
 * scenario"*. This build cannot mint one: `apps/web/server/auth/session.ts` implements a single
 * credential path (the bootstrap administrator, an Owner) and neither `POST /api/users` nor
 * invitation acceptance writes a password, so a provisioned Builder or Viewer cannot sign in —
 * `projects-archive.spec.mjs` declares the same gap for the same reason. The refusal that **is**
 * reachable with a real cookie is the last-Owner `409`, and it is asserted below against the same
 * session the UI scenarios use. The role matrix itself is covered without a browser by
 * `apps/web/server/team/membership-capability.test.ts`,
 * `apps/web/server/rbac/authorisation-matrix.test.ts` and `apps/web/server/rbac/routes.test.ts`.
 *
 * Removing a member who owns a session is likewise out of reach here: a session can only be started
 * by a signed-in identity, and there is only one. `sessions_member_workspace_fk` and the wording
 * this screen puts on its violation are covered in `apps/web/components/team/model.test.ts`.
 */
import { expect, test } from '@playwright/test';

import {
  bootstrapAdminCredentials,
  expectBasicAccessibility,
  signInAsBootstrapAdmin,
} from './harness.mjs';

const credentials = bootstrapAdminCredentials();

test.skip(
  credentials === null,
  'BOOTSTRAP_ADMIN/BOOTSTRAP_ADMIN_PASSWORD are not configured, so no account can sign in.',
);

/** Unique per run and per Playwright project, so parallel workers never race over one row or slug. */
function runTag(testInfo) {
  return `${testInfo.project.name}-${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`.toLowerCase();
}

function memberIdentity(testInfo) {
  const tag = runTag(testInfo);
  return { email: `w9-185-${tag}@example.test`, name: `W9-185 ${tag}` };
}

/** A second tenant's name and slug. The slug shape is `handlers.ts`'s: lower-case, digits, hyphens. */
function workspaceIdentity(testInfo) {
  const tag = runTag(testInfo);
  return { name: `W9-185 workspace ${tag}`, slug: `w9-185-ws-${tag}` };
}

/**
 * Provision a member through `POST /api/users`, the route whose browser form #185 removed.
 *
 * It stays the only way a spec can create a second member: the invitation flow needs a mailbox and
 * an OIDC identity, and this screen deliberately offers no create control of its own.
 */
async function createMember(page, identity, role) {
  const created = await page.evaluate(
    async ({ email, name, chosen }) => {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, name, role: chosen }),
      });
      return { status: response.status, body: await response.json() };
    },
    { email: identity.email, name: identity.name, chosen: role },
  );
  expect(created.status).toBe(201);
  return created.body.membership;
}

/**
 * Provision a second workspace through `POST /api/workspaces`.
 *
 * It is the one tenant boundary a spec can cross with the single identity this build can sign in
 * as: the route is gated only on being signed in (W9-UI-120 records that create is deliberately not
 * Owner-gated) and creates the workspace with the caller as its **sole Owner**
 * (`apps/web/server/workspaces/handlers.ts`), so the bootstrap administrator ends up a member of
 * both. Left behind afterwards, like the members the specs above provision: the slug is unique per
 * run, and sign-in always mints a session for the configured `WORKSPACE_SLUG`
 * (`apps/web/server/auth/session.ts`), so a scratch workspace is never where a later run lands.
 */
async function createWorkspace(page, workspace) {
  const created = await page.evaluate(async ({ name, slug }) => {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name, slug }),
    });
    return { status: response.status, body: await response.json() };
  }, workspace);
  expect(created.status).toBe(201);
  return created.body.workspace;
}

/**
 * The sidebar's workspace switcher trigger.
 *
 * Located by `aria-haspopup` rather than by accessible name because that name is the *current*
 * workspace's, which this spec does not know — the slug comes from the deployment's
 * `WORKSPACE_SLUG`. It is the only such control in the application.
 */
function workspaceSwitcher(page) {
  return page.locator('button[aria-haspopup="menu"]');
}

/** The signed-in Owner's own membership row, read from the same list the screen reads. */
async function ownMembership(page, email) {
  const list = await page.evaluate(async () => {
    const response = await fetch('/api/memberships', { headers: { accept: 'application/json' } });
    return response.ok ? await response.json() : { memberships: [] };
  });
  const mine = list.memberships.find((membership) => membership.email === email.toLowerCase());
  expect(mine, 'the bootstrap administrator holds a membership in this workspace').toBeTruthy();
  return mine;
}

/** The session ids this caller can see, as the "history is not erased" comparison. */
async function visibleSessionIds(page) {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/sessions', { headers: { accept: 'application/json' } });
    return response.ok ? await response.json() : { sessions: [] };
  });
  return body.sessions.map((session) => session.id ?? session.sessionId).sort();
}

/**
 * The table row a member's name or address appears in.
 *
 * Matched case-insensitively because `users.email` is stored lower-cased while `BOOTSTRAP_ADMIN`
 * may not be, and escaped because an address is not a regular expression.
 */
function memberRow(page, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return page.getByRole('row').filter({ hasText: new RegExp(escaped, 'iu') });
}

test('lists active members with role, join date and the current-user marker', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const identity = memberIdentity(testInfo);
  await page.goto('/admin/users');
  await createMember(page, identity, 'viewer');
  await page.reload();

  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

  // The signed-in Owner's own row: marked "You", and — as the workspace's only Owner — carrying
  // neither a demotion nor a removal, with the reason stated on the row rather than only on
  // failure.
  const mine = memberRow(page, credentials.email);
  await expect(mine).toContainText('You');
  await expect(mine).toContainText('Owner');
  await expect(mine).toContainText('Last Owner');
  await expect(mine.locator('select')).toHaveCount(0);
  await expect(mine.getByRole('button')).toHaveCount(0);

  // The provisioned member's row carries the joined name from #181, the address, the role, and both
  // controls — each named after the member it acts on.
  const theirs = memberRow(page, identity.name);
  await expect(theirs).toContainText(identity.email);
  await expect(theirs).toContainText('Viewer');
  await expect(page.getByLabel(`Role for ${identity.name}`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Remove ${identity.name}` })).toBeVisible();
});

test('refuses a direct last-Owner demotion made with the browser’s own session', async ({
  page,
}) => {
  await signInAsBootstrapAdmin(page, credentials);
  await page.goto('/admin/users');
  const mine = await ownMembership(page, credentials.email);

  // The "direct API calls are still refused" criterion, driven with the same cookie the UI uses:
  // the control is withheld on the row above, and the route refuses it anyway.
  const answer = await page.evaluate(async (id) => {
    const response = await fetch(`/api/memberships/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });
    return { status: response.status, body: await response.json() };
  }, mine.id);

  expect(answer.status).toBe(409);
  expect(answer.body.error.code).toBe('last_owner');
  expect(answer.body.error.detail).toContain('last Owner');

  // And the demotion did not happen.
  expect((await ownMembership(page, credentials.email)).role).toBe('owner');
});

test('changes a member’s role to one the server allows this caller to confer', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const identity = memberIdentity(testInfo);
  await page.goto('/admin/users');
  await createMember(page, identity, 'viewer');
  await page.reload();

  await page.getByLabel(`Role for ${identity.name}`).selectOption('builder');
  await expect(memberRow(page, identity.name)).toContainText('Builder');

  // The change is what the server stored, not what the screen hoped: a reload re-reads the list.
  await page.reload();
  await expect(memberRow(page, identity.name)).toContainText('Builder');
});

test('removes a member by keyboard, keeps history, and does not repaint them on Back', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const identity = memberIdentity(testInfo);
  await page.goto('/admin/users');
  await createMember(page, identity, 'viewer');
  await page.reload();

  const before = await visibleSessionIds(page);

  // Keyboard operation and the focus contract the hand-written dialog owes: Enter opens it, Cancel
  // takes focus (the safe answer is where a stray Enter lands), Escape closes it and gives focus
  // back to the control that opened it.
  const trigger = page.getByRole('button', { name: `Remove ${identity.name}` });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(identity.email);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText(
    /owns no sessions|stay in this workspace|could not be counted/u,
  );

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Reopen and confirm, still without the mouse. Tab moves from Cancel to the confirm control.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: `Remove ${identity.name} from` }),
  ).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(memberRow(page, identity.name)).toHaveCount(0);

  // Focus survives the removal. It cannot go back to the row's Remove button — the reload unmounts
  // it, and a detached element's focus falls to `<body>`, restarting the next Tab at the top of the
  // page. The screen's heading outlives the list, so that is where focus lands.
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeFocused();

  // Removing a member erases no history: the sessions this caller can see are exactly the same set.
  expect(await visibleSessionIds(page)).toEqual(before);

  // Back must not reconstruct stale member data. The screen keeps no client cache, every read is
  // `cache: 'no-store'`, and the route answers `Cache-Control: no-store`, so a restored entry
  // re-reads rather than repainting the list this session already invalidated.
  await page.goto('/projects');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(memberRow(page, identity.name)).toHaveCount(0);
});

test('does not repaint the previous workspace’s members after a switch and Back', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const identity = memberIdentity(testInfo);
  await page.goto('/admin/users');
  await createMember(page, identity, 'viewer');
  await page.reload();
  await expect(memberRow(page, identity.name)).toHaveCount(1);

  // Switch tenants through the real control: each item is a submit button for the hidden form that
  // posts to `/api/auth/workspace`, so this is a full navigation under a freshly minted session.
  const workspace = await createWorkspace(page, workspaceIdentity(testInfo));
  await workspaceSwitcher(page).click();
  await page.getByRole('menuitem', { name: workspace.name }).click();
  await expect(workspaceSwitcher(page)).toContainText(workspace.name);

  // Back returns to the previous tenant's `/admin/users` entry, and it must not show that tenant's
  // members. Nothing survives the switch to repaint them: this screen keeps no client cache, every
  // read is `cache: 'no-store'`, and the one cache that can preserve a whole document across a full
  // navigation — the bfcache — is reloaded by the shell's `pageshow` handler before it is revealed.
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(memberRow(page, identity.name)).toHaveCount(0);

  // And what is on screen is the new workspace's list rather than an empty table: the caller is its
  // sole Owner, so their own row is there, with both controls withheld for that reason.
  await expect(memberRow(page, credentials.email)).toContainText('Last Owner');
});

test('keeps the members screen accessible, including while the confirmation is open', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const identity = memberIdentity(testInfo);
  await page.goto('/admin/users');
  await createMember(page, identity, 'viewer');
  await page.reload();
  await expectBasicAccessibility(page);

  await page.getByRole('button', { name: `Remove ${identity.name}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // The dialog is named by its own heading rather than by a duplicated `aria-label`.
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  await expect(page.locator(`#${labelledBy}`)).toBeVisible();
  await expectBasicAccessibility(page);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Leave the workspace as this spec found it, so a later run does not accumulate members.
  await page.getByRole('button', { name: `Remove ${identity.name}` }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `Remove ${identity.name} from` })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
