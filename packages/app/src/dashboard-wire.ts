/**
 * The dashboard route's wire (issue #1522): the answer `dashboardRoutes` in `./server` serves and
 * `Dashboard` in `./react` reads. One module, so the two halves cannot drift. Pure Zod, with no
 * server or browser dependency; not a public entry point.
 */
import {
  RUN_STATUSES,
  RunApprovalCallSchema,
  type RunApprovalCall,
  type RunStatus,
} from '@indx-workspace/contracts/runs';
import { z } from 'zod';

/** Where the dashboard route is: `app/api/dashboard/route.ts`. */
export const DASHBOARD_PATH = '/api/dashboard';

/**
 * One run as the dashboard shows it: picked from the platform's run, never its prompt, its output
 * or its usage. `parentRunId` is the lead run of a team member's run (ADR-0104), `null` for a root.
 */
export interface RunSummary {
  readonly id: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly pendingApproval: RunApprovalCall | null;
  readonly cost: { readonly amount: string; readonly currency: string };
  readonly parentRunId: string | null;
}

/** What the person's runs since the start of today cost in one currency. */
export interface DashboardSpend {
  readonly currency: string;
  /** The exact decimal sum of the settled and unsettled amounts so far. */
  readonly amount: string;
  readonly runs: number;
  /** How many of those runs are not settled yet (`accountingState` other than `complete`). */
  readonly unsettled: number;
}

/** Which lists stopped at a page limit, so there are more runs than they show. */
export interface DashboardTruncated {
  readonly running: boolean;
  readonly waiting: boolean;
  readonly failed: boolean;
  readonly spend: boolean;
}

/** `GET /api/dashboard`: J5's four lists, as the signed-in person may see them. */
export interface DashboardSnapshot {
  /** `queued` and `running` runs, newest first. */
  readonly running: readonly RunSummary[];
  /** `awaiting_approval` runs, newest first. */
  readonly waiting: readonly RunSummary[];
  /** `failed` runs created in the last 24 hours, newest first. */
  readonly failed: readonly RunSummary[];
  /** Today's spend by currency, from the start of the day in the app's time zone. */
  readonly spendToday: readonly DashboardSpend[];
  /** The instant the lists were read. */
  readonly asOf: string;
  readonly truncated: DashboardTruncated;
}

const RunSummarySchema: z.ZodType<RunSummary> = z.strictObject({
  id: z.string().min(1),
  agentId: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  createdAt: z.string().min(1),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  pendingApproval: RunApprovalCallSchema.nullable(),
  cost: z.strictObject({ amount: z.string().min(1), currency: z.string().min(1) }),
  parentRunId: z.string().min(1).nullable(),
});

export const DashboardSnapshotSchema: z.ZodType<DashboardSnapshot> = z.strictObject({
  running: z.array(RunSummarySchema),
  waiting: z.array(RunSummarySchema),
  failed: z.array(RunSummarySchema),
  spendToday: z.array(
    z.strictObject({
      currency: z.string().min(1),
      amount: z.string().min(1),
      runs: z.number().int().nonnegative(),
      unsettled: z.number().int().nonnegative(),
    }),
  ),
  asOf: z.string().min(1),
  truncated: z.strictObject({
    running: z.boolean(),
    waiting: z.boolean(),
    failed: z.boolean(),
    spend: z.boolean(),
  }),
});
