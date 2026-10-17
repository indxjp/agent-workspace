import crypto from 'node:crypto';

import {
  agents,
  browserTokens,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runs,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import { afterEach, describe, expect, it } from 'vitest';

import { mintBrowserToken } from '../server/rbac/browser-token';
import { decide } from '../server/rbac/decide';
import { installRbacApi } from '../server/composition/session-rbac';
import { requireSessionScopeMatch } from '../server/runs/api';
import type { Principal } from '../server/runs/environment';
import { mayOpenSession } from '../server/surfaces/public/conditions';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const vectors = loadVectors('authz-run-token', 'browser.json');
const visitorVectors = loadVectors('authz-run-token', 'visitor.json');
const openVectors = loadVectors('authz-run-token', 'open.json');
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const SESSION_SECRET = 'formal-browser-token-session-secret-at-least-thirty-two-bytes';

describe.skipIf(!hasDatabase)(
  'authz-run-token: browser token resolution against PostgreSQL',
  () => {
    let isolated: IsolatedTestDatabase | undefined;
    let root: DatabaseRoot | undefined;

    afterEach(async () => {
      await root?.close();
      if (isolated !== undefined) await closeIsolatedTestResources(isolated);
      isolated = undefined;
      root = undefined;
    });

    it.each(vectors)(
      '$id',
      async ({ id, input, expected }) => {
        const args = asRecord(input, id);
        const answer = asRecord(expected, id);
        const scopeKind = asString(args['scope'], 'scope');
        const db = await createIsolatedTestDatabase('aw_formal_run_token');
        isolated = db;
        const workspaceId = crypto.randomUUID();
        const userId = crypto.randomUUID();
        const membershipId = crypto.randomUUID();
        const agentId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const runId = crypto.randomUUID();

        await db.db
          .insert(workspaces)
          .values({ id: workspaceId, slug: workspaceId, name: 'Formal' });
        await db.db
          .insert(users)
          .values({ id: userId, email: `${userId}@example.com`, name: 'Minter' });
        const principalId = await db.db.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({ id: membershipId, workspaceId, userId, role: 'admin' });
          const inserted = await tx
            .insert(workspacePrincipals)
            .values({
              workspaceId,
              kind: 'membership',
              membershipId,
            })
            .returning({ id: workspacePrincipals.id });
          const row = inserted[0];
          if (row === undefined) throw new Error('principal fixture did not insert');
          return row.id;
        });
        await db.db.insert(agents).values({
          id: agentId,
          workspaceId,
          name: 'Fixture',
          instructions: '',
          ownerPrincipalId: principalId,
          createdBy: userId,
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        });
        await db.db.insert(sessions).values({
          id: sessionId,
          workspaceId,
          userId,
          ownerPrincipalId: principalId,
          agentId,
        });
        await db.db.insert(runs).values({ id: runId, workspaceId, sessionId });

        const minted = await mintBrowserToken();
        await db.db.insert(browserTokens).values({
          id: crypto.randomUUID(),
          workspaceId,
          mintedByPrincipalId: principalId,
          scopeKind: scopeKind === 'run' ? 'run' : 'session',
          runId: scopeKind === 'run' ? runId : null,
          sessionId: scopeKind === 'session' ? sessionId : null,
          tokenHash: minted.tokenHash,
          expiresAt: new Date(Date.now() + 5 * 60_000),
        });
        const opened = await openDatabaseRoot({ DATABASE_URL: db.url });
        root = opened;
        const installed = await installRbacApi(opened, SESSION_SECRET);
        const request = new Request(`https://example.invalid/api/runs/${runId}`, {
          headers: { authorization: `Bearer ${minted.presented}` },
        });
        if (args['runTerminal'] === true) {
          const scope = await opened.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error('workspace scope missing');
          await opened.runs.forScope(scope).finish(runId, 'cancelled', null);
        }
        if (args['sessionArchived'] === true) {
          const scope = await opened.scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error('workspace scope missing');
          await opened.sessions.forScope(scope).archive(sessionId);
        }
        const principal = await installed.identify(request);
        expect(principal !== null).toBe(answer['current']);
        if (principal !== null) {
          expect(principal.scope).toEqual({
            kind: scopeKind,
            id: scopeKind === 'run' ? runId : sessionId,
          });
          expect(principal.principalId).toBe(principalId);
        }
        if (id === 'terminal-run') {
          expect(answer['readTarget']).toBe(true);
          expect(principal).toBeNull();
        }
      },
      180_000,
    );
  },
);

/** The session-scope half a run route applies after the row (or the turn's body) is in hand. */
function sessionScopeOutcome(
  principal: Principal,
  target: string | null,
): { decision: string; status: number | null } {
  const refused = requireSessionScopeMatch(principal, target);
  return refused === null
    ? { decision: 'proceed', status: null }
    : { decision: 'token_out_of_scope', status: refused.status };
}

/**
 * Issue #622: a visitor's session-scoped token (`visitor_token_reaches_only_its_session`). The two
 * halves the model composes run for real: `decide()`'s scope grammar, then
 * `requireSessionScopeMatch` with the session the row or the turn's body names. `proceed` is the
 * model's "neither half objects"; what §21's table decides next is not this replay's question.
 */
describe('authz-run-token: a visitor token against decide() and requireSessionScopeMatch', () => {
  it.each(visitorVectors)('$id', ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const answer = asRecord(expected, id);
    const scope = { kind: 'session' as const, id: asString(args['scopeSessionId'], 'scope') };
    const target = args['sessionId'] === null ? null : asString(args['sessionId'], 'sessionId');
    const principal: Principal = {
      principalId: 'visitor',
      ownerPrincipalId: 'visitor',
      userId: null,
      workspaceId: 'workspace',
      scope,
    };
    const decision = decide({
      role: 'owner',
      method: asString(args['method'], 'method'),
      path: asString(args['path'], 'path'),
      ownership: 'own',
      scope,
    });
    const outcome =
      decision.effect === 'deny' && decision.code === 'token_out_of_scope'
        ? { decision: 'token_out_of_scope', status: 403 }
        : sessionScopeOutcome(principal, target);
    expect(outcome).toEqual({ decision: answer['decision'], status: answer['status'] });
  });
});

/**
 * Issue #622: `mayOpenSession` (`cross_origin_visitor_opens_only_from_an_allowed_origin`,
 * `missing_origin_never_opens_a_session`). The model's `loopback` is ADR-0105's flag, listener and
 * request host all holding; its `sameOrigin` is a request whose `Origin` is this origin's own.
 */
describe('authz-run-token: opening a visitor session against mayOpenSession', () => {
  it.each(openVectors)('$id', ({ id, input, expected }) => {
    const args = asRecord(input, id);
    const answer = asRecord(expected, id);
    const loopback = args['loopback'] === true;
    const sameOrigin = args['sameOrigin'] === true;
    const host = loopback ? '127.0.0.1:3000' : 'surface.example';
    const origin = sameOrigin
      ? `http://${host}`
      : args['origin'] === null
        ? null
        : asString(args['origin'], 'origin');
    const headers = new Headers({
      host,
      'sec-fetch-site': sameOrigin ? 'same-origin' : 'cross-site',
      ...(origin === null ? {} : { origin }),
    });
    const listed = Array.isArray(args['allowedOrigins'])
      ? args['allowedOrigins'].map((value) => asString(value, 'allowedOrigins'))
      : [];
    const surface: SurfaceDefinition = {
      name: 'main',
      agent: 'support',
      ...(listed.length === 0 ? {} : { allowedOrigins: listed }),
    };
    const env = loopback ? { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } : {};
    const mode = asString(args['mode'], 'mode') === 'page' ? 'page' : 'session';
    const verdict = mayOpenSession(surface, headers, env, mode);
    expect(
      verdict.ok
        ? { verdict: verdict.branch, corsOrigin: verdict.corsOrigin }
        : { verdict: 'refused', corsOrigin: null },
    ).toEqual({ verdict: answer['verdict'], corsOrigin: answer['corsOrigin'] });
  });
});
