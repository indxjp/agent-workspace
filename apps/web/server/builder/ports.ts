import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type {
  BUILDER_CATALOG_KINDS,
  BUILDER_TOOLS,
  BuilderDecision,
  BuilderToolName,
  BuilderToolOutputs,
} from '@indx-workspace/contracts/builder';
import type { EvalCase, EvaluationResource } from '@indx-workspace/contracts/evaluations';
import type { RunStatus } from '@indx-workspace/contracts/runs';

import type { RunOwnershipPrincipal } from '../agents/run-ownership';
import type { Role } from '../rbac/roles';
import type { Facts, JournalRow } from './core/facts';

/** The cost class of a tool (design §04): what the caller's role must allow. */
export type BuilderToolKind = (typeof BUILDER_TOOLS)[BuilderToolName]['kind'];

/** The person a run acts for. Built from the run token only (design §08 Security rule 2). */
type CallerIdentity =
  | { readonly kind: 'person'; readonly principal: RunOwnershipPrincipal & { readonly role: Role } }
  | { readonly kind: 'none' };

/**
 * The door a call came through, set by the transport from the verified credential. `run` is the
 * internal route: the agent whose run token it is, and the version that run is pinned to.
 */
export type CallDoor =
  | { readonly kind: 'run'; readonly agentId: string; readonly agentVersion: number }
  | { readonly kind: 'external' };

/** Where a tool call comes from. No field is ever taken from tool arguments. */
export type CallContext = {
  readonly workspaceId: string;
  readonly door: CallDoor;
  readonly runId: string;
  readonly traceId: string;
  readonly caller: CallerIdentity;
  readonly modelId: string;
  readonly promptVersion: string;
};

/** A tool call as the model made it: the tool and the raw arguments, before any parsing or defaults. */
export type ApprovalRequest = { readonly tool: BuilderToolName; readonly arguments: unknown };

export interface ApprovalPort {
  /**
   * Whether the person approved exactly this call in this run: the tool and its arguments, as the
   * gateway's backstop canonicalises them. The record has no call id, so one changed argument, tool,
   * run or workspace answers `missing`.
   */
  status(ctx: CallContext, call: ApprovalRequest): Promise<'granted' | 'missing'>;
}

export interface AuthorizationPort {
  /** What the caller may do with this kind of tool on this agent; a missing agent is `not_owner`. */
  access(ctx: CallContext, kind: BuilderToolKind, agentId?: string): Promise<Facts['access']>;
  /**
   * Who is building, from the door: the Builder, another agent (with its version body, whether the
   * deployment's policy lets it build, and whether an agent made it) or an outside client. `null`
   * when the caller cannot be resolved; the shell refuses then and never falls back to the Builder.
   */
  creator(ctx: CallContext): Promise<Facts['creator'] | null>;
  /**
   * The version a trial or evaluation names; `null` when the agent or version cannot be resolved in
   * this workspace, or the caller is not an agent.
   */
  target(ctx: CallContext, agentId: string, version: number): Promise<Facts['target']>;
}

export interface PolicyPort {
  limits(ctx: CallContext): Promise<Facts['limits']>;
}

/** One call as the journal keeps it; the run, workspace and trace come from the `CallContext`. */
type JournalEntry = {
  readonly callId: string;
  /** `null` for a call whose tool name is not on the aw-control list. */
  readonly tool: BuilderToolName | null;
  readonly decision: BuilderDecision['kind'];
  readonly outcome: JournalRow['outcome'];
  readonly code: string | null;
  readonly input: unknown;
  readonly result: unknown;
};

export interface AuditPort {
  /** The run's counts, from the same `tallyRun` the core defines. */
  runCounts(ctx: CallContext): Promise<Facts['run']>;
  /**
   * Keeps the first row for a `(runId, callId)`. The one exception: a later `ok` of the same tool
   * replaces an `error` row, so a retry after a transient failure replays its success. Answers
   * whether the call was stored; `false` means the id was already taken and nothing changed.
   */
  record(ctx: CallContext, entry: JournalEntry): Promise<boolean>;
  /** The stored result of the first successful write of this `(runId, callId)` by `tool`, or `null`. */
  replay(
    ctx: CallContext,
    callId: string,
    tool: BuilderToolName,
  ): Promise<{ readonly result: unknown } | null>;
  /**
   * The inputs, as journaled (parsed, and bounded: an oversize one is a `{ truncated: true, sha256 }`
   * marker), of the run's calls of `tool` that ended `ok` or `error`: a write that failed part-way
   * may still have happened. A `refused` or `check_failed` call wrote nothing and is not listed. The
   * shell uses them to see that an approval was used.
   */
  spentInputs(ctx: CallContext, tool: BuilderToolName): Promise<readonly unknown[]>;
}

/** What a dry-run check answers: the pipeline's own code and details, never renamed. */
export type CheckResult =
  | { readonly ok: true; readonly number: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details: readonly string[];
      readonly fix: string;
    };

export interface CheckerPort {
  /** Runs the version pipeline as a dry run for the caller; writes nothing. `agentId` unset checks a new agent. */
  check(
    ctx: CallContext,
    agentId: string | undefined,
    body: AgentVersionBody,
  ): Promise<CheckResult>;
}

/** An evaluation as the console stores it, or the refusal the console route would have answered. */
export type EvalResult =
  | { readonly ok: true; readonly evaluation: EvaluationResource }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A trial run as it ended, or the refusal the run route would have answered. `output` is untrusted data. */
export type TrialResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly status: RunStatus;
      readonly output: string;
      readonly truncated: boolean;
      readonly costUsd: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface RunnerPort {
  /**
   * Scores `cases` against a saved version as the caller, through the evaluations route's own
   * handler and RBAC: whoever may not evaluate the agent in the console may not here either.
   */
  evaluate(
    ctx: CallContext,
    agentId: string,
    version: number,
    cases?: readonly EvalCase[],
  ): Promise<EvalResult>;
  /**
   * Runs `input` once against a saved version as the caller, in a run of its own that the caller's
   * RBAC allows and that is no part of the Builder's run. `budgetUsd` is capped at
   * `BUILDER_DEFAULT_LIMITS.trialBudgetUsd` and can only lower the agent's own budget. A repeated
   * `idempotencyKey` starts no second run and answers the first one's result.
   */
  trial(
    ctx: CallContext,
    agentId: string,
    version: number,
    input: string,
    budgetUsd: number,
    idempotencyKey: string,
  ): Promise<TrialResult>;
}

export type CatalogKind = (typeof BUILDER_CATALOG_KINDS)[number];
export type CatalogEntry = BuilderToolOutputs['catalog_list']['entries'][number];

export interface CatalogPort {
  /** Names and ids only, in `BUILDER_CATALOG_KINDS` order; a kind the caller's role cannot read is left out. */
  list(ctx: CallContext, kinds: readonly CatalogKind[]): Promise<readonly CatalogEntry[]>;
}

/** A save of a draft. `baseVersion` is the `local` version the draft was built on, `null` for none. */
type SaveRequest =
  | {
      readonly agentId?: undefined;
      readonly body: AgentVersionBody;
      readonly summary?: string;
      /** The agent making this one, with the version it runs; the store adds `ctx.runId`. */
      readonly createdByAgent?: { readonly agentId: string; readonly version: number };
      /** Refuses the save as `quota_exceeded` once `limit` agents were created since `since`, inside the create transaction. */
      readonly quota?: { readonly since: Date; readonly limit: number };
    }
  | {
      readonly agentId: string;
      readonly baseVersion: number | null;
      readonly body: AgentVersionBody;
      readonly summary?: string;
    };

/** A refused save names the pipeline's own code, or `pointer_moved` with where `local` is now. */
export type SaveResult =
  | { readonly ok: true; readonly agentId: string; readonly version: number }
  | { readonly ok: false; readonly code: 'pointer_moved'; readonly current: number | null }
  | Extract<CheckResult, { readonly ok: false }>;

export interface AgentStorePort {
  /** The version `local` points at, or `null` for none (or no such agent). */
  localVersion(ctx: CallContext, agentId: string): Promise<number | null>;
  /** How many agents the workspace created at or after `since`: a person, the Builder or an agent. */
  creationsSince(ctx: CallContext, since: Date): Promise<number>;
  /**
   * Saves the draft as the caller with `via: 'builder'` and moves `local` only, never `production`.
   * A `local` that is no longer `baseVersion` leaves the new version unpointed and answers
   * `pointer_moved`. A new agent is written with its first version, its pointer and its
   * `agent-created` row (naming the person and `ctx.runId`) in one transaction; a new version of an
   * existing agent is audited `agent-changed` by the pointer move itself.
   */
  save(ctx: CallContext, req: SaveRequest): Promise<SaveResult>;
}
