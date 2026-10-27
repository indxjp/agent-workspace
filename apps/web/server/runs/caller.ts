import type { IdentityPrincipalKind } from '@indx-workspace/contracts/identity-assertion';

import type { RunPrincipal } from './environment';

/** Who a run acts for, as an opted-in connector is told (ADR-0142 D1, D2). */
export interface RunCaller {
  readonly sub: string;
  readonly principalKind: IdentityPrincipalKind;
}

/**
 * The caller identity of a run, or `null` when none can be asserted. A `subject` is always asserted
 * as an `api-key` caller and is signed unchecked, so its safety rests on the caller. Invariant: the
 * only sources of a `subject` are an API-key `POST /api/agents/:id/runs` (the `run_subject_forbidden`
 * gate refuses one from anything but a key, ADR-0142 D2), a stored trigger `subject`, which only
 * a member who may mint API keys can set or keep (`trigger_subject_not_allowed`, ADR-0156), and the
 * stored `subject` of the run an approval continues, which only that run's own start supplied
 * (ADR-0157; the approval body never carries one). A new run starter (A2A, evaluations, ...) must
 * not forward a subject it did not read from one of these. Without a
 * subject, a signed-in member is its own principal. Everything else (an API key with no subject, a
 * browser token minted by a key, a principal that predates `via`/`kind`) is `null`, so a connector
 * that asked for an identity is never dialled without one.
 */
export function runCallerOf(
  principal: RunPrincipal,
  subject: string | undefined,
): RunCaller | null {
  if (subject !== undefined) return { sub: subject, principalKind: 'api-key' };
  if (principal.via !== 'api-key' && principal.kind === 'membership') {
    return { sub: principal.principalId, principalKind: 'membership' };
  }
  return null;
}
