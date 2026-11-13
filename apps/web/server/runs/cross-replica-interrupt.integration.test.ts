/**
 * The cross-replica interrupt over a real PostgreSQL (ADR-0151-FU-1440 D1, issue #261).
 *
 * Two run stores over one database stand for two replicas. Replica A launches the run and holds
 * its stream; replica B serves the interrupt the way `interruptRun` in `run-api.ts` does it — the
 * terminal status, then the token revocation — and its live-run registry has no entry for the run,
 * so it signals nothing. The run must still stop: A's cancellation watch reads the committed
 * status and interrupts the runtime it holds.
 *
 * Runs whenever `TEST_DATABASE_URL` names a database (`pnpm test` provides one, through Docker or
 * the embedded-postgres fallback); skipped, by name, otherwise.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { log as webLogger } from '../telemetry/logger';
import { interruptRunFor } from './api';
import type { LaunchContext, RunApiEnvironment, RunPrincipal } from './environment';
import { resetLiveRuns } from './interrupt';
import { createRunnerLauncher } from './launcher';
import { createRepositoryRunStore } from './repository-store';
import type { RunStore } from './store';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';
if (!hasDatabase) {
  console.warn(
    '[runs/cross-replica-interrupt.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, ' +
      'so the cross-replica interrupt was NOT proved against PostgreSQL.',
  );
}

/** `apps/web/server/runs/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/** The declared test-only escape to the raw handle and the tables (see `store.test.ts`). */
type CoreDb = typeof import('@agent-workspace/core/db/unscoped');

const WATCH_MS = 50;

describe.skipIf(!hasDatabase)('a run interrupted through a replica that does not hold it', () => {
  let core: CoreDb;
  let isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;

  beforeAll(async () => {
    const dist = path.join(
      repoRoot,
      'packages',
      'core',
      'dist',
      'db',
      'repositories',
      'unscoped.js',
    );
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` first.`,
      );
    }
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_rf_cancel_runs');
  }, 180_000);

  afterAll(async () => {
    resetLiveRuns();
    await isolated.close();
  });

  /** A workspace, its owner, an agent and a session: the rows a run references. */
  async function seed(): Promise<{
    readonly workspaceId: string;
    readonly userId: string;
    readonly principalId: string;
    readonly agentId: string;
    readonly sessionId: string;
  }> {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(core.workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Cross-replica interrupt' });
    await isolated.db
      .insert(core.users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Runner' });
    await isolated.db
      .insert(core.memberships)
      .values({ id: membershipId, workspaceId, userId, role: 'owner' });
    const principal = (await isolated.db.select().from(core.workspacePrincipals)).find(
      (candidate) => candidate.membershipId === membershipId,
    );
    if (principal === undefined) throw new Error('the membership trigger created no principal');
    await isolated.db.insert(core.agents).values({
      id: agentId,
      workspaceId,
      name: 'Interrupted agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId: principal.id,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(core.sessions)
      .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId: principal.id });
    return { workspaceId, userId, principalId: principal.id, agentId, sessionId };
  }

  /** One replica's run store: its own instance, over the shared database. */
  function replicaStore(): RunStore {
    return createRepositoryRunStore({
      repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
      events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (id: string): Promise<string | null> =>
        core.findRunWorkspace(isolated.db, id),
    });
  }

  it('revokes every token before the interrupt answers, and stops the runtime within the watch interval', async () => {
    resetLiveRuns();
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const ids = await seed();
    const scope = await core
      .createDatabaseWorkspaceScopeResolver(isolated.db)
      .forWorkspaceId(ids.workspaceId);
    if (scope === null) throw new Error('the seeded workspace did not resolve');
    const tokens = core.createDatabaseRunTokenRepositoryProvider(isolated.db).forScope(scope);
    const replicaA = replicaStore();
    const replicaB = replicaStore();
    const runId = crypto.randomUUID();
    const run = await replicaA.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId: ids.workspaceId,
      agentId: ids.agentId,
      sessionId: ids.sessionId,
    });
    const principal: RunPrincipal = {
      principalId: ids.principalId,
      ownerPrincipalId: ids.principalId,
      userId: ids.userId,
      workspaceId: ids.workspaceId,
      role: 'owner',
      scope: null,
    };
    const context: LaunchContext = {
      run,
      agent: { id: ids.agentId, workspaceId: ids.workspaceId, engine: 'claude-agent-sdk' },
      session: { id: ids.sessionId, agentId: ids.agentId, engine: null },
      principal,
      prompt: 'hello',
    };

    // Replica A's runtime: an idle stream (a long tool call) that ends only when it is aborted.
    const interruptsAtA: unknown[] = [];
    let openedAtA: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      openedAtA = resolve;
    });
    let settledAtA: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settledAtA = resolve;
    });
    createRunnerLauncher({
      baseUrl: 'http://runtime-a:8080',
      store: replicaA,
      cancellationWatchIntervalMs: WATCH_MS,
      // Mints the run's gateway token, as `gateway.issue` does in production.
      buildRunRequest: async () => {
        await tokens.register({
          id: crypto.randomUUID(),
          runId,
          tokenHash: createHash('sha256').update(runId).digest('hex'),
          expiresAt: new Date(Date.now() + 60 * 60_000),
        });
        return { runId };
      },
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'http://runtime-a:8080/interrupt') {
          interruptsAtA.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
          return Promise.resolve(Response.json({ interrupted: true }, { status: 202 }));
        }
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(signal.reason), {
              once: true,
            });
          },
        });
        openedAtA();
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      },
      onLaunchSettled: () => settledAtA(),
    })(context);
    await opened;
    await vi.waitFor(async () => expect((await replicaB.get(runId))?.status).toBe('running'));

    // Replica B serves the interrupt: no registry entry there, so no runtime signal.
    const env: RunApiEnvironment = {
      store: replicaB,
      authenticate: () => Promise.resolve(principal),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      launch: () => undefined,
      interruptRun: async (_principal, target) => {
        await replicaB.finish(target.id, 'cancelled', 'the run was interrupted by request', true);
        await tokens.revokeForRun(target.id);
      },
    };
    const current = await replicaB.get(runId);
    if (current === null) throw new Error('replica B cannot see the run');
    const answeredAt = Date.now();
    expect(await interruptRunFor(env, principal, current)).toBe('stopped');

    // The invariant: when B answers, no token of the run is live.
    const rows = await isolated.db.select().from(core.runTokens);
    const ofRun = rows.filter((row) => row.runId === runId);
    expect(ofRun).toHaveLength(1);
    expect(ofRun.every((row) => row.revokedAt !== null)).toBe(true);

    // A's runtime is interrupted within the watch interval (plus scheduling slack).
    await vi.waitFor(() => expect(interruptsAtA).toEqual([{ runId }]), {
      timeout: WATCH_MS * 20,
      interval: 5,
    });
    expect(Date.now() - answeredAt).toBeLessThan(WATCH_MS * 20);
    await settled;
    const final = await replicaB.get(runId);
    expect(final?.status).toBe('cancelled');
    expect(final?.error).toBe('the run was interrupted by request');
    log.mockRestore();
  });
});
