/**
 * The seam between the three §34 run routes and the rest of the control plane.
 *
 * **Why this exists rather than direct calls.** W1-CP-04 lands at the same stack level as the
 * tasks that own the three things a run route needs: authentication and workspace scoping
 * (W1-CP-06, `apps/web/server/auth/**`), the agent record and the PostgreSQL run store
 * (W1-DB-01 / W1-CP-05), and the runtime that produces events (W1-RN-02). None of them exists on
 * this branch, and `apps/web/package.json` — where a dependency on `@agent-workspace/core` would
 * have to be declared — is not this task's file to edit. So the routes are written against one
 * interface, and the adapters are installed by whoever wires the application together.
 *
 * **Why the default is a refusal and not a stub.** ADR-0015: a check that cannot run FAILS, and a
 * capability is supported because a scenario passed, never because nothing failed. An
 * unconfigured run API therefore answers `503` and names the piece that is missing. It does not
 * answer `401` (which would promise that credentials could fix it), it does not answer `200` with
 * an empty stream (which would present an unimplemented capability as a working one), and it does
 * not fall back to an in-memory store behind the operator's back. The in-memory adapter in
 * `store.ts` exists and is exercised, but something has to install it on purpose.
 *
 * See `docs/adr/W1-CP-04-run-api-is-installed-not-imported.md`.
 */
import type { AgentPermissions } from '@agent-workspace/core';
import type { StoredAgentVersionEvaluation } from '@agent-workspace/core/db';
import type { RunFeedbackRating, RunFeedbackRequest } from '@indx-workspace/contracts/feedback';
import type { RunStartProblemCode } from '@indx-workspace/contracts/runs';
import type { SurfaceLimitProblemCode } from '@indx-workspace/contracts/surfaces';
import type { CeilingFor } from '../policy-ceiling/ceiling';
import type { TokenScope } from '../rbac/token-scope';
import type { SseEvent } from './sse';
import type { RunRecord, RunStore } from './store';

/** What `listAgentFeedback` reads (issue #620). */
export interface AgentFeedbackQuery {
  readonly agentId: string;
  readonly rating?: RunFeedbackRating;
  readonly since?: Date;
  readonly runId?: string;
  /** Only ratings of runs in sessions this principal owns; absent for a workspace-wide reader. */
  readonly ownerPrincipalId?: string;
  readonly limit: number;
}

/** One rating, with its run's prompt (`null` before migration 0042) and stored events. */
export interface AgentFeedbackRow {
  readonly runId: string;
  readonly rating: RunFeedbackRating;
  readonly comment: string | null;
  readonly input: string | null;
  readonly createdAt: Date;
  readonly events: readonly SseEvent[];
}

/** Who is making the request, already resolved to one workspace (spec §25 multi-tenant isolation). */
export interface Principal {
  /** The principal that acted. */
  readonly principalId: string;
  /**
   * The principal that owns what this caller writes and that own/other is decided against
   * (`rbac/principal.ts`'s `ownerPrincipalId`). Equal to `principalId` except for a local
   * runtime key, which writes for the member it acts for (issue #509, S1-24). Every composition
   * root sets it, so it is required (`rbac/owner-principal.ts`).
   */
  readonly ownerPrincipalId: string;
  readonly userId: string | null;
  readonly workspaceId: string;
  /** Present for cookie/API-key identities that need an owner/admin-only operation. */
  readonly role?: 'owner' | 'admin' | 'builder' | 'viewer';
  /**
   * The attenuation a browser-token credential carries (issue #236, SDK-04, S-1), or `null` for a
   * session or an API-key principal. `requireRunPermission` and `decideRunListAccess` (`./api.ts`)
   * pass this straight through to `decide()`, whose scope grammar denies before §21's own table is
   * even consulted; a session scope's row identity (its run must belong to that session) is a
   * separate check at the row read, because `decide()` sees only the path and cannot know it.
   *
   * **Required, not optional.** An optional field lets a composition root that forgets it compile
   * anyway, and a principal whose scope silently reads `undefined` reaches every run route with
   * its minter's full width — the defect this field was added to prevent. Spelling `null` is the
   * positive assertion that this credential carries no attenuation.
   */
  readonly scope: TokenScope | null;
}

/** The part of an agent a run route needs. The rest of §17's agent belongs to W1-CP-05. */
export interface AgentRef {
  readonly id: string;
  readonly workspaceId: string;
  /**
   * The engine this agent's policy names (ADR-0065) — `policy.engine`, or the default arm for an
   * agent with no stored policy (`engineForStoredPolicy`, `../engines/session-engine.ts`). For a
   * follow-up in a version-pinned conversation, the pinned version's policy (issue #612).
   *
   * **Required, not optional**, for the reason {@link Principal.scope} gives: an optional field lets
   * a composition root that forgets it compile anyway, and a run whose engine silently read
   * `undefined` would be recorded as the platform's default engine whatever the agent actually says.
   *
   * A `string` rather than `EngineId`: while the contracts publish one engine, a comparison between
   * two `EngineId`s can never differ, so `session_engine_mismatch` would be unreachable even from a
   * test. `../engines/session-engine.ts` explains the widening and narrows once, where a value is
   * recorded.
   */
  readonly engine: string;
}

/** The session a run belongs to (spec §20). `runs.session_id` is NOT NULL, so a run needs one. */
export interface SessionRef {
  readonly id: string;
  readonly agentId: string;
  /** True only after repository-backed workspace/agent/user authorization of a requested session. */
  readonly resume?: boolean;
  /**
   * The engine this session is pinned to (ADR-0065 D8), or `null` while no run has pinned it.
   *
   * A run for an agent on a different engine is refused with `409 session_engine_mismatch` and
   * creates no run row; a `null` session accepts any engine and is pinned by the run that reports an
   * engine session id. Widened to `string` for the reason {@link AgentRef.engine} gives.
   */
  readonly engine: string | null;
  /**
   * The agent version the session pinned when it started (issue #612): every run of it composes
   * from that version. `null` or absent for a legacy session, whose runs read the agent row.
   */
  readonly agentVersionId?: string | null;
  /** The engine the pinned version runs on, which a run compares in place of the agent's. */
  readonly versionEngine?: string;
}

/**
 * One layer's `(connection, model)` pair for issue #129's resolution ladder. Never one half
 * without the other — `startRun`'s body parser refuses a request that supplies only one.
 */
export interface ModelSelection {
  readonly connectionId: string;
  readonly model: string;
}

/**
 * What a new run of one agent would use (issue #393), as the composer shows it before a message
 * is sent. `unrunnable` carries the same code `runs.start` would refuse with.
 */
export type RunTargetDescription =
  | {
      readonly kind: 'runnable';
      /**
       * Which ladder layer supplies the model: the agent's own, a project or workspace default, or
       * the deployment default for the agent's connection (issue #506).
       */
      readonly source: 'agent' | 'project' | 'workspace' | 'deployment';
      readonly connectionId: string;
      readonly connectionName: string;
      readonly provider: string;
      readonly model: string;
      readonly runtimeProfileName: string;
    }
  | {
      readonly kind: 'unrunnable';
      readonly code: RunStartProblemCode;
      readonly reason: string;
    };

/** What a new run of one agent would use: outside any project, and in each project with a default. */
export interface RunTargetDescriptions {
  readonly outsideProject: RunTargetDescription;
  /**
   * One entry per project whose default sits on the agent's ladder. Empty when the agent names its
   * own model (the ladder stops there) or cannot run for a reason no model fixes.
   */
  readonly byProject: ReadonlyMap<string, RunTargetDescription>;
}

export interface LaunchContext {
  readonly run: RunRecord;
  readonly agent: AgentRef;
  readonly session: SessionRef;
  readonly principal: Principal;
  readonly prompt: string;
  /** A caller may only narrow the stored agent permissions for this run. */
  readonly permissionOverride?: AgentPermissions;
  /**
   * Per-run provider choice, pre-#129: a connection id on its own, with no paired model. Kept
   * for callers that predate the resolution ladder (`w4-switch.test.ts`'s "switch one run's
   * connection without a model override" exercise, outside this task's `Owns:` globs) — `null`
   * means use the agent's saved default connection, and the agent's own `model` still applies.
   * A NEW caller should set {@link modelOverride} instead, which is issue #129's actual
   * run-override layer and always outranks this field when both are present.
   */
  readonly modelConnectionId?: string | null;
  /**
   * The run-override layer of issue #129's resolution ladder — the highest-precedence layer, and
   * the only one of the two fields above that a full `(connection, model)` pair can express.
   * `null`/omitted means this run supplies no override; resolution falls through to the agent's
   * own default, then the project's, then the workspace's.
   */
  readonly modelOverride?: ModelSelection | null;
}

export interface RunApiEnvironment {
  /**
   * Resolve the caller. `null` means unauthenticated and the route answers 401.
   *
   * Returning a principal is a positive assertion that the request carried valid credentials —
   * an implementation must not return a default principal when it finds no credentials.
   */
  authenticate(request: Request): Promise<Principal | null>;
  /**
   * The agent, or `null` when it does not exist **or** is not this principal's to run. With the
   * `sessionId` a follow-up continues, `engine` is that conversation's pinned version's when it
   * has one (issue #612), not the row's a push moved.
   */
  findAgent(
    principal: Principal,
    agentId: string,
    sessionId?: string | null,
  ): Promise<AgentRef | null>;
  /**
   * The session this run joins. `requested` is the caller's `sessionId`, or `null` to start a new
   * one. `null` back means the requested session is not usable — a wrong workspace, or an agent
   * that does not match, which §19.5 rule 4 makes a new session rather than a silent fork.
   * `agentVersionId` pins a new session to that version of `agent` instead of the one `local`
   * points at (an evaluation, issue #618); the caller has already found it among the agent's.
   */
  openSession(
    principal: Principal,
    agent: AgentRef,
    requested: string | null,
    agentVersionId?: string,
  ): Promise<SessionRef | null>;
  /**
   * Version `number` of `agentId` in the principal's workspace, or `null` when there is none
   * (issue #697: `POST /api/agents/:id/runs` with `version`). Absent: no version can be named.
   */
  readonly findAgentVersion?: (
    principal: Principal,
    agentId: string,
    number: number,
  ) => Promise<{ readonly id: string } | null>;
  /**
   * Decide whether this run can be launched at all, before a run row exists (issue #393): the
   * agent's runtime profile, and the model its resolution ladder settles on. `null` means queue it;
   * a refusal becomes a `422` with the contract-declared code, and no run is created. Optional so a
   * composition without stored configuration (a test, a share) queues as before; the launch then
   * reports the same code as the run's failure.
   */
  readonly preflight?: (
    principal: Principal,
    agent: AgentRef,
    /**
     * The session the run continues, or `null` for a run that opens a new one. A new run is
     * checked before its session is opened, so a refused start leaves no session behind.
     */
    sessionId: string | null,
    modelOverride: ModelSelection | null,
    /** The version a new session will pin, as {@link RunApiEnvironment.openSession} takes it. */
    agentVersionId?: string,
  ) => Promise<{ readonly code: RunStartProblemCode; readonly message: string } | null>;
  /**
   * The deployment's policy ceiling (issue #535): `startRun` refuses an explicit `modelOverride`
   * outside its `models` with `403 policy_cannot_widen`. Absent when `AW_DEPLOYMENT_POLICY` is unset.
   */
  readonly ceilingFor?: CeilingFor;
  /** What a new run of the agent would use, for the composer (issue #393); `null` if unknown. */
  readonly describeRunTarget?: (
    workspaceId: string,
    agentId: string,
  ) => Promise<RunTargetDescriptions | null>;
  /** Establish row ownership through the run's persisted session owner. */
  ownsRun(principal: Principal, run: RunRecord): Promise<boolean>;
  readonly store: RunStore;
  /** Revoke one token id, or every active token when tokenId is null. */
  readonly revokeRunTokens?: (
    principal: Principal,
    runId: string,
    tokenId: string | null,
  ) => Promise<{ readonly revoked: number; readonly outcome: string }>;
  /**
   * Stop `run` (issue #235, S-14): write its terminal `cancelled` status, revoke its gateway
   * tokens, and best-effort signal the runtime holding it. The caller has already established that
   * `run` is not yet terminal; this performs the action and does not itself re-read the record —
   * `interruptRun` in `./api.ts` does that after calling it, so the response always reflects what
   * was actually written rather than what was asked for.
   */
  readonly interruptRun?: (principal: Principal, run: RunRecord) => Promise<void>;
  /**
   * Append one rating of `run` (issue #539, S2-05c, C19). The caller has already found the run,
   * checked a session scope's row identity and §21, and parsed the body; this only stores it.
   */
  readonly recordRunFeedback?: (
    principal: Principal,
    run: RunRecord,
    feedback: RunFeedbackRequest,
  ) => Promise<void>;
  /**
   * The newest ratings of `query.agentId`'s runs, each with its run's stored events (issue #620),
   * or `null` when the principal's workspace has no such agent. The caller has already authorised
   * the call and decided `ownerPrincipalId` from the caller's runs grant; this only reads.
   */
  readonly listAgentFeedback?: (
    principal: Principal,
    query: AgentFeedbackQuery,
  ) => Promise<readonly AgentFeedbackRow[] | null>;
  /**
   * Admit one turn or rating by a session-scoped token for `sessionId` (issue #622; #606), or
   * refuse it with a typed `429`. Called after authorisation and before anything is written; a
   * session that no surface opened is always admitted. Absent: nothing is limited.
   */
  readonly admitVisitorWrite?: (
    workspaceId: string,
    sessionId: string,
    kind: 'turn' | 'feedback',
    headers: Headers,
  ) => Promise<{
    readonly code: SurfaceLimitProblemCode;
    readonly message: string;
    readonly retryAfterSeconds: number | null;
  } | null>;
  /**
   * Ask the model version `agentVersionId` of `agent` resolves to for one reply to `prompt`
   * (issue #618's `judge` check). Throws on any failure; the evaluation handler records that as
   * `judge_unavailable`.
   */
  readonly judgeEvaluationCase?: (
    principal: Principal,
    agent: AgentRef,
    agentVersionId: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * Store one scored evaluation of an agent version (issue #618). The handler has already
   * authorised the call and run every case; this only stores it.
   */
  readonly recordEvaluation?: (
    principal: Principal,
    evaluation: {
      readonly versionId: string;
      readonly passed: number;
      readonly total: number;
      readonly casesSnapshot: unknown;
      readonly results: unknown;
    },
  ) => Promise<{ readonly id: string; readonly createdAt: Date }>;
  /**
   * The storage of evaluation runs (issue #799), which the handlers drive one advance at a time.
   * Each call is for the principal's workspace; the handler has already authorised it.
   */
  readonly evaluationRuns?: {
    readonly start: (
      principal: Principal,
      run: {
        readonly versionId: string;
        readonly total: number;
        readonly casesSnapshot: unknown;
      },
    ) => Promise<{ readonly id: string; readonly createdAt: Date }>;
    readonly find: (
      principal: Principal,
      evaluationId: string,
    ) => Promise<StoredAgentVersionEvaluation | null>;
    /** Take the run's lease for `leaseMs`; `null` when it is not running or already leased. */
    readonly claim: (
      principal: Principal,
      evaluationId: string,
      leaseMs: number,
    ) => Promise<StoredAgentVersionEvaluation | null>;
    readonly progress: (
      principal: Principal,
      evaluationId: string,
      progress: {
        readonly results: unknown;
        readonly passed: number;
        readonly completed: boolean;
        readonly release: boolean;
      },
    ) => Promise<void>;
  };
  /**
   * Start producing events for a run. Returns immediately; the run's outcome is written to the
   * store, never to the HTTP response that started it (R-13 finding 8, spec §14.6).
   */
  launch(context: LaunchContext): void;
}

/**
 * The registry is anchored on `globalThis`, not on a module-level `let`, and that is not a
 * stylistic choice.
 *
 * **Next.js compiles `instrumentation.ts` and the route handlers into separate module graphs.**
 * Verified during this task's acceptance run on `next@16.3.4`: an `instrumentation.ts` that
 * imported this module and called `installRunApi` logged its own success, and a request to
 * `GET /api/runs/:id` in the same process still answered `503 run_api_not_configured`, because
 * the route's bundle held a second, untouched copy of the module-level variable. A `globalThis`
 * property is shared by every bundle in one Node process, so the two halves see one registry.
 *
 * The scope this buys is exactly one process. It is deliberately not more: two replicas have two
 * registries, which is correct, because what they are registering is per-process wiring.
 */
interface RunApiRegistry {
  /** Namespaced so it cannot collide with anything else on the global object. */
  __agentWorkspaceRunApiEnvironment__?: RunApiEnvironment;
}

const registry = globalThis as typeof globalThis & RunApiRegistry;

/** Install the adapters. Called once by whoever composes the application. */
export function installRunApi(environment: RunApiEnvironment): void {
  registry.__agentWorkspaceRunApiEnvironment__ = environment;
}

/** Remove the adapters. For tests, and for a harness that must not leak into the next case. */
export function resetRunApi(): void {
  delete registry.__agentWorkspaceRunApiEnvironment__;
}

export function getRunApi(): RunApiEnvironment | null {
  return registry.__agentWorkspaceRunApiEnvironment__ ?? null;
}

/** The 503 every run route returns while nothing is installed. */
export const RUN_API_NOT_CONFIGURED_MESSAGE =
  'the run API has no environment installed: call installRunApi() with an authenticator, an agent lookup, a run store and a runtime launcher. This server will not guess any of them.';
