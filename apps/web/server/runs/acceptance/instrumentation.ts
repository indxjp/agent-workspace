/**
 * The acceptance harness — the only thing in this repository that calls `installRunApi`, and it
 * exists solely so the W1-CP-04 acceptance criterion can be executed against the **real** route
 * handlers in a **real** `next build && next start`, behind a **real** nginx.
 *
 * **Read this before you copy anything from it.**
 *
 *   * It is not the production wiring. W1-CP-06 installs the authenticator, W1-DB-01/W1-CP-05 the
 *     agent lookup and the PostgreSQL run store, W1-RN-02 the runtime. This file substitutes for
 *     all four because none of them exists on this branch.
 *   * Its authenticator **authenticates everybody**. That is why `register()` refuses to run
 *     unless `AW_ACCEPTANCE_HARNESS=1` is set, and why nothing in `apps/web` imports this module:
 *     it is reached only through a root `instrumentation.ts` that `run-acceptance.mjs` writes for
 *     the duration of the probe and deletes afterwards. There is no committed import of it.
 *
 * See `README.md` beside this file for what the probe measures and what it does not prove.
 */
import { DEFAULT_ENGINE_ID } from '../../engines/session-engine';
import { installRunApi, type AgentRef, type Principal, type SessionRef } from '../environment';
import { createRunnerLauncher } from '../launcher';
import { InMemoryRunStore } from '../store';

const ENABLED = 'AW_ACCEPTANCE_HARNESS';
const RUNNER_URL = 'AW_ACCEPTANCE_RUNNER_URL';

/** Fixed ids, so the probe script can address the agent without a database to look one up in. */
export const ACCEPTANCE_WORKSPACE_ID = 'a0000000-0000-4000-8000-000000000001';
export const ACCEPTANCE_AGENT_ID = 'a0000000-0000-4000-8000-000000000002';
export const ACCEPTANCE_USER_ID = 'a0000000-0000-4000-8000-000000000003';
export const ACCEPTANCE_PRINCIPAL_ID = 'a0000000-0000-4000-8000-000000000004';

const PRINCIPAL: Principal = {
  principalId: ACCEPTANCE_PRINCIPAL_ID,
  ownerPrincipalId: ACCEPTANCE_PRINCIPAL_ID,
  userId: ACCEPTANCE_USER_ID,
  workspaceId: ACCEPTANCE_WORKSPACE_ID,
  role: 'owner',
  scope: null,
};

/**
 * Next.js calls this once per server process.
 *
 * It throws rather than returning quietly when the harness is not explicitly enabled: a silent
 * no-op here would let a build that accidentally carried a root `instrumentation.ts` come up with
 * no run API and look like a configuration problem instead of like the mistake it is.
 */
export function register(): void {
  // Skip only on a runtime this harness positively cannot serve. `NEXT_RUNTIME` is not
  // guaranteed to be set, and `!== 'nodejs'` would turn "the variable is absent" into a silent
  // no-op — the ADR-0015 shape exactly: the check falls through to the do-nothing path because
  // its input was missing.
  if (process.env['NEXT_RUNTIME'] === 'edge') return;
  if (process.env[ENABLED] !== '1') {
    throw new Error(
      `${ENABLED} is not "1": refusing to install the W1-CP-04 acceptance harness. This module authenticates every request and stores runs in memory; it is a probe fixture, not an environment.`,
    );
  }
  const runnerUrl = process.env[RUNNER_URL];
  if (runnerUrl === undefined || runnerUrl.length === 0) {
    throw new Error(`${RUNNER_URL} must name the §14.3 runtime the harness relays from.`);
  }

  // The probe reads this line to confirm the harness really ran in this process.
  console.log(`[acceptance] installing the run API harness, relaying from ${runnerUrl}`);
  const store = new InMemoryRunStore();
  installRunApi({
    // Authenticates unconditionally. Only ever reachable behind the env guard above.
    authenticate: (): Promise<Principal> => Promise.resolve(PRINCIPAL),
    findAgent: (principal: Principal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === ACCEPTANCE_AGENT_ID
          ? {
              id: agentId,
              workspaceId: principal.workspaceId,
              // The harness has no agent record to read a policy from, so it states the engine the
              // platform's default policy arm names (ADR-0065).
              engine: DEFAULT_ENGINE_ID,
            }
          : null,
      ),
    openSession: (_p: Principal, agent: AgentRef, requested: string | null): Promise<SessionRef> =>
      // `engine: null` is an unpinned session: the harness never writes a session row, so nothing
      // has pinned one, and the first run's engine is the agent's.
      Promise.resolve({ id: requested ?? crypto.randomUUID(), agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: createRunnerLauncher({
      baseUrl: runnerUrl,
      store,
      // `fake-runner.mjs` reads `runId` and `sessionId` and ignores the rest; it is not the
      // §14.3 `RunRequest` validator and never was. The real body is composed by
      // `apps/web/instrumentation.ts` from an agent record and the deployment's values —
      // W1-COMP-01 — and this probe has neither. Keeping the four fields the fixture actually
      // reads is what stops this file from looking like a second, competing composer.
      buildRunRequest: (context) => ({
        runId: context.run.id,
        sessionId: context.session.id,
        agentId: context.agent.id,
        prompt: context.prompt,
      }),
    }),
  });
}
