import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { MEMBERSHIP_ROLES, type MembershipRoleName } from './team.js';

/** The longest name `POST /api/api-keys` accepts, after trimming. */
export const API_KEY_NAME_MAX_LENGTH = 120;

/** §22's printed prefix: every key, presented or displayed, starts with it. */
export const API_KEY_PREFIX = 'ak_live_';

/** Base64url characters in the public half (16 bytes) and the secret half (32 bytes) of a key. */
export const API_KEY_ID_LENGTH = 22;
export const API_KEY_SECRET_LENGTH = 43;

/**
 * The displayable head of a key — `ak_live_<key id>` — which a list may show because it is not
 * enough to authenticate. It is how a key is named after its secret is gone.
 */
export const API_KEY_DISPLAY_PREFIX_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}[A-Za-z0-9_-]{${String(API_KEY_ID_LENGTH)}}$`,
  'u',
);

/**
 * A whole presented key — `ak_live_<key id>_<secret>` — the shape the mint response's `key`
 * carries and the shape `Authorization: Bearer` expects.
 */
export const API_KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}[A-Za-z0-9_-]{${String(API_KEY_ID_LENGTH)}}_[A-Za-z0-9_-]{${String(API_KEY_SECRET_LENGTH)}}$`,
  'u',
);

/**
 * One API key as every item of `GET /api/api-keys`, the `apiKey` of the mint response and the
 * `200` of `DELETE /api/api-keys/:id` render it.
 *
 * There is no field for the secret and no field for its hash, and `.strict()` refuses a body that
 * carries either: §22's "show the raw secret only once" is a type with nowhere to put it. The
 * one-time reveal is {@link MintedApiKeyResponseSchema}'s sibling `key` field, beside this
 * resource, never inside it. `revokedAt` is set rather than the row deleted, so a revoked key stays
 * listable and auditable; `lastUsedAt` is `null` until the key first authenticates.
 */
export const ApiKeyResourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(MEMBERSHIP_ROLES),
    keyPrefix: z.string().regex(API_KEY_DISPLAY_PREFIX_PATTERN),
    lastUsedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type ApiKeyResource = z.infer<typeof ApiKeyResourceSchema>;

/** The body of `GET /api/api-keys`: prefixes and timestamps, never a secret. */
export const ApiKeyListResponseSchema = z
  .object({ apiKeys: z.array(ApiKeyResourceSchema).readonly() })
  .strict()
  .readonly();

export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;

/**
 * The `200` of `DELETE /api/api-keys/:id`: the row with `revokedAt` set. A second revoke answers
 * the same way rather than failing; the route never returns a `204`.
 */
export const ApiKeyResponseSchema = z.object({ apiKey: ApiKeyResourceSchema }).strict().readonly();

export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

/**
 * The `201` of `POST /api/api-keys` — the only response body in the platform that carries an API
 * key's plaintext. `key` is the whole credential the operator pastes; `warning` is the server's
 * own sentence saying it is shown once, parsed rather than reworded so the caller that stores the
 * key has been told the guarantee the server actually made.
 */
export const MintedApiKeyResponseSchema = z
  .object({
    apiKey: ApiKeyResourceSchema,
    key: z.string().regex(API_KEY_PATTERN),
    warning: z.string().min(1),
  })
  .strict()
  .readonly();

export type MintedApiKeyResponse = z.infer<typeof MintedApiKeyResponseSchema>;

/**
 * The body of `POST /api/api-keys`. `name` is trimmed, non-blank, at most
 * {@link API_KEY_NAME_MAX_LENGTH} characters and unique in the workspace (`409 name_taken`).
 * `role` is the role the key will authenticate as and must be one the caller may confer
 * (`403 forbidden_role_conferral`). `expiresAt` is an ISO-8601 instant later than now
 * (`400 invalid_field` otherwise); omit it or send `null` for a key that does not expire.
 */
export interface CreateApiKeyInput {
  readonly name: string;
  readonly role: MembershipRoleName;
  readonly expiresAt?: string | null;
}
