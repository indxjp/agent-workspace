import { z } from 'zod';

/**
 * ADR-0161: an app backend trades the signed-in person's ID token, signed by the deployment's own
 * `OIDC_ISSUER_URL`, for a short-lived access token bound to an `app-backend` endpoint client.
 * `POST /api/auth/token-exchange` keeps RFC 8693's field names, takes JSON, and answers in the
 * ADR-0075 problem envelope.
 */

/** RFC 8693 §2.1 `grant_type`. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** RFC 8693 §3: the only `subject_token_type` accepted is an OpenID Connect ID token. */
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

/** RFC 8693 §3: what the exchange issues, and the only `requested_token_type` it accepts. */
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** ADR-0161 D2: an exchanged token lives five minutes and has no refresh token. */
export const TOKEN_EXCHANGE_TTL_SECONDS = 300;

/** ADR-0161 D3: the longest ID token accepted, 16 KiB of compact JWS. */
export const SUBJECT_TOKEN_MAX_LENGTH = 16_384;

/** The prefix of an ADR-0134 part 3 access token, which the proxy recognises by shape. */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'awo_live_';

/**
 * An ADR-0134 access token: `awo_live_<22-char id>_<43-char secret>`, base64url. The second group
 * is the secret half the server hashes; the server's token module reads it from this one pattern.
 */
export const OAUTH_ACCESS_TOKEN_PATTERN = /^awo_live_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/u;

/**
 * The body of `POST /api/auth/token-exchange`. The endpoint client authenticates with
 * `client_secret_basic`, never in the body; `audience`, `resource`, `scope` and `actor_token` are
 * refused because the client's binding decides all of them.
 */
export const TokenExchangeRequestSchema = z
  .object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z.string().min(1).max(SUBJECT_TOKEN_MAX_LENGTH),
    subject_token_type: z.literal(ID_TOKEN_TYPE),
    requested_token_type: z.literal(ACCESS_TOKEN_TYPE).optional(),
  })
  .strict()
  .readonly();

export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequestSchema>;

/**
 * The `200` of `POST /api/auth/token-exchange`, sent with `Cache-Control: no-store`. No
 * `refresh_token` and no `scope`: the token's reach is the client's binding.
 */
export const TokenExchangeResponseSchema = z
  .object({
    access_token: z.string().regex(OAUTH_ACCESS_TOKEN_PATTERN),
    issued_token_type: z.literal(ACCESS_TOKEN_TYPE),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(TOKEN_EXCHANGE_TTL_SECONDS),
  })
  .strict()
  .readonly();

export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponseSchema>;

/**
 * ADR-0161 D7: the domain problem codes of `POST /api/auth/token-exchange`, with the status each
 * travels under. `subject_not_member` says the same thing whether the person is unknown or a member
 * of another workspace only. The body-shape refusals are the common `invalid_body`,
 * `malformed_body` and `unsupported_media_type`.
 */
export const TOKEN_EXCHANGE_PROBLEM_CODES = {
  token_exchange_not_configured: 503,
  invalid_client: 401,
  subject_token_invalid: 401,
  subject_token_wrong_issuer: 401,
  subject_token_wrong_audience: 401,
  subject_not_member: 403,
  rate_limited: 429,
} as const;

export type TokenExchangeProblemCode = keyof typeof TOKEN_EXCHANGE_PROBLEM_CODES;
