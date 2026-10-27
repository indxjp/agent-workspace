import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  isNull,
  lte,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type { Database } from '../client.js';
import { runs, terminalRunStatuses } from '../schema/runs.js';
import { triggerDeliveries } from '../schema/trigger-deliveries.js';
import { triggers, type Trigger, type TriggerKind } from '../schema/triggers.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

/** How long a delivery key stays claimed (ADR-0144 D4). After it, the same key may fire again. */
export const TRIGGER_DELIVERY_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /** The schema every run of this trigger answers in, or `null` (ADR-0154). */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  /** The caller every run of this trigger acts for, or `null` (ADR-0156). */
  readonly subject: string | null;
  readonly ownerPrincipalId: string;
  /** Whether a webhook secret is set. The hash itself never leaves the repository. */
  readonly hasSecret: boolean;
  readonly lastFiredAt: Date | null;
  /** When counting due schedule slots last restarted: re-enabled, or cron or time zone changed. */
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

export type NewTriggerInput =
  | (NewTriggerBase & {
      readonly kind: 'webhook';
      /** SHA-256 hex of the URL secret, computed by the caller. */
      readonly secretHash: string;
    })
  | (NewTriggerBase & {
      readonly kind: 'schedule';
      readonly cron: string;
      readonly timezone: string;
    });

interface TriggerPatch {
  readonly name?: string | undefined;
  readonly promptTemplate?: string | undefined;
  /** `schedule` triggers only; a webhook refuses it as `invalid-shape`. */
  readonly cron?: string | undefined;
  readonly timezone?: string | undefined;
  readonly enabled?: boolean | undefined;
  /** An object replaces the schema, `null` clears it, `undefined` keeps it. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | null | undefined;
  /** A string replaces the subject, `null` clears it, `undefined` keeps it. */
  readonly subject?: string | null | undefined;
}

type DeliveryClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'duplicate'; readonly runId: string | null }
  | { readonly kind: 'trigger-not-found' };

export interface TriggerRepository {
  list(): Promise<readonly TriggerRecord[]>;
  get(id: string): Promise<TriggerRecord | null>;
  /**
   * `agent-not-found` / `owner-not-found` for an id that is absent or belongs to another workspace;
   * nothing is written then.
   */
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
  /** Replace the webhook secret's hash. Throws on a value that is not SHA-256 hex. */
  setSecretHash(
    id: string,
    secretHash: string,
  ): Promise<
    { kind: 'set'; trigger: TriggerRecord } | { kind: 'not-found' } | { kind: 'not-webhook' }
  >;
  /** Deliveries of `triggerId` claimed at or after `since` (the rate limit's window). */
  countDeliveriesSince(triggerId: string, since: Date): Promise<number>;
  /** Deliveries of `triggerId` whose run has not reached a terminal status (the concurrency cap). */
  countUnfinishedRuns(triggerId: string): Promise<number>;
  /** Record a firing. `lastFiredAt` only moves forward. `false` when the trigger is absent. */
  markFired(id: string, at: Date): Promise<boolean>;
  /** Also removes the trigger's deliveries. `false` when absent. */
  remove(id: string): Promise<boolean>;
  /**
   * Claim `(trigger, key)` in one statement. A key claimed within
   * {@link TRIGGER_DELIVERY_DEDUPE_WINDOW_MS} of `now` is a `duplicate` (with the first firing's run
   * id once recorded); an older claim is reclaimed in place.
   */
  claimDelivery(triggerId: string, key: string, now: Date): Promise<DeliveryClaim>;
  /** Name the run a claim started. Only a claim that has no run yet is written. */
  recordDeliveryRun(triggerId: string, key: string, runId: string): Promise<boolean>;
  /** Free a claim so a failed firing can be retried with the same key (ADR-0144 D8). */
  releaseDelivery(triggerId: string, key: string): Promise<boolean>;
  /**
   * Delete the deliveries claimed more than {@link TRIGGER_DELIVERY_DEDUPE_WINDOW_MS} before `now`,
   * except those whose run is still unfinished (the concurrency cap counts them). Returns how many.
   */
  pruneDeliveries(now: Date): Promise<number>;
}

export interface TriggerRepositoryProvider {
  forScope(scope: WorkspaceScope): TriggerRepository;
}

/** What the public fire route reads about the trigger a URL names, before it knows the workspace. */
export interface TriggerForIngress {
  readonly trigger: TriggerRecord;
  readonly secretHash: string | null;
}

/**
 * The trigger an id names, in whatever workspace it lives, with the hash of its URL secret. The
 * public ingress is the only caller: the URL carries a trigger id and a secret, never a workspace.
 * The caller re-scopes by `trigger.workspaceId` for every query after this one.
 */
export async function findTriggerForIngress(
  db: Database,
  id: string,
): Promise<TriggerForIngress | null> {
  const rows = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : { trigger: toRecord(row), secretHash: row.secretHash };
}

function toRecord(row: Trigger): TriggerRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    name: row.name,
    kind: row.kind,
    promptTemplate: row.promptTemplate,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    outputSchema: row.outputSchema,
    subject: row.subject,
    ownerPrincipalId: row.ownerPrincipalId,
    hasSecret: row.secretHash !== null,
    lastFiredAt: row.lastFiredAt,
    scheduleFrom: row.scheduleFrom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function violatedConstraints(error: unknown): Set<string> {
  return new Set([...postgresViolations(error)].map((violation) => violation.constraint));
}

export function createDatabaseTriggerRepositoryProvider(db: Database): TriggerRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'TriggerRepositoryProvider');
      const inScope = (id: string) =>
        and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id));
      const deliveryOf = (triggerId: string, key: string) =>
        and(
          eq(triggerDeliveries.workspaceId, workspaceId),
          eq(triggerDeliveries.triggerId, triggerId),
          eq(triggerDeliveries.deliveryKey, key),
        );

      return {
        async list() {
          const rows = await db
            .select()
            .from(triggers)
            .where(eq(triggers.workspaceId, workspaceId))
            .orderBy(asc(triggers.name));
          return rows.map(toRecord);
        },
        async get(id) {
          const rows = await db.select().from(triggers).where(inScope(id)).limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },
        async create(input) {
          try {
            const inserted = await db
              .insert(triggers)
              .values({
                workspaceId,
                agentId: input.agentId,
                name: input.name,
                kind: input.kind,
                promptTemplate: input.promptTemplate,
                ownerPrincipalId: input.ownerPrincipalId,
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
                ...(input.outputSchema === undefined
                  ? {}
                  : { outputSchema: { ...input.outputSchema } }),
                ...(input.subject === undefined ? {} : { subject: input.subject }),
                ...(input.kind === 'webhook'
                  ? { secretHash: input.secretHash }
                  : { cron: input.cron, timezone: input.timezone }),
              })
              .returning();
            const row = inserted[0];
            if (row === undefined) throw new Error('trigger insert returned no row');
            return { kind: 'created' as const, trigger: toRecord(row) };
          } catch (error) {
            const violated = violatedConstraints(error);
            if (violated.has('triggers_workspace_name_key')) return { kind: 'name-taken' as const };
            if (violated.has('triggers_agent_workspace_fk')) {
              return { kind: 'agent-not-found' as const };
            }
            if (violated.has('triggers_owner_workspace_fk')) {
              return { kind: 'owner-not-found' as const };
            }
            throw error;
          }
        },
        async update(id, patch) {
          // Enabling a disabled schedule, or changing when it fires, restarts its counting now, so
          // it owes no catch-up run for the windows before (ADR-0144).
          const restarts = [
            ...(patch.enabled === true ? [not(triggers.enabled)] : []),
            ...(patch.cron === undefined
              ? []
              : [sql`${triggers.cron} is distinct from ${patch.cron}`]),
            ...(patch.timezone === undefined
              ? []
              : [sql`${triggers.timezone} is distinct from ${patch.timezone}`]),
          ];
          try {
            const updated = await db
              .update(triggers)
              .set({
                updatedAt: sql`now()`,
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.promptTemplate === undefined
                  ? {}
                  : { promptTemplate: patch.promptTemplate }),
                ...(patch.cron === undefined ? {} : { cron: patch.cron }),
                ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
                ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                ...(patch.outputSchema === undefined
                  ? {}
                  : {
                      outputSchema: patch.outputSchema === null ? null : { ...patch.outputSchema },
                    }),
                ...(patch.subject === undefined ? {} : { subject: patch.subject }),
                ...(restarts.length === 0
                  ? {}
                  : {
                      scheduleFrom: sql`case when ${or(...restarts)} then now() else ${triggers.scheduleFrom} end`,
                    }),
              })
              .where(inScope(id))
              .returning();
            const row = updated[0];
            return row === undefined
              ? { kind: 'not-found' as const }
              : { kind: 'updated' as const, trigger: toRecord(row) };
          } catch (error) {
            const violated = violatedConstraints(error);
            if (violated.has('triggers_workspace_name_key')) return { kind: 'name-taken' as const };
            if (violated.has('triggers_kind_shape')) return { kind: 'invalid-shape' as const };
            throw error;
          }
        },
        async setSecretHash(id, secretHash) {
          const updated = await db
            .update(triggers)
            .set({ secretHash, updatedAt: sql`now()` })
            .where(and(inScope(id), eq(triggers.kind, 'webhook')))
            .returning();
          const row = updated[0];
          if (row !== undefined) return { kind: 'set' as const, trigger: toRecord(row) };
          const existing = await db
            .select({ id: triggers.id })
            .from(triggers)
            .where(inScope(id))
            .limit(1);
          return existing.length === 0
            ? { kind: 'not-found' as const }
            : { kind: 'not-webhook' as const };
        },
        async countDeliveriesSince(triggerId, since) {
          const rows = await db
            .select({ total: count() })
            .from(triggerDeliveries)
            .where(
              and(
                eq(triggerDeliveries.workspaceId, workspaceId),
                eq(triggerDeliveries.triggerId, triggerId),
                gte(triggerDeliveries.createdAt, since),
              ),
            );
          return rows[0]?.total ?? 0;
        },
        async countUnfinishedRuns(triggerId) {
          const rows = await db
            .select({ total: count() })
            .from(triggerDeliveries)
            .innerJoin(
              runs,
              and(
                eq(runs.id, triggerDeliveries.runId),
                eq(runs.workspaceId, triggerDeliveries.workspaceId),
              ),
            )
            .where(
              and(
                eq(triggerDeliveries.workspaceId, workspaceId),
                eq(triggerDeliveries.triggerId, triggerId),
                notInArray(runs.status, [...terminalRunStatuses]),
              ),
            );
          return rows[0]?.total ?? 0;
        },
        async markFired(id, at) {
          const updated = await db
            .update(triggers)
            .set({
              lastFiredAt: sql`greatest(coalesce(${triggers.lastFiredAt}, ${at}::timestamptz), ${at}::timestamptz)`,
            })
            .where(inScope(id))
            .returning({ id: triggers.id });
          return updated.length > 0;
        },
        async remove(id) {
          const removed = await db
            .delete(triggers)
            .where(inScope(id))
            .returning({ id: triggers.id });
          return removed.length > 0;
        },
        async claimDelivery(triggerId, key, now) {
          const cutoff = new Date(now.getTime() - TRIGGER_DELIVERY_DEDUPE_WINDOW_MS);
          try {
            const claimed = await db
              .insert(triggerDeliveries)
              .values({ workspaceId, triggerId, deliveryKey: key, createdAt: now })
              .onConflictDoUpdate({
                target: [
                  triggerDeliveries.workspaceId,
                  triggerDeliveries.triggerId,
                  triggerDeliveries.deliveryKey,
                ],
                set: { createdAt: now, runId: null },
                setWhere: lte(triggerDeliveries.createdAt, cutoff),
              })
              .returning({ id: triggerDeliveries.id });
            if (claimed.length > 0) return { kind: 'claimed' as const };
          } catch (error) {
            if (violatedConstraints(error).has('trigger_deliveries_trigger_workspace_fk')) {
              return { kind: 'trigger-not-found' as const };
            }
            throw error;
          }
          const existing = await db
            .select({ runId: triggerDeliveries.runId })
            .from(triggerDeliveries)
            .where(deliveryOf(triggerId, key))
            .limit(1);
          return { kind: 'duplicate' as const, runId: existing[0]?.runId ?? null };
        },
        async recordDeliveryRun(triggerId, key, runId) {
          const updated = await db
            .update(triggerDeliveries)
            .set({ runId })
            .where(and(deliveryOf(triggerId, key), isNull(triggerDeliveries.runId)))
            .returning({ id: triggerDeliveries.id });
          return updated.length > 0;
        },
        async releaseDelivery(triggerId, key) {
          const released = await db
            .delete(triggerDeliveries)
            .where(deliveryOf(triggerId, key))
            .returning({ id: triggerDeliveries.id });
          return released.length > 0;
        },
        async pruneDeliveries(now) {
          const cutoff = new Date(now.getTime() - TRIGGER_DELIVERY_DEDUPE_WINDOW_MS);
          const unfinishedRun = db
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                eq(runs.id, triggerDeliveries.runId),
                eq(runs.workspaceId, triggerDeliveries.workspaceId),
                notInArray(runs.status, [...terminalRunStatuses]),
              ),
            );
          const pruned = await db
            .delete(triggerDeliveries)
            .where(
              and(
                eq(triggerDeliveries.workspaceId, workspaceId),
                lte(triggerDeliveries.createdAt, cutoff),
                not(exists(unfinishedRun)),
              ),
            )
            .returning({ id: triggerDeliveries.id });
          return pruned.length;
        },
      };
    },
  };
}
