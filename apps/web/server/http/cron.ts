/**
 * What every `GET /api/cron/*` route shares: the `Authorization: Bearer $CRON_SECRET` check and the
 * problem answer. Session retention, storage cleanup and trigger schedules each run one such route
 * (refactoring plan part 10, step 3 moved these here from `sessions/retention-cron.ts`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { problemBody } from './result';

/** A problem response from a cron route. */
export function problem(status: number, code: string, message: string): Response {
  return Response.json(problemBody(code, message), { status });
}

/**
 * The one reading of `CRON_SECRET`: trimmed, and `null` when unset or blank. Every driver choice and
 * every bearer check goes through it, so a whitespace-only value is "unset" everywhere alike.
 */
export function cronSecretFrom(env: Readonly<Record<string, string | undefined>>): string | null {
  const trimmed = env['CRON_SECRET']?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Compare digests, so the comparison takes the same time whatever the length of the guess. */
export function bearerMatches(header: string | null, secret: string): boolean {
  const supplied = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(secret));
}
