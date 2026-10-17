import { z } from 'zod';

import { AGENT_VERSION_NUMBER_MAX, AGENT_VERSION_PROBLEM_CODES } from './agent-versions.js';
import {
  HOSTED_PLATFORM_IDS,
  PLATFORM_IDS,
  PlatformIdSchema,
  type HostedPlatformId,
  type PlatformId,
} from './platform-ids.js';
import { PortableRelativePathSchema } from './portable-agent.js';

export {
  HOSTED_PLATFORM_IDS,
  PLATFORM_IDS,
  PlatformIdSchema,
  type HostedPlatformId,
  type PlatformId,
};

/** How a platform carries one capability of the portable agent (ADR-0133 D7). */
export const PLATFORM_SUPPORT = ['native', 'mapped', 'unsupported'] as const;
export type PlatformSupport = (typeof PLATFORM_SUPPORT)[number];

export const PLATFORM_CAPABILITY_KEYS = [
  'description',
  'instructions',
  'model',
  'engine',
  'permissions',
  'mcpRemote',
  'mcpStdio',
  'codeTools',
  'openapiTools',
  'builtinTools',
  'skills',
  'knowledgeFiles',
  'knowledgeUrls',
  'knowledgeConnectors',
  'subagents',
  'limits',
] as const;
export type PlatformCapabilityKey = (typeof PLATFORM_CAPABILITY_KEYS)[number];

const PlatformSupportSchema = z.enum(PLATFORM_SUPPORT);

export const PlatformCapabilitiesSchema = z
  .object({
    description: PlatformSupportSchema,
    instructions: PlatformSupportSchema,
    model: PlatformSupportSchema,
    engine: PlatformSupportSchema,
    permissions: PlatformSupportSchema,
    mcpRemote: PlatformSupportSchema,
    mcpStdio: PlatformSupportSchema,
    codeTools: PlatformSupportSchema,
    openapiTools: PlatformSupportSchema,
    builtinTools: PlatformSupportSchema,
    skills: PlatformSupportSchema,
    knowledgeFiles: PlatformSupportSchema,
    knowledgeUrls: PlatformSupportSchema,
    knowledgeConnectors: PlatformSupportSchema,
    subagents: PlatformSupportSchema,
    limits: PlatformSupportSchema,
  } satisfies Record<PlatformCapabilityKey, typeof PlatformSupportSchema>)
  .strict()
  .readonly();
export type PlatformCapabilities = z.infer<typeof PlatformCapabilitiesSchema>;

export const PLATFORM_VERDICTS = ['native', 'mapped', 'dropped'] as const;
export type PlatformVerdict = (typeof PLATFORM_VERDICTS)[number];

/** ADR-0133 D8: why a field was dropped. New codes are added by amending the ADR. */
export const PLATFORM_DROP_CODES = [
  'code_tool_needs_public_mcp',
  'stdio_mcp_unsupported',
  'subagents_unsupported',
  'skills_unsupported',
  'knowledge_unsupported',
  'builtin_unsupported',
  'limits_unsupported',
  'permissions_unsupported',
  'field_unsupported',
] as const;
export type PlatformDropCode = (typeof PLATFORM_DROP_CODES)[number];

/** ADR-0133 D8: the only reasons a compile refuses instead of dropping. */
export const PLATFORM_REFUSAL_CODES = [
  'platform_model_unsupported',
  'platform_limit_exceeded',
  'platform_options_invalid',
  'platform_agent_not_found',
] as const;
export type PlatformRefusalCode = (typeof PLATFORM_REFUSAL_CODES)[number];

export const FieldVerdictSchema = z
  .object({
    path: z.string().min(1).max(512),
    verdict: z.enum(PLATFORM_VERDICTS),
    code: z.enum(PLATFORM_DROP_CODES).optional(),
    note: z.string().max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.verdict === 'dropped' && value.code === undefined) {
      context.addIssue({ code: 'custom', path: ['code'], message: 'a dropped field needs a code' });
    } else if (value.verdict !== 'dropped' && value.code !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'only a dropped field carries a code',
      });
    }
  })
  .readonly();
export type FieldVerdict = z.infer<typeof FieldVerdictSchema>;

/** One emitted file. `content` is UTF-8 text, or bytes when the source was binary (a skill asset). */
export const PlatformFileSchema = z
  .object({
    path: PortableRelativePathSchema,
    content: z.union([z.string(), z.instanceof(Uint8Array)]),
  })
  .strict()
  .readonly();
export type PlatformFile = z.infer<typeof PlatformFileSchema>;

export const PlatformRefusalSchema = z
  .object({
    code: z.enum(PLATFORM_REFUSAL_CODES),
    message: z.string().min(1).max(1_024),
    details: z.array(z.string().max(1_024)).max(64).readonly(),
  })
  .strict()
  .readonly();
export type PlatformRefusal = z.infer<typeof PlatformRefusalSchema>;

/** One platform as `GET /api/platforms` lists it; the target's `optionsSchema` is code, not wire. */
export const PlatformDescriptorSchema = z
  .object({
    id: PlatformIdSchema,
    displayName: z.string().min(1).max(80),
    docsUrl: z.url(),
    capabilities: PlatformCapabilitiesSchema,
  })
  .strict()
  .readonly();
export type PlatformDescriptor = z.infer<typeof PlatformDescriptorSchema>;

export const PlatformListResponseSchema = z
  .object({ platforms: z.array(PlatformDescriptorSchema).readonly() })
  .strict()
  .readonly();
export type PlatformListResponse = z.infer<typeof PlatformListResponseSchema>;

/** Bound of the export request body: options are a platform's own block, small by nature. */
export const PLATFORM_EXPORT_REQUEST_MAX_BYTES = 16 * 1024;
/** Bound of all file contents of one export, in decoded bytes. */
export const PLATFORM_EXPORT_MAX_BYTES = 8 * 1024 * 1024;

export const PlatformExportRequestSchema = z
  .object({
    version: z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX),
    /** A hosted target; the `eject-*` ids have no compiler here, so they are refused as a bad request. */
    platform: z.enum(HOSTED_PLATFORM_IDS),
    /** `extensions.platforms[platform]`; validated by that target's `optionsSchema`, never here. */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .readonly();
export type PlatformExportRequest = z.infer<typeof PlatformExportRequestSchema>;
export type PlatformExportRequestInput = z.input<typeof PlatformExportRequestSchema>;

/**
 * One emitted file on the wire. A {@link PlatformFile} may carry bytes (a skill asset), which JSON
 * cannot, so text travels as `utf8` and bytes as `base64`. The path rules are the emitted file's own.
 */
export const PlatformExportFileSchema = z
  .object({
    path: PortableRelativePathSchema,
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
  })
  .strict()
  .readonly();
export type PlatformExportFile = z.infer<typeof PlatformExportFileSchema>;

export const PlatformExportResponseSchema = z
  .object({
    agentId: z.string().min(1),
    version: z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX),
    platform: PlatformIdSchema,
    /** Every file the target emitted, plus `PLATFORM_REPORT.md`, sorted by `path`. */
    files: z.array(PlatformExportFileSchema).readonly(),
    report: z.array(FieldVerdictSchema).readonly(),
  })
  .strict()
  .readonly();
export type PlatformExportResponse = z.infer<typeof PlatformExportResponseSchema>;

/**
 * Problem codes the platform export routes answer, with the status each travels under (issue #968).
 * A code the version routes own keeps that table's status, read from it rather than retyped.
 */
export const PLATFORM_EXPORT_PROBLEM_CODES = {
  invalid_agent_id: AGENT_VERSION_PROBLEM_CODES.invalid_agent_id,
  /** The body is not a {@link PlatformExportRequest}; each `details` entry is `<path>: <message>`. */
  invalid_platform_export: 400,
  /** The target's `optionsSchema` refused `options`; each `details` entry is `<path>: <message>`. */
  platform_options_invalid: 400,
  agent_not_found: AGENT_VERSION_PROBLEM_CODES.agent_not_found,
  /** `details` is `[version:<n>]`. */
  agent_version_not_found: AGENT_VERSION_PROBLEM_CODES.agent_version_not_found,
  /** The agent's name is not lower-case kebab, which a portable agent requires. */
  agent_name_not_portable: 422,
  /** A compile refusal; `details` are the refusal's. */
  platform_model_unsupported: 422,
  platform_limit_exceeded: 422,
  /** A subagent name resolved to nothing. */
  platform_agent_not_found: 422,
  /** `details` is `[bytes:<n>, max:<PLATFORM_EXPORT_MAX_BYTES>]`. */
  platform_export_too_large: 422,
  agent_policy_not_configured: AGENT_VERSION_PROBLEM_CODES.agent_policy_not_configured,
} as const;
export type PlatformExportProblemCode = keyof typeof PLATFORM_EXPORT_PROBLEM_CODES;
