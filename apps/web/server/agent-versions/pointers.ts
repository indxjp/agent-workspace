/**
 * `PUT /api/agents/:id/pointers` (S1-06, issue #444; ADR-0101): point an environment at a saved
 * version. Moving `local` also materialises the version onto the agent row and its assignments,
 * which are `local`'s working copy; moving `production` (issue #612) moves only its pointer, after
 * the promotion gate (issue #619, below). RBAC has already run when this is called: the route's
 * ownership resolver loaded `agent` in the caller's workspace and `decide()` allowed the caller onto
 * it (a Viewer, and a Builder on another principal's agent, are `403`).
 *
 * ## The flow
 *
 * 1. Parse with `SetAgentPointerRequestSchema` → `400 invalid_agent_version` (`<path>: <message>`).
 * 2. `find` the version → `404 agent_version_not_found`, `details: [version:<n>]`.
 * 3. Re-validate the stored body against the agent as it is now (`validateAgentVersion`): an
 *    engine since unregistered, a name since deleted or made ambiguous, an engine switch that would
 *    now widen, a configuration over the deployment's policy ceiling (issue #535), each refuses
 *    with the code a save would answer. Pointing at an old version can
 *    therefore be refused, and that is intended: the agent never becomes what a save would refuse.
 * 4. `applyAndPoint` — one core transaction rewrites the row and the assignments (`local` only),
 *    moves the pointer, checks C9 and writes the move's `agent-changed` audit row (spec §36).
 *    A body `expectedVersion` (#1847) is compared with the pointer inside that transaction's lock:
 *    a different pointer answers `409 pointer_moved`, `details: [environment:<env>, current:<n|none>]`,
 *    and nothing moves. A version a caller saved for the refused move stays listed, unpointed.
 *    `name-conflict` → `409 agent_name_conflict` (the version's agent name is another agent's: the
 *    code legacy `POST`/`PATCH /api/agents` answer), `surface-name-taken` →
 *    `409 surface_name_taken`, `details: [surface:<name>]`, and the row is unchanged.
 *    `reference-gone` (a name resolved a moment ago was deleted before the write) re-resolves once:
 *    still unresolved answers that refusal, otherwise the write is retried once; a second
 *    `reference-gone` is a race this handler does not chase and throws (`500`).
 * 5. On `applied`, the move and its audit row have committed together: `200 {agent, pointer}`.
 *    A refused move writes no audit row. An audit row the database refuses (an actor that is not a
 *    principal of the workspace, a blank label) rejects the transaction, so the whole move rolls
 *    back and the request answers `500` — a pointer never moves unrecorded (ADR-0101, issue #478).
 *
 * ## Promote and rollback (issue #615)
 *
 * `POST /api/agents/:id/promote` points `production` at `local`'s version (or a given one), and
 * `POST /api/agents/:id/rollback` points an environment (default `production`) at the version
 * before its current one: the second entry of the history `rollbackHistory` replays from its
 * moves, where a rollback takes off the version it left, so two rollbacks go two versions back
 * (BH061-004). Each reads, decides with `./release.ts`'s pure functions, then runs steps 2–5
 * above with its own history `reason`. `dryRun: true` stops after step 3 and writes nothing (C8).
 * Both answer `200 {environment, from, to, saved, bar}`.
 *
 * ## The promotion gate (issue #619)
 *
 * When the deployment's policy ceiling sets `promotion.minEvalScore`, every move of `production`
 * but a rollback — a promote, and a `PUT` of `production` — first reads the target version's
 * newest evaluation (by its id, so only an evaluation of exactly that version counts) and lets
 * `decidePromote` judge it: `409 promotion_not_evaluated` or `409 promotion_gate_failed`, and
 * nothing moves. A dry run answers the same verdict. `local` and rollback are never gated.
 */
import type {
  AgentPointerAudit,
  AgentPointerMoveReason,
  AgentVersionRecord,
  ApplyAndPointOutcome,
  MaterialisedAgent,
  ResolvedReferences,
  WorkspaceAgentVersionStore,
} from './store';
import {
  AGENT_VERSION_PROBLEM_CODES,
  PromoteAgentRequestSchema,
  RollbackAgentRequestSchema,
  SetAgentPointerRequestSchema,
  type AgentEnvironment,
  type AgentPointerMoveResponse,
  type SetAgentPointerResponse,
} from '@indx-workspace/contracts/agent-versions';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import type { z } from 'zod';

import { builderNameRefusal } from '../agents/builder-name';
import type { AgentRecord } from '../agents/contract';
import { toAgentResource } from '../agents/contract';
import { agentNotFound } from '../agents/handlers';
import { formatIssues, problem, type ApiResult } from '../http/result';
import { toAgentVersionPointer, toAgentVersionResource } from './contract';
import { materialise } from './materialise';
import { definitionReferences, validateAgentVersion } from './pipeline';
import type { StorageConnectionLookup } from './storage-grants';
import {
  agentNameConflict,
  agentVersionNotFound,
  codeToolNeedsHost,
  noPointer,
  nothingToRollBack,
  pointerMoved,
  promotionGateFailed,
  promotionNotEvaluated,
  stdioConnectorNeedsToolSandbox,
  subagentNestingRefusal,
  surfaceNameTaken,
  withReferenceRetry,
} from './problems';
import { decidePromote, decideRollback, rollbackHistory, type PromoteDecision } from './release';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import type { Role } from '../rbac/roles';
import type { ToolBundleLookup } from '../tool-bundles/handlers';

/** Who moves the pointer: the authenticated principal's ids and its display attribution. */
export interface PointerActor {
  readonly principalId: string;
  readonly userId: string | null;
  /** The actor's workspace role, which decides whether a reserved name may be given (#1851); absent is a Member. */
  readonly role?: Role | undefined;
  /** The compatibility identity the audit trail labels the actor with (`Principal.actor`). */
  readonly actor: string;
}

export interface SetAgentPointerDependencies {
  readonly store: WorkspaceAgentVersionStore;
  /** The deployment's engine ids; defaults to the installed registry's (see the pipeline). */
  readonly registered?: readonly string[];
  /** The deployment's policy ceiling for this request (pipeline step 7, issue #535). */
  readonly ceiling?: RequestCeiling | null;
  /** The caller's tool bundles (pipeline step 4, issue #790). */
  readonly toolBundles?: ToolBundleLookup | null;
  /** The workspace's storage connections, which step 4a resolves `storage://` grants against. */
  readonly storageConnections?: StorageConnectionLookup | null;
  /** Whether the deployment has a tool host (ADR-0118 TS8); absent means it has none. */
  readonly toolHost?: boolean;
  /** Why the tool sandbox cannot enforce a code tool's `allowedDomains` (#1018), or `null`. */
  readonly toolDomainsRefusal?: string | null;
}

/** The deployment's promotion bar, or `null` when it sets none (issue #619). */
function promotionBar(dependencies: SetAgentPointerDependencies): number | null {
  return dependencies.ceiling?.policy.promotion?.minEvalScore ?? null;
}

/**
/**
 * Why `environment` cannot run the version, or `null` when it can. Only `local` can leave these:
 * ADR-0118 TS8, a version that lists the tool host's connector leaves `local` only on a deployment
 * with a tool sandbox, and only when it pins a bundle the sandbox can serve for its tools (each
 * entry carries the `description` and `inputSchema` a pre-sandbox `aw push` did not record), the
 * refusal naming which of the two is missing; and issue #793, a version that lists `stdio` MCP
 * connectors, which launch only in a tool sandbox no deployment environment starts for them yet
 * (ADR-0118 TS6). A rollback is a move like any other: the earlier version's own pinned bundle
 * comes back with it.
 */
async function environmentRefusal(
  record: AgentVersionRecord,
  environment: string,
  toolHost: boolean | undefined,
  store: WorkspaceAgentVersionStore,
): Promise<ApiResult | null> {
  if (environment === 'local') return null;
  const { body } = toAgentVersionResource(record);
  const { connectors } = body.definition.resources;
  if (connectors.includes(AW_DEV_TOOLS_CONNECTOR)) {
    if (toolHost !== true) return codeToolNeedsHost(environment, 'no-tool-host');
    const bundles = body.toolBundles ?? [];
    const hostable =
      bundles.length > 0 &&
      bundles.every(
        (bundle) => bundle.description !== undefined && bundle.inputSchema !== undefined,
      );
    return hostable ? null : codeToolNeedsHost(environment, 'unbundled');
  }
  const stdio = await store.stdioConnectorNames(connectors);
  return stdio.length === 0 ? null : stdioConnectorNeedsToolSandbox(environment, stdio);
}

/** A promote refusal as the problem it answers; `requested` is the version the body named. */
function promoteRefusal(
  decision: Extract<PromoteDecision, { readonly problem: string }>,
  requested: number | undefined,
): ApiResult {
  if (decision.problem === 'promotion_not_evaluated') {
    return promotionNotEvaluated(decision.version, decision.bar);
  }
  if (decision.problem === 'promotion_gate_failed') return promotionGateFailed(decision);
  return requested === undefined ? noPointer() : agentVersionNotFound(requested);
}

/** `400 invalid_agent_version` for a body that is not a `request`; `<path>: <message>` details. */
function invalidBody(request: string, error: z.ZodError): ApiResult {
  return problem(
    AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
    'invalid_agent_version',
    `The body is not a ${request}.`,
    formatIssues(error.issues),
  );
}

/** What {@link pointAt} answers: a refusal, a dry run that passed, or the applied move. */
type Pointed =
  | { readonly kind: 'refused'; readonly result: ApiResult }
  | { readonly kind: 'checked' }
  | Extract<ApplyAndPointOutcome, { readonly kind: 'applied' }>;

/**
 * Steps 2–5 of the flow: find version `number`, re-validate it, and — unless `dryRun` — move
 * `environment` to it with `reason`. Every route that moves a pointer moves it through here.
 */
async function pointAt(
  agent: AgentRecord,
  move: {
    readonly environment: AgentEnvironment;
    readonly number: number;
    readonly reason: AgentPointerMoveReason;
    readonly dryRun: boolean;
    /** Compare-and-set (#1847): absent moves unconditionally, `null` expects an unset pointer. */
    readonly expectedVersion?: number | null | undefined;
  },
  actor: PointerActor,
  dependencies: SetAgentPointerDependencies,
): Promise<Pointed> {
  const { environment, number, reason, expectedVersion } = move;
  const { store } = dependencies;

  const record = await store.find(agent.id, number);
  if (record === null) return { kind: 'refused', result: agentVersionNotFound(number) };

  // The pipeline is a body's only writer, so one that does not parse throws (`500`).
  const { body } = toAgentVersionResource(record);
  const { definition } = body;
  const unrunnable = await environmentRefusal(record, environment, dependencies.toolHost, store);
  if (unrunnable !== null) return { kind: 'refused', result: unrunnable };
  const validated = await validateAgentVersion(body, {
    ...dependencies,
    subject: { kind: 'existing', agent },
    bodyPath: 'body',
    dryRun: move.dryRun,
  });
  if (!validated.ok) return { kind: 'refused', result: validated.result };
  // Only the local pointer rewrites the agent row, so only it can rename the agent.
  if (environment === 'local' && definition.agent.name !== agent.name) {
    const reserved = builderNameRefusal(dependencies.ceiling, actor.role, definition.agent.name);
    if (reserved !== null) return { kind: 'refused', result: reserved };
  }
  if (move.dryRun) return { kind: 'checked' };
  const materialised = (references: ResolvedReferences): MaterialisedAgent =>
    materialise(definition, references, validated.policyToStore);
  const audit: AgentPointerAudit = {
    // The name the agent has after the move: a version can rename it.
    subjectLabel:
      `${definition.agent.name}: ${environment} -> version ${String(number)}` +
      (reason === 'set' ? '' : ` (${reason})`),
    actorPrincipalId: actor.principalId,
    actorUserId: actor.userId,
    actorLabel: actor.actor,
  };

  const outcome = await withReferenceRetry(
    validated.references,
    () => store.resolveDefinition(definitionReferences(definition)),
    (references) =>
      store.applyAndPoint(agent.id, {
        environment,
        number,
        reason,
        agent: materialised(references),
        audit,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
  );
  switch (outcome.kind) {
    case 'refused':
    case 'applied':
      return outcome;
    case 'not-found':
      return { kind: 'refused', result: agentNotFound() };
    case 'version-not-found':
      return { kind: 'refused', result: agentVersionNotFound(number) };
    case 'name-conflict':
      return { kind: 'refused', result: agentNameConflict(outcome.name) };
    case 'surface-name-taken':
      return { kind: 'refused', result: surfaceNameTaken(outcome.name) };
    case 'pointer-moved':
      return { kind: 'refused', result: pointerMoved(environment, outcome.current) };
    case 'subagent-nesting':
      return {
        kind: 'refused',
        result: subagentNestingRefusal(outcome.unusable, outcome.parents),
      };
    case 'reference-gone':
      throw new Error('withReferenceRetry answered reference-gone, which it never returns.');
  }
}

/** Point an environment of `agent` at one of its saved versions. */
export async function setAgentPointer(
  raw: unknown,
  agent: AgentRecord,
  actor: PointerActor,
  dependencies: SetAgentPointerDependencies,
): Promise<ApiResult> {
  const parsed = SetAgentPointerRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidBody('pointer request', parsed.error);
  const { environment, version: number, expectedVersion } = parsed.data;
  const bar = environment === 'production' ? promotionBar(dependencies) : null;
  if (bar !== null) {
    const record = await dependencies.store.find(agent.id, number);
    // A missing version passes on to `pointAt`, which answers its `404`.
    if (record !== null) {
      // Before the bar: an evaluation can never make this version promotable.
      const unrunnable = await environmentRefusal(
        record,
        environment,
        dependencies.toolHost,
        dependencies.store,
      );
      if (unrunnable !== null) return unrunnable;
      const evaluation = await dependencies.store.latestEvaluation(record.id);
      const decision = decidePromote({
        requested: number,
        source: null,
        exists: () => true,
        bar,
        evaluationOf: () => evaluation,
      });
      if ('problem' in decision) return promoteRefusal(decision, number);
    }
  }
  const pointed = await pointAt(
    agent,
    { environment, number, reason: 'set', dryRun: false, expectedVersion },
    actor,
    dependencies,
  );
  switch (pointed.kind) {
    case 'refused':
      return pointed.result;
    case 'checked':
      throw new Error('pointAt answered a dry run to a move that was not one.');
    case 'applied':
      return {
        status: 200,
        body: {
          agent: toAgentResource(pointed.agent),
          pointer: toAgentVersionPointer(pointed.pointer),
        } satisfies SetAgentPointerResponse,
      };
  }
}

/** Run a decided promote or rollback, or its dry run, and answer the from/to versions. */
async function moveAndAnswer(
  agent: AgentRecord,
  move: {
    readonly environment: AgentEnvironment;
    readonly from: number | null;
    readonly to: number;
    readonly reason: 'promote' | 'rollback';
    readonly dryRun: boolean;
    readonly bar: number | null;
  },
  actor: PointerActor,
  dependencies: SetAgentPointerDependencies,
): Promise<ApiResult> {
  const pointed = await pointAt(
    agent,
    { environment: move.environment, number: move.to, reason: move.reason, dryRun: move.dryRun },
    actor,
    dependencies,
  );
  if (pointed.kind === 'refused') return pointed.result;
  return {
    status: 200,
    body: {
      environment: move.environment,
      from: move.from,
      to: move.to,
      saved: pointed.kind === 'applied',
      bar: move.bar,
    } satisfies AgentPointerMoveResponse,
  };
}

/** Point `production` at `local`'s version, or at the version the body names (issue #615). */
export async function promoteAgent(
  raw: unknown,
  agent: AgentRecord,
  actor: PointerActor,
  dependencies: SetAgentPointerDependencies,
): Promise<ApiResult> {
  const parsed = PromoteAgentRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidBody('promote request', parsed.error);
  const { version: requested, dryRun } = parsed.data;
  const listing = await dependencies.store.list(agent.id);
  if (listing === null) return agentNotFound();
  const pointerOf = (environment: AgentEnvironment): number | null =>
    listing.pointers.find((pointer) => pointer.environment === environment)?.number ?? null;
  const recordOf = (number: number | null) =>
    listing.versions.find((version) => version.number === number);
  const source = pointerOf('local');
  const bar = promotionBar(dependencies);
  // Read only the candidate's evaluation, and only when there is a bar to judge it against.
  const candidate = recordOf(requested ?? source);
  // Before the bar: an evaluation can never make this version promotable.
  if (candidate !== undefined) {
    const unrunnable = await environmentRefusal(
      candidate,
      'production',
      dependencies.toolHost,
      dependencies.store,
    );
    if (unrunnable !== null) return unrunnable;
  }
  const evaluation =
    bar === null || candidate === undefined
      ? null
      : await dependencies.store.latestEvaluation(candidate.id);
  const decision = decidePromote({
    requested,
    source,
    exists: (number) => recordOf(number) !== undefined,
    bar,
    evaluationOf: (number) => (number === candidate?.number ? evaluation : null),
  });
  if ('problem' in decision) return promoteRefusal(decision, requested);
  return moveAndAnswer(
    agent,
    {
      environment: 'production',
      from: pointerOf('production'),
      to: decision.to,
      reason: 'promote',
      dryRun: dryRun === true,
      bar,
    },
    actor,
    dependencies,
  );
}

/**
 * How many of an environment's moves a rollback replays. Older moves only matter after this many
 * rollbacks in a row.
 */
const ROLLBACK_MOVES_READ = 1000;

/** Point an environment back at the version before its current one (issue #615, BH061-004). */
export async function rollbackAgent(
  raw: unknown,
  agent: AgentRecord,
  actor: PointerActor,
  dependencies: SetAgentPointerDependencies,
): Promise<ApiResult> {
  const parsed = RollbackAgentRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidBody('rollback request', parsed.error);
  const { environment, dryRun } = parsed.data;
  const moves = await dependencies.store.listMoves(agent.id, environment, ROLLBACK_MOVES_READ);
  const decision = decideRollback(rollbackHistory(moves));
  if ('problem' in decision) return nothingToRollBack(environment);
  return moveAndAnswer(
    agent,
    {
      environment,
      from: decision.from,
      to: decision.to,
      reason: 'rollback',
      dryRun: dryRun === true,
      bar: null,
    },
    actor,
    dependencies,
  );
}
