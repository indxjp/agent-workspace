/**
 * `GET /api/cron/retention`: session retention driven by Vercel Cron instead of the in-process
 * interval (ADR-0120 clause 7).
 *
 * A function instance does not live long enough for a timer, so on the Vercel target the schedule
 * is `deploy/vercel/vercel.json`'s `crons` entry. Vendor facts, checked 2026-10-08
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs): Vercel sends the cron
 * request as a GET with `Authorization: Bearer $CRON_SECRET` when the project defines
 * `CRON_SECRET`; and delivery can occur more than once
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#duplicate-events), which the per-workspace
 * lease and the idempotent purge already tolerate.
 *
 * The route exists only where `CRON_SECRET` is set. Without it the answer is a 404, so a deployment
 * on any other target exposes nothing; with it, only the exact bearer runs the pass.
 */
import { log } from '../telemetry/logger';

import type { SessionRetentionResult } from './retention';
import { bearerMatches, cronSecretFrom, problem } from '../http/cron';

export type RetentionCronPass = () => Promise<readonly SessionRetentionResult[]>;

/**
 * The retention driver this process runs: `cron` carries the pass `GET /api/cron/retention` runs,
 * `interval` means an in-process timer runs it and the route has nothing to serve.
 */
export type RetentionDriver =
  { readonly kind: 'cron'; readonly pass: RetentionCronPass } | { readonly kind: 'interval' };

/**
 * Pick the one retention driver this process runs: the cron route when `CRON_SECRET` is set (the
 * Vercel target), the in-process interval otherwise. Never both, never neither.
 */
export function wireSessionRetention(
  deps: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    runPass: RetentionCronPass;
    startScheduler: () => void;
  }>,
): RetentionDriver {
  if (cronSecretFrom(deps.env) !== null) return { kind: 'cron', pass: deps.runPass };
  deps.startScheduler();
  return { kind: 'interval' };
}

export async function handleRetentionCron(
  request: Request,
  deps: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    pass: RetentionCronPass | null;
  }>,
): Promise<Response> {
  const secret = cronSecretFrom(deps.env);
  if (secret === null) {
    return problem(404, 'not_found', 'There is nothing at this path.');
  }
  if (!bearerMatches(request.headers.get('authorization'), secret)) {
    return problem(401, 'unauthenticated', 'A valid cron bearer is required.');
  }
  if (deps.pass === null) {
    return problem(
      503,
      'retention_not_configured',
      'Session retention has no store installed in this process.',
    );
  }
  let results: readonly SessionRetentionResult[];
  try {
    results = await deps.pass();
  } catch (error) {
    // SQL and storage text stay in the server log; the caller gets the standard envelope.
    log.error('[retention-cron] pass failed', { error });
    return problem(500, 'internal_error', 'The request could not be completed.');
  }
  const counts = { workspaces: results.length, purged: 0, dryRun: 0, leaseHeld: 0 };
  for (const result of results) {
    if (result.kind === 'purged') counts.purged += 1;
    else if (result.kind === 'dry-run') counts.dryRun += 1;
    else counts.leaseHeld += 1;
  }
  return Response.json(counts, { status: 200 });
}
