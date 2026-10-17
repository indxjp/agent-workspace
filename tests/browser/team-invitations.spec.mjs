/* global fetch, document, window, localStorage, sessionStorage, URL */

/**
 * Invitation management through the real UI — issue #186.
 *
 * Everything here is a behaviour no component test can reach: this repository has no jsdom, so
 * effects never run in a Vitest render and no fetch, clipboard, focus move or navigation is
 * observable there. What this file owns is therefore the lifecycle of the one-time reveal — created,
 * copied, rotated by a resend, dismissed, and *gone* after a reload, a Back and a workspace switch —
 * plus the five-surface leak snapshot #186 asks for, the create/resend/revoke flows, keyboard
 * operation, and the accessibility floor.
 *
 * ## The leak snapshot
 *
 * {@link expectNoTokenAnywhere} is the assertion this spec exists for. After a reveal it checks all
 * five surfaces #186 names — the URL, `localStorage`, `sessionStorage`, every `console` message
 * collected since the page opened, and the DOM **with the reveal element removed** — and it runs
 * again after every event that must end the reveal. Rendering the link as an `<a href>` fails the
 * URL check the moment it is followed; keeping the token in any storage fails the second and third;
 * a stray `console.log` fails the fourth; a second element showing it fails the fifth.
 *
 * ## What this file deliberately does not do
 *
 * #186 asks that *"Builder and Viewer users cannot see or invoke invitation controls"*. This build
 * cannot mint such a session: `apps/web/server/auth/session.ts` implements a single credential path
 * (the bootstrap administrator, an Owner) and neither `POST /api/users` nor invitation acceptance
 * writes a password, so a provisioned Builder or Viewer cannot sign in — `team-members.spec.mjs` and
 * `projects-archive.spec.mjs` declare the same gap for the same reason. The matrix is covered
 * without a browser by `apps/web/server/team/invitation-capability.test.ts`,
 * `apps/web/server/rbac/authorisation-matrix.test.ts` and `apps/web/server/rbac/routes.test.ts`, and
 * the hidden-control half by `apps/web/components/team/invitations-table.test.tsx` and
 * `invitation-form.test.tsx`.
 *
 * The unauthorized direct call that **is** reachable with one identity is the cross-tenant one, and
 * it is asserted below: the bootstrap administrator owns two workspaces, so their session for one
 * can be pointed at the other's invitation id. An API-key refusal is *not* asserted here — a fetch
 * from a signed-in page carries the session cookie, so `authorise()` builds a session principal and
 * the `api-key` branch is never reached. `apps/web/server/invitations/routes.test.ts` drives that
 * refusal where it is real.
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

/** Clipboard reads and writes need the permission granted to the origin under test. */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** Unique per run and per Playwright project, so parallel workers never race over one row or slug. */
function runTag(testInfo) {
  return `${testInfo.project.name}-${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`.toLowerCase();
}

function inviteeAddress(testInfo) {
  return `w9-186-${runTag(testInfo)}@example.test`;
}

/** A second tenant's name and slug. The slug shape is `handlers.ts`'s: lower-case, digits, hyphens. */
function workspaceIdentity(testInfo) {
  const tag = runTag(testInfo);
  return { name: `W9-186 workspace ${tag}`, slug: `w9-186-ws-${tag}` };
}

/**
 * Collect every `console` message the page emits, for the fourth surface of the leak snapshot.
 *
 * Attached before the first navigation so nothing is missed, and it collects **all** levels: #186
 * says "logs", and a token in a `debug` line is a token in the logs.
 */
function collectConsole(page) {
  const messages = [];
  page.on('console', (message) => messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(String(error)));
  return messages;
}

/**
 * The reveal, looked up across the whole document on purpose.
 *
 * Every `toHaveCount(0)` below is the claim that no reveal exists *anywhere*, which is what #186
 * asks; scoping this to {@link invitationsSection} would narrow that claim to one subtree and let a
 * second element carrying the link pass.
 */
const revealElement = (page) => page.locator('[data-invitation-reveal]');

/**
 * The invitations half of `/admin/users`, as a scope for everything this spec looks up in it.
 *
 * `apps/web/components/team/invitations-section.tsx` renders it as a `<section>` named by its own
 * `h2`, so it is a region and can be addressed by that name.
 *
 * Scoping matters here because this screen is shared and its rows are not this spec's alone. The
 * members table sits above this section, `team-members.spec.mjs` runs in a parallel worker against
 * the same workspace, and the members it provisions stay in the list — so a page this spec opens
 * renders that spec's rows too, each with a `Role for <name>` select and a `Remove <name>` button.
 * An unscoped `getByLabel('Role')` matches all of them and fails Playwright's strict mode. `exact`
 * alone would also settle today's collision; the scope is what keeps holding when the members table
 * gains a control this spec has never heard of.
 */
const invitationsSection = (page) => page.getByRole('region', { name: 'Invitations', exact: true });

/**
 * The section's own `h2` — the element the region is named by, and the one focus lands on when a
 * reveal is dismissed. `exact`, so it cannot widen to a heading that merely contains the word.
 */
const invitationsHeading = (page) =>
  page.getByRole('heading', { level: 2, name: 'Invitations', exact: true });

/** The link the reveal is currently showing, read as text so no attribute is involved. */
async function revealedLink(page) {
  const link = (await revealElement(page).locator('code').innerText()).trim();
  expect(link, 'the reveal shows an absolute accept link').toMatch(
    /^https?:\/\/.+\/accept-invitation\?id=[^&]+&token=.+$/u,
  );
  return link;
}

/** The `token` query parameter of a revealed link — the secret itself, on its own. */
function tokenOf(link) {
  const token = new URL(link).searchParams.get('token');
  expect(token, 'the accept link carries a token').toBeTruthy();
  return token;
}

/**
 * The five surfaces #186 names, asserted free of `token`.
 *
 * The DOM is checked with the reveal element **removed**, so this is usable both while a reveal is
 * on screen (nothing outside it may carry the token) and after one has been cleared (nothing at
 * all may). `where` names the moment, so a failure says which lifecycle event leaked.
 */
async function expectNoTokenAnywhere(page, token, consoleMessages, where) {
  expect(page.url(), `URL after ${where}`).not.toContain(token);

  const stored = await page.evaluate(() => {
    const dump = (store) => {
      const entries = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        entries.push(`${key}=${store.getItem(key) ?? ''}`);
      }
      return entries.join('\n');
    };
    const body = document.body.cloneNode(true);
    for (const element of body.querySelectorAll('[data-invitation-reveal]')) element.remove();
    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      documentOutsideReveal: body.outerHTML,
      // The address bar as the document itself sees it, including a fragment `page.url()` keeps but
      // a server never receives.
      href: window.location.href,
    };
  });

  expect(stored.local, `localStorage after ${where}`).not.toContain(token);
  expect(stored.session, `sessionStorage after ${where}`).not.toContain(token);
  expect(stored.documentOutsideReveal, `DOM outside the reveal after ${where}`).not.toContain(
    token,
  );
  expect(stored.href, `document.location after ${where}`).not.toContain(token);

  const leaked = consoleMessages.filter((message) => message.includes(token));
  expect(leaked, `console messages after ${where}`).toEqual([]);
}

/**
 * The row an invitee's address appears in, within the invitations table only.
 *
 * An address is not a regular expression, hence the escape. The scope keeps `getByRole('row')` off
 * the members table above, whose rows this page also renders.
 */
function invitationRow(page, email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return invitationsSection(page)
    .getByRole('row')
    .filter({ hasText: new RegExp(escaped, 'iu') });
}

/** Send an invitation through the real form and wait for the reveal it produces. */
async function invite(page, email, role = 'viewer') {
  // Scoped and exact, for {@link invitationsSection}'s reason: "Email", "Role" and "Send invitation"
  // are generic names on a screen that also renders another spec's member rows, and Playwright
  // matches both a label and an accessible name by substring unless told otherwise.
  const section = invitationsSection(page);
  await section.getByLabel('Email', { exact: true }).fill(email);
  await section.getByLabel('Role', { exact: true }).selectOption(role);
  await section.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(revealElement(page)).toBeVisible();
  return revealedLink(page);
}

/** Every invitation this session's workspace can see, read from the same route the screen reads. */
async function listInvitations(page) {
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/invitations', { headers: { accept: 'application/json' } });
    return response.ok ? await response.json() : { invitations: [] };
  });
  return body.invitations;
}

/**
 * Provision a second workspace through `POST /api/workspaces`, as `team-members.spec.mjs` does.
 *
 * It is the one tenant boundary a spec can cross with the single identity this build can sign in
 * as: the route is gated only on being signed in and creates the workspace with the caller as its
 * sole Owner, so the bootstrap administrator ends up a member of both.
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

/** The sidebar's workspace switcher trigger — the only `aria-haspopup` control in the application. */
function workspaceSwitcher(page) {
  return page.locator('button[aria-haspopup="menu"]');
}

/** Leave the workspace as the spec found it: a revoked row offers no action and joins nothing. */
async function revokeThrough(page, email) {
  const revoke = page.getByRole('button', { name: `Revoke the invitation for ${email}` });
  if ((await revoke.count()) > 0) await revoke.click();
  await expect(revoke).toHaveCount(0);
}

test('creates an invitation, reveals the link once, and leaks it to no other surface', async ({
  page,
}, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  await expect(invitationsHeading(page)).toBeVisible();
  const link = await invite(page, email);
  const token = tokenOf(link);

  // The reveal carries the server's own one-time sentence, and the row is now in the list.
  await expect(revealElement(page)).toContainText('only time this token is shown');
  await expect(revealElement(page)).toContainText(email);
  await expect(invitationRow(page, email)).toContainText('Pending');
  await expect(invitationRow(page, email)).toContainText('Viewer');

  // The link is text, not a link: an anchor is what would put the token in the address bar and in
  // `document.referrer`.
  await expect(revealElement(page).locator('a')).toHaveCount(0);
  await expect(revealElement(page).locator('code')).toHaveCount(1);

  // The token is in the reveal and in none of the five surfaces — while the reveal is still up.
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a create');

  await revokeThrough(page, email);
});

test('copies the shown link to the clipboard, byte for byte', async ({ page }, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  const link = await invite(page, email);
  await page.getByRole('button', { name: `Copy the invitation link for ${email}` }).click();
  await expect(revealElement(page)).toContainText('Link copied');

  // What is on the clipboard is what was shown — the absolute link, usable by the recipient.
  const clipboard = await page.evaluate(() => window.navigator.clipboard.readText());
  expect(clipboard).toBe(link);

  // Copying put it nowhere else.
  await expectNoTokenAnywhere(page, tokenOf(link), consoleMessages, 'a copy');

  await revokeThrough(page, email);
});

test('never re-reveals the link after a reload, a Back, or a dismiss', async ({
  page,
}, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  const link = await invite(page, email);
  const token = tokenOf(link);

  // Dismiss: the reveal goes, the invitation stays.
  await page.getByRole('button', { name: `Dismiss the invitation link for ${email}` }).click();
  await expect(revealElement(page)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a dismiss');
  await expect(invitationRow(page, email)).toContainText('Pending');

  // Reload: a fresh document, and the token was never stored anywhere that could rebuild it.
  await page.reload();
  await expect(invitationsHeading(page)).toBeVisible();
  await expect(revealElement(page)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a reload');

  // Back: the entry may be restored from the bfcache, which is the one cache that preserves React
  // state across a full navigation. This screen drops the reveal on its own `pagehide`.
  await page.goto('/projects');
  await page.goBack();
  await expect(invitationsHeading(page)).toBeVisible();
  await expect(revealElement(page)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a Back');

  await revokeThrough(page, email);
});

test('rotates the token on resend and shows only the replacement', async ({ page }, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  const first = await invite(page, email);
  const firstToken = tokenOf(first);

  await page.getByRole('button', { name: `Resend the invitation for ${email}` }).click();
  await expect(revealElement(page)).toContainText('previous token no longer works');

  const second = await revealedLink(page);
  const secondToken = tokenOf(second);
  expect(secondToken, 'the resend minted a different token').not.toBe(firstToken);

  // Only the replacement is on screen, and the invalidated one is gone from everywhere.
  const revealText = await revealElement(page).innerText();
  expect(revealText).not.toContain(firstToken);
  await expectNoTokenAnywhere(page, firstToken, consoleMessages, 'a resend');
  await expectNoTokenAnywhere(page, secondToken, consoleMessages, 'a resend');

  // Both links address the same invitation row, which is what makes this a rotation rather than a
  // second invitation: the id is unchanged and the token is not.
  expect(new URL(second).searchParams.get('id')).toBe(new URL(first).searchParams.get('id'));
  await expect(invitationRow(page, email)).toHaveCount(1);

  // That the *server* stopped honouring the first token is not assertable from here: acceptance
  // requires the dedicated `__Host-aw_invitation_identity` cookie, which no signed-in tenant session
  // carries, so both tokens would be refused for that reason rather than for rotation. It is
  // covered where it is real, against the repository — see the task ADR's declared gaps and
  // `apps/web/server/rbac/postgres-invitations.test.ts`.

  await revokeThrough(page, email);
});

test('revokes an invitation and leaves no usable action on it', async ({ page }, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  const link = await invite(page, email);
  const token = tokenOf(link);

  await page.getByRole('button', { name: `Revoke the invitation for ${email}` }).click();

  // Both actions disappear, the state is Revoked, and the reveal for the row went with the action.
  await expect(
    page.getByRole('button', { name: `Revoke the invitation for ${email}` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `Resend the invitation for ${email}` }),
  ).toHaveCount(0);
  await expect(invitationRow(page, email)).toContainText('Revoked');
  await expect(revealElement(page)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a revoke');

  // The revoke cleared the reveal, but focus was on the row's own control and never inside it, so
  // `clearReveal`'s guard has to leave focus alone rather than pull the reader up to the heading.
  // Deleting that guard makes this fail while the post-Dismiss assertion in the keyboard test still
  // passes.
  await expect(invitationsHeading(page)).not.toBeFocused();

  // And it is the server's state, not the screen's hope: a reload re-reads the list.
  await page.reload();
  await expect(invitationRow(page, email)).toContainText('Revoked');
  await expect(
    page.getByRole('button', { name: `Revoke the invitation for ${email}` }),
  ).toHaveCount(0);
});

test('refuses a second invitation to a pending address, in the server’s own words', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  await invite(page, email);

  // The partial pending-uniqueness index refuses a second pending row for the same address. The
  // screen must show the server's own sentence, including the way out it names — resend or revoke —
  // and it must not show a reveal, because no token was issued.
  const section = invitationsSection(page);
  await section.getByLabel('Email', { exact: true }).fill(email);
  // The role too: a successful create resets the draft to no role at all, so the submit control is
  // disabled again until this second attempt names one.
  await section.getByLabel('Role', { exact: true }).selectOption('viewer');
  await section.getByRole('button', { name: 'Send invitation', exact: true }).click();
  const refusal = section
    .getByRole('alert')
    .filter({ hasText: 'already has a pending invitation' });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText(/[Rr]esend/u);
  await expect(revealElement(page)).toHaveCount(0);

  await revokeThrough(page, email);
});

test('carries no token across a workspace switch', async ({ page }, testInfo) => {
  const consoleMessages = collectConsole(page);
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  const link = await invite(page, email);
  const token = tokenOf(link);

  // Switch tenants through the real control: each item submits the hidden form that posts to
  // `/api/auth/workspace`, so this is a full navigation under a freshly minted session.
  const workspace = await createWorkspace(page, workspaceIdentity(testInfo));
  await workspaceSwitcher(page).click();
  await page.getByRole('menuitem', { name: workspace.name }).click();
  await expect(workspaceSwitcher(page)).toContainText(workspace.name);

  await page.goto('/admin/users');
  await expect(invitationsHeading(page)).toBeVisible();
  await expect(revealElement(page)).toHaveCount(0);
  // The new tenant's list, not the previous one's: no invitation has been sent from it.
  await expect(invitationRow(page, email)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a workspace switch');

  // And Back into the previous tenant's entry does not repaint the reveal either.
  await page.goBack();
  await expect(revealElement(page)).toHaveCount(0);
  await expectNoTokenAnywhere(page, token, consoleMessages, 'a switch and Back');
});

test('drives create, copy, resend and revoke from the keyboard alone', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  // The form: Tab from the address field reaches the role select and then the submit control, and
  // Enter in the field submits the form rather than navigating. Scoped and exact for
  // `invitationsSection`'s reason — a bare `Role` also names every member row's select.
  const section = invitationsSection(page);
  const roleSelect = section.getByLabel('Role', { exact: true });
  await section.getByLabel('Email', { exact: true }).focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(roleSelect).toBeFocused();

  // The role has to be chosen, and choosing it is what puts the submit control into the tab order:
  // the form opens on a disabled placeholder, so until a role is picked the button is `disabled` and
  // Tab skips it. `selectOption` rather than arrow keys because a native select's key handling is
  // the platform's, not this application's; it leaves focus on the control, so the Tab chain either
  // side of it is still what this test is about.
  await roleSelect.selectOption('viewer');
  await expect(roleSelect).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(section.getByRole('button', { name: 'Send invitation', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');

  // The reveal appears and takes focus, because the link is shown once and a keyboard user must not
  // have to hunt for it.
  await expect(revealElement(page)).toBeVisible();

  // The invitation carries the role that was chosen. This is the assertion that fails if the form
  // ever opens on a pre-selected role again: `invitableRoles` is ordered most privileged first, so
  // the previous default made an untouched form grant `owner`.
  await expect(invitationRow(page, email)).toContainText('Viewer');
  const created = (await listInvitations(page)).find((row) => row.email === email.toLowerCase());
  expect(
    created?.role,
    'the created invitation carries the chosen role, not the first offered',
  ).toBe('viewer');

  const copy = page.getByRole('button', { name: `Copy the invitation link for ${email}` });
  await expect(copy).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(revealElement(page)).toContainText('Link copied');

  // Dismiss is the next control in the cycle.
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: `Dismiss the invitation link for ${email}` }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(revealElement(page)).toHaveCount(0);

  // Dismiss unmounts the control that was pressed, so focus has to be put somewhere deliberate: on
  // the section heading, which outlives the reveal. Left alone it would fall to `<body>` and the
  // next Tab would restart from the top of the page.
  await expect(invitationsHeading(page)).toBeFocused();

  // The row's own controls operate by keyboard too.
  const resend = page.getByRole('button', { name: `Resend the invitation for ${email}` });
  await resend.focus();
  await page.keyboard.press('Enter');
  await expect(revealElement(page)).toBeVisible();

  const revoke = page.getByRole('button', { name: `Revoke the invitation for ${email}` });
  await revoke.focus();
  await page.keyboard.press('Enter');
  await expect(revoke).toHaveCount(0);
  await expect(invitationRow(page, email)).toContainText('Revoked');
});

test('refuses a direct cross-tenant resend and revoke with the browser’s own session', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');

  // An invitation in the workspace the session was minted for…
  await invite(page, email);
  const mine = (await listInvitations(page)).find((row) => row.email === email.toLowerCase());
  expect(mine, 'the invitation just created is in this workspace’s list').toBeTruthy();

  // …and a second workspace this same identity owns, which is the only tenant boundary a
  // single-credential build can cross.
  const workspace = await createWorkspace(page, workspaceIdentity(testInfo));
  await workspaceSwitcher(page).click();
  await page.getByRole('menuitem', { name: workspace.name }).click();
  await expect(workspaceSwitcher(page)).toContainText(workspace.name);
  await page.goto('/admin/users');

  // The UI shows no control for that row here — it is not in this tenant's list at all — and the
  // routes refuse it anyway. Both answers are compared against a random id: PR #175's concealment
  // finding requires them to be byte-identical, so a foreign id cannot be told from a nonexistent
  // one. Hiding a control is never this application's security boundary.
  const answers = await page.evaluate(async (foreignId) => {
    const call = async (method, path) => {
      const response = await fetch(path, { method, headers: { accept: 'application/json' } });
      return { status: response.status, body: await response.text() };
    };
    const absentId = '00000000-0000-4000-8000-000000000000';
    return {
      foreignRevoke: await call('DELETE', `/api/invitations/${foreignId}`),
      absentRevoke: await call('DELETE', `/api/invitations/${absentId}`),
      foreignResend: await call('POST', `/api/invitations/${foreignId}/resend`),
      absentResend: await call('POST', `/api/invitations/${absentId}/resend`),
    };
  }, mine.id);

  expect(answers.foreignRevoke.status).toBe(404);
  expect(answers.foreignResend.status).toBe(404);
  expect(answers.foreignRevoke).toEqual(answers.absentRevoke);
  expect(answers.foreignResend).toEqual(answers.absentResend);

  // And this tenant's own list is untouched by any of it: nothing has been invited from here.
  expect(await listInvitations(page)).toEqual([]);
});

test('keeps the team screen accessible with the invitations section on it', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const email = inviteeAddress(testInfo);
  await page.goto('/admin/users');
  await expectBasicAccessibility(page);

  // And again with a reveal on screen: it adds two controls and a live region, and both controls
  // have to carry a name naming their invitee.
  await invite(page, email);
  await expect(revealElement(page)).toHaveAttribute('role', 'status');
  await expectBasicAccessibility(page);

  await revokeThrough(page, email);
  await expectBasicAccessibility(page);
});
