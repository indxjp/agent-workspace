/* global Buffer, URL, fetch, process */

/**
 * Helpers for `projects-archive.spec.mjs`: project set-up, the composer's project picker, and the
 * attachment journey's API seams. Kept apart so the spec reads as the journeys it asserts.
 */
import { expect } from '@playwright/test';
import pg from 'pg';

/** Unique per run and per Playwright project, so parallel workers never race over one row. */
export function projectName(testInfo) {
  return `W9-184 ${testInfo.project.name} ${String(Date.now())}-${String(
    Math.floor(Math.random() * 10000),
  )}`;
}

/** Create a project through the UI and answer with its id, read from the row's own link. */
export async function createProject(page, name) {
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
export async function composerProjectOptions(page) {
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
      spendCeilingUsd: null,
      error: null,
      output: null,
      pendingApproval: null,
      accountingState: 'pending',
      accountingError: null,
      parentRunId: null,
    },
    events: `/api/runs/attach-journey-${sessionId}/events`,
  };
}

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

/** Same-origin JSON call from the page, so it carries the session cookie and the `Origin`. */
export function jsonCaller(page) {
  return (method, path, body) =>
    page.evaluate(
      async ({ method, path, body, headers }) => {
        const response = await fetch(path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      },
      { method, path, body, headers: JSON_HEADERS },
    );
}

/** The body that pushes an agent version carrying one surface that offers the `attachments` part. */
function attachmentAgentPush(name, surfaceName) {
  return {
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
  };
}

/** File a project session under a surface, as a bootstrap would (the one row a visitor has). */
async function fileSessionUnderSurface(sessionId, surfaceName) {
  const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO surface_session_keys (session_id, workspace_id, surface_name, agent_id, key_hash)
       SELECT id, workspace_id, $2, agent_id, 'browser-test' FROM sessions WHERE id = $1`,
      [sessionId, surfaceName],
    );
  } finally {
    await client.end();
  }
}

/**
 * An agent with an attachments surface, a session of it in the project, and a session-scoped token.
 * The attachment route admits only such a token, whose session belongs to a surface that offers the
 * `attachments` part.
 */
export async function seedAttachmentSession(call, { name, projectId, projectKind }) {
  const surfaceName = `attach-${projectKind}-${String(Date.now())}`.replace(/[^a-z0-9-]+/gu, '-');
  const agent = await call('POST', '/api/agents', attachmentAgentPush(name, surfaceName));
  expect(agent.status, JSON.stringify(agent.body)).toBeLessThan(300);
  const session = await call('POST', `/api/projects/${projectId}/sessions`, {
    agentId: agent.body.agent.id,
  });
  expect(session.status, JSON.stringify(session.body)).toBe(201);

  // A project session is no surface visitor, so file it under the surface and mint its token.
  await fileSessionUnderSurface(session.body.id, surfaceName);
  const minted = await call('POST', '/api/tokens', {
    scope: { kind: 'session', id: session.body.id },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return { agent: agent.body.agent, sessionId: session.body.id, token: minted.body.token };
}

/** Upload `scan.txt` with the session token (no cookie is needed: the bearer decides). */
export function uploadWithToken(page, { sessionId, token }) {
  return page.evaluate(
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
    { engineSessionId: sessionId, token },
  );
}

/** Upload with the console cookie and no token, as the composer's Attach file control does. */
export function uploadWithConsoleCookie(page, { sessionId, name }) {
  return page.evaluate(
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
    { engineSessionId: sessionId, name },
  );
}

/** Answer only a session-less run start with `startedRunBody`; the follow-up reaches the real route. */
export async function answerFirstRunStart(page, { agent, sessionId }) {
  await page.route('**/api/agents/*/runs', (route) =>
    route.request().method() === 'POST' && route.request().postDataJSON().sessionId === null
      ? route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(startedRunBody(agent, sessionId)),
        })
      : route.fallback(),
  );
}

/** Pick a file through the composer's Attach file control. */
export async function attachFileThroughComposer(page, name) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('hello') });
}

/** The answer a refused or unknown file id gets, byte for byte. */
export const FILE_NOT_FOUND_ANSWER = {
  error: { code: 'file_not_found', message: 'No file has that id.' },
};
