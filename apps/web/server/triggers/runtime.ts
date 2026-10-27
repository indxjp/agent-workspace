/**
 * The seam between `/api/triggers` (issue #1293, ADR-0144) and the database layer: the trigger
 * repository of a workspace, the unscoped lookup the public fire route starts from, the owner
 * principal a firing acts as, and the write-only Zoom secret token. The same shape as
 * `endpoint-clients/runtime.ts`, for the same reason: `apps/web/server/rbac/**` knows no triggers.
 *
 * The composition root installs it as `ApplicationContext.triggers`. A firing starts a run, so it is
 * `disabled` until the run runtime is wired and stays `disabled` on a deployment with no runtime at
 * all; the routes then answer their named 503, as they do with no context installed.
 */
import type { TriggerKind } from '@indx-workspace/contracts/triggers';

import type { Ownership } from '../rbac/decide';
import type { Principal } from '../rbac/principal';

/**
 * A trigger as this domain reads it. The repository in `@agent-workspace/core/db` satisfies these
 * shapes structurally; only `store.ts` names it (F-15).
 */
export interface TriggerRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly name: string;
  readonly kind: TriggerKind;
  readonly promptTemplate: string;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly enabled: boolean;
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly subject: string | null;
  readonly ownerPrincipalId: string;
  readonly hasSecret: boolean;
  readonly lastFiredAt: Date | null;
  readonly scheduleFrom: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface NewTriggerBase {
  readonly agentId: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly ownerPrincipalId: string;
  readonly enabled?: boolean | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly subject?: string | undefined;
}

type NewTriggerInput =
  | (NewTriggerBase & { readonly kind: 'webhook'; readonly secretHash: string })
  | (NewTriggerBase & {
      readonly kind: 'schedule';
      readonly cron: string;
      readonly timezone: string;
    });

interface TriggerPatch {
  readonly name?: string | undefined;
  readonly promptTemplate?: string | undefined;
  readonly cron?: string | undefined;
  readonly timezone?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | null | undefined;
  readonly subject?: string | null | undefined;
}

/** The trigger repository of one workspace. Semantics are documented on the core repository. */
interface TriggerRepository {
  list(): Promise<readonly TriggerRecord[]>;
  get(id: string): Promise<TriggerRecord | null>;
  create(
    input: NewTriggerInput,
  ): Promise<
    | { kind: 'created'; trigger: TriggerRecord }
    | { kind: 'name-taken' }
    | { kind: 'agent-not-found' }
    | { kind: 'owner-not-found' }
  >;
  update(
    id: string,
    patch: TriggerPatch,
  ): Promise<
    | { kind: 'updated'; trigger: TriggerRecord }
    | { kind: 'not-found' }
    | { kind: 'name-taken' }
    | { kind: 'invalid-shape' }
  >;
  setSecretHash(
    id: string,
    secretHash: string,
  ): Promise<
    { kind: 'set'; trigger: TriggerRecord } | { kind: 'not-found' } | { kind: 'not-webhook' }
  >;
  countDeliveriesSince(triggerId: string, since: Date): Promise<number>;
  countUnfinishedRuns(triggerId: string): Promise<number>;
  markFired(id: string, at: Date): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  claimDelivery(
    triggerId: string,
    key: string,
    now: Date,
  ): Promise<
    | { readonly kind: 'claimed' }
    | { readonly kind: 'duplicate'; readonly runId: string | null }
    | { readonly kind: 'trigger-not-found' }
  >;
  recordDeliveryRun(triggerId: string, key: string, runId: string): Promise<boolean>;
  releaseDelivery(triggerId: string, key: string): Promise<boolean>;
  pruneDeliveries(now: Date): Promise<number>;
}

/** What the public fire route reads about the trigger a URL names, before it knows the workspace. */
interface TriggerForIngress {
  readonly trigger: TriggerRecord;
  readonly secretHash: string | null;
}

/**
 * A Zoom app secret token is a secret, so it lives in the secrets service under a name derived from
 * the trigger and never in a trigger row or a response.
 */
export interface ZoomSecretTokens {
  /** Which of `triggerIds` have a token stored. */
  configured(workspaceId: string, triggerIds: readonly string[]): Promise<ReadonlySet<string>>;
  set(workspaceId: string, triggerId: string, token: string): Promise<void>;
  clear(workspaceId: string, triggerId: string): Promise<void>;
  read(workspaceId: string, triggerId: string): Promise<string | null>;
}

export interface TriggersRuntime {
  /** The triggers of `workspaceId`; a row of another workspace is as absent as one never created. */
  repository(workspaceId: string): Promise<TriggerRepository>;
  /** The trigger a fire URL names, in whatever workspace it lives. */
  findForIngress(triggerId: string): Promise<TriggerForIngress | null>;
  /** The member `principalId` as a principal, or `null` once the membership is revoked or removed. */
  owner(workspaceId: string, principalId: string): Promise<Principal | null>;
  /** Whether `principal` may run `agentId`, as `decide()` reads it for `POST /api/agents/:id/runs`. */
  agentOwnership(principal: Principal, agentId: string): Promise<Ownership>;
  /** `null` when the deployment has no secrets service. */
  readonly zoomTokens: ZoomSecretTokens | null;
  now(): Date;
}

/** The trigger routes as the application context holds them. */
export type Triggers =
  { readonly kind: 'serving'; readonly runtime: TriggersRuntime } | { readonly kind: 'disabled' };
