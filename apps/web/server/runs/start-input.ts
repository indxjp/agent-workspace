import { type ResolvedAttachment } from './attachments';
import type {
  AgentRef,
  RunReadEnvironment,
  RunStartEnvironment,
  RunLimitsOverride,
  RunPrincipal,
} from './environment';
import { type ApprovalCall, type RunIdempotency } from './store';

export interface StartRunBody {
  readonly prompt: string;
  /** Continue an existing session, or omit to start one (spec §19.5 rule 4). */
  readonly sessionId: string | null;
  /**
   * Override the agent's default without mutating its definition (spec §48). Issue #129: a
   * connection and a model are supplied together or not at all — no layer of the resolution
   * ladder may mix a connection from one level with a model from another, and the run override is
   * the top of that ladder.
   */
  readonly modelOverride: { readonly connectionId: string; readonly model: string } | null;
  /** Run a new session on this numbered version instead of `local`'s (issue #697). */
  readonly version?: number;
  /** Workspace files granted to this run read-only (ADR-0146). Resolved by `resolveRunAttachments`. */
  readonly attachments?: readonly { readonly fileId: string }[];
  /** A JSON Schema the run must answer with (ADR-0143); already checked against its limits. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /**
   * Makes this run the continuation of a paused run in `sessionId` (ADR-0145 D2.3): the paused run
   * is completed in the transaction that creates this one, and `approvedToolCalls` is what the
   * decision lets it run.
   */
  readonly decides?: {
    readonly runId: string;
    readonly approvedToolCalls: readonly ApprovalCall[];
  };
  /** The person an API-key caller acts for (ADR-0142 D2); `startRun` has already checked the caller. */
  readonly subject?: string;
  /** Narrows the run's file grants to these paths (issue #1539); judged by compose at launch. */
  readonly fileScope?: readonly string[];
  /** Lowers the run's spend ceiling (ADR-0162); a value above its limit is refused. */
  readonly spendCeilingUsd?: number;
}

export type RunStartInput = Omit<StartRunBody, 'attachments'> & {
  readonly agentVersionId?: string;
  /** The caller's attachments after `resolveRunAttachments` authorised them. */
  readonly attachments?: readonly ResolvedAttachment[];
  /** The start key (ADR-0151); the run row holds it from the moment it is created. */
  readonly idempotency?: RunIdempotency;
  /**
   * Lowers this run's budget or turns below what its policy resolves; it never raises them. Set
   * only by trusted in-process callers: `parseStartRunBody` rejects it in a request body.
   */
  readonly limits?: RunLimitsOverride;
  /**
   * Makes the run a child run of a team's lead run (ADR-0104 acceptance decisions 5 and 6),
   * written once as `parent_run_id`; over `maxChildren` the start is refused
   * `team_member_limit` and nothing is written. Set only by the member endpoint:
   * `parseStartRunBody` rejects it in a request body.
   */
  readonly parent?: { readonly runId: string; readonly maxChildren: number };
  /**
   * The team version a team run's lead runs (ADR-0104 decision 4), written once on insert. Set
   * only by the team run start, never from a request body.
   */
  readonly agentTeamVersionId?: string;
};

export interface RunStartContext {
  readonly env: RunReadEnvironment & RunStartEnvironment;
  readonly principal: RunPrincipal;
  readonly agent: AgentRef;
  readonly input: RunStartInput;
}
