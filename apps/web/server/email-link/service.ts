/**
 * The email-link use cases (spec §21, "Guest"): send a single-use link to an address, and open one
 * to sign the visitor in as the guest of their demo workspace.
 *
 * The secret is 32 random bytes from the identity entry's `randomToken`. Only SHA-256 hashes of it
 * and of the lower-cased address are stored; the raw token exists in this module for the length of
 * one call and in the message handed to the sender. Nothing here logs. Time comes from the `Clock`,
 * row ids from the `IdGenerator`.
 */
import {
  EMAIL_LINK_TOKEN_PATTERN,
  type EmailLinkIssuedResponse,
} from '@indx-workspace/contracts/email-link';

import type { ClientIdentitySettings } from '../client-identity';
import type { Clock } from '../clock';
import { admitClient, perMinuteLimiter } from '../http/rate-limit';
import { hashApiKeySecret, randomToken } from '../identity';
import type { IdGenerator } from '../ids';
import {
  EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT,
  EMAIL_LINK_ISSUES_PER_ADDRESS,
  EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT,
  addressWindowStart,
  buildLinkUrl,
  linkExpiry,
} from './core/rules';
import type {
  ChallengeVerifier,
  DisposableEmailList,
  EmailLinkRefusal,
  EmailLinkSender,
  EmailLinkService,
  GuestWorkspaceBinder,
  LoginTokenStore,
} from './ports';

/** 32 random bytes: the same entropy budget an invitation token has. */
const TOKEN_BYTES = 32;

const SENT: EmailLinkIssuedResponse = Object.freeze({ status: 'sent' });

export interface EmailLinkServiceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly clientIdentity: ClientIdentitySettings;
  readonly store: LoginTokenStore;
  readonly binder: GuestWorkspaceBinder;
  /** `null` when this deployment cannot send links: issuing answers `email_link_unavailable`. */
  readonly sender: EmailLinkSender | null;
  /** The public origin a link points at (`AW_EMAIL_LINK_BASE_URL`); `null` as for `sender`. */
  readonly linkBaseUrl: string | null;
  /** `null` when no challenge is configured (`AW_EMAIL_LINK_CHALLENGE`): as for `sender`. */
  readonly challenge: ChallengeVerifier | null;
  readonly disposable: DisposableEmailList;
}

const refuse = (code: EmailLinkRefusal['code']): EmailLinkRefusal => ({ kind: 'refused', code });

const hashAddress = (email: string): Promise<string> =>
  hashApiKeySecret(email.trim().toLowerCase());

export function createEmailLinkServiceFrom(deps: EmailLinkServiceDependencies): EmailLinkService {
  const issueLimiter = perMinuteLimiter(EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT);
  const verifyLimiter = perMinuteLimiter(EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT);

  return {
    async issue({ email, challenge, entry, headers }) {
      const { sender, linkBaseUrl, challenge: verifier } = deps;
      if (sender === null || linkBaseUrl === null || verifier === null) {
        return refuse('email_link_unavailable');
      }

      const now = deps.clock.now();
      const admission = admitClient(
        issueLimiter,
        EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT,
        headers,
        now.getTime(),
        deps.clientIdentity,
      );
      if (!admission.admitted) {
        return {
          ...refuse('email_link_rate_limited'),
          retryAfterSeconds: admission.retryAfterSeconds,
        };
      }
      // Cheapest refusal first, and nothing past the challenge runs for a client that failed it.
      if ((await verifier.verify(challenge, headers)) !== 'pass') {
        return refuse('email_link_challenge_failed');
      }

      const address = email.trim().toLowerCase();
      if (deps.disposable.isDisposable(address)) return refuse('email_link_address_refused');
      if (entry !== undefined && !(await deps.binder.hasEntry(entry))) {
        return refuse('demo_entry_unavailable');
      }

      const token = randomToken(TOKEN_BYTES);
      const expiresAt = linkExpiry(now);
      const id = deps.ids.newId();
      // Counting and storing are one atomic step, so concurrent requests for one address from any
      // number of clients cannot exceed the limit. Over it the answer is the same `sent`, so a
      // caller cannot tell an address that has been flooded from one that has not.
      const reserved = await deps.store.reserve(
        {
          id,
          tokenHash: await hashApiKeySecret(token),
          emailHash: await hashAddress(address),
          createdAt: now,
          expiresAt,
        },
        { since: addressWindowStart(now), limit: EMAIL_LINK_ISSUES_PER_ADDRESS },
      );
      if (!reserved) return { kind: 'issued', body: SENT };
      try {
        await sender.send({
          to: address,
          link: buildLinkUrl(linkBaseUrl, token, address, entry),
          expiresAt,
        });
      } catch {
        // A send that fails leaves nothing behind and does not count against the per-address
        // limit. The answer is the same `sent` as for any other address, so a provider that
        // rejects one particular address cannot be used to probe addresses.
        await deps.store.release(id);
      }
      return { kind: 'issued', body: SENT };
    },

    async verify({ email, token, entry, headers }) {
      const now = deps.clock.now();
      const admission = admitClient(
        verifyLimiter,
        EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT,
        headers,
        now.getTime(),
        deps.clientIdentity,
      );
      if (!admission.admitted) {
        return {
          ...refuse('email_link_rate_limited'),
          retryAfterSeconds: admission.retryAfterSeconds,
        };
      }
      if (!EMAIL_LINK_TOKEN_PATTERN.test(token)) return refuse('email_link_invalid');

      // Before the link is consumed, so a demo that went away leaves the link usable.
      if (entry !== undefined && !(await deps.binder.hasEntry(entry))) {
        return refuse('demo_entry_unavailable');
      }

      const address = email.trim().toLowerCase();
      const outcome = await deps.store.consume({
        tokenHash: await hashApiKeySecret(token),
        emailHash: await hashAddress(address),
        now,
      });
      if (outcome.kind !== 'consumed') return refuse('email_link_invalid');

      const binding = await deps.binder.bind({
        email: address,
        now,
        ...(entry === undefined ? {} : { entry }),
      });
      if (binding === null) return refuse('email_link_invalid');
      return {
        kind: 'verified',
        body: {
          workspaceId: binding.workspaceId,
          workspaceSlug: binding.workspaceSlug,
          role: 'guest',
          created: binding.created,
        },
        binding,
        email: address,
      };
    },
  };
}
