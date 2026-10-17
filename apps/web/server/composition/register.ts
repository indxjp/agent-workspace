/**
 * The composition root of the Next.js application — the module that makes §34 answer.
 *
 * ## Why this file exists
 *
 * Everything under `apps/web/server/**` was written against an interface and installed by nobody.
 * `installRunApi()` and `configureAgentsRuntime()` are the two seams the run routes and the agent
 * routes reach their world through, and before this file the only callers of either were unit
 * tests and a probe fixture that refuses to run unless `AW_ACCEPTANCE_HARNESS=1`. The consequence
 * was measured rather than assumed: every route under `/api/` answered
 * `503 run_api_not_configured` or `503 agents_runtime_not_configured` in a real deployment, and no
 * request had ever travelled from the web application to the runner. Three tasks each declared
 * that and each correctly declined to fix it, because none of them owned a file that could.
 * ADR-0017 rule 5 makes cross-cutting wiring a task of its own; this is that task's file.
 *
 * ## What a composition root is allowed to be (§53)
 *
 * A file that calls constructors. There is no container here, no registry, no service locator and
 * no bootstrapper — {@link register} reads the environment contract, decides what this deployment
 * can actually do, builds the adapters that back it, and passes them to the two installers. Every
 * `if` below is a configuration question with a named answer, and every answer that is "no" leaves
 * the corresponding seam **uninstalled**, which is what keeps the two 503s honest.
 *
 * ## The 503s stay reachable, and that is the point
 *
 * The task this file lands under says it plainly: a 503 that can no longer fire because the check
 * was deleted is the wrong fix. So nothing here is installed unconditionally. `SESSION_SECRET`
 * missing, `DATABASE_URL` unusable, `RUNNER_URL` absent — each of those leaves a real capability
 * genuinely unavailable, and a route that answered anything other than 503 would be claiming a
 * capability nobody configured (ADR-0015). What changes is that a *configured* deployment now
 * installs both, which is the half that has never been true.
 *
 * The two seams are installed independently, because they need different things. Agent CRUD needs
 * a session and a workspace; it does not need a runtime. So a deployment with no `RUNNER_URL`
 * serves `/api/agents` and answers 503 on `/api/agents/:id/runs`, which is the truth about it.
 *
 * ## What is wired, and what is honestly not
 *
 * | seam | backed by | survives a restart |
 * | --- | --- | --- |
 * | authentication | `apps/web/server/auth` — the real HMAC session cookie | n/a |
 * | workspace + user identity | PostgreSQL, through `@agent-workspace/core/db` | yes |
 * | agent persistence | `createRepositoryAgentStoreProvider()` → the `agents` table | **yes** |
 * | run records | `createRepositoryRunStore()` → the `runs` table | **yes** |
 * | run events | PostgreSQL `run_events`, ordered per run | **yes** |
 * | sessions | PostgreSQL rows plus authenticated transcript mirror | **yes** |
 * | the runtime | `POST {RUNNER_URL}/run`, spec §14.3 | n/a |
 *
 * The first four rows are what W2-DB-02 changed, and the reason it existed: before it,
 * `apps/web` contained no code that read or wrote the database, and an agent created through the
 * UI was gone on the next restart (ADR-0024).
 *
 * Run events and session transcripts are installed as durable seams. Session *state* and resume are W2-CP-07's
 * whole task; what this file persists is the session row `runs_session_workspace_fk` demands, and
 * `docs/adr/W2-DB-02-a-run-needs-a-session-row.md` draws that line. Both are declared as gaps on
 * this task's PR, and this table plus the `[compose] persistence:` line printed at start-up are
 * the honest inventory the routes' own 200s cannot give you.
 *
 * ## There is no silent fallback to memory
 *
 * A deployment whose database is unreachable installs **nothing** and answers 503 by name. It
 * does not quietly run on the in-memory stores: those are what the conformance suite holds the
 * PostgreSQL implementations to, and they are not a deployment mode, because every request here
 * is authorised by reading `workspaces`, `users` and `memberships` — a process with no database
 * can authorise nobody, so an in-memory agent store would never be reached.
 * `docs/adr/W2-DB-02-no-silent-memory-fallback.md`.
 */
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import type { DatabaseRoot, SessionRecord, WorkspaceScope } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import type { RuntimeRunSpec } from '@agent-workspace/runtime';

import { configureAgentVersionsRuntime } from '../agent-versions/runtime';
import {
  createRunAgentReader,
  engineOfVersion,
  versionToPin,
} from '../agent-versions/session-version';
import { createRepositoryAgentVersionStoreProvider } from '../agent-versions/store';
import { after } from 'next/server';
import { createRepositoryAgentStoreProvider } from '../agents/store';
import { createRepositoryAgentResourceStoreProvider } from '../agents/resource-store';
import { createRepositoryAgentGrantStoreProvider } from '../agents/agent-grants-store';
import { configureAgentsRuntime, type WorkspaceResolution } from '../agents/runtime';
import { configureAuditRuntime } from '../audit/runtime';
import { readDeploymentWorkspaceSlug, readSessionSecret } from '../auth/session';
import { buildRunRequestFor, readRuntimeSettings, runNetworkGrant } from '../compose/run-request';
import {
  codeLaunchedRunFailure,
  createRunPreflight,
  modelResolutionRefusal,
  runStartRefusalError,
  type LaunchedModel,
} from '../compose/run-preflight';
import {
  createRuntimeRunResolver,
  localRuntimeRunSpecRejection,
  runtimeSettingsFor,
  type RuntimeLaunchTarget,
} from '../compose/runtime-profile';
import { createAgentRunResourceLoader } from '../compose/resource-loader';
import { buildToolSandboxRequest } from '../compose/tool-sandbox';
import { readToolBundle } from '../tool-bundles/handlers';
import { openToolBundleStore } from '../tool-bundles/http';
import {
  createRuntimeManagerClient,
  probeRuntimeManager,
  type RuntimeManagerClient,
} from '../compose/runtime-manager-client';
import { createProviderCredentialResolver } from '../compose/runtime-provider-credential';
import { createRuntimeWorkspaceLifecycle } from '../compose/workspace-lifecycle';
import { currentConnectorsRuntime } from '../connectors/runtime';
import { createModelJudge } from '../evaluations/handlers';
import { currentFilesRuntime } from '../files/runtime';
import { readDeploymentDefaultModels } from '../models/deployment-default';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import {
  createRunTokenIssuer,
  createUnavailableRunTokenIssuer,
  readGatewayIssuerSettings,
} from '../gateway/issuer';
import { createProjectRunGate, guardProjectSessionCreation } from '../projects/archive-gate';
import { configureProjectsRuntime } from '../projects/runtime';
import { configureSharesRuntime } from '../shares/core/runtime';
import {
  createRunGate,
  guardSessionCreation,
  isWorkspaceUsableForRuns,
} from '../workspaces/run-gate';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import { currentSkillsRuntime } from '../skills/runtime';
import { installA2a } from '../a2a/env';
import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { installToolEndpoint } from '../tool-endpoint/env';
import { createToolEndpointSources } from '../tool-endpoint/sources';
import {
  getRunApi,
  installRunApi,
  type AgentRef,
  type LaunchContext,
  type ModelSelection,
  type Principal,
  type RunApiEnvironment,
  type SessionRef,
} from '../runs/environment';
import { signalLiveRun } from '../runs/interrupt';
import { atStep, resolvedSecretValues } from '../runs/failures';
import { createRunnerLauncher } from '../runs/launcher';
import { createRepositoryRunStore, isTerminalRunStatus, type RunStore } from '../runs/store';
import {
  configuredPath,
  hostLaunchOptions,
  maximumRunDurationMs,
  readDeploymentPolicy,
  runnerManagerDriverId,
  runtimeVerificationNetworkPolicy,
} from './config';
import { createCeilingFor, type CeilingFor } from '../policy-ceiling/ceiling';
import { restrictedUnenforceableReason } from '../runtimes/network-policy';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { mintBrowserToken } from '../rbac/browser-token';
import { configureSurfaceSessionsRuntime } from '../surfaces/public/runtime';
import { createSurfaceSessionsRuntime } from '../surfaces/public/composition';
import { admitSurfaceVisitorWrite } from '../surfaces/public/limits';
import { configureTokensRuntime, currentTokensRuntime } from '../tokens/runtime';
import {
  configureSetupRuntimeDetection,
  setupRuntimeDetectionInputs,
} from '../setup/runtime-detection';
import { installSetupApi } from './setup';
import {
  engineForStoredPolicy,
  pinSessionEngine,
  sessionEngineMismatchMessage,
} from '../engines/session-engine';
import { recordReportedSessionIdentity, sessionForLaunch } from './session-launch';
import { installRbacApi, installSessionTranscripts } from './session-rbac';
import {
  installConnectorsApi,
  installDriverRegistry,
  installEndpointClientsApi,
  installModelsApi,
  installOAuthApi,
  installRuntimesApi,
  installSecretsApi,
} from './services';
import { installFilesApi, installSkillsApi } from './storage';

export { storageRootsOverlap } from './config';
export { sessionCookieValue } from './identity';
export type { InstalledModelsApi } from './types';

/** This composition root opens PostgreSQL, object storage and host runtime adapters. */
export const runtime = 'nodejs';

/**
 * Issue #119: "Archived workspaces … are excluded from new run/session creation." Re-exported
 * from `apps/web/server/workspaces/run-gate.ts` — this task's owned, unit-testable home for the
 * predicate and the {@link createRunGate} it backs — rather than declared here, so
 * `apps/web/server/workspaces/register-archived-guard.test.ts`'s existing
 * `import { isWorkspaceUsableForRuns } from '../composition/register'` keeps working unchanged.
 * See `run-gate.ts`'s own header for why the *call sites* below, not only this predicate, now
 * have a load-bearing test (verification round 1, finding 2).
 */
export { isWorkspaceUsableForRuns };

/**
 * Next.js calls this once per server process, before the first request is served.
 *
 * Expected missing configuration never throws: the affected routes already have a correct answer
 * for "not configured" — a 503 that names the missing piece — and startup logs which capability
 * is off and why. An unexpected installer failure is different: earlier installers may already
 * have published process-wide seams, so serving on with a half-installed composition would be
 * unsafe. Such a failure closes every database resource opened by this call before it is rethrown.
 *
 * ## Why the database module is imported inside the function
 *
 * **Next.js compiles `instrumentation.ts` for the edge runtime as well as for Node**, and a
 * top-level `import … from '@agent-workspace/core/db'` is therefore compiled for the edge — where
 * `pg`, `node:fs` and `node:url` do not exist. Measured, not inferred: with the import at the top
 * of this file, `next dev` printed
 *
 * ```text
 * Ecmascript file had an error
 * Import trace:
 *   Edge Instrumentation:
 *     ./packages/core/dist/db/migrate.js
 *     ./packages/core/dist/db/index.js
 *     ./apps/web/instrumentation.ts
 * ```
 *
 * and **every** `/api/**` route answered 500 instead of 401 — the whole of `tests/auth.test.ts`'s
 * live-server block went red. A guard *inside* the function does not help, because the import is
 * resolved before the function is ever called. So the module is loaded with a dynamic `import`
 * expression below the guard, which is the shape Next.js's own documentation uses for this exact
 * reason. (Described here without the call syntax on purpose — `tests/no-sdk-import.test.ts` scans
 * comments too, and the bare construct with no literal argument reads as undecidable to it.)
 * The `DatabaseRoot` type is still a static `import type`, which is erased and reaches no bundler.
 */
/** Resources owned by one installed Node composition root. */
export interface RegisteredComposition {
  /**
   * Release every database pool opened while installing the composition root. Idempotent.
   *
   * Once `register()` opens its database root, every later expected exit returns this handle, even
   * when an optional capability such as the run API could not be installed. Unexpected installer
   * failures close the same resources before rejecting, so `undefined` means that no database
   * resource was opened by the call.
   */
  close(): Promise<void>;
}

export async function register(): Promise<RegisteredComposition | undefined> {
  // Not `!== 'nodejs'`. `NEXT_RUNTIME` is not guaranteed to be set, and an absent value read as
  // "not node" would silently skip the whole composition — the ADR-0015 shape, where the check
  // falls through to the do-nothing path because its input was missing. Only a runtime this file
  // positively cannot serve is skipped: `pg` and `node:*` do not exist on the edge runtime.
  if (process.env['NEXT_RUNTIME'] === 'edge') return;

  // Issue #535 (C13): read once, before the database opens. An invalid value throws, so start-up
  // stops rather than run without the ceiling the operator asked for.
  const policyCeiling = readDeploymentPolicy(process.env);
  console.log(
    `[compose] policy ceiling: ${policyCeiling === null ? 'none' : Object.keys(policyCeiling).join(', ')}`,
  );

  const secret = readSessionSecret(process.env);
  if (!secret.ok) {
    console.error(
      `[compose] no seam installed: ${secret.reason} Every /api/** route will answer 503, and the middleware refuses each request 401 before it gets there.`,
    );
    return;
  }

  let root: DatabaseRoot;
  try {
    const core = await import('@agent-workspace/core/db');
    // `openDatabaseRoot` is the whole of this file's access to PostgreSQL. It creates the pool
    // once and keeps it for the life of the process, which is what `client.ts` says a long-lived
    // service must do. Production ignores the teardown handle returned below and lets process exit
    // close the pool; integration tests await it before dropping their isolated database.
    //
    // It hands back scope-bound repository providers and **no** database handle. That is the
    // point: before verification round 1 this file held a `Database`, and the same import that
    // gave it one gave every route handler in the application one, along with every schema table
    // object. `packages/core/src/db/index.ts` records what that made possible.
    //
    // The seam is installed because a query SUCCEEDED, never because nothing threw while a pool
    // object was constructed — `openDatabaseRoot` issues `select 1` before it returns. Without
    // that round trip a `DATABASE_URL` that merely parses (a host that is not there, a database
    // that was never created, credentials that were rotated) printed "installed" and then failed
    // every request with a 500 raised inside a route handler: ADR-0015's shape exactly, a
    // fallback indistinguishable from success.
    root = await core.openDatabaseRoot(process.env);
  } catch (error) {
    console.error(
      `[compose] no seam installed: ${error instanceof Error ? error.message : String(error)} Both the agent API and the run API answer 503 without a reachable database.`,
    );
    // No fallback to the in-memory stores, deliberately, and the reason is not caution — it is
    // that the fallback is not implementable here. Every request is authorised by reading
    // `workspaces`, `users` and `memberships` (`DatabaseRoot.resolveMembership` in core), so a
    // process with no database can authorise nobody and an in-memory agent store would never be
    // reached. Giving identity a memory implementation means owning users and memberships, which
    // is W2-CP-06's.
    // `docs/adr/W2-DB-02-no-silent-memory-fallback.md` records this, including that it makes
    // ADR-0024's "what docker compose up -d falls back to" false as written.
    return;
  }

  let secretsService: SecretsService | null = null;
  let closePromise: Promise<void> | undefined;
  const registeredComposition: RegisteredComposition = {
    close(): Promise<void> {
      closePromise ??= (async () => {
        const resources = [
          root.close(),
          ...(secretsService === null ? [] : [secretsService.close()]),
        ];
        const results = await Promise.allSettled(resources);
        const failures: unknown[] = [];
        for (const result of results) {
          if (result.status === 'rejected') {
            const reason: unknown = result.reason;
            failures.push(reason);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Failed to close the registered composition root.');
        }
      })();
      return closePromise;
    },
  };

  try {
    return await registerOpenedDatabase(
      root,
      secret.secret,
      policyCeiling,
      registeredComposition,
      (service) => {
        secretsService = service;
      },
    );
  } catch (error) {
    try {
      await registeredComposition.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Composition registration failed and its database resources could not be closed.',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/**
 * Why this deployment's tool sandbox cannot enforce a code tool's `allowedDomains`, or `null`. The
 * runner starts the tool sandbox on the same driver as the agent sandbox, so the same capability
 * answers (#1018).
 */
function toolDomainsRefusalFromEnv(env: NodeJS.ProcessEnv): string | null {
  return restrictedUnenforceableReason(
    runnerManagerDriverId(env),
    (env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '') !== '',
  );
}

/**
 * A launch lives in the process that started it, so a replica that dies mid-run leaves the run
 * open. Where runs can launch, fail every run still open five minutes past the longest a launch
 * can live (`../runs/stale-sweep.ts`).
 */
async function startStaleRunSweep(
  root: DatabaseRoot,
  runs: RunStore,
  gatewaySettings: ReturnType<typeof readGatewayIssuerSettings>,
): Promise<void> {
  if (!gatewaySettings.ok) return;
  const { startStaleRunSweeper } = await import('../runs/stale-sweep');
  startStaleRunSweeper({
    lease: { tryAcquire: (name, ttlMs) => root.tryAcquireMaintenanceLease(name, ttlMs) },
    listStaleRunIds: (before) => root.listStaleRunIds(before),
    finish: (runId, status, error, emitStatusEvent) =>
      runs.finish(runId, status, error, emitStatusEvent),
    staleAfterMs:
      maximumRunDurationMs(process.env, gatewaySettings.settings.ttlSeconds) + 5 * 60_000,
    intervalMs: 60_000,
    onError: (error) =>
      console.error(
        `[compose] stale-run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

async function registerOpenedDatabase(
  root: DatabaseRoot,
  sessionSecret: string,
  policyCeiling: ProjectPolicy | null,
  registeredComposition: RegisteredComposition,
  captureSecretsService: (service: SecretsService | null) => void,
): Promise<RegisteredComposition> {
  const principalIdentity = await installRbacApi(root, sessionSecret);
  const identifyAuditActor = (request: Request) => principalIdentity.identify(request);
  const identify = async (request: Request): Promise<Principal | null> => {
    const actor = await identifyAuditActor(request);
    return actor === null
      ? null
      : {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          // Issue #236 (SDK-04, S-1): the browser token's attenuation has to survive this
          // projection or the run API decides with `null` and the token acts with its minter's
          // full width. `RunApiEnvironment`'s `Principal.scope` is required so that dropping it
          // here is a compile error rather than a silent widening.
          scope: actor.scope,
        };
  };

  // One scope resolver and one provider, shared by both seams. `findAgent` on the run API and
  // `GET /api/agents` must see the same rows or a run could start against an agent the API says
  // does not exist.
  //
  // This is the line ADR-0024 exists for. Until it, `apps/web` contained no code that read or
  // wrote the database and an agent created through the UI was gone on the next restart. The
  // scope resolver is what turns the workspace id the routes carry into the `WorkspaceScope` the
  // repository will not run a query without.
  const scopes = root.scopes;
  const agents = createRepositoryAgentStoreProvider({ repositories: root.agents, scopes });
  const agentResources = createRepositoryAgentResourceStoreProvider({
    repositories: root.agentResources,
    scopes,
  });
  // issue #117: `POST /api/agents/:id/runs`'s Viewer "permitted" check.
  const agentGrants = createRepositoryAgentGrantStoreProvider({
    repositories: root.agentGrants,
    scopes,
  });
  const resourceCatalog = createResourceCatalogStoreProvider({
    repositories: root.resourceCatalogs,
    scopes,
  });
  const sessionRows = root.sessions;
  // Issue #119: one gate, shared by every seam below that creates a NEW run or session — see
  // `apps/web/server/workspaces/run-gate.ts` for why this is a module of its own rather than an
  // inline read at each call site.
  const runGate = createRunGate(root.workspaces);

  /**
   * Which workspace this request acts in, or why it acts in none.
   *
   * One closure, shared by the agents, secrets and files runtimes. Each of those three declared
   * its own structurally identical `WorkspaceResolution` type rather than importing a sibling
   * task's (see each `runtime.ts` header for why), but there must be exactly one *answer* in a
   * deployment: two resolvers reading the same cookie could disagree, and the one place a
   * disagreement about which workspace a request acts in would surface is a cross-tenant read.
   */
  const resolveWorkspace = async (request: Request): Promise<WorkspaceResolution> => {
    const result = await principalIdentity.resolveActor(request);
    // `unauthenticated` and `forbidden` are different answers and are kept apart: no valid
    // session at all is the first, a valid session whose account is not a member of the
    // workspace it names is the second. Collapsing them would report a revoked membership as a
    // forgotten login.
    if (result.kind !== 'workspace') return result;
    // This seam answers "which workspace", never "may this role": it carries no role and no
    // attenuation. The role decision is `decide()`'s, and every route handler of the families
    // this seam serves (agents, secrets, files, skills, connectors, runtime profiles and
    // connections, the runtime test) calls `requireResourceAccess` or `authorise` before it —
    // issue #388 closed the last handlers that did not (the secrets collection and `PUT`, the
    // runtime families, the connectors collection), which had let any member or API key of the
    // workspace reach them whatever its role.
    //
    // Issue #236 (SDK-04, S-1): a scoped credential is still refused here rather than silently
    // widened to its minter, exactly as `session-rbac.ts` refuses one, so a handler that ever
    // reached this seam without the gate would not hand a browser token its minter's width.
    if (result.principal.scope !== null) {
      return { kind: 'forbidden', reason: 'A scoped browser token does not reach this route.' };
    }
    return { kind: 'workspace', workspaceId: result.principal.workspaceId };
  };

  // Issue #506: the deployment default model, the run ladder's last layer, parsed once here. An
  // invalid value is reported without echoing it and treated as absent, so it fails closed: an
  // agent with a connection but no model is refused, not given a guessed model.
  const deploymentDefaults = readDeploymentDefaultModels(process.env);
  if (!deploymentDefaults.ok) {
    console.error(`[compose] AW_DEPLOYMENT_DEFAULT_MODELS ignored: ${deploymentDefaults.reason}`);
  }
  const deploymentDefaultModels = deploymentDefaults.ok ? deploymentDefaults.defaults : {};
  // Issue #535: one ceiling, handed to every write path that can widen an agent — the agents and
  // version runtimes, the run API and setup. Absent when no ceiling is configured, so each of
  // those paths is unchanged.
  const ceilingFor: CeilingFor | undefined =
    policyCeiling === null
      ? undefined
      : createCeilingFor({
          policy: policyCeiling,
          deploymentDefaultModels,
          modelProvider: async (workspaceId, connectionId) => {
            const scope = await scopes.forWorkspaceId(workspaceId);
            if (scope === null) return null;
            const connection = await root.modelConnections.forScope(scope).get(connectionId);
            return connection?.provider ?? null;
          },
          connectorName: async (workspaceId, connectorId) => {
            const scope = await scopes.forWorkspaceId(workspaceId);
            if (scope === null) return null;
            return (await root.mcpServers.forScope(scope).get(connectorId))?.name ?? null;
          },
          identifyActor: identifyAuditActor,
          recordAuditEvent: (event) => root.recordAuditEvent(event),
        });
  const withCeiling = ceilingFor === undefined ? {} : { ceilingFor };

  // PR #403 review: the agent first-run setup configured, which the composer selects first.
  const setupAgentId = (workspaceId: string): Promise<string | null> =>
    root.getWorkspaceSetupAgentId(workspaceId);
  configureAgentsRuntime({
    agents,
    agentResources,
    agentGrants,
    resolveWorkspace,
    skillCatalog: resourceCatalog,
    setupAgentId,
    ...withCeiling,
  });
  // S1-05 (#443): `GET`/`POST /api/agents/:id/versions`.
  configureAgentVersionsRuntime({
    versions: createRepositoryAgentVersionStoreProvider({
      repositories: root.agentVersions,
      evaluations: root.agentVersionEvaluations,
      scopes,
    }),
    // The runner manager starts the tool sandbox from this image (ADR-0118); the web reads the
    // same variable, so both processes must be given it. Empty keeps code-tool promotion refused.
    toolHost: (process.env['AGENT_WORKSPACE_TOOL_HOST_IMAGE']?.trim() ?? '') !== '',
    // The runner starts the tool sandbox on the same driver as the agent sandbox, so the same
    // capability says whether it can enforce a code tool's `allowedDomains` (#1018).
    toolDomainsRefusal: toolDomainsRefusalFromEnv(process.env),
    ...withCeiling,
  });
  configureAuditRuntime({ scopes, repositories: root.auditEventRepository });
  const { configureTelemetryRuntime, recordRunTelemetry } = await import('../telemetry/runtime');
  const telemetryConfigured = await configureTelemetryRuntime(process.env);
  console.log(
    telemetryConfigured
      ? '[compose] OpenTelemetry installed: exporting traces to OTEL_EXPORTER_OTLP_ENDPOINT'
      : '[compose] OpenTelemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT is unset',
  );
  console.log(
    '[compose] agent API installed: session cookie → PostgreSQL membership → PostgreSQL agent repository',
  );
  // The inventory an operator needs, printed rather than left to be inferred from a 200. Every
  // line is a statement about what a restart keeps, and the one that is not durable says so in
  // capitals, because that is the line somebody will be reading at the moment it matters.
  console.log(
    '[compose] persistence: agents durable (PostgreSQL) · run records durable (PostgreSQL) · ' +
      'run events durable and replayable (PostgreSQL run_events) · ' +
      'session transcripts durable with authenticated runner mirroring and resume',
  );

  // ── The sub-wave 2b-1 subsystems (ADR-0038) ──────────────────────────────────────────────────
  //
  // Four tracks each shipped a runtime seam and an ADR naming the exact call that installs it, and
  // none of them owned this file, so in a deployment built from their four branches every
  // /api/secrets/**, /api/files*, RBAC and session route answered 503. These are those calls.
  //
  // Each is installed independently and each is skipped for a *named* reason, never silently: a
  // subsystem whose configuration is absent leaves its own seam uninstalled and its own routes on
  // the 503 that says so by name. That is the same rule the run API above follows, and it is why
  // the RBAC block below installs nothing at all.
  const secretsService = await installSecretsApi(resolveWorkspace, scopes);
  captureSecretsService(secretsService);
  const modelsApi = await installModelsApi(
    resolveWorkspace,
    identifyAuditActor,
    root,
    secretsService,
  );
  await installConnectorsApi(resolveWorkspace, identifyAuditActor, root, secretsService);
  installEndpointClientsApi(root);
  installOAuthApi(root);
  const runtimeSwitchAudit = await installRuntimesApi(
    resolveWorkspace,
    identifyAuditActor,
    root,
    secretsService,
  );
  if (runtimeSwitchAudit !== null) {
    configureAgentsRuntime({
      agents,
      agentResources,
      agentGrants,
      resolveWorkspace,
      runtimeSwitchAudit,
      skillCatalog: resourceCatalog,
      setupAgentId,
      ...withCeiling,
    });
  }
  const runnerManagerUrl = configuredPath('RUNNER_MANAGER_URL');
  const runnerManagerToken = configuredPath('RUNNER_MANAGER_TOKEN');
  let runnerManager: RuntimeManagerClient | null = null;
  let runnerManagerVerificationPolicy: RuntimeRunSpec['networkPolicy'] = 'none';
  if (runnerManagerUrl !== null && runnerManagerToken !== null) {
    try {
      runnerManagerVerificationPolicy = runtimeVerificationNetworkPolicy(process.env);
      runnerManager = createRuntimeManagerClient(
        runnerManagerUrl,
        runnerManagerToken,
        globalThis.fetch,
        { verificationNetworkPolicy: runnerManagerVerificationPolicy },
      );
    } catch (error) {
      console.error(
        `[compose] runner manager NOT configured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (runnerManagerUrl !== null || runnerManagerToken !== null) {
    console.error(
      '[compose] runner manager NOT configured: RUNNER_MANAGER_URL and RUNNER_MANAGER_TOKEN must be set together.',
    );
  }
  const resolveProviderCredential = createProviderCredentialResolver({
    secrets: secretsService,
    scopes,
  });
  await installDriverRegistry(
    runnerManager,
    runnerManagerUrl,
    runnerManagerVerificationPolicy,
    resolveProviderCredential,
    {
      get: async (workspaceId, driverId) => {
        const scope = await scopes.forWorkspaceId(workspaceId);
        return scope === null ? null : root.runtimeVerifications.forScope(scope).get(driverId);
      },
      record: async (workspaceId, driverId, verification) => {
        const scope = await scopes.forWorkspaceId(workspaceId);
        if (scope === null) throw new Error('the workspace of the runtime verification is gone');
        await root.runtimeVerifications.forScope(scope).record(driverId, verification);
      },
    },
  );
  // Issue #378: the first-run wizard defaults to the driver this deployment actually runs. Only a
  // runner manager that was really created counts, so its URL is passed only alongside a client.
  configureSetupRuntimeDetection(
    setupRuntimeDetectionInputs(
      runnerManager === null ? null : runnerManagerUrl,
      runnerManagerDriverId(process.env),
      probeRuntimeManager,
    ),
  );
  await installFilesApi(resolveWorkspace, scopes, resourceCatalog);
  await installSkillsApi(resolveWorkspace, scopes, resourceCatalog);
  await installSessionTranscripts(identifyAuditActor, root);
  await installSetupApi(root, modelsApi, { policyCeiling, runtimeSecrets: secretsService });

  const filesRuntime = currentFilesRuntime();
  const skillsRuntime = currentSkillsRuntime();
  const connectorsRuntime = currentConnectorsRuntime();
  // issue #125: a project's `project_files`/`project_mcp_servers` associations, read the same way
  // every other provider here is — bound to a workspace id, with the `WorkspaceScope` lookup
  // hidden inside the adapter rather than pushed onto `resource-loader.ts`, which knows nothing
  // about scopes. `root.projectFiles`/`root.projectMcpServers` are the same `.forScope` providers
  // `configureProjectsRuntime` below already reads from.
  const projectResources = {
    async listFileIds(workspaceId: string, projectId: string): Promise<readonly string[]> {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? [] : root.projectFiles.forScope(scope).list(projectId);
    },
    async listMcpServerIds(workspaceId: string, projectId: string): Promise<readonly string[]> {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? [] : root.projectMcpServers.forScope(scope).list(projectId);
    },
  };
  const runResources = createAgentRunResourceLoader({
    catalog: resourceCatalog,
    ...(filesRuntime === null ? {} : { files: filesRuntime.store }),
    ...(skillsRuntime === null ? {} : { skills: skillsRuntime.store }),
    ...(connectorsRuntime === null ? {} : { connectors: connectorsRuntime.connectors }),
    projectResources,
  });
  // Issue #612: a session pins the version `local` points at when its row is inserted, and every
  // run of it composes from that version; a legacy session (no pin) runs from the row.
  const pinnedVersionFor = async (scope: WorkspaceScope, agentId: string): Promise<string | null> =>
    // ponytail: `list` reads every version body for one pointer; add a pointer-only read if agents
    // collect enough versions for session start to notice.
    versionToPin((await root.agentVersions.forScope(scope).list(agentId))?.pointers ?? [], 'local');
  const launchRef = async (scope: WorkspaceScope, row: SessionRecord): Promise<SessionRef> => {
    const ref = sessionForLaunch(row);
    if (row.agentVersionId === null) return ref;
    const version = await root.agentVersions.forScope(scope).findById(row.agentVersionId);
    return version === null ? ref : { ...ref, versionEngine: engineOfVersion(version) };
  };
  // The runtime resolver, allocation, compose and hydration all read the run's configuration, so
  // one read is shared per launch context; a failed read is dropped so a retry reads again.
  const readRunAgent = createRunAgentReader({
    agents,
    assignments: agentResources,
    versions: async (workspaceId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null ? null : root.agentVersions.forScope(scope);
    },
  });
  const runAgents = new WeakMap<LaunchContext, ReturnType<typeof readRunAgent>>();
  const runAgentOf = (context: LaunchContext) => {
    const cached = runAgents.get(context);
    if (cached !== undefined) return cached;
    const read = readRunAgent(
      context.principal.workspaceId,
      context.agent.id,
      context.session.agentVersionId ?? null,
    );
    runAgents.set(context, read);
    read.catch(() => runAgents.delete(context));
    return read;
  };

  const resolveWave5Actor = async (request: Request) => {
    const result = await principalIdentity.resolveActor(request);
    if (result.kind !== 'workspace') return result;
    const identity = result.principal;
    return {
      kind: 'workspace' as const,
      workspaceId: identity.workspaceId,
      principalId: identity.principalId,
      ownerPrincipalId: identity.ownerPrincipalId,
      userId: identity.userId,
      userLabel: identity.label,
      role: identity.role,
      scope: identity.scope,
    };
  };
  const wave5Repositories = async (workspaceId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`workspace ${workspaceId} no longer exists`);
    return {
      projects: root.projects.forScope(scope),
      files: root.projectFiles.forScope(scope),
      mcpServers: root.projectMcpServers.forScope(scope),
      shares: root.shares.forScope(scope),
      views: root.shareViews.forScope(scope),
      audit: root.auditEventRepository.forScope(scope),
      // issue #125: `POST /api/projects/:id/sessions` resolves `defaultAgentId` and persists it
      // by calling these two directly, rather than through the `apps/web/server/agents/**` and
      // `apps/web/server/runs/**` adapters — both outside this task's Owns globs this wave.
      agents: root.agents.forScope(scope),
      sessions: root.sessions.forScope(scope),
      agentVersions: root.agentVersions.forScope(scope),
    };
  };
  configureProjectsRuntime({
    resolveActor: resolveWave5Actor,
    forWorkspace: async (workspaceId) => {
      const repositories = await wave5Repositories(workspaceId);
      return {
        projects: repositories.projects,
        files: repositories.files,
        mcpServers: repositories.mcpServers,
        audit: repositories.audit,
        agents: repositories.agents,
        agentVersions: repositories.agentVersions,
        // Verification round 1, finding 3: `POST /api/projects/:id/sessions` (issue #125,
        // `apps/web/app/api/projects/**`/`apps/web/server/projects/**`, outside this task's
        // `Owns`) called `sessions.ensure(...)` on this provider with no archived-workspace
        // check at all, so it created a new session in an archived workspace. Neither the route
        // nor `apps/web/server/projects/runtime.ts` is a file this task may edit, so the seam
        // this composition root DOES own — the provider handed to `configureProjectsRuntime` —
        // is wrapped instead: see `apps/web/server/workspaces/run-gate.ts`'s
        // `guardSessionCreation`.
        //
        // Issue #183 wraps that wrapper with the archived-PROJECT gate, defence in depth behind
        // `POST /api/projects/:id/sessions`'s own named `409 project_archived`: the route is where
        // a caller learns why, and this is what keeps the refusal true for any other caller of the
        // same provider. Order is irrelevant — both refuse, neither writes — but the workspace
        // gate stays innermost so an archived workspace is still answered by #119's own line.
        sessions: guardProjectSessionCreation(
          guardSessionCreation(repositories.sessions, workspaceId, runGate),
          createProjectRunGate(repositories.projects),
        ),
      };
    },
  });
  configureSharesRuntime({
    resolveActor: resolveWave5Actor,
    forWorkspace: async (workspaceId) => {
      const repositories = await wave5Repositories(workspaceId);
      return { shares: repositories.shares, views: repositories.views, audit: repositories.audit };
    },
    resolvePublic: async (token) => {
      const workspaceId = await root.findShareWorkspace(token);
      if (workspaceId === null) return null;
      const repositories = await wave5Repositories(workspaceId);
      return {
        workspaceId,
        sharing: {
          shares: repositories.shares,
          views: repositories.views,
          audit: repositories.audit,
        },
      };
    },
    sharingMaterials: async (workspaceId) => {
      if (secretsService === null) return { values: [], referenceIds: [] };
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) return { values: [], referenceIds: [] };
      const metadata = await secretsService.list(scope);
      const resolved = await Promise.all(
        metadata.map(async (secretMetadata) =>
          secretsService.resolveByName(scope, secretMetadata.name),
        ),
      );
      return {
        values: resolved.flatMap((secretValue) =>
          secretValue === null ? [] : [secretValue.value.toString('utf8')],
        ),
        referenceIds: metadata.map((secretMetadata) => secretMetadata.id),
      };
    },
    subjectOwnership: async ({ workspaceId, principalId, subjectType, subjectId }) => {
      if (typeof subjectId !== 'string') return 'unknown';
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) return 'unknown';
      if (subjectType === 'project') {
        const project = await root.projects.forScope(scope).get(subjectId);
        return project === null
          ? 'unknown'
          : project.ownerPrincipalId === principalId
            ? 'own'
            : 'other';
      }
      if (subjectType === 'session') {
        const session = await sessionRows.forScope(scope).get(subjectId);
        return session === null
          ? 'unknown'
          : session.ownerPrincipalId === principalId
            ? 'own'
            : 'other';
      }
      // This resolver implements ownership lookups only for projects and sessions. Agent and skill
      // subjects remain unknown here, so own-only grants fail closed.
      return 'unknown';
    },
    runPublic: async ({ workspaceId, share, prompt, sessionId }) => {
      const runApi = getRunApi();
      if (runApi === null) throw new Error('The runner is not configured.');

      // Verification round 2, finding 1: this closure creates a session row and a queued run
      // row exactly like `findAgent`/`openSession` above, so it is bound by the same issue #119
      // rule ("Archived workspaces … are excluded from new run/session creation") and the same
      // `runGate` those two call sites share — see `run-gate-integration.test.ts` for the
      // `currentSharesRuntime().runPublic` probe this line makes pass.
      if (!(await runGate.isUsable(workspaceId))) {
        throw new Error('The public share became unavailable because its workspace is archived.');
      }

      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('The publishing workspace no longer exists.');
      const agent = await agents.forWorkspace(workspaceId).get(share.subjectId);
      if (agent === null) throw new Error('The shared agent no longer exists.');

      // Issue #183, the public run path its acceptance criteria name explicitly. A session this
      // closure *creates* carries no `projectId`, so the only way an archived project is reached
      // here is a `sessionId` that already names a session inside one — `ensure` would return it
      // as `existing` and the run below would be a NEW run in an archived project. Refused before
      // either insert, exactly like the archived-workspace line above.
      const priorSession = await sessionRows.forScope(scope).get(sessionId);
      if (
        priorSession !== null &&
        !(await createProjectRunGate(root.projects.forScope(scope)).isUsableForNewWork(
          priorSession.projectId,
        ))
      ) {
        throw new Error('The public share became unavailable because its project is archived.');
      }

      // A machine publisher has no human `userId` for the current runnable-share contract. Refuse
      // before `ensure`: the visitor session id is deterministic, so writing first would leave a
      // durable machine-owned session that every retry finds but can never run.
      if (share.createdBy === null) {
        throw new Error('Machine-published runnable shares are not enabled in this release.');
      }

      // Lean `startSession`: a visitor's session that already started keeps its pin (`ensure`
      // answers it `existing`), so only a new one reads the pointer.
      const sessionOutcome = await sessionRows.forScope(scope).ensure({
        id: sessionId,
        agentId: agent.id,
        ownerPrincipalId: share.publisherPrincipalId,
        userId: share.createdBy,
        agentVersionId: priorSession === null ? await pinnedVersionFor(scope, agent.id) : null,
      });
      if (sessionOutcome.kind !== 'created' && sessionOutcome.kind !== 'existing') {
        throw new Error('The publisher can no longer run this agent.');
      }

      const principal = {
        principalId: share.publisherPrincipalId,
        // The publisher principal is already the owner (`ShareService.publish` records
        // `ownerPrincipalIdOf(actor)`), so the share runs as, and writes for, that owner.
        ownerPrincipalId: share.publisherPrincipalId,
        userId: share.createdBy,
        workspaceId,
        // A public share runs as its publisher, not as a browser-token holder: no attenuation.
        scope: null,
      };
      const session = sessionForLaunch(sessionOutcome.session);
      // The session's pinned version, not the row, decides the engine and the permissions.
      const { agent: pinned } = await readRunAgent(
        workspaceId,
        agent.id,
        session.agentVersionId ?? null,
      );
      const agentEngine = engineForStoredPolicy(pinned.policy);
      const agentRef = { id: agent.id, workspaceId, engine: agentEngine };
      // ADR-0065 D8, exactly as `startRun` applies it: a visitor's run is still a run in a session
      // with a history, so it is refused before the run row exists rather than re-pinning the
      // session. A share whose agent was moved to another engine after a visitor started talking
      // becomes unavailable, which is the same answer the archived-workspace lines above give.
      const pin = pinSessionEngine({ sessionEngine: session.engine, agentEngine });
      if (pin.kind === 'mismatch') {
        throw new Error(`The public share cannot run: ${sessionEngineMismatchMessage(pin)}`);
      }
      const run = await runApi.store.create({
        engine: pin.engine,
        id: crypto.randomUUID(),
        workspaceId,
        agentId: agent.id,
        sessionId: session.id,
      });
      const attribution = await root.shares.forScope(scope).linkRun(share.id, run.id, new Date());
      if (attribution.kind === 'unavailable') {
        throw new Error('The public share became unavailable before its run was linked.');
      }
      runApi.launch({
        run,
        agent: agentRef,
        session,
        principal,
        prompt,
        permissionOverride: {
          ...pinned.permissions,
          runCommands: false,
          writeFiles: false,
        },
      });
      return {
        output: { runId: run.id, events: `/api/runs/${run.id}/events` },
        runId: run.id,
      };
    },
  });
  console.log('[compose] project and sharing APIs installed');

  const runtime = readRuntimeSettings(process.env);
  if (!runtime.ok) {
    // RUNNER_URL configures the in-process "local" driver only (§14.3's one fixed runtime URL).
    // A deployment that instead allocates a runtime per session through the runner manager
    // (RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN, checked above) has a real runtime with no use for
    // that fixed URL, so its absence is not itself a reason to leave the run API uninstalled — only
    // the absence of *every* runtime is. See docs/adr/ADR-cloud-run-service-driver.md.
    console.error(`[compose] "local" runtime driver unavailable: ${runtime.reason}`);
    if (runnerManager === null) {
      // Neither a fixed runtime URL nor a runner manager is configured, so there is truly nothing
      // to relay a run to. The three run routes go on answering 503 by name, which is the true
      // statement about a deployment with no runtime at all.
      console.error(
        '[compose] run API NOT installed: no runtime is configured (neither RUNNER_URL nor ' +
          'RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN).',
      );
      return registeredComposition;
    }
  }
  const gatewaySettings = readGatewayIssuerSettings(process.env);
  const hostLaunch = hostLaunchOptions(process.env, after);
  const gateway = gatewaySettings.ok
    ? createRunTokenIssuer(gatewaySettings.settings, async ({ claims, tokenHash }) => {
        const scope = await scopes.forWorkspaceId(claims.workspaceId);
        if (scope === null) throw new Error(`cannot register a token for unknown workspace`);
        await root.runTokens.forScope(scope).register({
          id: claims.tokenId,
          runId: claims.runId,
          tokenHash,
          expiresAt: new Date(claims.expiresAt * 1_000),
        });
      })
    : createUnavailableRunTokenIssuer(gatewaySettings.reason);
  if (!gatewaySettings.ok) {
    console.error(
      `[compose] run launch disabled: ${gatewaySettings.reason} Run lookup and event routes remain installed, but a launch fails closed before the runner is called.`,
    );
  }

  const runs = createRepositoryRunStore({
    repositories: root.runs,
    events: root.runEvents,
    scopes,
    findRunWorkspace: (runId: string): Promise<string | null> => root.findRunWorkspace(runId),
  });
  await startStaleRunSweep(root, runs, gatewaySettings);
  const [{ createRepositoryRuntimeProfileStoreProvider }, { currentWebRuntimeRegistry }] =
    await Promise.all([import('../runtimes/store'), import('../runtimes/registry')]);
  const driverRegistry = currentWebRuntimeRegistry();
  if (driverRegistry === null) {
    console.error(
      '[compose] run API NOT installed: the runtime driver registry is unavailable, so an agent profile cannot select a launch driver.',
    );
    return registeredComposition;
  }
  const runtimeProfiles = createRepositoryRuntimeProfileStoreProvider({
    repositories: root.runtimeProfiles,
    scopes,
  });
  // Issue #393: what `runs.start` checks before it queues a run, and the model ladder the launch
  // resolves again — one implementation, so the pre-queue answer and the launch cannot disagree.
  const runPreflight = createRunPreflight({
    agents,
    profiles: runtimeProfiles,
    models: modelsApi,
    deploymentDefaultModels,
    policyCeiling,
    workspaceDefault: (workspaceId) => root.getWorkspaceModelDefault(workspaceId),
    projectDefault: async (workspaceId, sessionId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      const sessionRow = scope === null ? null : await sessionRows.forScope(scope).get(sessionId);
      if (sessionRow === null || sessionRow.projectId === null) return null;
      const project = await (
        await wave5Repositories(workspaceId)
      ).projects.get(sessionRow.projectId);
      return project?.defaultModelConnectionId === null ||
        project?.defaultModelConnectionId === undefined ||
        project.defaultModel === null
        ? null
        : { connectionId: project.defaultModelConnectionId, model: project.defaultModel };
    },
    projectDefaults: async (workspaceId) => {
      // Active projects only: an archived project takes no new work, so its default is moot.
      const projects = await (await wave5Repositories(workspaceId)).projects.list('active');
      const defaults = new Map<string, ModelSelection>();
      for (const project of projects) {
        if (project.defaultModelConnectionId !== null && project.defaultModel !== null) {
          defaults.set(project.id, {
            connectionId: project.defaultModelConnectionId,
            model: project.defaultModel,
          });
        }
      }
      return defaults;
    },
  });
  /** The pin of session `sessionId`, when it is one of `agentId`'s; else `null`. */
  const sessionPin = async (
    workspaceId: string,
    agentId: string,
    sessionId: string | null,
  ): Promise<string | null> => {
    const scope = sessionId === null ? null : await scopes.forWorkspaceId(workspaceId);
    const row =
      scope === null || sessionId === null
        ? null
        : await sessionRows.forScope(scope).get(sessionId);
    return row?.agentId === agentId ? row.agentVersionId : null;
  };
  /** The run-start preflight against version `versionId`, or the row for `null` (a legacy pin). */
  const preflightAgainst = async (
    principal: Principal,
    agent: AgentRef,
    sessionId: string | null,
    modelOverride: ModelSelection | null,
    versionId: string | null,
  ) => {
    const pinned =
      versionId === null
        ? null
        : (await readRunAgent(principal.workspaceId, agent.id, versionId)).agent;
    return runPreflight.check({
      workspaceId: principal.workspaceId,
      agentId: agent.id,
      sessionId,
      modelOverride,
      ...(pinned === null ? {} : { agent: pinned }),
    });
  };
  // A follow-up is checked against the configuration it will run: its session's pinned version,
  // so a push never refuses (or lets through) an open conversation's next turn from the row. A new
  // session asked to pin a version (an evaluation, #618) is checked against that version.
  const runStartPreflight: NonNullable<RunApiEnvironment['preflight']> = async (
    principal,
    agent,
    sessionId,
    modelOverride,
    agentVersionId,
  ) =>
    preflightAgainst(
      principal,
      agent,
      sessionId,
      modelOverride,
      agentVersionId ?? (await sessionPin(principal.workspaceId, agent.id, sessionId)),
    );
  // Every launched run's model selection, until it finishes (PR #403 review, issue #661).
  const launchedModels = new Map<string, LaunchedModel>();
  const runtimeResolver = createRuntimeRunResolver({
    agentFor: async (context) => (await runAgentOf(context)).agent,
    profiles: runtimeProfiles,
    registry: driverRegistry,
    // ponytail: this reads the agent and loads the run's resources a second time, because
    // `buildRunRequest` loads them after the spec is allocated; pass one load through if launch
    // latency matters.
    networkGrantFor: async (context) => {
      const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
      const sessionRow =
        scope === null ? null : await sessionRows.forScope(scope).get(context.session.id);
      const project =
        sessionRow?.projectId === null || sessionRow?.projectId === undefined
          ? null
          : await (
              await wave5Repositories(context.principal.workspaceId)
            ).projects.get(sessionRow.projectId);
      return runNetworkGrant(
        context,
        await runAgentOf(context),
        runResources,
        policyCeiling,
        project?.id ?? null,
      );
    },
    // The runner manager starts the proxy from this image (#822); the web reads the same variable,
    // as it does for the runtime images, so both processes must be given it.
    egressProxyConfigured: (process.env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE']?.trim() ?? '') !== '',
    onNetworkLowered: (context, lowered) => {
      console.info(
        `[runs] run ${context.run.id}: the agent lacks unrestrictedNetwork, so the open runtime ` +
          `profile was lowered to ${lowered.applied}` +
          (lowered.allowedDomains.length === 0 ? '' : ` (${lowered.allowedDomains.join(', ')})`),
      );
    },
    // RUNNER_URL positively configures the local HTTP runtime only. Other drivers stay
    // unavailable until their own launch adapters register a target; they never fall back here.
    targets: [
      ...(runtime.ok
        ? [
            {
              driver: 'local' as const,
              runnerUrl: runtime.settings.runnerUrl,
              workspaceRoot: runtime.settings.workspaceRoot,
              validate: localRuntimeRunSpecRejection,
            },
          ]
        : []),
      ...(runnerManager === null
        ? []
        : [
            {
              // The runner manager allocates whatever runtime its own RUNTIME_DRIVER selects
              // (docker container, Cloud Run service, …) — this web process names that same
              // driver so an agent's runtime profile can select it. RUNTIME_DRIVER is read again
              // here rather than threaded through, because the two processes are configured
              // independently and must still agree on the id by construction: a mismatch here
              // means a runtime profile can never find this target (`createRuntimeRunResolver`
              // matches on `driver` alone), not that it reaches the wrong runtime.
              driver: runnerManagerDriverId(process.env),
              runnerUrl: runnerManagerUrl!,
              workspaceRoot: '/workspace',
              allocate: async (context: LaunchContext, spec: RuntimeRunSpec) => {
                // ADR-0118: a version that pins code tools gets the session's tool sandbox from
                // this allocation, and the run records where it is so the gateway can reach it.
                const workspaceId = context.principal.workspaceId;
                // Refuse a misconfigured connection before any tool secret is decrypted.
                const providerCredential = await atStep('runtime_connection', () =>
                  resolveProviderCredential(workspaceId, spec),
                );
                const { toolBundles } = await atStep('tools', () => runAgentOf(context));
                const toolSandbox =
                  toolBundles.length === 0
                    ? undefined
                    : await atStep('tools', () =>
                        buildToolSandboxRequest(context.run.id, toolBundles, {
                          bundle: async (digest) => {
                            const store = openToolBundleStore(workspaceId);
                            return store === null ? null : readToolBundle(store, digest);
                          },
                          secret: (name) =>
                            atStep('secrets', async () => {
                              const scope = await scopes.forWorkspaceId(workspaceId);
                              const resolved =
                                scope === null || secretsService === null
                                  ? null
                                  : await secretsService.resolveByName(scope, name);
                              return resolved === null ? null : resolved.value.toString('utf8');
                            }),
                          runToken: (runId) => {
                            if (!gatewaySettings.ok) throw new Error(gatewaySettings.reason);
                            return toolSandboxRunToken(
                              gatewaySettings.settings.signingSecret,
                              runId,
                            );
                          },
                        }),
                      );
                const allocation = await atStep('allocation', () =>
                  runnerManager.allocate(context, spec, toolSandbox, providerCredential),
                );
                if (allocation.toolSandboxOrigin !== undefined) {
                  const toolSandboxOrigin = allocation.toolSandboxOrigin;
                  try {
                    await atStep('tools', async () => {
                      const scope = await scopes.forWorkspaceId(workspaceId);
                      const outcome =
                        scope === null
                          ? null
                          : await root.runs
                              .forScope(scope)
                              .recordToolSandbox?.(context.run.id, toolSandboxOrigin);
                      if (outcome?.kind !== 'recorded') {
                        throw new Error(
                          `the run tool sandbox was not recorded (${outcome?.kind ?? 'unavailable'})`,
                        );
                      }
                    });
                  } catch (error) {
                    // No target is returned, so the launcher never releases this run's tool sandbox.
                    if (spec.driver === 'external') {
                      await runnerManager
                        .releaseRunToolSandboxes(workspaceId, context.run.id, providerCredential)
                        .catch(() => undefined);
                    }
                    throw error;
                  }
                }
                return {
                  runnerUrl: allocation.runnerUrl,
                  workspaceRoot: '/workspace',
                  ...(allocation.toolSandboxOrigin === undefined
                    ? {}
                    : { toolSandboxOrigin: allocation.toolSandboxOrigin }),
                };
              },
            },
          ]),
    ],
  });
  // Issue #235 (S-14): the interrupt route reuses exactly this revocation, so it is a function
  // rather than duplicated inline in both `revokeRunTokens` and `interruptRun` below.
  //
  // Issue #236 (SDK-04, S-1): every credential that reaches this run dies here, not just the
  // gateway's. §3.1 lists explicit revocation as one of three conditions that end a browser
  // token's life, alongside expiry and the run going terminal — and without this call that third
  // condition has no production caller at all, so an operator revoking a run's credentials
  // *before* any terminal transition leaves an `awt_live_…` token scoped to it still valid. The
  // browser-token count is deliberately not folded into `revoked`: that number is the run-token
  // outcome the route reports, and §34's response shape is about gateway tokens.
  const revokeAllRunTokensFor = async (
    principal: Principal,
    runId: string,
  ): Promise<{ readonly revoked: number; readonly outcome: string }> => {
    const scope = await scopes.forWorkspaceId(principal.workspaceId);
    if (scope === null) return { revoked: 0, outcome: 'not-found' };
    const repository = root.runTokens.forScope(scope);
    const revoked = await repository.revokeForRun(runId);
    await root.browserTokens.forScope(scope).revokeForRun(runId);
    return { revoked, outcome: revoked > 0 ? 'revoked' : 'already-revoked' };
  };
  const evaluationsOf = async (workspaceId: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`evaluation: workspace ${workspaceId} did not resolve`);
    return root.agentVersionEvaluations.forScope(scope);
  };
  // ADR-0135: an agent is published when its `production` pointer names a version; `list()` has
  // no by-name lookup, so the name is matched over the workspace's agents.
  // ponytail: O(agents + versions) per A2A call, `tasks/get` polls included; move to a by-name
  // lookup on the `agents_workspace_name_key` unique index plus a pointer read if that shows up.
  const publishedAgentIn = async (workspaceId: string, name: string) => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) return null;
    const agent = (await agents.forWorkspace(workspaceId).list()).find((a) => a.name === name);
    if (agent === undefined) return null;
    const listing = await root.agentVersions.forScope(scope).list(agent.id);
    const versionId = versionToPin(listing?.pointers ?? [], 'production');
    const version = listing?.versions.find((v) => v.id === versionId);
    return version === undefined
      ? null
      : {
          agentId: agent.id,
          name: agent.name,
          productionVersionId: version.id,
          versionNumber: version.number,
        };
  };
  installA2a({
    identify: async (request) => {
      const actor = await identifyAuditActor(request);
      if (actor === null) return null;
      return {
        principal: {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          scope: actor.scope,
        },
        via: actor.via,
        apiKeyId: actor.apiKeyId,
        oauth: actor.oauth,
      };
    },
    findPublishedAgent: publishedAgentIn,
    // The workspace of the deployment, resolved as the hosted surfaces resolve theirs.
    findDeploymentAgent: async (name) => {
      const slug = readDeploymentWorkspaceSlug(process.env);
      if (!slug.ok) return null;
      const scope = await scopes.forWorkspaceSlug(slug.slug);
      return scope === null ? null : publishedAgentIn(scope.workspaceId, name);
    },
    now: () => Date.now(),
  });
  installToolEndpoint({
    identify: async (request) => {
      const actor = await identifyAuditActor(request);
      if (actor === null) return null;
      return {
        principal: {
          principalId: actor.principalId,
          ownerPrincipalId: actor.ownerPrincipalId,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          role: actor.role,
          scope: actor.scope,
        },
        via: actor.via,
        apiKeyId: actor.apiKeyId,
        oauth: actor.oauth,
        label: actor.label,
      };
    },
    agentOwnership: resolveAgentRunOwnership,
    ...createToolEndpointSources({
      scopes,
      agentVersions: root.agentVersions,
      runtimeProfiles: root.runtimeProfiles,
      providerCredential: resolveProviderCredential,
      secrets: secretsService,
      bundle: async (workspaceId, digest) => {
        const store = openToolBundleStore(workspaceId);
        return store === null ? null : readToolBundle(store, digest);
      },
      runnerManager,
      gatewaySettings,
    }),
    now: () => Date.now(),
  });
  installRunApi({
    ...withCeiling,
    store: runs,
    authenticate: async (request: Request): Promise<Principal | null> => identify(request),
    revokeRunTokens: async (principal, runId, tokenId) => {
      if (tokenId === null) return revokeAllRunTokensFor(principal, runId);
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return { revoked: 0, outcome: 'not-found' };
      const repository = root.runTokens.forScope(scope);
      const outcome = await repository.revoke(tokenId, runId);
      return { revoked: outcome === 'revoked' ? 1 : 0, outcome };
    },
    // Issue #235 (S-14): the control-plane transition is the security boundary (this file's own
    // `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`) — write the
    // terminal `cancelled` status and revoke this run's tokens BEFORE the best-effort runtime
    // signal, so a caller never sees success for a run whose credential is still live. Ordered the
    // same way `launcher.ts`'s own credential-lifetime timer already reads it.
    interruptRun: async (principal, run) => {
      await runs.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
      await revokeAllRunTokensFor(principal, run.id);
      await signalLiveRun(run.id, globalThis.fetch);
    },
    // Issue #539 (S2-05c, C19): one row per rating; the handler has already authorised the call.
    recordRunFeedback: async (principal, run, { rating, comment }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      await root.runFeedback
        .forScope(scope)
        .record({ runId: run.id, rating, comment: comment ?? null });
    },
    // Issue #620: the handler has authorised the call and decided the owner filter.
    // ponytail: one event read per row (at most 50); store the answer on the run if it gets slow.
    listAgentFeedback: async (principal, { agentId, ...filter }) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`run feedback: workspace ${principal.workspaceId} did not resolve`);
      }
      if ((await agents.forWorkspace(principal.workspaceId).get(agentId)) === null) return null;
      const events = root.runEvents.forScope(scope);
      const rows = await root.runFeedback.forScope(scope).listForAgent({ agentId, ...filter });
      return Promise.all(
        rows.map(async ({ prompt, ...row }) => ({
          ...row,
          input: prompt,
          events: await events.list(row.runId, null),
        })),
      );
    },
    // Issue #622 (#606): a surface visitor's turns and ratings are rate-limited and capped.
    admitVisitorWrite: admitSurfaceVisitorWrite,
    // Issue #618: one row per evaluation; the handler has already authorised it and run its cases.
    recordEvaluation: async (principal, evaluation) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) {
        throw new Error(`evaluation: workspace ${principal.workspaceId} did not resolve`);
      }
      return root.agentVersionEvaluations.forScope(scope).record({
        ...evaluation,
        createdByPrincipalId: principal.principalId,
      });
    },
    // Issue #799: an evaluation run's rows; every call opens this workspace's repository.
    evaluationRuns: {
      start: async (principal, run) =>
        (await evaluationsOf(principal.workspaceId)).start({
          ...run,
          createdByPrincipalId: principal.principalId,
        }),
      find: async (principal, id) => (await evaluationsOf(principal.workspaceId)).find(id),
      claim: async (principal, id, leaseMs) =>
        (await evaluationsOf(principal.workspaceId)).claim(id, leaseMs),
      progress: async (principal, id, progress) =>
        (await evaluationsOf(principal.workspaceId)).progress(id, progress),
    },
    judgeEvaluationCase: createModelJudge({
      // Judged by version n's model connection, like its runs, not by `local`'s row.
      resolveModel: async ({ agentVersionId, ...query }) =>
        runPreflight.resolveModel({
          ...query,
          agent: (await readRunAgent(query.workspaceId, query.agentId, agentVersionId)).agent,
        }),
      connection: async (workspaceId, connectionId) =>
        (await modelsApi?.models.forWorkspace(workspaceId)?.resolve(connectionId)) ?? null,
    }),
    describeRunTarget: (workspaceId, agentId) => runPreflight.describe(workspaceId, agentId),
    preflight: runStartPreflight,
    findAgentVersion: async (principal, agentId, number) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      return scope === null ? null : root.agentVersions.forScope(scope).find(agentId, number);
    },
    findAgent: async (
      principal: Principal,
      agentId: string,
      sessionId: string | null = null,
    ): Promise<AgentRef | null> => {
      // Issue #119: "Archived workspaces … are excluded from new run/session creation." Checked
      // before the agent lookup, so an archived workspace answers the same `agent_not_found` a
      // caller in no workspace at all would see — archiving does not disclose anything about the
      // agent that a non-member's request would not already fail to see (§25).
      if (!(await runGate.isUsable(principal.workspaceId))) return null;
      const agent = await agents.forWorkspace(principal.workspaceId).get(agentId);
      // The store is already scoped to the workspace, so an agent it returns is this principal's
      // by construction. The id is echoed from the record rather than from the path.
      if (agent === null) return null;
      // Issue #612: a follow-up in a pinned conversation runs its version's engine, not the row's
      // a push moved.
      const pin = await sessionPin(principal.workspaceId, agent.id, sessionId);
      const scope = pin === null ? null : await scopes.forWorkspaceId(principal.workspaceId);
      const version =
        scope === null || pin === null
          ? null
          : await root.agentVersions.forScope(scope).findById(pin);
      return {
        id: agent.id,
        workspaceId: principal.workspaceId,
        // ADR-0065: the agent's own engine, which `startRun` compares against the session's
        // pin. A NULL policy column reads as the compiled policy's arm, not as "unknown".
        engine: version === null ? engineForStoredPolicy(agent.policy) : engineOfVersion(version),
      };
    },
    openSession: async (
      principal: Principal,
      agent: AgentRef,
      requested: string | null,
      agentVersionId?: string,
    ): Promise<SessionRef | null> => {
      // Defence in depth for a caller that reaches `openSession` some other way than the one
      // `findAgent`-then-`openSession` path this composition root wires today (issue #119).
      if (!(await runGate.isUsable(principal.workspaceId))) return null;
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return null;
      const sessions = sessionRows.forScope(scope);
      if (requested !== null) {
        const existing = await sessions.get(requested);
        if (
          existing === null ||
          existing.agentId !== agent.id ||
          existing.ownerPrincipalId !== ownerPrincipalIdOf(principal) ||
          existing.status !== 'active'
        ) {
          return null;
        }
        // Issue #183: `openSession` is always followed by a run being created (`startRun` in
        // `../runs/api.ts`), so resuming a session that lives in an archived project is a NEW run
        // in an archived project. `null` here is what `startRun` already turns into
        // `409 session_not_usable`, the same answer a session that is not the caller's produces —
        // so archiving discloses nothing a non-owner's request would not already fail to see.
        // The session itself is untouched: a run started before the archive still finishes.
        if (
          !(await createProjectRunGate(root.projects.forScope(scope)).isUsableForNewWork(
            existing.projectId,
          ))
        ) {
          return null;
        }
        return launchRef(scope, existing);
      }
      // The row must exist before `runs` can reference it: `runs_session_workspace_fk` is what
      // makes a run's workspace and its session's workspace the same value (spec §25). Wave 1
      // minted this id and stored nothing, which a `Map` did not mind and a foreign key does.
      const outcome = await sessions.ensure({
        id: crypto.randomUUID(),
        agentId: agent.id,
        ownerPrincipalId: ownerPrincipalIdOf(principal),
        userId: principal.userId,
        agentVersionId: agentVersionId ?? (await pinnedVersionFor(scope, agent.id)),
      });
      if (outcome.kind === 'created' || outcome.kind === 'existing') {
        return launchRef(scope, outcome.session);
      }
      // The explicit else. `unknown-agent` and `not-a-member` are real, different states — an
      // agent deleted between `findAgent` and here, a membership revoked mid-request — and the
      // route turns `null` into a 409. Logged by name so the 409 is diagnosable, because the
      // message the route prints is about `sessionId` and would be misleading on its own.
      console.error(
        `[compose] no session could be opened for agent ${agent.id}: ${outcome.kind}. The run route will answer 409.`,
      );
      return null;
    },
    ownsRun: async (principal: Principal, run) => {
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return false;
      const session = await sessionRows.forScope(scope).get(run.sessionId);
      return session?.ownerPrincipalId === ownerPrincipalIdOf(principal);
    },
    launch: createRunnerLauncher({
      runtime: runtimeResolver,
      store: runs,
      ...(filesRuntime === null
        ? {}
        : {
            workspaceLifecycle: createRuntimeWorkspaceLifecycle({
              resources: runResources,
              assignments: async (context) => (await runAgentOf(context)).assignments,
              objects: filesRuntime.store,
            }),
          }),
      ...(runnerManager === null
        ? {}
        : { runtimeRequestHeaders: () => runnerManager.authorizationHeaders() }),
      // A provider-hosted tool sandbox (E2B) counts against the account's concurrent cap until it
      // ends, so the one a run started is killed with the run rather than left to its timeout. The
      // session's agent runtime is not: the session's other runs keep using it (issue #832).
      ...(runnerManager === null
        ? {}
        : {
            releaseRunSandboxes: async (context: LaunchContext, target: RuntimeLaunchTarget) => {
              if (target.driver !== 'external' || target.toolSandboxOrigin === undefined) return;
              await runnerManager.releaseRunToolSandboxes(
                context.principal.workspaceId,
                context.run.id,
                await resolveProviderCredential(context.principal.workspaceId, target),
              );
            },
          }),
      // The SDK subprocess receives a fixed token at spawn time. End the run with a 10% safety
      // margin so no active run silently outlives that credential.
      ...(gatewaySettings.ok
        ? {
            maxRunDurationMs: maximumRunDurationMs(
              process.env,
              gatewaySettings.settings.ttlSeconds,
            ),
          }
        : {}),
      // Issue #235 (S-14): an interrupt that lands while the run is still `queued` revoked nothing,
      // because the run's token row is only created by `gateway.issue` inside `buildRunRequest`
      // below. The launcher calls this when it discovers the run went terminal underneath it, so
      // the credential it has just minted does not outlive the cancelled run.
      revokeRunTokens: async (context: LaunchContext) => {
        await revokeAllRunTokensFor(context.principal, context.run.id);
      },
      // Issue #827: what a preparation failure's log line is redacted of. Declared agent secrets,
      // tool secrets, the runtime connection credential and model connection keys are all workspace
      // secrets; the tool-sandbox token is derived from the run id. The gateway token is a long
      // random token, which `redacted` already masks by shape.
      preparationSecrets: async (context: LaunchContext) => {
        const runToken = gatewaySettings.ok
          ? [await toolSandboxRunToken(gatewaySettings.settings.signingSecret, context.run.id)]
          : [];
        const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
        if (scope === null || secretsService === null) return runToken;
        const metadata = await secretsService.list(scope);
        const values = await resolvedSecretValues(
          metadata.map(async (secret) => {
            const resolved = await secretsService.resolveByName(scope, secret.name);
            return resolved === null ? null : resolved.value.toString('utf8');
          }),
        );
        return [...values, ...runToken];
      },
      ...hostLaunch,
      onRunFinished: recordRunTelemetry,
      // Whatever ends a launch — a finished run, a refused build, an unexpected throw — forgets
      // its launched-model entry, so the map never outlives the runs it describes.
      onLaunchSettled: (context) => {
        launchedModels.delete(context.run.id);
      },
      // Issue #661: a key the provider rejects mid-run fails with the coded
      // `model_credential_rejected`. PR #403 review: a run queued while discovery was down carries
      // an unchecked model; when the provider then answers "model not found", the run fails with
      // the coded `model_unavailable`.
      codeRuntimeFailure: (context, reason) =>
        codeLaunchedRunFailure(reason, launchedModels.get(context.run.id)),
      onSessionIdentified: async (context, reportedSessionId) => {
        const scope = await scopes.forWorkspaceId(context.principal.workspaceId);
        if (scope === null) throw new Error('the run workspace disappeared');
        await recordReportedSessionIdentity(
          sessionRows.forScope(scope),
          context.session,
          reportedSessionId,
          // The engine this run recorded, so the pin names what actually produced the id.
          context.run.engine,
        );
      },
      buildRunRequest: async (context, runtimeTarget) => {
        if (runtimeTarget === undefined) {
          throw new Error('the selected runtime profile did not produce a launch target');
        }
        const workspaceId = context.principal.workspaceId;
        const scope = await scopes.forWorkspaceId(workspaceId);
        const sessionRow =
          scope === null ? null : await sessionRows.forScope(scope).get(context.session.id);
        const project =
          sessionRow?.projectId === null || sessionRow?.projectId === undefined
            ? null
            : await (await wave5Repositories(workspaceId)).projects.get(sessionRow.projectId);

        // issue #129: resolve and validate the run's model BEFORE it is composed into a request,
        // so a refusal names the layer and the run never reaches the runtime with an unresolved
        // or stale model. `runs.start` already ran this check before queueing (issue #393); it
        // runs again because the configuration may have changed since, and a refusal here is
        // thrown with the same contract code so the run's stored error carries it.
        const runAgent = await runAgentOf(context);
        const resolution = await atStep('model', () =>
          runPreflight.resolveModel({
            workspaceId,
            agentId: context.agent.id,
            sessionId: context.session.id,
            modelOverride: context.modelOverride ?? null,
            agent: runAgent.agent,
          }),
        );
        if (!resolution.ok) throw runStartRefusalError(modelResolutionRefusal(resolution));
        // Snapshotted before the request is even built, let alone posted: a run that fails later
        // in this function, or one the runtime never answers, still shows what it attempted.
        await atStep('model', () =>
          runs.snapshotModel(context.run.id, {
            connectionId: resolution.connectionId,
            model: resolution.model,
            provider: resolution.provider,
          }),
        );

        const request = await buildRunRequestFor(
          context,
          runAgent,
          runtimeSettingsFor(runtimeTarget),
          gateway,
          {},
          context.permissionOverride,
          project?.instructions ?? null,
          runResources,
          { connectionId: resolution.connectionId, model: resolution.model },
          project?.id ?? null,
          // ENG-04: the provider this run's connection resolved to, so compose can check that
          // the agent's engine speaks a dialect the gateway serves for it.
          resolution.provider,
          // C16: the run's tool connector set, which the gateway authorises each tool call by.
          async (runId, connectorIds) => {
            const outcome =
              scope === null
                ? null
                : await root.runs.forScope(scope).snapshotTools?.(runId, connectorIds);
            if (outcome?.kind !== 'snapshotted') {
              throw new Error(
                `the run tool snapshot was not recorded (${outcome?.kind ?? 'unavailable'})`,
              );
            }
          },
          // S2-04c: the run meets the deployment's ceiling before anything is issued or posted.
          policyCeiling,
        );
        // Recorded only once the request is built: a build that throws records nothing to forget.
        launchedModels.set(context.run.id, {
          layer: resolution.layer,
          connectionName: resolution.connectionName,
          model: resolution.model,
          validated: resolution.validated,
        });
        return request;
      },
    }),
  });
  console.log(
    `[compose] run API installed: agent runtime profiles select registered launch targets; ` +
      (runtime.ok
        ? `local relays through ${runtime.settings.runnerUrl} (spec §14.3)`
        : `no "local" target ("${runtime.reason}"); the runner manager provides the rest`),
  );

  // Issue #236 (SDK-04, S-1): `POST /api/tokens`'s runtime, sharing the same scope resolver and
  // session repository the run API above already closes over. `findTarget`'s run branch reads the
  // run's *session* for ownership, exactly as `ownsRun` above does — a run itself carries no
  // `ownerPrincipalId` (`packages/core/src/db/schema/runs.ts`'s own header explains why).
  configureTokensRuntime({
    findTarget: async (principal, scope) => {
      const dbScope = await scopes.forWorkspaceId(principal.workspaceId);
      if (dbScope === null) return { kind: 'not-found' };
      if (scope.kind === 'run') {
        const run = await root.runs.forScope(dbScope).get(scope.id);
        if (run === null) return { kind: 'not-found' };
        const session = await sessionRows.forScope(dbScope).get(run.sessionId);
        if (session === null) return { kind: 'not-found' };
        return { kind: 'found', ownerPrincipalId: session.ownerPrincipalId };
      }
      const session = await sessionRows.forScope(dbScope).get(scope.id);
      if (session === null) return { kind: 'not-found' };
      return { kind: 'found', ownerPrincipalId: session.ownerPrincipalId };
    },
    issue: async (principal, scope, ttlSeconds) => {
      const dbScope = await scopes.forWorkspaceId(principal.workspaceId);
      if (dbScope === null) return null;
      // Re-checked rather than assumed from the ownership resolver's earlier read: the row may
      // have been deleted between that check and this write, and the two calls do not share a
      // transaction.
      //
      // A target that has already reached a terminal state is refused here too. `§3.1`'s
      // revocation conditions make `resolveBrowserTokenActor` (`session-rbac.ts`) reject a
      // terminal run and an archived session on the token's very first use, and the plaintext is
      // shown exactly once — so a `201` there would hand the caller an unusable credential it can
      // never mint again. `null` is the only refusal this seam's contract carries, which makes the
      // answer the route's indistinguishable `404 run_not_found` / `404 session_not_found`: the
      // same one a target deleted a moment earlier gives, and for the same reason.
      if (scope.kind === 'run') {
        const run = await root.runs.forScope(dbScope).get(scope.id);
        if (run === null || isTerminalRunStatus(run.status)) return null;
      } else {
        const session = await sessionRows.forScope(dbScope).get(scope.id);
        if (session === null || session.status === 'archived') return null;
      }
      const minted = await mintBrowserToken();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await root.browserTokens.forScope(dbScope).issue({
        id: crypto.randomUUID(),
        mintedByPrincipalId: principal.principalId,
        scope,
        tokenHash: minted.tokenHash,
        expiresAt,
      });
      return { token: minted.presented, expiresAt };
    },
  });
  console.log('[compose] tokens API installed: PostgreSQL browser tokens');
  // S1-17 (#455): the hosted surface page's local session bootstrap, over the same seams.
  configureSurfaceSessionsRuntime(
    createSurfaceSessionsRuntime({
      env: () => process.env,
      scopes,
      agentVersions: root.agentVersions,
      agents,
      principalById: (workspaceId, principalId) =>
        root.directory.principalById(workspaceId, principalId),
      sessions: sessionRows,
      surfaceSessionKeys: root.surfaceSessionKeys,
      runGate,
      preflight: (publisher, agent, sessionId, versionId) =>
        sessionId === null
          ? preflightAgainst(publisher, agent, null, null, versionId)
          : runStartPreflight(publisher, agent, sessionId, null),
      tokens: currentTokensRuntime,
    }),
  );

  return registeredComposition;
}
