import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/**
 * The Agent Store's public demo (internal spec, "How Try it works" and "Abuse controls"): the words
 * the platform and the store share about a visitor's demo workspace and the caps on its runs.
 *
 * A visitor picks a catalog entry; the entry's slug names the demo template the provisioner copies
 * into the visitor's own demo workspace. Every demo run start is checked against three caps (runs
 * per person, runs per client address, and the whole site's model cost today) and every demo run is
 * bounded by two more (turns and cost, set on the copied agent). A start refused by a cap is a
 * typed `429` (or `503` when the caps are not configured), and the store shows the recording with
 * the reason {@link demoFallbackReason} names; it never shows the internal detail.
 */

/** A catalog entry's slug, as the store sends it to name the demo the visitor chose. */
export const DEMO_ENTRY_SLUG_MAX_LENGTH = 64;
export const DemoEntrySlugSchema = z
  .string()
  .max(DEMO_ENTRY_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'must be a catalog entry slug');
export type DemoEntrySlug = z.infer<typeof DemoEntrySlugSchema>;

/**
 * The slug of the workspace a deployment fills with one entry's demo agent and its `demo.seed`
 * sample data. The provisioner copies from it and never runs in it.
 */
export function demoTemplateWorkspaceSlug(entry: DemoEntrySlug): string {
  return `${DEMO_TEMPLATE_SLUG_PREFIX}${entry}`;
}

/**
 * The slug prefix of every demo template workspace. It is reserved: `POST /api/workspaces` refuses a
 * slug that starts with it, so only the deployment's own seeding step can make a template, and a
 * person cannot squat an entry's template slug.
 */
export const DEMO_TEMPLATE_SLUG_PREFIX = 'demo-template-';

/** Whether `slug` is in the reserved demo-template namespace ({@link DEMO_TEMPLATE_SLUG_PREFIX}). */
export function isDemoTemplateWorkspaceSlug(slug: string): boolean {
  return slug.trim().toLowerCase().startsWith(DEMO_TEMPLATE_SLUG_PREFIX);
}

/** Fixed by the spec: one person starts at most this many demo runs in {@link DEMO_RUN_WINDOW_SECONDS}. */
export const DEMO_RUNS_PER_PERSON_PER_DAY = 20;

/** The window the per-person and per-client run counts look back over: a rolling 24 hours. */
export const DEMO_RUN_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * The recommended default for runs started from one client address in
 * {@link DEMO_RUN_WINDOW_SECONDS}, across every account it signs in as
 * (`AW_DEMO_RUNS_PER_CLIENT_PER_DAY` overrides it).
 */
export const DEMO_RUNS_PER_CLIENT_PER_DAY = 60;

/**
 * The run-start refusals of a demo workspace, each with its HTTP status. They join
 * `RUN_START_PROBLEM_CODES`:
 *
 * - `demo_person_runs_reached` — the person has started {@link DEMO_RUNS_PER_PERSON_PER_DAY} (or the
 *   configured number of) demo runs in the last 24 hours.
 * - `demo_client_runs_reached` — the client address has started its configured number of demo runs
 *   in the last 24 hours, whichever accounts started them.
 * - `demo_site_cost_reached` — the whole site's demo model cost today (UTC) has reached the
 *   configured daily cap, so no demo run starts until the next UTC midnight.
 * - `demo_caps_unconfigured` — a cap the spec leaves to configuration is not set, so no demo run
 *   starts at all (fail closed).
 * - `demo_expired` — the demo workspace's end (`workspaces.demo_expires_at`) has passed, so nothing
 *   more runs in it, even before the retention sweep deletes it.
 */
export const DEMO_RUN_START_PROBLEM_CODES = {
  demo_person_runs_reached: 429,
  demo_client_runs_reached: 429,
  demo_site_cost_reached: 429,
  demo_caps_unconfigured: 503,
  demo_expired: 409,
} as const;
export type DemoRunStartProblemCode = keyof typeof DEMO_RUN_START_PROBLEM_CODES;

/**
 * Why the store shows the recording instead of a live run, in the words the visitor reads: the
 * person's or the run's count, the cost, the load from one address, or the demo being unavailable.
 */
export const DEMO_FALLBACK_REASONS = ['count', 'cost', 'load', 'unavailable'] as const;
export const DemoFallbackReasonSchema = z.enum(DEMO_FALLBACK_REASONS);
export type DemoFallbackReason = z.infer<typeof DemoFallbackReasonSchema>;

/** A run's own stop at its per-run caps, as the run API reports it. */
const RUN_CAP_REASONS: Readonly<Record<string, DemoFallbackReason>> = {
  /** The run's stored error code when the gateway stopped it at its spend ceiling. */
  run_budget_reached: 'cost',
  /** The run's stop reason when it used its turns. */
  max_turns: 'count',
};

const START_REASONS: Readonly<Record<DemoRunStartProblemCode, DemoFallbackReason>> = {
  demo_person_runs_reached: 'count',
  demo_client_runs_reached: 'load',
  demo_site_cost_reached: 'cost',
  demo_caps_unconfigured: 'unavailable',
  demo_expired: 'unavailable',
};

/**
 * The reason to show for a demo start refusal code, or for a run that stopped at a per-run cap
 * (`run_budget_reached`, `max_turns`); `null` for anything else, which is not a cap.
 */
export function demoFallbackReason(code: string): DemoFallbackReason | null {
  if (Object.hasOwn(START_REASONS, code)) return START_REASONS[code as DemoRunStartProblemCode];
  return Object.hasOwn(RUN_CAP_REASONS, code) ? (RUN_CAP_REASONS[code] ?? null) : null;
}

/**
 * What a demo agent's tool that would send or write outside answers instead. Nothing leaves the
 * demo; the visitor reads that it did not.
 */
export const DEMO_SEND_RESULT = Object.freeze({
  ja: '送信しました（デモのため、実際には送信していません）',
  en: 'Sent (demo only, nothing was actually sent)',
});

/**
 * `GET /api/demo/allowance`: what the signed-in guest's demo has left, for the store to show
 * ("18 of 20 runs left") and never type in. Answered only to a session whose workspace is a demo
 * workspace; any other is `404 demo_workspace_not_found`.
 *
 * - `runsPerDay` — the person's configured runs per 24 hours (`AW_DEMO_RUNS_PER_PERSON_PER_DAY`).
 * - `runsLeft` — how many more the person may start now; `0` once the cap is reached.
 * - `expiresAt` — when the demo workspace and everything in it is deleted
 *   (`workspaces.demo_expires_at`).
 */
export const DEMO_ALLOWANCE_PATH = '/api/demo/allowance';
export const DemoAllowanceSchema = z
  .object({
    runsPerDay: z.number().int().min(1),
    runsLeft: z.number().int().min(0),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type DemoAllowance = z.infer<typeof DemoAllowanceSchema>;

/** The refusals of `GET /api/demo/allowance`, each with its HTTP status. */
export const DEMO_ALLOWANCE_PROBLEM_CODES = {
  unauthenticated: 401,
  demo_workspace_not_found: 404,
} as const;
export type DemoAllowanceProblemCode = keyof typeof DEMO_ALLOWANCE_PROBLEM_CODES;

/**
 * `GET /api/store/privacy`: the facts the store's privacy notice states that only the platform's
 * configuration knows, so the page never types them in. Public (no session); the store reads it
 * from its own server when it renders the notice.
 *
 * - `leadRetentionDays` — how long a lead is kept after its last contact
 *   (`AW_STORE_LEAD_RETENTION_DAYS`); `null` while the period is not decided, and the page then
 *   says it is to be set.
 * - `demoWorkspaceHours` — how long a demo workspace and everything typed in it lasts.
 */
export const STORE_PRIVACY_PATH = '/api/store/privacy';
export const StorePrivacyFactsSchema = z
  .object({
    leadRetentionDays: z.number().int().min(1).nullable(),
    demoWorkspaceHours: z.number().int().min(1),
  })
  .strict()
  .readonly();
export type StorePrivacyFacts = z.infer<typeof StorePrivacyFactsSchema>;

/**
 * `GET /api/store/demos`: the live entries whose demo is under maintenance, for the store to show on
 * the card and the Try tab. Public (no session), like `GET /api/store/privacy`.
 */
export const STORE_DEMOS_PATH = '/api/store/demos';
export const StoreDemoStatesSchema = z
  .strictObject({ maintenance: z.array(DemoEntrySlugSchema).readonly() })
  .readonly();
export type StoreDemoStates = z.infer<typeof StoreDemoStatesSchema>;
