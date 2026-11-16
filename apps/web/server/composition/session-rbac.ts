import * as tokenActors from './session-token-actors';
import { log } from '../telemetry/logger';
import { verifyActiveRunToken } from '../gateway/run-token-verifier';
import { mayAccessSession } from '../rbac/core/owner-principal';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import { verifySessionToken } from '../auth/session';
import type { CliAuthRuntime } from '../cli-auth/runtime';
import type { InvitationsRuntime } from '../invitations/runtime';
import { isCliTokenRoutePath } from '../cli-auth/token-routes';
import type { SessionApiEnvironment, SessionApiPrincipal } from '../sessions/environment';
import type { SessionRetentionResult } from '../sessions/retention';
import type { StorageService } from '../storage/service';
import type { WorkspacesRuntime } from '../workspaces/runtime';
import { configuredPath } from './config';
import { isAgentEndpointRoute } from '../auth/agent-endpoint-routes';
import { isAppBackendRoute } from '../auth/app-backend-routes';
import { readBearerOAuthAccessAttempt } from '../oauth/tokens';
import { sessionCookieValue } from './identity';
import type { Principal } from '../rbac/principal';
import type { RbacRuntime } from '../rbac/runtime';

export type PrincipalResolution =
  | { readonly kind: 'workspace'; readonly principal: Principal }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

export interface InstalledRbacApi {
  identify(request: Request): Promise<Principal | null>;
  resolveActor(request: Request): Promise<PrincipalResolution>;
  /** Identity and directory, for the root to install as `ApplicationContext.rbac`. */
  readonly rbac: RbacRuntime;
  /** `/api/auth/cli-*`, for the root to install as `ApplicationContext.cliAuth`. */
  readonly cliAuth: CliAuthRuntime;
  /** `/api/invitations`, for the root to install as `ApplicationContext.invitations`. */
  readonly invitations: InvitationsRuntime;
  /** `/api/workspaces/**`, for the root to install as `ApplicationContext.workspaces`. */
  readonly workspaces: WorkspacesRuntime;
}

/**
 * Build the session API's environment — authenticator, transcript and state stores, session rows
 * and the retention driver — for the composition root to install as `ApplicationContext.sessions`.
 */

function createSessionAuthenticator(
  authenticateUser: (request: Request) => Promise<Principal | null>,
  database: DatabaseRoot,
): SessionApiEnvironment['authenticate'] {
  const tokenSecret = configuredPath('GATEWAY_TOKEN_SECRET');
  const tokens = tokenSecret === null ? null : createRunTokenCodec({ secret: tokenSecret });
  const authenticateSessionRequest = async (
    request: Request,
  ): Promise<SessionApiPrincipal | null> => {
    if (tokens !== null) {
      const active = await verifyActiveRunToken(
        request.headers.get('authorization'),
        tokens,
        database,
      );
      if (active !== null) {
        return {
          kind: 'runner',
          workspaceId: active.claims.workspaceId,
          runId: active.claims.runId,
          sessionId: active.claims.sessionId,
        };
      }
    }
    const actor = await authenticateUser(request);
    // Issue #236 (SDK-04, S-1): no `/api/sessions/**` route is inside any scope's §3.1 grammar,
    // and this family's only gate is `canAccessSession` below — it never calls `decide()`, so the
    // scope grammar that would deny these paths is never consulted. `SessionApiPrincipal` has no
    // field to carry an attenuation either, so projecting a browser-token actor into one would
    // hand it the minter's full role over every transcript in the workspace. Fail closed: a
    // scoped credential is not a session credential. (Admitting a session-scoped token here would
    // take `SessionApiPrincipal` carrying the scope and `canAccessSession` comparing it — a widening
    // of §3.1's grammar, and a separate change.)
    //
    // Issue #242 (SDK-10, S-22) review round 1: the same holds for the token `aw login` holds. The
    // proxy passes any bearer on `/api/sessions/**` (for the runner's run token above), so without
    // this a CLI token would list sessions and read or write transcripts and state with the
    // person's full role. ADR-0083 admits it only on the person-facing routes; `resolveActor`
    // already refuses it off those paths, and this names the rule where the family is gated.
    if (actor === null || actor.scope !== null || actor.via === 'user-token') return null;
    return {
      kind: 'user',
      principalId: actor.principalId,
      ownerPrincipalId: actor.ownerPrincipalId,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      role: actor.role,
    };
  };

  return authenticateSessionRequest;
}
async function installTranscriptRetention(
  database: DatabaseRoot,
  stores: Pick<
    Parameters<typeof import('../sessions/retention').runSessionRetentionPass>[0],
    'store' | 'stateStore'
  >,
  stopOnClose: (stop: () => void) => void,
): Promise<SessionApiEnvironment['retention']> {
  const { store: transcriptStore, stateStore } = stores;
  const { readSessionRetentionPolicy, runSessionRetentionPass, startSessionRetentionScheduler } =
    await import('../sessions/retention');
  const { purgeSessionAttachments } = await import('../surfaces/public/attachments');
  const retentionPolicy = readSessionRetentionPolicy(process.env);
  const retention = {
    listWorkspaceIds: () => database.listWorkspaceIds(),
    store: transcriptStore,
    // ENG-06: the same policy covers the engine-scoped store, where every new conversation lives.
    stateStore,
    // ADR-0146 D6: a purged session's visitor uploads go with it.
    attachments: { purgeSessions: purgeSessionAttachments },
    lease: {
      tryAcquire: (name: string, ttlMs: number) => database.tryAcquireMaintenanceLease(name, ttlMs),
    },
    policy: retentionPolicy,
    onResult: (workspaceId: string, result: SessionRetentionResult) => {
      if (result.kind !== 'purged') return;
      log.info(
        `[compose] session retention purged workspace ${workspaceId}: ${String(result.transcripts)} legacy transcripts, ${String(result.stateEntries)} state entries, ${String(result.stateBlobs)} state blobs, ${String(result.attachments)} attachments`,
      );
    },
  };
  // The Vercel target (ADR-0120 clause 7): a function instance outlives no timer, so Vercel Cron
  // calls `GET /api/cron/retention` instead of an in-process interval.
  const { wireSessionRetention } = await import('../sessions/retention-cron');
  const driver = wireSessionRetention({
    env: process.env,
    runPass: () => runSessionRetentionPass(retention),
    startScheduler: () => {
      const scheduler = startSessionRetentionScheduler({
        ...retention,
        intervalMs: 24 * 60 * 60 * 1_000,
        onError: (error) => log.error('[compose] session retention failed', { error }),
      });
      stopOnClose(() => scheduler.stop());
    },
  });
  log.info(
    `[compose] session retention ${driver.kind === 'cron' ? 'runs from the cron route' : 'scheduled'}: ${String(retentionPolicy.transcriptDays)} days, ${retentionPolicy.dryRun ? 'dry run' : 'purge enabled'}`,
  );

  return driver;
}
export async function installSessionTranscripts(
  authenticateUser: (request: Request) => Promise<Principal | null>,
  database: DatabaseRoot,
  stopOnClose: (stop: () => void) => void,
  storage?: StorageService,
): Promise<SessionApiEnvironment> {
  const authenticateSessionRequest = createSessionAuthenticator(authenticateUser, database);
  const {
    DatabaseSessionStateStore,
    DatabaseTranscriptStore,
    createRepositorySessionsStoreProvider,
  } = await import('../sessions/store');
  const transcriptStore = new DatabaseTranscriptStore(database.sessionTranscripts, database.scopes);
  // ENG-06 (#305): the engine-scoped store, installed beside the Claude-shaped one rather than
  // instead of it. Migration 0027 copied every existing transcript across and left the old tables
  // in place, so both halves serve until the contract step of the expand/contract lands (ADR-0071).
  const stateStore = new DatabaseSessionStateStore({
    repositories: database.sessionState,
    scopes: database.scopes,
    ...(storage === undefined ? {} : { storage }),
  });
  const environment: Omit<SessionApiEnvironment, 'retention'> = {
    authenticate: authenticateSessionRequest,
    canAccessSession: async (principal, sessionId) => {
      if (principal.kind === 'runner') return principal.sessionId === sessionId;
      const scope = await database.scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return false;
      const repository = database.sessions.forScope(scope);
      const session =
        (await repository.get(sessionId)) ?? (await repository.getByEngineSessionId(sessionId));
      return session !== null && mayAccessSession(principal, session);
    },
    runFileGrants: async (workspaceId, runId) => {
      const scope = await database.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return [];
      return (await database.runs.forScope(scope).get(runId))?.fileGrants ?? [];
    },
    store: transcriptStore,
    stateStore,
    sessions: createRepositorySessionsStoreProvider({
      repositories: database.sessions,
      scopes: database.scopes,
    }),
  };
  const driver = await installTranscriptRetention(
    database,
    { store: transcriptStore, stateStore },
    stopOnClose,
  );
  log.info(
    '[compose] session API wired: owner/admin RBAC and per-run signed mirror claims → PostgreSQL',
  );
  return { ...environment, retention: driver };
}

async function installInvitationsApi(root: DatabaseRoot): Promise<InvitationsRuntime> {
  const { createManualLinkInvitationSender } = await import('../invitations/send-invitation');
  return {
    recordAuditEvent: (event) => root.recordAuditEvent(event),
    sendInvitation: createManualLinkInvitationSender(),
  };
}

export interface RbacActorDependencies {
  readonly root: DatabaseRoot;
  readonly sessionSecret: string;
  readonly directory: ReturnType<
    typeof import('../rbac/postgres-directory').createPostgresDirectory
  >;
  readonly keyModule: typeof import('../rbac/api-key');
  readonly principalModule: typeof import('../rbac/principal');
  readonly browserTokenModule: typeof import('../rbac/browser-token');
  readonly cliTokenModule: typeof import('../rbac/cli-token');
}
async function resolveBrowserTokenActor(
  token: import('../rbac/browser-token').PresentedBrowserToken,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  return tokenActors.resolveBrowserTokenActor(token, context);
}

async function resolveCliTokenActor(
  token: import('../rbac/cli-token').PresentedCliToken,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  return tokenActors.resolveCliTokenActor(token, context);
}

async function resolveOAuthActor(
  secret: string,
  route: 'agent-endpoint' | 'app-backend',
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  return tokenActors.resolveOAuthActor(secret, route, context);
}

async function resolveSessionActor(
  request: Request,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  const { root, sessionSecret, principalModule } = context;
  const verified = await verifySessionToken(
    sessionCookieValue(request.headers.get('cookie')),
    sessionSecret,
  );
  if (!verified.ok) return { kind: 'unauthenticated', reason: verified.code };
  const member = await root.resolveMembership(verified.claims.sub, verified.claims.ws);
  if (member === null) {
    return {
      kind: 'forbidden',
      reason: 'The verified account is not a member of the session workspace.',
    };
  }
  const built = principalModule.Principal.fromSession(
    verified.claims,
    { id: member.workspaceId, slug: verified.claims.ws },
    member.role,
    {
      principalId: member.principalId,
      userId: member.userId,
      label: member.userLabel,
    },
  );
  return built.ok
    ? { kind: 'workspace', principal: built.principal }
    : { kind: 'forbidden', reason: built.because };
}
async function resolveActor(
  request: Request,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  const { directory, keyModule, principalModule, browserTokenModule, cliTokenModule } = context;

  const authorization = request.headers.get('authorization');
  // Tried before the other bearers for the same reason as the browser token below. Admitted only
  // on an agent-endpoint route, and on an app-backend route for an app-backend client's token
  // (ADR-0161 D9): the `a2a-agent` scope grammar also allows `POST /api/agents/:id/runs`, which an
  // endpoint's token must not reach.
  const oauthAttempt = readBearerOAuthAccessAttempt(authorization);
  if (oauthAttempt.kind === 'invalid') {
    return { kind: 'unauthenticated', reason: 'The bearer credential is invalid.' };
  }
  if (oauthAttempt.kind === 'presented') {
    const { pathname } = new URL(request.url);
    if (isAgentEndpointRoute(request.method, pathname)) {
      return resolveOAuthActor(oauthAttempt.secret, 'agent-endpoint', context);
    }
    if (isAppBackendRoute(request.method, pathname)) {
      return resolveOAuthActor(oauthAttempt.secret, 'app-backend', context);
    }
    return {
      kind: 'unauthenticated',
      reason: 'An OAuth access token is not accepted on this route.',
    };
  }
  // Tried first: `readBearerApiKeyAttempt` below classifies ANY well-formed "Bearer <token>"
  // that is not `ak_live_`-shaped as `invalid` and answers 401 without ever reaching the session
  // cookie — which is exactly right for a genuinely malformed credential, but would also catch a
  // syntactically well-formed `awt_live_…` bearer before this function ever tried to verify it.
  // A header that is not shaped like a browser token at all comes back `absent` here (never
  // `invalid` in a way that blocks the fall-through below), so this changes nothing for an API
  // key, a session cookie, or genuine garbage.
  const browserAttempt = browserTokenModule.readBearerBrowserTokenAttempt(authorization);
  if (browserAttempt.kind === 'presented') {
    return resolveBrowserTokenActor(browserAttempt.token, context);
  }
  const cliAttempt = cliTokenModule.readBearerCliTokenAttempt(authorization);
  if (cliAttempt.kind === 'presented') {
    // ADR-0083 §4: the user token is admitted only on the person-facing routes. Refused here,
    // for every family that resolves its caller through this function, so no route outside that
    // list can act on one — whatever the proxy let through and whatever cookie rode along.
    if (!isCliTokenRoutePath(new URL(request.url).pathname)) {
      return {
        kind: 'unauthenticated',
        reason: 'The token `aw login` holds is not accepted on this route.',
      };
    }
    return resolveCliTokenActor(cliAttempt.token, context);
  }
  const attempt = keyModule.readBearerApiKeyAttempt(authorization);
  if (attempt.kind === 'invalid') {
    return { kind: 'unauthenticated', reason: 'The bearer credential is invalid.' };
  }
  if (attempt.kind === 'presented') {
    const identity = await directory.authenticateApiKey(
      keyModule.presentedKeyText(attempt.key),
      new Date(),
    );
    return identity === null
      ? { kind: 'unauthenticated', reason: 'The bearer credential is invalid.' }
      : { kind: 'workspace', principal: principalModule.Principal.fromApiKey(identity) };
  }
  return resolveSessionActor(request, context);
}
export async function installRbacApi(
  root: DatabaseRoot,
  sessionSecret: string,
): Promise<InstalledRbacApi> {
  const [adapter, keyModule, principalModule, browserTokenModule, cliTokenModule] =
    await Promise.all([
      import('../rbac/postgres-directory'),
      import('../rbac/api-key'),
      import('../rbac/principal'),
      import('../rbac/browser-token'),
      import('../rbac/cli-token'),
    ]);
  const directory = adapter.createPostgresDirectory(root.directory);
  const actorDependencies: RbacActorDependencies = {
    root,
    sessionSecret,
    directory,
    keyModule,
    principalModule,
    browserTokenModule,
    cliTokenModule,
  };
  const resolveRequestActor = (request: Request) => resolveActor(request, actorDependencies);
  const identify = async (request: Request): Promise<Principal | null> => {
    const resolution = await resolveRequestActor(request);
    return resolution.kind === 'workspace' ? resolution.principal : null;
  };
  log.info('[compose] RBAC API installed: PostgreSQL users, memberships, and hashed API keys');
  log.info('[compose] workspaces API installed: PostgreSQL workspaces and memberships');
  return {
    identify,
    resolveActor: resolveRequestActor,
    rbac: { directory, identify },
    cliAuth: { sessions: root.cliSessions, secret: sessionSecret },
    invitations: await installInvitationsApi(root),
    // Issue #119: `/api/workspaces/**` needs a repository that reaches ANY workspace by id, not the
    // `.forWorkspace(principal.workspaceId)` slice `RbacRuntime.directory` hands the routes above —
    // see `apps/web/server/workspaces/runtime.ts`'s header for why this is a domain of its own.
    workspaces: { repository: root.workspaces },
  };
}
