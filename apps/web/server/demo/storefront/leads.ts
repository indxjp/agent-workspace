/**
 * The store's lead form (`POST /api/store/leads`; internal spec, "The store app and how it reaches
 * the platform"): an enquiry or a launch-notice request from a visitor who has not signed in.
 *
 * Order, cheapest first, as the email-link sign-in orders it: the deployment can take a lead at all
 * (a challenge is configured), the per-client limit, the challenge, then the disposable-email
 * blocklist. A blocked address is answered as received and keeps nothing, so a caller cannot tell
 * it from a kept one. Time comes from the `Clock`.
 */
import type { StoreLeadRequest, StoreLeadProblemCode } from '@indx-workspace/contracts/email-link';

import type { ClientIdentitySettings } from '../../client-identity';
import type { Clock } from '../../clock';
import type { ChallengeVerifier, DisposableEmailList } from '../../identity';
import { admitClient, perMinuteLimiter } from '../../http/rate-limit';
import type { LeadStore } from '../ports';

/** Leads one client address may send per minute. */
export const STORE_LEADS_PER_MINUTE_PER_CLIENT = 5;

type StoreLeadOutcome =
  | { readonly kind: 'received' }
  | {
      readonly kind: 'refused';
      readonly code: Exclude<StoreLeadProblemCode, 'invalid_body'>;
      readonly retryAfterSeconds?: number;
    };

/** The lead form's use case. */
export interface StoreLeadService {
  submit(request: StoreLeadRequest, headers: Headers): Promise<StoreLeadOutcome>;
}

export interface StoreLeadDependencies {
  readonly clock: Clock;
  readonly clientIdentity: ClientIdentitySettings;
  /** `null` when no challenge is configured: every lead is refused `store_lead_unavailable`. */
  readonly challenge: ChallengeVerifier | null;
  readonly disposable: DisposableEmailList;
  readonly leads: LeadStore;
}

export function createStoreLeadService(deps: StoreLeadDependencies): StoreLeadService {
  const limiter = perMinuteLimiter(STORE_LEADS_PER_MINUTE_PER_CLIENT);
  return {
    async submit(request, headers) {
      const verifier = deps.challenge;
      if (verifier === null) return { kind: 'refused', code: 'store_lead_unavailable' };
      const now = deps.clock.now();
      const admission = admitClient(
        limiter,
        STORE_LEADS_PER_MINUTE_PER_CLIENT,
        headers,
        now.getTime(),
        deps.clientIdentity,
      );
      if (!admission.admitted) {
        return {
          kind: 'refused',
          code: 'store_lead_rate_limited',
          retryAfterSeconds: admission.retryAfterSeconds,
        };
      }
      if ((await verifier.verify(request.challenge, headers)) !== 'pass') {
        return { kind: 'refused', code: 'store_lead_challenge_failed' };
      }
      const email = request.email.trim().toLowerCase();
      if (deps.disposable.isDisposable(email)) return { kind: 'received' };
      if (request.kind === 'launch_notice') {
        await deps.leads.recordLaunchNotice({ email, entry: request.entry, now });
      } else {
        const detail =
          request.entry === undefined && request.setup === undefined
            ? null
            : {
                ...(request.entry === undefined ? {} : { entry: request.entry }),
                ...(request.setup === undefined ? {} : { setup: request.setup }),
              };
        await deps.leads.recordEnquiry({ email, message: request.message, detail, now });
      }
      return { kind: 'received' };
    },
  };
}
