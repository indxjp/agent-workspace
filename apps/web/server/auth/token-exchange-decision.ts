/**
 * The pure half of ADR-0161 D5: what an exchange decides once the ID token's signature, issuer,
 * audience and expiry have been verified against the configured issuer's key set. It reads no
 * clock, key, network or database; the adapter (`./token-exchange.ts`) passes those facts in.
 *
 * Two steps, so the adapter can keep D5's order: {@link claimsRefusal} runs before any database
 * read about the person, and {@link decideExchange} turns the person lookup into the answer.
 */
import type { EndpointClientKind } from '@indx-workspace/contracts/endpoint-clients';
import {
  TOKEN_EXCHANGE_TTL_SECONDS,
  type TokenExchangeProblemCode,
} from '@indx-workspace/contracts/token-exchange';

/** ADR-0161 D5 step 5: the clock skew allowed on `exp` and `iat`, in seconds. */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/** The claims of a verified ID token that the decision reads, as untyped as the token carried them. */
export interface IdTokenClaims {
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly iat?: unknown;
  readonly exp?: unknown;
  readonly email_verified?: unknown;
}

/** The endpoint client that authenticated, as the decision reads it. */
export interface ExchangeClient {
  readonly kind: EndpointClientKind;
  readonly oidcAudience: string | null;
  readonly hasClientSecret: boolean;
  readonly revoked: boolean;
}

/** The person's membership of the client's workspace, or `null` when there is none. */
export interface ExchangeMember {
  readonly userId: string;
  readonly principalId: string;
}

export type ExchangeRefusal = {
  readonly kind: 'refuse';
  readonly code: Exclude<
    TokenExchangeProblemCode,
    'token_exchange_not_configured' | 'rate_limited'
  >;
};

export type ExchangeDecision =
  | {
      readonly kind: 'accept';
      readonly membershipPrincipalId: string;
      readonly userId: string;
      readonly expiresAt: Date;
    }
  | ExchangeRefusal;

const refuse = (code: ExchangeRefusal['code']): ExchangeRefusal => ({ kind: 'refuse', code });

/**
 * Whether `client` may exchange at all: an unrevoked, confidential `app-backend` client with an
 * audience. Anything else is `invalid_client`, the same answer as a wrong secret.
 */
export function clientRefusal(client: ExchangeClient | null): ExchangeRefusal | null {
  if (client === null || client.revoked || !client.hasClientSecret) return refuse('invalid_client');
  if (client.kind !== 'app-backend' || client.oidcAudience === null) {
    return refuse('invalid_client');
  }
  return null;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * D5 steps 4 to 6 on claims the signature check already passed: with more than one `aud`, `azp`
 * must be the client's audience; `exp` and `iat` are required and within the tolerance; `sub` is a
 * non-empty string; `email_verified` is exactly `true`.
 */
export function claimsRefusal(
  claims: IdTokenClaims,
  oidcAudience: string,
  now: Date,
): ExchangeRefusal | null {
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== oidcAudience) {
    return refuse('subject_token_wrong_audience');
  }
  const nowSeconds = now.getTime() / 1000;
  if (!isNumericDate(claims.exp) || claims.exp <= nowSeconds - ID_TOKEN_CLOCK_TOLERANCE_SECONDS) {
    return refuse('subject_token_invalid');
  }
  if (!isNumericDate(claims.iat) || claims.iat >= nowSeconds + ID_TOKEN_CLOCK_TOLERANCE_SECONDS) {
    return refuse('subject_token_invalid');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') return refuse('subject_token_invalid');
  // An unverified email is whatever the person typed at the provider ("nOAuth"); the browser
  // callback refuses the same.
  if (claims.email_verified !== true) return refuse('subject_token_invalid');
  return null;
}

/**
 * The whole decision. `member` is the person's membership of the **client's** workspace: an
 * unknown `(iss, sub)` and a member of another workspace only are both `null`, and both answer the
 * same `subject_not_member`, so the answer does not say which.
 */
export function decideExchange(input: {
  readonly client: ExchangeClient | null;
  readonly claims: IdTokenClaims;
  readonly member: ExchangeMember | null;
  readonly now: Date;
}): ExchangeDecision {
  const client = clientRefusal(input.client);
  if (client !== null || input.client === null || input.client.oidcAudience === null) {
    return client ?? refuse('invalid_client');
  }
  const claims = claimsRefusal(input.claims, input.client.oidcAudience, input.now);
  if (claims !== null) return claims;
  if (input.member === null) return refuse('subject_not_member');
  return {
    kind: 'accept',
    membershipPrincipalId: input.member.principalId,
    userId: input.member.userId,
    expiresAt: new Date(input.now.getTime() + TOKEN_EXCHANGE_TTL_SECONDS * 1000),
  };
}
