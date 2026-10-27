/**
 * `GET /api/readyz` — the web server's readiness probe (issue #1562, owner decision D9).
 *
 * The server boots whatever its configuration, and each subsystem it could not build answers its
 * own named 503. Readiness fails only for a misconfiguration the operator meant to make work and
 * got wrong, so that a rollout stops instead of serving a pod that looks healthy: today that is a
 * `MASTER_ENCRYPTION_KEY` that is set but malformed. An unset key means "secrets are not configured
 * here" and leaves readiness alone. The answer names the variable and the expected format, never
 * the value; the route is unauthenticated, like every probe, and reveals nothing else.
 */
import { MASTER_KEY_EXPECTED_FORMAT } from '@agent-workspace/core/secrets';

import type { ApplicationContext } from './application-context';
import { problemBody } from './http/result';

const NO_STORE = { 'cache-control': 'no-store' };

/** `context` is `null` before the composition root has run; there is nothing to report then. */
export function readiness(context: ApplicationContext | null): Response {
  if (
    context?.secrets.kind === 'unavailable' &&
    context.secrets.reason === 'malformed-master-key'
  ) {
    return Response.json(
      problemBody(
        'service_unavailable',
        `MASTER_ENCRYPTION_KEY is set but malformed. ${MASTER_KEY_EXPECTED_FORMAT}.`,
        ['malformed_master_key'],
      ),
      { status: 503, headers: NO_STORE },
    );
  }
  return Response.json({ status: 'ready' }, { headers: NO_STORE });
}
