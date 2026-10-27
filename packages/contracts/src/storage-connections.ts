/**
 * Storage connections (the storage design, §05 and §06 Phase 5): an admin connects their own S3,
 * GCS, Azure or server-folder storage, and grants an agent a folder of it as
 * `storage://<connection>/<prefix>`. Access is read-only unless the connection sets
 * `writeAllowed`, and limited to `allowedPrefixes`. This module is the shared wire shape only; the
 * store, the routes and the checks live in the server layers that import it.
 */
import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { isCanonicalFileScopePath } from './runs.js';
import { SECRET_VALUE_MAX_LENGTH } from './secrets.js';
import { parseStorageUrl } from './storage-url.js';

/**
 * The operator's list of local folders a `file` connection may name. A `file` connection is
 * accepted only for a folder under one of these roots; the server enforces it (Q-21), a contract
 * cannot because the roots are deployment configuration.
 */
// @story US-STO-12
export const STORAGE_CONNECTION_FILE_ROOTS_ENV = 'AW_STORAGE_CONNECTION_FILE_ROOTS';

// @story US-STO-12
export const STORAGE_CONNECTION_PROVIDERS = ['s3', 'gcs', 'azblob', 'file'] as const;
export type StorageConnectionProvider = (typeof STORAGE_CONNECTION_PROVIDERS)[number];

/** The most folders one connection may allow. */
export const MAX_STORAGE_CONNECTION_PREFIXES = 50;

const STORAGE_CONNECTION_URL_MAX_LENGTH = 2_048;

// @story US-STO-12
export const StorageConnectionNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);

/**
 * A name a client may give a connection or write in a `storage://` grant: one that is not shaped
 * like a connection id. A lowercase UUID that starts with a letter matches the name grammar, so
 * without this a grant could address a connection by id.
 */
const AddressableNameSchema = StorageConnectionNameSchema.refine(
  (name) => !UuidSchema.safeParse(name).success,
  'must not be shaped like a connection id',
);

const CanonicalPrefixSchema = z
  .string()
  .refine(isCanonicalFileScopePath, 'must be a canonical folder path: no leading or trailing "/"');

const AllowedPrefixesSchema = z
  .array(CanonicalPrefixSchema)
  .min(1)
  .max(MAX_STORAGE_CONNECTION_PREFIXES);

/**
 * One storage connection as every response renders it. The credential is write-only and has no
 * field here: `hasCredential` says whether one is stored. `url` is the `AW_STORAGE_URL` grammar and
 * never carries a secret.
 */
// @story US-STO-12
export const StorageConnectionResourceSchema = z
  .object({
    id: UuidSchema,
    name: StorageConnectionNameSchema,
    provider: z.enum(STORAGE_CONNECTION_PROVIDERS),
    url: z.string().min(1).max(STORAGE_CONNECTION_URL_MAX_LENGTH),
    allowedPrefixes: AllowedPrefixesSchema,
    writeAllowed: z.boolean(),
    hasCredential: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type StorageConnectionResource = z.infer<typeof StorageConnectionResourceSchema>;

// @story US-STO-12
export const StorageConnectionListResponseSchema = z
  .object({ connections: z.array(StorageConnectionResourceSchema).readonly() })
  .strict()
  .readonly();
export type StorageConnectionListResponse = z.infer<typeof StorageConnectionListResponseSchema>;

const CredentialValueSchema = z.string().min(1).max(SECRET_VALUE_MAX_LENGTH);

/**
 * The `type` of a Google credential file, if the string is a JSON object that has one. Only a
 * `service_account` key is a key to use: `external_account` (workload identity) carries a
 * `credential_source` that can make the server read a file or call a URL.
 */
function googleCredentialType(json: string): unknown {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The write-only credential of a connection, shaped by the provider it is for. It is stored by
 * connection id, never as a `secret:<name>` string, and never returned. A `file` connection has
 * nothing to authenticate with. A GCS connection holds a service-account key or a short-lived
 * OAuth `accessToken` (it expires, so the connection then needs rotating); a key whose JSON names
 * a `type` other than `service_account` is refused as `storage_connection_url_invalid`.
 */
// @story US-STO-12
export const StorageConnectionCredentialSchema = z
  .union([
    z
      .object({
        provider: z.literal('s3'),
        accessKeyId: CredentialValueSchema,
        secretAccessKey: CredentialValueSchema,
        /** Temporary (STS) credentials only. They expire, so the connection then needs rotating. */
        sessionToken: CredentialValueSchema.optional(),
      })
      .strict(),
    z
      .object({
        provider: z.literal('gcs'),
        serviceAccountJson: z.string().min(2).max(SECRET_VALUE_MAX_LENGTH),
      })
      .strict(),
    z.object({ provider: z.literal('gcs'), accessToken: CredentialValueSchema }).strict(),
    z.object({ provider: z.literal('azblob'), accountKey: CredentialValueSchema }).strict(),
    z.object({ provider: z.literal('azblob'), sasToken: CredentialValueSchema }).strict(),
    z.object({ provider: z.literal('file') }).strict(),
  ])
  .superRefine((credential, context) => {
    if (!('serviceAccountJson' in credential)) return;
    const type = googleCredentialType(credential.serviceAccountJson);
    if (type !== undefined && type !== 'service_account') {
      context.addIssue({
        code: 'custom',
        path: ['serviceAccountJson'],
        message: 'storage_connection_url_invalid',
      });
    }
  });
export type StorageConnectionCredential = z.infer<typeof StorageConnectionCredentialSchema>;

/**
 * The stable code a refusal carries. Expected failures of the connection routes, with their HTTP
 * status.
 */
// @story US-STO-12
export const STORAGE_CONNECTION_PROBLEM_CODES = {
  /** No connection with that id in the workspace. */
  storage_connection_not_found: 404,
  /** Another connection in the workspace already has that name. */
  storage_connection_name_taken: 409,
  /**
   * The patch moves a connection that holds a credential to another endpoint, account, bucket or
   * container without sending the credential for it.
   */
  storage_connection_credential_required: 409,
  /** An agent still holds a grant on the connection. */
  storage_connection_in_use: 409,
  /** The URL is not a storage URL, or the credential is not for its provider. */
  storage_connection_url_invalid: 422,
  /** The URL carries userinfo or a signing or secret query parameter. */
  storage_connection_url_has_secret: 422,
  /** The endpoint (or, for `file`, the folder) is not one the deployment allows. */
  storage_connection_endpoint_forbidden: 422,
  /** The path is outside the connection's `allowedPrefixes`. */
  storage_connection_prefix_not_allowed: 403,
  /** The connection is read-only, or the grant does not include write. */
  storage_connection_write_not_allowed: 403,
  /** The storage did not answer. */
  storage_connection_unreachable: 502,
} as const;
export type StorageConnectionProblemCode = keyof typeof STORAGE_CONNECTION_PROBLEM_CODES;

// A refusal's message is its stable code, never the URL or the credential it refused.
function refuseUrl(context: z.RefinementCtx, code: StorageConnectionProblemCode): void {
  context.addIssue({ code: 'custom', path: ['url'], message: code });
}

function refuseUnusableUrl(url: string, context: z.RefinementCtx) {
  const parsed = parseStorageUrl(url);
  if (parsed.ok) return parsed.location;
  refuseUrl(
    context,
    parsed.secret === true ? 'storage_connection_url_has_secret' : 'storage_connection_url_invalid',
  );
  return null;
}

/**
 * The body of `POST /api/storage-connections`. The provider is the URL's scheme; `file` is
 * allowed only for a folder under {@link STORAGE_CONNECTION_FILE_ROOTS_ENV}. `url` is parsed by
 * `parseStorageUrl`, so userinfo and any unknown query parameter are refused as
 * `storage_connection_url_has_secret`, and a `credential` for another provider as
 * `storage_connection_url_invalid`. Access is read-only unless `writeAllowed` is `true`.
 */
// @story US-STO-12
export const CreateStorageConnectionInputSchema = z
  .object({
    name: AddressableNameSchema,
    url: z.string().min(1).max(STORAGE_CONNECTION_URL_MAX_LENGTH),
    allowedPrefixes: AllowedPrefixesSchema,
    writeAllowed: z.boolean().default(false),
    credential: StorageConnectionCredentialSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = refuseUnusableUrl(value.url, context);
    if (parsed === null || value.credential === undefined) return;
    if (value.credential.provider !== parsed.kind) {
      context.addIssue({
        code: 'custom',
        path: ['credential', 'provider'],
        message: 'storage_connection_url_invalid',
      });
    } else if (
      parsed.kind === 'gcs' &&
      parsed.projectId === undefined &&
      'accessToken' in value.credential
    ) {
      // A token names no project, and without one the client would look in gcloud or the metadata server.
      refuseUrl(context, 'storage_connection_url_invalid');
    }
  });
export type CreateStorageConnectionInput = z.input<typeof CreateStorageConnectionInputSchema>;

/**
 * The body of `PATCH /api/storage-connections/:id`. A new `url` is checked like a created one; the
 * server also keeps its provider, because the stored credential is shaped for it. A `url` that
 * moves a connection holding a credential to another endpoint, account, bucket or container needs
 * a new `credential` in the same patch (`storage_connection_credential_required`), which replaces
 * the stored one; a change of the URL's prefix keeps it.
 */
// @story US-STO-12
export const UpdateStorageConnectionPatchSchema = z
  .object({
    name: AddressableNameSchema.optional(),
    url: z.string().min(1).max(STORAGE_CONNECTION_URL_MAX_LENGTH).optional(),
    allowedPrefixes: AllowedPrefixesSchema.optional(),
    writeAllowed: z.boolean().optional(),
    credential: StorageConnectionCredentialSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'a patch must change something')
  .superRefine((patch, context) => {
    if (patch.url !== undefined) refuseUnusableUrl(patch.url, context);
  });
export type UpdateStorageConnectionPatch = z.infer<typeof UpdateStorageConnectionPatchSchema>;

/** The body of `POST /api/storage-connections/:id/test`; `code` says why it failed. */
// @story US-STO-12
export const StorageConnectionTestOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true) })
    .strict()
    .readonly(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['unreachable', 'forbidden', 'not_found']),
    })
    .strict()
    .readonly(),
]);
export type StorageConnectionTestOutcome = z.infer<typeof StorageConnectionTestOutcomeSchema>;

/** One page of a connection's folder listing, inside its allowed prefixes. */
// @story US-STO-12
export const StorageConnectionBrowseResponseSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1),
            kind: z.enum(['file', 'folder']),
            size: z.number().int().nonnegative().optional(),
          })
          .strict()
          .readonly(),
      )
      .readonly(),
    next: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type StorageConnectionBrowseResponse = z.infer<typeof StorageConnectionBrowseResponseSchema>;

/** The scheme of a grant that names a folder of a storage connection instead of a workspace file. */
export const STORAGE_GRANT_SCHEME = 'storage://';

/**
 * Reads `storage://<connection>/<prefix>`. `null` for any other path (a plain path is a workspace
 * file), for a connection name that is not valid or is shaped like a connection id, and for a
 * prefix that is not a canonical folder path (empty, absolute, or holding a `.` or `..` segment).
 */
// @story US-STO-12
export function parseStorageGrantPath(path: string): { connection: string; prefix: string } | null {
  if (!path.startsWith(STORAGE_GRANT_SCHEME)) return null;
  const rest = path.slice(STORAGE_GRANT_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const connection = rest.slice(0, slash);
  const prefix = rest.slice(slash + 1);
  if (!AddressableNameSchema.safeParse(connection).success) return null;
  return isCanonicalFileScopePath(prefix) ? { connection, prefix } : null;
}
