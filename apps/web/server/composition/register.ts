/**
 * The composition root of the Next.js application — the module that makes §34 answer.
 *
 * ## Why this file exists
 *
 * Everything under `apps/web/server/**` was written against an interface and installed by nobody.
 * The run API and the agents runtime (now `ApplicationContext.runs` and `.agents`) are the two
 * seams the run routes and the agent routes reach their world through, and before this file the only
 * callers of either were unit tests and a probe fixture that refuses to run unless `AW_ACCEPTANCE_HARNESS=1`. The consequence
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
 * can actually do, builds the adapters that back it, and installs them as one application context.
 * Every `if` below is a configuration question with a named answer, and every answer that is "no" leaves
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
import { log } from '../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import { installApplicationContext } from '../application-context';
import { readSessionSecret } from '../auth/session';
import { isWorkspaceUsableForRuns } from '../workspaces/run-gate';
import { configuredPath, readDeploymentPolicy } from './config';
import { wireAgents } from './wiring/agents';
import { wireBuilder } from './wiring/builder';
import { wireProjects, wireShares } from './wiring/projects';
import { RUN_DOMAINS_DISABLED, wireRunDomains } from './wiring/run-api';
import { wireRunResources } from './wiring/run-resources';
import { wireRunRuntime } from './wiring/run-runtime';
import { wireSubsystems } from './wiring/subsystems';

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
   * Stop the background drivers and release every database pool opened while installing the
   * composition root. Idempotent.
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
  log.info(
    `[compose] policy ceiling: ${policyCeiling === null ? 'none' : Object.keys(policyCeiling).join(', ')}`,
  );

  const secret = readSessionSecret(process.env);
  if (!secret.ok) {
    log.error(
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
    log.error(
      '[compose] no seam installed. Both the agent API and the run API answer 503 without a reachable database.',
      { error },
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
  // Background drivers (stale-run sweeper, trigger scheduler, session retention) started while
  // installing; `close()` stops them first, so none fires against a closed pool.
  const stops: (() => void)[] = [];
  let closePromise: Promise<void> | undefined;
  const registeredComposition: RegisteredComposition = {
    close(): Promise<void> {
      closePromise ??= (async () => {
        for (const stop of stops.splice(0)) stop();
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
      (stop) => stops.push(stop),
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

async function registerOpenedDatabase(
  root: DatabaseRoot,
  sessionSecret: string,
  policyCeiling: ProjectPolicy | null,
  registeredComposition: RegisteredComposition,
  captureSecretsService: (service: SecretsService | null) => void,
  stopOnClose: (stop: () => void) => void,
): Promise<RegisteredComposition> {
  const agentWiring = await wireAgents({ root, sessionSecret, policyCeiling });
  const subsystems = await wireSubsystems({
    ...agentWiring,
    root,
    policyCeiling,
    captureSecretsService,
    stopOnClose,
  });
  const wired = {
    ...agentWiring,
    ...subsystems,
    ...wireRunResources({ ...agentWiring, ...subsystems, root }),
    root,
    policyCeiling,
    stopOnClose,
  };
  const { principalIdentity } = wired;
  const context = {
    agents: { ...wired.agentsRuntime, runtimeSwitchAudit: wired.runtimeSwitchAudit },
    agentVersions: wired.agentVersions,
    audit: wired.audit,
    builder: wireBuilder({
      ...wired,
      tokenSecret: configuredPath('GATEWAY_TOKEN_SECRET'),
      directory: principalIdentity.rbac.directory,
    }),
    cliAuth: principalIdentity.cliAuth,
    connectors: wired.connectors,
    endpointClients: wired.endpointClients,
    files: wired.files,
    invitations: principalIdentity.invitations,
    models: wired.models,
    oauth: wired.oauth,
    projects: wireProjects(wired),
    rbac: principalIdentity.rbac,
    runtimes: wired.runtimes,
    secrets: wired.secrets,
    sessions: wired.sessions,
    setup: wired.setup,
    skills: wired.skills,
    storageConnections: wired.storageConnections,
    workspaces: principalIdentity.workspaces,
    shares: wireShares(wired),
  };
  // The run API, the A2A and tool endpoints, `POST /api/tokens`, the triggers and the public
  // surfaces need the run runtime; with none they are disabled (503). One install, after
  // everything is built, so no route ever reads a half-composed context.
  const runRuntime = await wireRunRuntime(wired);
  installApplicationContext({
    ...context,
    ...(runRuntime === null ? RUN_DOMAINS_DISABLED : wireRunDomains({ ...wired, ...runRuntime })),
  });
  log.info('[compose] project, session and sharing APIs installed');
  return registeredComposition;
}
