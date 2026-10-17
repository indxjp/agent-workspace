/**
 * `aw login` end to end **as `register()` composes it**, against real PostgreSQL — issue #242
 * (SDK-10, S-22), ADR-0083, review round 1.
 *
 * `server/cli-auth/handlers.test.ts` proves the handlers over an in-memory repository and
 * `packages/core/src/db/repositories/cli-sessions.test.ts` proves the SQL; this file proves the
 * flow the Issue names through the real route functions and the real composition: start → approve
 * from a signed-in browser session → exchange → `GET /api/workspaces` with the token → sign out →
 * `401`. It also pins the scope-leak fix: the token is refused on every route outside ADR-0083's
 * person-facing list — the `/api/sessions/**` family in particular, which the proxy opens to any
 * other bearer for the runner's run token.
 *
 * The fixture shape (controlled env vars, `createIsolatedTestDatabase`, `register()` in
 * `beforeAll`) is `browser-token-composition.integration.test.ts`'s.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
  CLI_TOKEN_PATTERN,
} from '@indx-workspace/contracts/cli-auth';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { POST as startRoute } from '../../app/api/auth/cli-device/route';
import { DELETE as signOutRoute, POST as pollRoute } from '../../app/api/auth/cli-token/route';
import { POST as approveRoute } from '../../app/api/auth/cli-verify/route';
import { GET as meRoute } from '../../app/api/me/route';
import { GET as listSecretsRoute } from '../../app/api/secrets/route';
import { GET as listWorkspacesRoute } from '../../app/api/workspaces/route';
import { sessionCookieName, mintSessionToken, newSessionClaims } from '../auth/session';
import { resetCliPollMemory } from '../cli-auth/handlers';
import type { RegisteredComposition } from './register';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[composition/cli-token-composition.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so the aw login flow was NOT exercised against a real database.',
  );
}

const CONTROLLED_ENV = [
  'DATABASE_URL',
  'MASTER_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'RUNNER_URL',
  'NEXT_RUNTIME',
  'AW_TRUSTED_PROXY_HOPS',
] as const;
const SESSION_SECRET = 'cli-token-composition-test-secret-at-least-32-chars';
const ORIGIN = 'http://web.test';
const MEMBERSHIP_ID = 'c1a00000-0000-4000-8000-000000000101';
const PRINCIPAL_ID = 'c1a00000-0000-4000-8000-000000000102';
const OWNER_MEMBERSHIP_ID = 'c1a00000-0000-4000-8000-000000000201';

describe.skipIf(!hasDatabase)('aw login, end to end through register() and the real routes', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let composition: RegisteredComposition;
  let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;
  const workspace = { id: crypto.randomUUID(), slug: 'cli-compose', name: 'CLI Compose' };
  const person = { id: crypto.randomUUID(), email: 'ada@cli-compose.test', name: 'Ada' };
  /** The workspace's Owner, so removing Ada's (admin) membership is not a last-owner refusal. */
  const owner = { id: crypto.randomUUID(), email: 'owner@cli-compose.test', name: 'Owner' };

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_cli_token_composition');
    await isolated.db.insert(workspaces).values(workspace);
    await isolated.db.insert(users).values([person, owner]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: MEMBERSHIP_ID, workspaceId: workspace.id, userId: person.id, role: 'admin' },
        { id: OWNER_MEMBERSHIP_ID, workspaceId: workspace.id, userId: owner.id, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values({
        id: PRINCIPAL_ID,
        workspaceId: workspace.id,
        kind: 'membership',
        membershipId: MEMBERSHIP_ID,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });

    previousEnv = Object.fromEntries(
      CONTROLLED_ENV.map((key) => [key, process.env[key]]),
    ) as typeof previousEnv;
    process.env['DATABASE_URL'] = isolated.url;
    process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
    process.env['SESSION_SECRET'] = SESSION_SECRET;
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    delete process.env['NEXT_RUNTIME'];
    delete process.env['AW_TRUSTED_PROXY_HOPS'];

    const { register } = await import('./register');
    const registered = await register();
    if (registered === undefined) throw new Error('composition registration was skipped');
    composition = registered;
    resetCliPollMemory();
  }, 180_000);

  afterAll(async () => {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeIsolatedTestResources(isolated, composition, root);
  });

  const json = (path: string, init: RequestInit = {}): Request =>
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  const bearer = (path: string, token: string, method = 'GET'): Request =>
    new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

  /** Start, approve in the browser, and exchange: the token `aw login` would store. */
  async function signIn(): Promise<string> {
    const started = startRoute(json('/api/auth/cli-device', { method: 'POST', body: '{}' }));
    expect(started.status).toBe(200);
    const device = DeviceAuthorizationResponseSchema.parse(await started.json());

    const pending = await pollRoute(
      json('/api/auth/cli-token', {
        method: 'POST',
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      }),
    );
    expect(pending.status).toBe(400);

    const cookie = await mintSessionToken(
      newSessionClaims(person.email, workspace.slug),
      SESSION_SECRET,
    );
    const approved = await approveRoute(
      new Request(`${ORIGIN}/api/auth/cli-verify`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          cookie: `${sessionCookieName()}=${cookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          userCode: device.userCode,
          decision: 'approve',
          confirm: 'yes',
        }).toString(),
      }),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);

    // `slow_down` is per device code: forget the first poll so this one is not refused for pace.
    resetCliPollMemory();
    const issued = await pollRoute(
      json('/api/auth/cli-token', {
        method: 'POST',
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      }),
    );
    expect(issued.status, await issued.clone().text()).toBe(200);
    const body = CliTokenResponseSchema.parse(await issued.json());
    expect(body.workspace.id).toBe(workspace.id);
    expect(CLI_TOKEN_PATTERN.test(body.token)).toBe(true);
    return body.token;
  }

  it('device → approve → token → workspaces list → logout → 401', async () => {
    const token = await signIn();

    const listed = await listWorkspacesRoute(bearer('/api/workspaces', token));
    expect(listed.status, await listed.clone().text()).toBe(200);
    const workspacesBody = (await listed.json()) as {
      readonly workspaces: readonly { readonly id: string }[];
    };
    expect(workspacesBody.workspaces.map((entry) => entry.id)).toContain(workspace.id);

    const me = await meRoute(bearer('/api/me', token));
    expect(me.status).toBe(200);

    const signedOut = await signOutRoute(bearer('/api/auth/cli-token', token, 'DELETE'));
    expect(signedOut.status).toBe(204);

    const afterSignOut = await listWorkspacesRoute(bearer('/api/workspaces', token));
    expect(afterSignOut.status).toBe(401);
  }, 180_000);

  it('refuses the token on the session list, transcript and state routes', async () => {
    const token = await signIn();
    const { listSessions, loadTranscript } = await import('../sessions/api');
    const { listSessionStateEntries } = await import('../sessions/state-api');
    const sessionId = crypto.randomUUID();

    const listed = await listSessions(bearer('/api/sessions', token));
    expect(listed.status).toBe(401);
    const transcript = await loadTranscript(
      bearer(`/api/sessions/${sessionId}/transcript`, token),
      sessionId,
    );
    expect(transcript.status).toBe(401);
    const state = await listSessionStateEntries(
      bearer(`/api/sessions/${sessionId}/state-entries`, token),
      sessionId,
    );
    expect(state.status).toBe(401);
  }, 180_000);

  it('refuses the token on a workspace route outside the person-facing list', async () => {
    const token = await signIn();
    const secrets = await listSecretsRoute(bearer('/api/secrets', token));
    expect([401, 403]).toContain(secrets.status);
  }, 180_000);

  it('ends the sign-in when the membership is removed', async () => {
    const token = await signIn();
    const removed = await root.directory.forWorkspace(workspace.id).deleteMembership(MEMBERSHIP_ID);
    expect(removed.kind).toBe('deleted');
    const listed = await listWorkspacesRoute(bearer('/api/workspaces', token));
    expect(listed.status).toBe(401);
  }, 180_000);
});
