/**
 * The demo sweeps' rules: pure functions and named limits, no I/O (AGENTS.md, hexagonal rule 1).
 * Time is an argument, never read here.
 */
import { DEMO_RUN_WINDOW_SECONDS } from '@indx-workspace/contracts/demo';

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;

/** The most demo workspaces one sweep deletes, so one pass never holds the maintenance lease for long. */
export const DEMO_SWEEP_WORKSPACES_PER_PASS = 50;

/** The sweep runs at most this often in one process; the trigger cron and the timer share the marker. */
export const DEMO_SWEEP_MIN_INTERVAL_MS = 5 * 60 * MS_PER_SECOND;

/** The maintenance lease the sweep holds while it deletes, and how long before another replica may take it. */
export const DEMO_SWEEP_LEASE_NAME = 'demo-sweep';
export const DEMO_SWEEP_LEASE_TTL_MS = 10 * 60 * MS_PER_SECOND;

/**
 * A used or expired login link is kept this long, so the per-address issue limit (which counts
 * links by when they were made) never loses a row it still reads.
 */
const LOGIN_TOKEN_KEEP_SECONDS = DEMO_RUN_WINDOW_SECONDS;

/** Admissions older than this no longer count toward any cap: the caps' own look-back window. */
const ADMISSION_KEEP_SECONDS = DEMO_RUN_WINDOW_SECONDS;

/** Links that expired, or were used, before this are deleted. */
export function loginTokenCutoff(now: Date): Date {
  return new Date(now.getTime() - LOGIN_TOKEN_KEEP_SECONDS * MS_PER_SECOND);
}

/** Admissions made before this are deleted. */
export function admissionCutoff(now: Date): Date {
  return new Date(now.getTime() - ADMISSION_KEEP_SECONDS * MS_PER_SECOND);
}

/** Leads last contacted before this are deleted, for a retention period of `retentionDays`. */
export function leadCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}
