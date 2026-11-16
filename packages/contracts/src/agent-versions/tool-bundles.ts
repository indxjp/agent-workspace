import { z } from 'zod';

import { isPlatformOwnedSecretName, SecretNameSchema } from '../secret-reference.js';
import { ToolOperationNameSchema } from '../tool-connectors.js';

/** The most bytes one code-tool bundle may hold (ADR-0118 TS1; issue #790). */
export const TOOL_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

/** A bundle's address: the lower-case hex SHA-256 of its bytes (ADR-0118 TS1; issue #790). */
export const TOOL_BUNDLE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** {@link TOOL_BUNDLE_DIGEST_PATTERN} as a schema. */
export const ToolBundleDigestSchema = z
  .string()
  .regex(TOOL_BUNDLE_DIGEST_PATTERN, 'must be 64 lower-case hexadecimal characters (a SHA-256)');

/**
 * The problem codes the tool-bundle routes own (ADR-0118 TS1; issue #790). The common vocabulary
 * (`malformed_body`, `request_body_too_large`, …) is `COMMON_PROBLEM_CODES`.
 */
export const TOOL_BUNDLE_PROBLEM_CODES = {
  /** A `contentBase64` outside standard padded base64, or empty. */
  invalid_tool_bundle: 400,
  /** More than {@link TOOL_BUNDLE_MAX_BYTES} bytes after decoding. */
  tool_bundle_too_large: 413,
  /** No bundle with that digest in this workspace. */
  tool_bundle_not_found: 404,
  /** This deployment has no store for tool bundles. */
  tool_bundles_not_configured: 503,
} as const;
export type ToolBundleProblemCode = keyof typeof TOOL_BUNDLE_PROBLEM_CODES;

/** The most secrets, and the most domains, one code tool may declare (ADR-0118 TS4, TS5). */
export const TOOL_SANDBOX_DECLARATION_MAX = 32;

/** The longest a code tool's `timeoutMs` may be (ADR-0118 TS1). */
export const TOOL_BUNDLE_TIMEOUT_MAX_MS = 600_000;

/**
 * A host name or `*.suffix`: the grammar the runtime drivers' egress proxy accepts. A comma, a
 * space or `=` could not be told from a second entry, and a bare `*` would mean every host.
 */
const TOOL_ALLOWED_DOMAIN_PATTERN = /^(?:\*\.)?[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/u;

/**
 * The secrets a code tool declares (ADR-0118 TS4): names only, each once, and never a storage
 * connection's, model connection's or runtime connection's credential, or a webhook's signing
 * secret (see `isPlatformOwnedSecretName`). That credential is bound to the
 * connection's URL and opened only by the server; a tool that declared it would receive it in its
 * environment and could send it anywhere.
 */
export const ToolSecretNamesSchema = z
  .array(
    SecretNameSchema.refine((name) => !isPlatformOwnedSecretName(name), {
      error:
        'must not name a platform-owned credential (STORAGE_CONNECTION_, MODEL_CONNECTION_, RUNTIME_CONNECTION__ or a webhook signing secret)',
    }),
  )
  .max(TOOL_SANDBOX_DECLARATION_MAX)
  .refine((names) => new Set(names).size === names.length, { error: 'must not repeat a name' })
  .readonly();

/** The hosts a code tool may reach (ADR-0118 TS5): names or `*.suffix`, each once. */
export const ToolAllowedDomainsSchema = z
  .array(
    z
      .string()
      .max(253)
      .regex(TOOL_ALLOWED_DOMAIN_PATTERN, { error: 'must be a host name or *.suffix' }),
  )
  .max(TOOL_SANDBOX_DECLARATION_MAX)
  .refine((domains) => new Set(domains).size === domains.length, {
    error: 'must not repeat a domain',
  })
  .readonly();

/**
 * The bundle a version pins for one code tool: the tool's name and the digest of the one ESM file
 * `aw push` built from its run file (ADR-0118 TS1; issue #790). A rollback to an earlier version
 * therefore also rolls the tool's code back.
 *
 * A hosted tool sandbox is made from the version alone (issue #791), so the entry also records the
 * declaration the tool host serves: `description`, `inputSchema`, `outputSchema` and `timeoutMs`,
 * and the `secrets` and `allowedDomains` the tool needs (ADR-0118 TS4, TS5). All are optional so an
 * entry `aw push` wrote before the sandbox existed still parses; such a tool is not served by a
 * hosted sandbox.
 */
export const AgentVersionToolBundleSchema = z
  .object({
    tool: ToolOperationNameSchema,
    digest: ToolBundleDigestSchema,
    description: z.string().min(1).max(2048).optional(),
    inputSchema: z.record(z.string(), z.unknown()).readonly().optional(),
    outputSchema: z.record(z.string(), z.unknown()).readonly().optional(),
    timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS).optional(),
    secrets: ToolSecretNamesSchema.optional(),
    allowedDomains: ToolAllowedDomainsSchema.optional(),
  })
  .strict()
  .readonly();
export type AgentVersionToolBundle = z.infer<typeof AgentVersionToolBundleSchema>;

/** The base64 length of a {@link TOOL_BUNDLE_MAX_BYTES} payload. */
export const TOOL_BUNDLE_MAX_BASE64_LENGTH = Math.ceil(TOOL_BUNDLE_MAX_BYTES / 3) * 4;

/** A flat character-class run: unlike a grouped pattern it cannot exhaust the stack on 11 MB. */
export const TOOL_BUNDLE_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** The body of `POST /api/tool-bundles`: the bundle's bytes, standard padded base64. */
export const UploadToolBundleRequestSchema = z
  .object({
    contentBase64: z
      .string()
      .min(1)
      .max(TOOL_BUNDLE_MAX_BASE64_LENGTH)
      .regex(TOOL_BUNDLE_BASE64_PATTERN, 'must be standard padded base64')
      .refine((value) => value.length % 4 === 0, 'must be standard padded base64'),
  })
  .strict()
  .readonly();
export type UploadToolBundleRequest = z.infer<typeof UploadToolBundleRequestSchema>;

/** One stored bundle: its address and size. The bytes are never served back. */
export const ToolBundleSchema = z
  .object({ digest: ToolBundleDigestSchema, sizeBytes: z.number().int().positive() })
  .strict()
  .readonly();
export type ToolBundle = z.infer<typeof ToolBundleSchema>;

/** What `GET /api/tool-bundles/:digest` answers. */
export const ToolBundleResponseSchema = z.object({ bundle: ToolBundleSchema }).strict().readonly();
export type ToolBundleResponse = z.infer<typeof ToolBundleResponseSchema>;

/**
 * What `POST /api/tool-bundles` answers: `201` with `created: true` when the bytes were new, `200`
 * with `created: false` when the workspace already held that digest and nothing was written.
 */
export const UploadToolBundleResponseSchema = z
  .object({ bundle: ToolBundleSchema, created: z.boolean() })
  .strict()
  .readonly();
export type UploadToolBundleResponse = z.infer<typeof UploadToolBundleResponseSchema>;
