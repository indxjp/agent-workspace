import { and, asc, count, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  runs,
  shareRunCharges,
  shareViews,
  shares,
  terminalRunStatuses,
  workspaces,
  type NewShare,
  type Share,
} from '../schema/index.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export type ShareRecord = Share;
export type CreateShareInput = Omit<
  NewShare,
  | 'id'
  | 'workspaceId'
  | 'createdAt'
  | 'spentUsd'
  | 'stopped'
  | 'revokedAt'
  | 'suspendedAt'
  | 'publisherPrincipalId'
  | 'createdBy'
> & {
  readonly publisherPrincipalId: string;
  readonly createdBy?: string | null;
};
export type ReserveShareMessageOutcome =
  | { readonly kind: 'reserved'; readonly share: ShareRecord }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'budget-exhausted'; readonly stoppedNow: boolean }
  | { readonly kind: 'unavailable' };
export type LinkShareRunOutcome =
  { readonly kind: 'linked' } | { readonly kind: 'existing' } | { readonly kind: 'unavailable' };
export interface ShareRepository {
  list(): Promise<readonly ShareRecord[]>;
  get(id: string): Promise<ShareRecord | null>;
  findByToken(token: string): Promise<ShareRecord | null>;
  create(input: CreateShareInput): Promise<ShareRecord>;
  getPublicSharingEnabled(): Promise<boolean>;
  setPublicSharingEnabled(enabled: boolean): Promise<void>;
  revoke(id: string): Promise<boolean>;
  setSuspended(suspended: boolean): Promise<void>;
  stop(id: string): Promise<boolean>;
  reserveVisitorMessage(input: {
    readonly id: string;
    readonly visitorKey: string;
    readonly windowStartedAt: Date;
    readonly now: Date;
    readonly limit: number;
  }): Promise<ReserveShareMessageOutcome>;
  linkRun(id: string, runId: string, now: Date): Promise<LinkShareRunOutcome>;
}

/**
 * How many runs of one public link may be in flight at once. Spend settles while a run works, so
 * `spentUsd < budgetCapUsd` alone admits every concurrent visitor; this bounds a cap's overshoot
 * to the cost of this many runs.
 */
// ponytail: one fixed limit for every share; make it a share setting if publishers need more.
const MAX_IN_FLIGHT_RUNS_PER_SHARE = 3;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The share's linked runs that have not reached a terminal status. Call under the share lock. */
async function countInFlightRuns(
  tx: Transaction,
  workspaceId: string,
  shareId: string,
): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(shareRunCharges)
    .innerJoin(
      runs,
      and(eq(runs.workspaceId, shareRunCharges.workspaceId), eq(runs.id, shareRunCharges.runId)),
    )
    .where(
      and(
        eq(shareRunCharges.workspaceId, workspaceId),
        eq(shareRunCharges.shareId, shareId),
        notInArray(runs.status, [...terminalRunStatuses]),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

export interface ShareRepositoryProvider {
  forScope(scope: WorkspaceScope): ShareRepository;
}
export function createDatabaseShareRepositoryProvider(db: Database): ShareRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ShareRepositoryProvider');
      const within = (id: string) => and(eq(shares.workspaceId, workspaceId), eq(shares.id, id));
      return {
        list: () =>
          db
            .select()
            .from(shares)
            .where(eq(shares.workspaceId, workspaceId))
            .orderBy(asc(shares.createdAt), asc(shares.id)),
        async get(id) {
          return (await db.select().from(shares).where(within(id)).limit(1))[0] ?? null;
        },
        async findByToken(token) {
          return (
            (
              await db
                .select()
                .from(shares)
                .where(and(eq(shares.workspaceId, workspaceId), eq(shares.token, token)))
                .limit(1)
            )[0] ?? null
          );
        },
        async create(input) {
          return (
            await db
              .insert(shares)
              .values({ ...input, workspaceId, createdBy: input.createdBy ?? null })
              .returning()
          )[0]!;
        },
        async getPublicSharingEnabled() {
          const row = (
            await db
              .select({ enabled: workspaces.publicSharingEnabled })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1)
          )[0];
          if (!row) throw new Error(`Workspace ${workspaceId} was not found.`);
          return row.enabled;
        },
        async setPublicSharingEnabled(enabled) {
          await db.transaction(async (tx) => {
            const updated = await tx
              .update(workspaces)
              .set({ publicSharingEnabled: enabled, updatedAt: new Date() })
              .where(eq(workspaces.id, workspaceId))
              .returning({ id: workspaces.id });
            if (updated.length !== 1) throw new Error(`Workspace ${workspaceId} was not found.`);
            await tx
              .update(shares)
              .set({ suspendedAt: enabled ? null : new Date() })
              .where(and(eq(shares.workspaceId, workspaceId), sql`${shares.revokedAt} is null`));
          });
        },
        async revoke(id) {
          return (
            (
              await db
                .update(shares)
                .set({ revokedAt: new Date() })
                .where(and(within(id), sql`${shares.revokedAt} is null`))
                .returning({ id: shares.id })
            ).length === 1
          );
        },
        async setSuspended(suspended) {
          await db
            .update(shares)
            .set({ suspendedAt: suspended ? new Date() : null })
            .where(and(eq(shares.workspaceId, workspaceId), sql`${shares.revokedAt} is null`));
        },
        async stop(id) {
          return db.transaction(async (tx) => {
            const lockKey = `public-share:${workspaceId}:${id}`;
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            return (
              (
                await tx
                  .update(shares)
                  .set({ stopped: true })
                  .where(and(within(id), eq(shares.stopped, false)))
                  .returning({ id: shares.id })
              ).length === 1
            );
          });
        },
        async reserveVisitorMessage(input) {
          if (
            input.visitorKey.length === 0 ||
            input.visitorKey.length > 128 ||
            !Number.isSafeInteger(input.limit) ||
            input.limit < 1 ||
            !Number.isFinite(input.windowStartedAt.getTime()) ||
            !Number.isFinite(input.now.getTime())
          ) {
            throw new Error(
              'A bounded visitor key, valid time window and positive limit are required.',
            );
          }
          return db.transaction(async (tx): Promise<ReserveShareMessageOutcome> => {
            const lockKey = `public-share:${workspaceId}:${input.id}`;
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            const current = (
              await tx
                .select({
                  share: shares,
                  budgetExhausted: sql<boolean>`${shares.budgetCapUsd} is not null and ${shares.spentUsd} >= ${shares.budgetCapUsd}`,
                })
                .from(shares)
                .where(within(input.id))
                .limit(1)
            )[0];
            if (current === undefined) return { kind: 'unavailable' };
            const share = current.share;
            if (
              share.visibility !== 'public' ||
              share.mode !== 'runnable' ||
              share.revokedAt !== null ||
              share.suspendedAt !== null ||
              share.stopped ||
              (share.expiresAt !== null && share.expiresAt.getTime() <= input.now.getTime())
            ) {
              return { kind: 'unavailable' };
            }
            if (share.budgetCapUsd === null) return { kind: 'unavailable' };
            if (current.budgetExhausted) {
              const stopped = await tx
                .update(shares)
                .set({ stopped: true })
                .where(and(within(input.id), eq(shares.stopped, false)))
                .returning({ id: shares.id });
              return { kind: 'budget-exhausted', stoppedNow: stopped.length === 1 };
            }
            const used = Number(
              (
                await tx
                  .select({ value: count() })
                  .from(shareViews)
                  .where(
                    and(
                      eq(shareViews.workspaceId, workspaceId),
                      eq(shareViews.shareId, input.id),
                      eq(shareViews.visitorKey, input.visitorKey),
                      sql`${shareViews.createdAt} >= ${input.windowStartedAt}`,
                    ),
                  )
              )[0]?.value ?? 0,
            );
            if (used >= input.limit) return { kind: 'rate-limited' };
            if (
              (await countInFlightRuns(tx, workspaceId, input.id)) >= MAX_IN_FLIGHT_RUNS_PER_SHARE
            ) {
              return { kind: 'busy' };
            }
            await tx.insert(shareViews).values({
              workspaceId,
              shareId: input.id,
              visitorKey: input.visitorKey,
              createdAt: input.now,
            });
            return { kind: 'reserved', share };
          });
        },
        async linkRun(id, runId, now) {
          if (!Number.isFinite(now.getTime())) throw new Error('share run link time must be valid');
          return db.transaction(async (tx): Promise<LinkShareRunOutcome> => {
            const lockKey = `public-share:${workspaceId}:${id}`;
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            const priorLink = (
              await tx
                .select({
                  shareId: shareRunCharges.shareId,
                  workspaceId: shareRunCharges.workspaceId,
                })
                .from(shareRunCharges)
                .where(eq(shareRunCharges.runId, runId))
                .limit(1)
            )[0];
            if (priorLink !== undefined) {
              if (priorLink.workspaceId === workspaceId && priorLink.shareId === id) {
                return { kind: 'existing' };
              }
              throw new Error(`run ${runId} is already attributed to another public share`);
            }
            const current = (await tx.select().from(shares).where(within(id)).limit(1))[0];
            if (
              current === undefined ||
              current.visibility !== 'public' ||
              current.mode !== 'runnable' ||
              current.budgetCapUsd === null ||
              current.revokedAt !== null ||
              current.suspendedAt !== null ||
              current.stopped ||
              (current.expiresAt !== null && current.expiresAt.getTime() <= now.getTime()) ||
              Number(current.spentUsd) >= Number(current.budgetCapUsd) ||
              (await countInFlightRuns(tx, workspaceId, id)) >= MAX_IN_FLIGHT_RUNS_PER_SHARE
            ) {
              return { kind: 'unavailable' };
            }
            const run = (
              await tx
                .select({
                  id: runs.id,
                  accountingState: runs.accountingState,
                  costUsd: runs.costUsd,
                })
                .from(runs)
                .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
                .limit(1)
            )[0];
            if (
              run === undefined ||
              run.accountingState !== 'pending' ||
              Number(run.costUsd) !== 0
            ) {
              return { kind: 'unavailable' };
            }
            const inserted = await tx
              .insert(shareRunCharges)
              .values({ workspaceId, shareId: id, runId })
              .onConflictDoNothing({ target: shareRunCharges.runId })
              .returning({ runId: shareRunCharges.runId });
            if (inserted.length === 1) return { kind: 'linked' };
            const existing = (
              await tx
                .select({ shareId: shareRunCharges.shareId })
                .from(shareRunCharges)
                .where(
                  and(
                    eq(shareRunCharges.workspaceId, workspaceId),
                    eq(shareRunCharges.runId, runId),
                  ),
                )
                .limit(1)
            )[0];
            if (existing?.shareId === id) return { kind: 'existing' };
            throw new Error(`run ${runId} is already attributed to another public share`);
          });
        },
      };
    },
  };
}

export interface ShareViewRepository {
  record(shareId: string, visitorKey?: string): Promise<void>;
  count(shareId: string): Promise<number>;
  countVisitorSince(shareId: string, visitorKey: string, since: Date): Promise<number>;
}
export interface ShareViewRepositoryProvider {
  forScope(scope: WorkspaceScope): ShareViewRepository;
}
export function createDatabaseShareViewRepositoryProvider(
  db: Database,
): ShareViewRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ShareViewRepositoryProvider');
      return {
        async record(shareId, visitorKey) {
          await db.insert(shareViews).values({ workspaceId, shareId, visitorKey });
        },
        async count(shareId) {
          return Number(
            (
              await db
                .select({ value: count() })
                .from(shareViews)
                .where(
                  and(eq(shareViews.workspaceId, workspaceId), eq(shareViews.shareId, shareId)),
                )
            )[0]?.value ?? 0,
          );
        },
        async countVisitorSince(shareId, visitorKey, since) {
          return Number(
            (
              await db
                .select({ value: count() })
                .from(shareViews)
                .where(
                  and(
                    eq(shareViews.workspaceId, workspaceId),
                    eq(shareViews.shareId, shareId),
                    eq(shareViews.visitorKey, visitorKey),
                    sql`${shareViews.createdAt} >= ${since}`,
                  ),
                )
            )[0]?.value ?? 0,
          );
        },
      };
    },
  };
}
