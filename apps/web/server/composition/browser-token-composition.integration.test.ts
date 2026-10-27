/**
 * The browser-token scope gate **as `register()` actually composes it** (issue #236, SDK-04, S-1).
 *
 * ## Why this file exists, next to `browser-token-principal.integration.test.ts`
 *
 * That file proves the verifier: it stops at `installRbacApi`'s seam, which is where the hash
 * lookup, the terminal-state refusal and the minter re-read all live. Review of the first
 * implementation found the two defects that live *past* that seam, in the projections
 * `registerOpenedDatabase` writes — the run API was handed a principal with `scope` dropped, so
 * `decide()`'s grammar ran against `null` and a browser token acted with its minter's full width;
 * and the `/api/sessions/**` family, which never calls `decide()` at all, accepted one. Neither is
 * visible from a test that builds its own principal or stops before `register()`.
 *
 * So every case below goes through the real composition: `register()` against an isolated
 * PostgreSQL, then the installed closures read back through `getRunApi()` and the route functions
 * themselves. Dropping `scope` in `register.ts`'s run-API `identify`, deleting the
 * `actor.scope !== null` refusal in `session-rbac.ts` or its twin in `resolveWorkspace`, or
 * removing the `browserTokens… revokeForRun` call from `revokeAllRunTokensFor` each makes a case
 * here fail.
 *
 * The second review round added the other half: `POST /api/tokens`'s **real** `TokensRuntime`,
 * which every other mint suite substitutes a fake for. The cases at the end drive the route itself
 * with a Builder API key, so the run→session ownership rule, the malformed-id refusal and the
 * terminal-target refusal are executed against PostgreSQL rather than a `Map`.
 *
 * The fixture shape (controlled env vars, `createIsolatedTestDatabase`, `register()` in
 * `beforeAll`) is `apps/web/server/workspaces/run-gate-integration.test.ts`'s, deliberately: it is
 * the established way this repository drives the composition root against a real database.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BROWSER_TOKEN_PATTERN } from '@indx-workspace/contracts/tokens';
import type { AgentPermissions } from '@agent-workspace/run-protocol';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  apiKeys,
  browserTokens,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runs as runRows,
  sessions as sessionRows,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { GET as listSecretsRoute } from '../../app/api/secrets/route';
import { POST as mintTokenRoute } from '../../app/api/tokens/route';
import { mintApiKey } from '../rbac/api-key';
import { mintBrowserToken } from '../rbac/browser-token';
import type { RegisteredComposition } from './register';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[composition/browser-token-composition.integration.test.ts] SKIPPED — TEST_DATABASE_URL is ' +
      'not set, so the composed run-API and session-transcript principals were NOT exercised ' +
      'against a real database. A green result without it says nothing about them.',
  );
}

const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

/**
 * Env vars `register()` reads that this test must control, restored afterwards.
 * `MASTER_ENCRYPTION_KEY` is here so the secrets API is actually installed: `GET /api/secrets` is
 * the route that proves `resolveWorkspace` refuses a scoped credential, and an uninstalled seam
 * would answer `503` for a reason that has nothing to do with the gate.
 */
const CONTROLLED_ENV = [
  'DATABASE_URL',
  'MASTER_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'RUNNER_URL',
  'NEXT_RUNTIME',
] as const;
const OWNER_MEMBERSHIP_ID = 'a2c0f0de-0000-4000-8000-000000000101';
const OWNER_PRINCIPAL_ID = 'a2c0f0de-0000-4000-8000-000000000102';
/** Comfortably above insert latency; `browser_tokens` CHECKs `expires_at > created_at`. */
const LIVE_TTL_MS = 5 * 60_000;

describe.skipIf(!hasDatabase)(
  'register() composes the browser-token scope into the run and session APIs',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let composition: RegisteredComposition;
    let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;
    const workspace = { id: crypto.randomUUID(), slug: 'bt-compose', name: 'Browser Token IT' };
    const owner = { id: crypto.randomUUID(), email: 'owner@bt-compose.test', name: 'Owner' };
    /** The run the token below is scoped to, and a second run in a *different* session. */
    const scopedRunId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();
    const scopedSessionId = crypto.randomUUID();
    const otherSessionId = crypto.randomUUID();
    /**
     * A Builder API key and the rows it owns. `tokens: { write: 'own' }` is the grant the mint
     * route's ownership resolver is there for, so a Builder is the only caller that proves it:
     * an Owner's `any` would mint for every row in the workspace regardless.
     */
    const builderSessionId = crypto.randomUUID();
    const builderRunId = crypto.randomUUID();
    const builderTerminalRunId = crypto.randomUUID();
    const builderPausedRunId = crypto.randomUUID();
    const builderArchivedSessionId = crypto.randomUUID();
    let builderApiKey: string;
    let builderPrincipalId: string;

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_browser_token_composition');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values(owner);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: OWNER_MEMBERSHIP_ID,
          workspaceId: workspace.id,
          userId: owner.id,
          role: 'owner',
        });
        await tx.insert(workspacePrincipals).values({
          id: OWNER_PRINCIPAL_ID,
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId: OWNER_MEMBERSHIP_ID,
        });
      });

      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
      const created = await root.agents.forScope(scope).create({
        name: 'Browser Token Agent',
        instructions: 'irrelevant',
        modelConnectionId: null,
        model: null,
        permissions: PERMISSIONS,
        createdBy: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
      });
      if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);

      for (const [sessionId, runId] of [
        [scopedSessionId, scopedRunId],
        [otherSessionId, otherRunId],
      ] as const) {
        await isolated.db.insert(sessionRows).values({
          id: sessionId,
          workspaceId: workspace.id,
          userId: owner.id,
          ownerPrincipalId: OWNER_PRINCIPAL_ID,
          agentId: created.agent.id,
        });
        await isolated.db
          .insert(runRows)
          .values({ id: runId, workspaceId: workspace.id, sessionId });
      }

      const builderKey = await mintApiKey();
      builderApiKey = builderKey.presented;
      const builderApiKeyId = crypto.randomUUID();
      await isolated.db.insert(apiKeys).values({
        id: builderApiKeyId,
        workspaceId: workspace.id,
        name: 'Builder key',
        role: 'builder',
        keyPrefix: builderKey.keyPrefix,
        keyHash: builderKey.keyHash,
      });
      const builderPrincipal = (await isolated.db.select().from(workspacePrincipals)).find(
        (candidate) => candidate.apiKeyId === builderApiKeyId,
      );
      if (builderPrincipal === undefined) {
        throw new Error('the API-key principal trigger created no identity for the Builder key');
      }
      builderPrincipalId = builderPrincipal.id;
      for (const [sessionId, status] of [
        [builderSessionId, 'active'],
        [builderArchivedSessionId, 'archived'],
      ] as const) {
        await isolated.db.insert(sessionRows).values({
          id: sessionId,
          workspaceId: workspace.id,
          userId: owner.id,
          ownerPrincipalId: builderPrincipalId,
          agentId: created.agent.id,
          status,
        });
      }
      await isolated.db.insert(runRows).values([
        { id: builderRunId, workspaceId: workspace.id, sessionId: builderSessionId },
        // `runs_status_valid`'s companion CHECK: a terminal status and `ended_at` travel together.
        {
          id: builderTerminalRunId,
          workspaceId: workspace.id,
          sessionId: builderSessionId,
          status: 'completed',
          endedAt: new Date(),
        },
        // Paused for a decision (ADR-0145): stopped, so it carries `ended_at`, the pending call and
        // the deadline for a decision (24 hours after the pause, as the repository stamps it).
        {
          id: builderPausedRunId,
          workspaceId: workspace.id,
          sessionId: builderSessionId,
          status: 'awaiting_approval',
          startedAt: new Date(),
          endedAt: new Date(),
          pendingApproval: { toolName: 'send_email', canonicalCall: '{}' },
          approvalDeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      ]);

      previousEnv = Object.fromEntries(
        CONTROLLED_ENV.map((key) => [key, process.env[key]]),
      ) as typeof previousEnv;
      process.env['DATABASE_URL'] = isolated.url;
      process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
      process.env['SESSION_SECRET'] = 'browser-token-composition-test-secret-32-chars';
      process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
      delete process.env['NEXT_RUNTIME'];

      const { register } = await import('./register');
      const registered = await register();
      if (registered === undefined) throw new Error('composition registration was skipped');
      composition = registered;
    }, 180_000);

    afterAll(async () => {
      for (const key of CONTROLLED_ENV) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeIsolatedTestResources(isolated, composition, root);
    });

    /** A live `awt_live_…` scoped to one run, inserted straight into `browser_tokens`. */
    async function issueRunToken(runId: string): Promise<string> {
      const minted = await mintBrowserToken();
      await isolated.db.insert(browserTokens).values({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        mintedByPrincipalId: OWNER_PRINCIPAL_ID,
        scopeKind: 'run',
        runId,
        sessionId: null,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() + LIVE_TTL_MS),
      });
      return minted.presented;
    }

    function bearer(url: string, token: string): Request {
      return new Request(url, { headers: { authorization: `Bearer ${token}` } });
    }

    /** `POST /api/tokens` as the Builder API key, through the real route and the real runtime. */
    async function mintFor(scope: unknown): Promise<Response> {
      return mintTokenRoute(
        new Request('http://web/api/tokens', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${builderApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ scope }),
        }),
      );
    }

    async function problemCode(response: Response): Promise<string | undefined> {
      const body: unknown = await response.json();
      return (body as { error?: { code?: string } }).error?.code;
    }

    it('hands the run API a principal that still carries the token’s scope', async () => {
      const { getRunApi } = await import('../runs/environment');
      const runApi = getRunApi();
      expect(runApi).not.toBeNull();
      if (runApi === null) return;

      const token = await issueRunToken(scopedRunId);
      const principal = await runApi.authenticate(
        bearer(`http://web/api/runs/${scopedRunId}`, token),
      );

      // The regression: `register()`'s run-API `identify` used to project four fields and drop
      // `scope`, so this was `undefined` and every gate below it was a no-op.
      expect(principal?.scope).toEqual({ kind: 'run', id: scopedRunId });
      expect(principal?.workspaceId).toBe(workspace.id);
      expect(principal?.role).toBe('owner');
    }, 180_000);

    it('lets a run-scoped token read its own run and refuses another one with 403', async () => {
      const { readRun } = await import('../runs/api');
      const token = await issueRunToken(scopedRunId);

      const own = await readRun(bearer(`http://web/api/runs/${scopedRunId}`, token), scopedRunId);
      expect(own.status).toBe(200);

      // Same workspace, same Owner minter, a run the scope does not name: `decide()`'s grammar
      // denies it — which it can only do because the scope reached it.
      const other = await readRun(bearer(`http://web/api/runs/${otherRunId}`, token), otherRunId);
      expect(other.status).toBe(403);
      const body: unknown = await other.json();
      expect((body as { error?: { code?: string } }).error?.code).toBe('token_out_of_scope');
    }, 180_000);

    it('refuses a browser token on the session transcript route with 401', async () => {
      const { loadTranscript } = await import('../sessions/api');
      const token = await issueRunToken(scopedRunId);

      const response = await loadTranscript(
        bearer(`http://web/api/sessions/${scopedSessionId}/transcript`, token),
        scopedSessionId,
      );

      // No `/api/sessions/**` route is in any scope's §3.1 grammar and that family never calls
      // `decide()`, so the credential is refused at the seam rather than authorised by a gate
      // that would never run.
      expect(response.status).toBe(401);
    }, 180_000);

    it('stops honouring a token once the run’s credentials are explicitly revoked', async () => {
      const { getRunApi } = await import('../runs/environment');
      const runApi = getRunApi();
      expect(runApi).not.toBeNull();
      if (runApi === null) return;

      const token = await issueRunToken(otherRunId);
      const request = (): Request => bearer(`http://web/api/runs/${otherRunId}`, token);
      await expect(runApi.authenticate(request())).resolves.not.toBeNull();

      // §3.1's third revocation condition, which had no production caller before this wiring:
      // the run is NOT terminal here, so only the explicit revoke can end the token's life.
      const ownerPrincipal = {
        principalId: OWNER_PRINCIPAL_ID,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        userId: owner.id,
        workspaceId: workspace.id,
        role: 'owner' as const,
        scope: null,
      };
      expect(runApi.revokeRunTokens).toBeDefined();
      await runApi.revokeRunTokens?.(ownerPrincipal, otherRunId, null);

      const run = await runApi.store.get(otherRunId);
      expect(run?.status).not.toBe('cancelled');
      await expect(runApi.authenticate(request())).resolves.toBeNull();
    }, 180_000);

    it('refuses a browser token on secrets, which its scope grammar does not reach', async () => {
      const token = await issueRunToken(scopedRunId);

      const response = await listSecretsRoute(bearer('http://web/api/secrets', token));

      // Before issue #236 this answered `200` with the workspace's secret metadata, and only
      // `proxy.ts`'s exemption regex stood between a browser token and this route. Since issue
      // #388 the route is gated by `decide()` itself, whose scope grammar refuses every resource
      // a run-scoped token does not name; `resolveWorkspace`'s own refusal of a scoped credential
      // stays behind it as a second layer.
      expect(response.status).toBe(403);
      await expect(problemCode(response)).resolves.toBe('token_out_of_scope');
    }, 180_000);

    it('mints through the real TokensRuntime for a session the Builder owns', async () => {
      const response = await mintFor({ kind: 'session', id: builderSessionId });

      expect(response.status, await response.clone().text()).toBe(201);
      const body = (await response.json()) as { token: string; scope: unknown };
      expect(BROWSER_TOKEN_PATTERN.test(body.token)).toBe(true);
      expect(body.scope).toEqual({ kind: 'session', id: builderSessionId });

      const rows = await isolated.db.select().from(browserTokens);
      expect(
        rows.filter(
          (row) =>
            row.sessionId === builderSessionId && row.mintedByPrincipalId === builderPrincipalId,
        ),
      ).toHaveLength(1);
    }, 180_000);

    it('refuses a Builder minting for a run whose session another principal owns', async () => {
      // The rule only this seam implements: a run carries no owner of its own, so `findTarget`
      // resolves ownership through the run's *session*. `otherRunId`'s session belongs to the
      // membership principal, so the Builder's `own` grant refuses — a 403, not the 404 a run in
      // another workspace would give.
      const response = await mintFor({ kind: 'run', id: otherRunId });

      expect(response.status).toBe(403);
    }, 180_000);

    it('answers a non-UUID scope.id instead of handing it to a uuid column', async () => {
      const response = await mintFor({ kind: 'run', id: 'not-a-uuid' });

      // `runs.id` is a `uuid` column: before the contract and `ownershipOfScope`'s guard refused
      // this shape, PostgreSQL raised `22P02` and the caller saw a 500.
      expect(response.status).toBe(400);
      await expect(problemCode(response)).resolves.toBe('invalid_field');
    }, 180_000);

    it('refuses minting for an already-terminal run, a paused run or an archived session', async () => {
      // The verifier rejects both on the token's very first use, and the plaintext is shown once —
      // so a 201 here would hand out a credential that can never work and never be minted again.
      const terminalRun = await mintFor({ kind: 'run', id: builderTerminalRunId });
      expect(terminalRun.status).toBe(404);
      await expect(problemCode(terminalRun)).resolves.toBe('run_not_found');

      // ADR-0145 D1: no token stays valid while a person decides, so none is minted for a paused run.
      const pausedRun = await mintFor({ kind: 'run', id: builderPausedRunId });
      expect(pausedRun.status).toBe(404);
      await expect(problemCode(pausedRun)).resolves.toBe('run_not_found');

      const archivedSession = await mintFor({ kind: 'session', id: builderArchivedSessionId });
      expect(archivedSession.status).toBe(404);
      await expect(problemCode(archivedSession)).resolves.toBe('session_not_found');
    }, 180_000);

    it('round-trips a minted plaintext: readRun accepts it for the run it names', async () => {
      const { readRun } = await import('../runs/api');
      const minted = await mintFor({ kind: 'run', id: builderRunId });
      expect(minted.status, await minted.clone().text()).toBe(201);
      const { token } = (await minted.json()) as { token: string };

      const own = await readRun(bearer(`http://web/api/runs/${builderRunId}`, token), builderRunId);
      expect(own.status).toBe(200);

      // The same plaintext, one row outside its scope: the grammar `decide()` applies is the same
      // one a hand-inserted token meets above, reached here from a credential the route minted.
      const other = await readRun(bearer(`http://web/api/runs/${otherRunId}`, token), otherRunId);
      expect(other.status).toBe(403);
    }, 180_000);
  },
);
