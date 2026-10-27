/* global Buffer, URL, fetch, process */

/**
 * Project archive and restore through the real UI — issue #184.
 *
 * Everything here is a behaviour a component test cannot reach: this repository has no jsdom, so
 * effects never run in a Vitest render and no fetch, focus move or navigation is observable there.
 * The five acceptance criteria this file owns are exactly the five that need a browser —
 * **archive**, **picker exclusion**, **history visibility**, **restore**, and **keyboard
 * operation** — plus the concealed refusal, asserted against a real session cookie.
 *
 * ## What this file deliberately does not do
 *
 * #184 asks for the server-refusal regression to be driven "with the same cookie as an unauthorized
 * UI user". This build has no way to produce one: `apps/web/server/auth/session.ts` implements a
 * single credential path (the bootstrap administrator), and `POST /api/users` writes no credential,
 * so a provisioned Viewer cannot sign in. The equivalent regression is PostgreSQL-backed instead,
 * in `apps/web/app/api/projects/[id]/archive/lifecycle.test.ts` (#183), which drives every role ×
 * ownership pair through the real route handlers and compares the refusal byte for byte against the
 * answer a nonexistent id gets; `apps/web/server/projects/archive-capability.test.ts` then proves
 * the UI's show/hide answer is the same `decide()` those routes consult. What *is* asserted below
 * with a real cookie is the shape of that concealed answer.
 */
import { expect, test } from '@playwright/test';
import pg from 'pg';

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

/** Unique per run and per Playwright project, so parallel workers never race over one row. */
function projectName(testInfo) {
  return `W9-184 ${testInfo.project.name} ${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`;
}

/** Create a project through the UI and answer with its id, read from the row's own link. */
async function createProject(page, name) {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const row = page.getByRole('link', { name: new RegExp(name, 'u') });
  await expect(row).toBeVisible();
  const href = await row.getAttribute('href');
  return href.slice(href.lastIndexOf('/') + 1);
}

/**
 * What the composer offers as a destination for new work, or `[]` when it offers nothing.
 *
 * `components/composer/home-chat.tsx` drops the project `<select>` entirely when no active project
 * is left, so an absent picker **is** exclusion rather than a missing control — and that is exactly
 * the state this file creates when it archives the workspace's only project. The catalogue response
 * is what the read is synchronised on: it arrives in an effect, so a picker read taken before it
 * lands cannot tell "not fetched yet" from "nothing to offer".
 */
async function composerProjectOptions(page) {
  const catalogue = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'GET',
  );
  await page.goto('/');
  const body = await (await catalogue).json().catch(() => ({}));
  const offered = Array.isArray(body.projects) ? body.projects : [];
  const picker = page.getByLabel('Project');
  if (offered.length === 0) {
    await expect(picker).toHaveCount(0);
    return [];
  }
  // One `<option>` per project plus the "No project" entry. Waiting for the rendered count keeps
  // the read from landing between the response and React applying it.
  await expect(picker.locator('option')).toHaveCount(offered.length + 1);
  return picker.locator('option').allTextContents();
}

test('archives a project by keyboard, removes it from new-work pickers, and restores it', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  // Before: the composer offers it as a destination for new work.
  expect(await composerProjectOptions(page)).toContain(name);

  await page.goto(`/projects/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const archive = page.getByRole('button', { name: 'Archive project' });
  await expect(archive).toBeVisible();

  // Keyboard operation, and the focus contract the hand-written dialog owes: Enter opens it, Cancel
  // takes focus (the safe answer is where a stray Enter lands), Escape closes it and gives focus
  // back to the control that opened it.
  await archive.focus();
  await expect(archive).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText(/become read-only|are affected|could not be counted/u);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(archive).toBeFocused();

  // Reopen and confirm, still without the mouse.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Archive project' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');

  // After: the screen says so, and offers the inverse transition instead.
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toBeVisible();
  // An archived project's settings are read-only — `PATCH` would still succeed, so this is the UI's
  // own decision and is recorded in the task ADR.
  await expect(page.getByLabel('Name')).toBeDisabled();

  // Picker exclusion. This is the assertion that makes the *absence* of `?archived=` in
  // `components/composer/home-chat.tsx` load-bearing: adding one fails here.
  const options = await composerProjectOptions(page);
  expect(options).not.toContain(name);

  // Gone from the default project list, reachable through the explicit history filter.
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: new RegExp(name, 'u') })).toHaveCount(0);
  await page.goto('/projects?archived=archived');
  const archivedRow = page.getByRole('link', { name: new RegExp(name, 'u') });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toContainText('Archived');

  // History keeps the project's name rather than calling it deleted — the `?archived=all` catalogue
  // in `components/run/history-screen.tsx`. Asserted as "the catalogue was read and this project is
  // in it", which is what the screen resolves run attribution against.
  const catalogue = await page.evaluate(async () => {
    const response = await fetch('/api/projects?archived=all', {
      headers: { accept: 'application/json' },
    });
    return response.ok ? await response.json() : { projects: [] };
  });
  expect(catalogue.projects.map((project) => project.name)).toContain(name);

  // Restore returns it to both places.
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: 'Restore project' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore project' }).click();
  await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeEnabled();
  expect(await composerProjectOptions(page)).toContain(name);
});

test('keeps the confirmation keyboard-operable after a failed archive', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  // The `failed` branch is the one where the focus contract is load-bearing: the panel stays open,
  // so a dialog that dropped focus when the browser disabled its buttons leaves Escape and the Tab
  // cycle dead. The success path hides that, because the dialog unmounts and restores focus anyway.
  await page.route('**/api/projects/*/archive', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'service_unavailable', message: 'Archiving is unavailable.' },
      }),
    }),
  );

  await page.goto(`/projects/${id}`);
  const trigger = page.getByRole('button', { name: 'Archive project' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Archive project' }).click();

  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('conceals a refused or missing project behind one indistinguishable answer', async ({
  page,
}) => {
  await signInAsBootstrapAdmin(page, credentials);
  // Issue #183's concealment, seen from a real browser session: an id that names nothing answers
  // exactly what a refused caller is answered, and the UI never claims to tell them apart.
  const answer = await page.evaluate(async () => {
    const response = await fetch('/api/projects/11111111-1111-4111-8111-111111111111/archive', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    return { status: response.status, body: await response.json() };
  });
  expect(answer.status).toBe(404);
  expect(answer.body).toEqual({
    error: { code: 'project_not_found', message: 'Project not found.' },
  });
});

test('keeps the project screens accessible, including while the confirmation is open', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  await page.goto('/projects');
  await expectBasicAccessibility(page);
  await page.goto('/projects?archived=archived');
  await expectBasicAccessibility(page);

  await page.goto(`/projects/${id}`);
  await expectBasicAccessibility(page);

  await page.getByRole('button', { name: 'Archive project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // The dialog is named by its own heading rather than by a duplicated `aria-label`.
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  await expect(page.locator(`#${labelledBy}`)).toBeVisible();
  await expectBasicAccessibility(page);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/**
 * The `202` a run start answers, for a session that already exists. The browser environment has no
 * model, so a real start is refused before it opens anything; the attach control needs only the
 * session id the start reports, and everything it does with that id is real.
 */
function startedRunBody(agent, sessionId) {
  const now = new Date().toISOString();
  return {
    run: {
      id: `attach-journey-${sessionId}`,
      workspaceId: agent.workspaceId ?? 'workspace',
      agentId: agent.id,
      projectId: null,
      initiatingUserId: null,
      sessionId,
      agentVersion: null,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      model: null,
      provider: null,
      modelConnectionId: null,
      engine: null,
      engineVersion: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
      },
      cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
      error: null,
      output: null,
      pendingApproval: null,
      accountingState: 'pending',
      accountingError: null,
    },
    events: `/api/runs/attach-journey-${sessionId}/events`,
  };
}

// @story US-STO-11
test('[US-STO-11][browser][chat] an archived project refuses attachments', async ({
  page,
}, testInfo) => {
  await signInAsBootstrapAdmin(page, credentials);
  const name = projectName(testInfo);
  const id = await createProject(page, name);

  // Same-origin JSON call from the page, so it carries the session cookie and the `Origin`.
  const call = (method, path, body) =>
    page.evaluate(
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

  // The attachment route admits only a session-scoped token whose session belongs to a surface
  // that offers the `attachments` part, so the agent is pushed with such a surface.
  const surfaceName = `attach-${testInfo.project.name}-${String(Date.now())}`.replace(
    /[^a-z0-9-]+/gu,
    '-',
  );
  const agent = await call('POST', '/api/agents', {
    version: {
      summary: 'Attachments surface',
      via: 'api',
      body: {
        definition: {
          apiVersion: 'agentworkspace.dev/v1',
          kind: 'AgentDefinition',
          agent: {
            name,
            instructions: 'Seed',
            permissions: {
              readFiles: true,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
            model: null,
            modelConnectionName: null,
            runtimeProfileName: null,
          },
          policy: {
            engine: 'claude-agent-sdk',
            tools: {
              base: 'claude_code_preset',
              autoApprove: [],
              deny: [],
              permissionMode: 'default',
              allowDangerouslySkipPermissions: false,
            },
            skills: { mode: 'all' },
            limits: { maxTurns: null, maxBudgetUsd: null },
          },
          policySource: 'stored',
          resources: { files: [], skills: [], connectors: [] },
        },
        surfaces: [
          {
            name: surfaceName,
            agent: name,
            allowedOrigins: ['http://127.0.0.1:1'],
            parts: { attachments: true },
          },
        ],
      },
    },
  });
  expect(agent.status, JSON.stringify(agent.body)).toBeLessThan(300);
  const session = await call('POST', `/api/projects/${id}/sessions`, {
    agentId: agent.body.agent.id,
  });
  expect(session.status, JSON.stringify(session.body)).toBe(201);

  // A project session is no surface visitor: file it under the surface as a bootstrap would
  // (the one row a visitor session has), then mint the session-scoped token the route accepts.
  const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO surface_session_keys (session_id, workspace_id, surface_name, agent_id, key_hash)
       SELECT id, workspace_id, $2, agent_id, 'browser-test' FROM sessions WHERE id = $1`,
      [session.body.id, surfaceName],
    );
  } finally {
    await client.end();
  }
  const minted = await call('POST', '/api/tokens', {
    scope: { kind: 'session', id: session.body.id },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);

  // Same-origin upload with the session token (no cookie is needed: the bearer decides).
  const upload = (token) =>
    page.evaluate(
      async ({ engineSessionId, token }) => {
        const response = await fetch(`/api/sessions/${engineSessionId}/attachments?name=scan.txt`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'text/plain',
            authorization: `Bearer ${token}`,
          },
          body: 'hello',
        });
        return { status: response.status, body: await response.json() };
      },
      { engineSessionId: session.body.id, token },
    );
  const token = minted.body.token;

  // Before the archive the credential works, so the refusal below is the gate and nothing else.
  const accepted = await upload(token);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

  // The console: the composer's own Attach file control and the console cookie, no token. The run
  // start is answered for this project's session (see `startedRunBody`), so the screen holds it.
  const consoleUpload = (name) =>
    page.evaluate(
      async ({ engineSessionId, name }) => {
        const response = await fetch(
          `/api/sessions/${engineSessionId}/attachments?name=${encodeURIComponent(name)}`,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'text/plain' },
            body: 'hello',
          },
        );
        return { status: response.status, body: await response.json() };
      },
      { engineSessionId: session.body.id, name },
    );
  // Only the first start is answered here; the follow-up reaches the real route (below).
  await page.route('**/api/agents/*/runs', (route) =>
    route.request().method() === 'POST' && route.request().postDataJSON().sessionId === null
      ? route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(startedRunBody(agent.body.agent, session.body.id)),
        })
      : route.fallback(),
  );
  await page.goto('/');
  await page.getByTestId('composer-input').fill('Look at the attached file');
  await page.getByRole('button', { name: 'Send' }).click();

  const attach = page.getByRole('button', { name: 'Attach file' });
  await expect(attach).toHaveAttribute('aria-disabled', 'false');
  const attachFile = async (name) => {
    const chooser = page.waitForEvent('filechooser');
    await attach.click();
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('hello') });
  };
  const attached = page.getByRole('list', { name: 'Attached files' });

  // In an active project the file is attached and listed where the composer shows attachments.
  const saved = page.waitForResponse(
    (response) => response.url().includes('/attachments') && response.request().method() === 'POST',
  );
  await attachFile('scan.txt');
  const scan = await (await saved).json();
  await expect(attached).toContainText('scan.txt');
  expect((await consoleUpload('direct.txt')).status).toBe(201);

  // The follow-up hands the listed file to its run and clears the list. The real route rules on the
  // file before anything else can refuse the start, so any answer but `file_not_found` is the
  // console's file admitted; this environment has no model, so the run itself cannot launch.
  const followUp = page.waitForRequest(
    (request) => request.url().includes('/runs') && request.method() === 'POST',
  );
  await page.getByRole('textbox', { name: 'Ask a follow-up' }).fill('Read the file');
  await page.getByRole('button', { name: 'Send' }).click();
  const request = await followUp;
  expect(request.postDataJSON()).toMatchObject({
    sessionId: session.body.id,
    attachments: [{ fileId: scan.fileId }],
  });
  const answer = await (await request.response()).json();
  expect(answer.error?.code, JSON.stringify(answer)).not.toBe('file_not_found');
  await expect(attached).toHaveCount(0);

  const archived = await call('POST', `/api/projects/${id}/archive`);
  expect(archived.status, JSON.stringify(archived.body)).toBeLessThan(300);

  // The open screen learns of the archive on the next attempt: the server refuses, and the control
  // becomes disabled with a reason the screen reader reads, and nothing more is listed.
  await attachFile('late.txt');
  await expect(attach).toHaveAttribute('aria-disabled', 'true');
  const reason = page.getByText('This project is archived, so files can no longer be attached.');
  await expect(reason).toBeVisible();
  await expect(attach).toHaveAttribute('aria-describedby', await reason.getAttribute('id'));
  await expect(attached).toHaveCount(0);
  // The same cookie, straight at the route: the concealed answer, not a different refusal.
  const direct = await consoleUpload('late.txt');
  expect(direct.status).toBe(404);
  expect(direct.body).toEqual({
    error: { code: 'file_not_found', message: 'No file has that id.' },
  });

  // The project screen is the page that lists the session.
  await page.goto(`/projects/${id}`);
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible();

  const refused = await upload(token);
  expect(refused.status).toBe(404);
  expect(refused.body).toEqual({
    error: { code: 'file_not_found', message: 'No file has that id.' },
  });

  const restored = await call('POST', `/api/projects/${id}/restore`);
  expect(restored.status, JSON.stringify(restored.body)).toBeLessThan(300);
  const again = await upload(token);
  expect(again.status, JSON.stringify(again.body)).toBe(201);
});
