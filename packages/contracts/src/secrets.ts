import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/**
 * The shape of a secret's name: uppercase letters, digits and underscores, starting with a
 * letter, 1–128 characters (`ANTHROPIC_API_KEY`). Transcribed from the `secrets_name_shape`
 * database CHECK; the route refuses a name outside it as `400 invalid_body` before it is stored.
 */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SECRET_NAME_MAX_LENGTH = 128;

/**
 * The largest plaintext a secret may hold, in string code units. A credential or a PEM-encoded
 * private key is a few KiB; this route is not a blob store.
 */
export const SECRET_VALUE_MAX_LENGTH = 64 * 1024;

/**
 * One secret's metadata as the `201` of `POST /api/secrets`, the `200` of
 * `PUT /api/secrets/:id` (both bare, not wrapped) and every item of `GET /api/secrets` render it.
 *
 * Secrets are write-only over HTTP: there is no field for the value here, no `GET /api/secrets/:id`,
 * and `.strict()` refuses a body that carries one. `algorithm` names the envelope cipher and
 * `masterKeyId` the key that wrapped the data key — enough to audit a rotation, never enough to
 * read the secret.
 */
export const SecretResourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().regex(SECRET_NAME_PATTERN),
    algorithm: z.string().min(1),
    masterKeyId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type SecretResource = z.infer<typeof SecretResourceSchema>;

/** The body of `GET /api/secrets`: every secret of the caller's workspace, metadata only. */
export const SecretListResponseSchema = z
  .object({ secrets: z.array(SecretResourceSchema).readonly() })
  .strict()
  .readonly();

export type SecretListResponse = z.infer<typeof SecretListResponseSchema>;

/**
 * The body of `POST /api/secrets`. `name` must match {@link SECRET_NAME_PATTERN} and be unique in
 * the workspace (`409 secret_name_conflict`); `value` is non-empty and at most
 * {@link SECRET_VALUE_MAX_LENGTH} code units. The value is sent once and never returned.
 */
export interface CreateSecretInput {
  readonly name: string;
  readonly value: string;
}

/**
 * Problem codes the secrets routes own, with the status each one travels under. The common
 * vocabulary is `COMMON_PROBLEM_CODES` at the package root.
 */
export const SECRETS_PROBLEM_CODES = {
  invalid_body: 400,
  invalid_secret_id: 400,
  secret_not_found: 404,
  secret_name_conflict: 409,
  /**
   * `DELETE /api/secrets/:id` while a connector authenticates with the secret or a model
   * connection owns it. `details` names each referrer as `connector:<id>` or
   * `model-connection:<id>` (`formatInUseReferrer`); nothing is deleted.
   */
  secret_in_use: 409,
  secrets_runtime_not_configured: 503,
} as const;

export type SecretsProblemCode = keyof typeof SECRETS_PROBLEM_CODES;

/**
 * The body of `PUT /api/secrets/:id`: the replacement value, and nothing else — a secret's name
 * is immutable through this route, and a body that carries one is `400 invalid_body`.
 */
export interface ReplaceSecretInput {
  readonly value: string;
}
