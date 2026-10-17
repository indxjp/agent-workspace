import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';

/**
 * Issue #236 (SDK-04, S-1): a short-lived, run- or session-scoped bearer a customer's own backend
 * mints for its own frontend. `awt_live_` — distinct from {@link import('./api-keys.js').API_KEY_PREFIX}
 * `ak_live_` — is what lets `apps/web/proxy.ts` recognise the credential by shape without verifying
 * it, and what lets this module pin a pattern the same way `api-keys.ts` pins `ak_live_`'s.
 */
export const BROWSER_TOKEN_PREFIX = 'awt_live_';

/** Same anchored fixed-length halves as an API key: 16 bytes / 32 bytes, base64url. */
export const BROWSER_TOKEN_ID_LENGTH = 22;
export const BROWSER_TOKEN_SECRET_LENGTH = 43;

/**
 * A whole presented browser token — `awt_live_<id>_<secret>` — the shape the mint response's
 * `token` carries and the shape `Authorization: Bearer` expects.
 */
export const BROWSER_TOKEN_PATTERN = new RegExp(
  `^${BROWSER_TOKEN_PREFIX}[A-Za-z0-9_-]{${String(BROWSER_TOKEN_ID_LENGTH)}}_[A-Za-z0-9_-]{${String(BROWSER_TOKEN_SECRET_LENGTH)}}$`,
  'u',
);

/** The two shapes a browser token may be scoped to (spec §3.1). */
export const TOKEN_SCOPE_KINDS = ['run', 'session'] as const;
export type TokenScopeKind = (typeof TOKEN_SCOPE_KINDS)[number];

/**
 * Which run or session a token may act on, and nothing else. `id` is the scoped row's id — a
 * `UuidSchema` for the same reason `StartRunRequestSchema.sessionId` is one: every run and session
 * id the control plane issues is a `uuid` column, so the SDK and the CLI refuse a malformed one
 * before it is sent rather than learning about it from the server. The grammar each kind may reach
 * is fixed by §3.1 and enforced server-side by `decide()`.
 */
export const TokenScopeSchema = z
  .object({
    kind: z.enum(TOKEN_SCOPE_KINDS),
    id: UuidSchema,
  })
  .strict()
  .readonly();

export type TokenScope = z.infer<typeof TokenScopeSchema>;

/** §3.1's TTL bounds: 60 seconds through one hour, default five minutes. */
export const BROWSER_TOKEN_MIN_TTL_SECONDS = 60;
export const BROWSER_TOKEN_MAX_TTL_SECONDS = 3600;
export const BROWSER_TOKEN_DEFAULT_TTL_SECONDS = 300;

/** The body of `POST /api/tokens`. `ttlSeconds` omitted means the default above. */
export const MintTokenRequestSchema = z
  .object({
    scope: TokenScopeSchema,
    ttlSeconds: z
      .number()
      .int()
      .min(BROWSER_TOKEN_MIN_TTL_SECONDS)
      .max(BROWSER_TOKEN_MAX_TTL_SECONDS)
      .optional(),
  })
  .strict()
  .readonly();

export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

/**
 * The `201` of `POST /api/tokens` — the only response body in the platform besides
 * `MintedApiKeyResponseSchema` that carries a bearer credential's plaintext. `token` is the whole
 * credential the caller forwards to its frontend; there is nowhere on this type to put a hash.
 */
export const MintTokenResponseSchema = z
  .object({
    token: z.string().regex(BROWSER_TOKEN_PATTERN),
    scope: TokenScopeSchema,
    expiresAt: IsoDateTimeSchema,
    warning: z.string().min(1),
  })
  .strict()
  .readonly();

export type MintTokenResponse = z.infer<typeof MintTokenResponseSchema>;
