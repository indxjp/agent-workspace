import { z } from 'zod';

import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_PROBLEM_CODES,
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_NAME_MAX_LENGTH,
  AGENT_POLICY_PROBLEM_CODES,
  AgentDefinitionSchema,
  AgentResourceSchema,
} from './agents.js';
import { IsoDateTimeSchema } from './identifiers.js';
import {
  PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH,
  PORTABLE_AGENT_LIST_MAX,
  PORTABLE_AGENT_SUBAGENTS_MAX,
} from './portable-agent.js';
import { SecretNameSchema } from './secret-reference.js';
import { STORAGE_CONNECTION_PROBLEM_CODES } from './storage-connections.js';
import { SurfaceDefinitionSchema } from './surfaces.js';
import { ToolOperationNameSchema } from './tool-connectors.js';

/**
 * Issue #440 (S1-02): the vocabulary of agent versions (ADR-0101). A version is an immutable,
 * numbered snapshot of one agent's definition and its surfaces (ADR-0108); an environment's
 * pointer names the version it runs. `aw push` (`via: 'aw-push'`), the browser (`via: 'ui'`),
 * a plain API client (`via: 'api'`) and the Builder (`via: 'builder'`) all save one the same
 * way. The routes arrive with S1-05 and S1-06; this module is their shared shape.
 */
export const AGENT_VERSION_VIAS = ['ui', 'aw-push', 'api', 'builder'] as const;
export type AgentVersionVia = (typeof AGENT_VERSION_VIAS)[number];
/** {@link AGENT_VERSION_VIAS} as a schema (ADR-0101; issue #440). */
export const AgentVersionViaSchema = z.enum(AGENT_VERSION_VIAS);

/**
 * The `via` values a client may send: every one but `'builder'`. The Builder saves a version
 * in-process, so a request body that named it would only let a member pose as the Builder in the
 * version history (issue #1847). Derived from {@link AGENT_VERSION_VIAS}, never a second list.
 */
export const CLIENT_AGENT_VERSION_VIAS = AGENT_VERSION_VIAS.filter(
  (via): via is Exclude<AgentVersionVia, 'builder'> => via !== 'builder',
);
export type ClientAgentVersionVia = (typeof CLIENT_AGENT_VERSION_VIAS)[number];
/** {@link CLIENT_AGENT_VERSION_VIAS} as a schema, for every request and draft a client sends. */
export const ClientAgentVersionViaSchema = z.enum(CLIENT_AGENT_VERSION_VIAS);

/**
 * The environments a pointer may name (ADR-0101, ADR-0108; issues #440, #612). `local` is the
 * working draft `aw push` moves; `production` is what public surfaces serve. Moving `production`
 * rewrites nothing but its pointer. `preview` is not an environment (P-6).
 */
export const AGENT_ENVIRONMENTS = ['local', 'production'] as const;
export type AgentEnvironment = (typeof AGENT_ENVIRONMENTS)[number];
/** {@link AGENT_ENVIRONMENTS} as a schema (ADR-0101; issue #440). */
export const AgentEnvironmentSchema = z.enum(AGENT_ENVIRONMENTS);

/** The most surfaces one version may carry (ADR-0101, ADR-0108; issue #440). */
export const AGENT_VERSION_SURFACES_MAX = 16;

/** The longest version summary, in characters (ADR-0101; issue #440). */
export const AGENT_VERSION_SUMMARY_MAX_LENGTH = 200;

/**
 * The largest version number: PostgreSQL's `integer` maximum, so a number the contract accepts is
 * one S1-04's version store can hold and look up — a larger one is refused as a bad request here
 * rather than overflowing the column as a `500` (ADR-0101; issue #440).
 */
export const AGENT_VERSION_NUMBER_MAX = 2_147_483_647;

/** A version number: the first version of an agent is `1`. */
const AgentVersionNumberSchema = z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX);

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

/** The secrets a code tool declares (ADR-0118 TS4): names only, each once. */
export const ToolSecretNamesSchema = z
  .array(SecretNameSchema)
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

/**
 * What a version holds: the agent's portable definition and its surfaces (ADR-0101, ADR-0108;
 * issue #440). `surfaces` defaults to `[]`, so an agent with no surface saves without one.
 * `toolBundles` is absent unless the agent has code tools (issue #790), so every earlier body is
 * unchanged. `description`, `subagents` and `knowledge` (ADR-0133) are absent unless the agent sets
 * them, for the same reason.
 *
 * These rules hold across the body, each refused at the offending entry's path:
 *
 * - surface names are unique within the body (`['surfaces', i, 'name']`);
 * - every surface names this body's agent, `definition.agent.name` (`['surfaces', i, 'agent']`) —
 *   a surface naming a different agent would otherwise be saved and silently attached to this one;
 * - a tool has at most one bundle (`['toolBundles', i, 'tool']`);
 * - subagent names are unique and none is the agent itself (`['subagents', i, 'name']`);
 * - knowledge is a label on resources the agent already reaches: every `files` path is granted in
 *   `definition.resources.files` (`['knowledge', i, 'paths', j]`) and every `connector` is in
 *   `definition.resources.connectors` (`['knowledge', i, 'name']`).
 */
export const AgentVersionBodySchema = z
  .object({
    definition: AgentDefinitionSchema,
    surfaces: z
      .array(SurfaceDefinitionSchema)
      .max(AGENT_VERSION_SURFACES_MAX)
      .default([])
      .readonly(),
    toolBundles: z
      .array(AgentVersionToolBundleSchema)
      .max(AGENT_DEFINITION_MAX_REFERENCES)
      .readonly()
      .optional(),
    /** ADR-0133 D2: what the agent is for, shown to platforms and to a parent agent choosing it. */
    description: z.string().min(1).max(PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH).optional(),
    /** ADR-0133 D14: other agents of this workspace this agent may delegate to, by name; one level. */
    subagents: z
      .array(
        z
          .object({ name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH) })
          .strict()
          .readonly(),
      )
      .max(PORTABLE_AGENT_SUBAGENTS_MAX)
      .readonly()
      .optional(),
    /** ADR-0133 D2: knowledge sources. Agent Workspace honours `files` and `connector`; `url` is not accepted in a body. */
    knowledge: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('files'),
              paths: z
                .array(z.string().min(1).max(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH))
                .min(1)
                .max(PORTABLE_AGENT_LIST_MAX)
                .readonly(),
            })
            .strict()
            .readonly(),
          z
            .object({
              kind: z.literal('connector'),
              name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
            })
            .strict()
            .readonly(),
        ]),
      )
      .max(PORTABLE_AGENT_LIST_MAX)
      .readonly()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const subagentNames = new Set<string>();
    for (const [index, subagent] of (value.subagents ?? []).entries()) {
      if (subagentNames.has(subagent.name) || subagent.name === value.definition.agent.name) {
        context.addIssue({
          code: 'custom',
          path: ['subagents', index, 'name'],
          message:
            subagent.name === value.definition.agent.name
              ? 'an agent cannot be its own subagent'
              : `the subagent ${JSON.stringify(subagent.name)} is already named in this version`,
        });
      }
      subagentNames.add(subagent.name);
    }
    const grantedFiles = new Set(value.definition.resources.files.map((file) => file.path));
    const connectors = new Set(value.definition.resources.connectors);
    const knowledgeConnectors = new Set<string>();
    for (const [index, source] of (value.knowledge ?? []).entries()) {
      if (source.kind === 'connector') {
        if (knowledgeConnectors.has(source.name)) {
          context.addIssue({
            code: 'custom',
            path: ['knowledge', index],
            message: `the knowledge connector ${JSON.stringify(source.name)} is already named in this version`,
          });
        }
        knowledgeConnectors.add(source.name);
        if (!connectors.has(source.name)) {
          context.addIssue({
            code: 'custom',
            path: ['knowledge', index, 'name'],
            message: `the knowledge connector ${JSON.stringify(source.name)} is not in resources.connectors`,
          });
        }
        continue;
      }
      for (const [pathIndex, path] of source.paths.entries()) {
        if (!grantedFiles.has(path)) {
          context.addIssue({
            code: 'custom',
            path: ['knowledge', index, 'paths', pathIndex],
            message: `the knowledge file ${JSON.stringify(path)} is not granted in resources.files`,
          });
        }
      }
    }
    const bundled = new Set<string>();
    for (const [index, bundle] of (value.toolBundles ?? []).entries()) {
      if (bundled.has(bundle.tool)) {
        context.addIssue({
          code: 'custom',
          path: ['toolBundles', index, 'tool'],
          message: `the tool ${JSON.stringify(bundle.tool)} already has a bundle in this version`,
        });
      }
      bundled.add(bundle.tool);
    }
    const agentName = value.definition.agent.name;
    const seen = new Set<string>();
    for (const [index, surface] of value.surfaces.entries()) {
      if (seen.has(surface.name)) {
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'name'],
          message: `the surface name ${JSON.stringify(surface.name)} is already used in this version`,
        });
      }
      seen.add(surface.name);
      if (surface.agent !== agentName) {
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'agent'],
          message: `must be ${JSON.stringify(agentName)}, the agent this version defines`,
        });
      }
    }
  })
  .readonly();
/** A parsed version body; `surfaces` is always present (ADR-0101; issue #440). */
export type AgentVersionBody = z.infer<typeof AgentVersionBodySchema>;
/** What {@link AgentVersionBodySchema} accepts; `surfaces` and `policySource` may be left out. */
export type AgentVersionBodyInput = z.input<typeof AgentVersionBodySchema>;

/**
 * A one-line description of what a version changed: 1–200 characters, no control (`Cc`), format
 * (`Cf`), lone surrogate (`Cs`) or line or paragraph separator (`Zl`, `Zp`) character, and no
 * whitespace at either end, so a summary of spaces alone is refused. The length check aborts
 * before the patterns run (ADR-0101; issue #440).
 */
export const AgentVersionSummarySchema = z
  .string()
  .min(1, { abort: true })
  .max(AGENT_VERSION_SUMMARY_MAX_LENGTH, { abort: true })
  .regex(
    /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u,
    'must not contain control or invisible characters',
  )
  .regex(/^(?!\s)[\s\S]*(?<!\s)$/u, 'must not start or end with whitespace');

const AGENT_VERSION_DRAFT_SHAPE = {
  body: AgentVersionBodySchema,
  summary: AgentVersionSummarySchema,
  via: ClientAgentVersionViaSchema,
};

/** A version as a client submits it: the body, a summary and how it was saved (ADR-0101; #440). */
export const AgentVersionDraftSchema = z.object(AGENT_VERSION_DRAFT_SHAPE).strict().readonly();
export type AgentVersionDraft = z.infer<typeof AgentVersionDraftSchema>;
export type AgentVersionDraftInput = z.input<typeof AgentVersionDraftSchema>;

/**
 * The body of a create-version request (S1-05). `dryRun: true` runs the whole save pipeline and
 * writes nothing (C8); `dryRun: false` is refused rather than meaning "save", so a client cannot
 * believe it asked for a dry run when it did not (ADR-0101; issue #440).
 */
export const CreateAgentVersionRequestSchema = z
  .object({ ...AGENT_VERSION_DRAFT_SHAPE, dryRun: z.literal(true).optional() })
  .strict()
  .readonly();
export type CreateAgentVersionRequest = z.infer<typeof CreateAgentVersionRequestSchema>;
export type CreateAgentVersionRequestInput = z.input<typeof CreateAgentVersionRequestSchema>;

/**
 * One saved version as it crosses the HTTP boundary — and the columns S1-04's version store keeps.
 * A version is immutable: it has a `createdAt` and no `updatedAt` (ADR-0101; issue #440).
 */
export const AgentVersionResourceSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    number: AgentVersionNumberSchema,
    summary: AgentVersionSummarySchema,
    via: AgentVersionViaSchema,
    body: AgentVersionBodySchema,
    createdByPrincipalId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentVersionResource = z.infer<typeof AgentVersionResourceSchema>;

/**
 * The `200` of every dry run: the body would be saved, as version `number` (ADR-0101; C8;
 * issue #440).
 */
export const AgentVersionCheckResponseSchema = z
  .object({ ok: z.literal(true), number: AgentVersionNumberSchema })
  .strict()
  .readonly();
export type AgentVersionCheckResponse = z.infer<typeof AgentVersionCheckResponseSchema>;

/** Which version an environment runs, and when that last changed (ADR-0101; issue #440). */
export const AgentVersionPointerSchema = z
  .object({
    environment: AgentEnvironmentSchema,
    number: AgentVersionNumberSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentVersionPointer = z.infer<typeof AgentVersionPointerSchema>;

/**
 * Why a pointer moved (issue #615): `set` is `PUT /pointers` (`aw push`) and an agent's first
 * version, `promote` and `rollback` are their own routes.
 */
export const AGENT_POINTER_MOVE_REASONS = ['set', 'promote', 'rollback'] as const;
export type AgentPointerMoveReason = (typeof AGENT_POINTER_MOVE_REASONS)[number];

/** How many pointer moves a version listing carries, newest first (issue #615). */
export const AGENT_POINTER_MOVES_LISTED = 10;

/**
 * One entry of an environment's pointer history (issue #615). `movedByPrincipalId` is `null` only
 * for a move recorded from a pointer that predates the history.
 */
export const AgentPointerMoveSchema = z
  .object({
    environment: AgentEnvironmentSchema,
    number: AgentVersionNumberSchema,
    reason: z.enum(AGENT_POINTER_MOVE_REASONS),
    movedByPrincipalId: z.string().min(1).nullable(),
    movedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type AgentPointerMove = z.infer<typeof AgentPointerMoveSchema>;

/**
 * The newest evaluation of one version (issue #714): what the promotion gate reads before it
 * judges the version (issue #619), so the score shown is the score gated. `score` is
 * `passed / total` rounded to four places.
 */
export const AgentVersionEvaluationSchema = z
  .object({
    version: AgentVersionNumberSchema,
    score: z.number().min(0).max(1),
    passed: z.number().int().min(0),
    total: z.number().int().min(1),
  })
  .strict()
  .readonly();
export type AgentVersionEvaluation = z.infer<typeof AgentVersionEvaluationSchema>;

/**
 * An agent's versions and its environment pointers. Slice 1 has no pagination (ADR-0101;
 * issue #440).
 */
export const AgentVersionListResponseSchema = z
  .object({
    items: z.array(AgentVersionResourceSchema).readonly(),
    /** At most one pointer per environment, as S1-04's `(agent_id, environment)` key holds them. */
    pointers: z
      .array(AgentVersionPointerSchema)
      .superRefine((pointers, context) => {
        const seen = new Set<string>();
        for (const [index, pointer] of pointers.entries()) {
          if (seen.has(pointer.environment)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'environment'],
              message: `the environment ${JSON.stringify(pointer.environment)} already has a pointer`,
            });
          }
          seen.add(pointer.environment);
        }
      })
      .readonly(),
    /**
     * The version the agent was last written from, or `null` once it was edited outside versions
     * (the UI's `PATCH`, `PUT /policy` or `PUT /resources`). `aw push` reads the agent as edited
     * since its `local` pointer moved when this differs from that pointer's `number` (issue #613).
     */
    materialised: AgentVersionNumberSchema.nullable(),
    /**
     * The last {@link AGENT_POINTER_MOVES_LISTED} pointer moves of every environment, newest first
     * (issue #615). A server older than the history omits it, which reads as `[]`.
     */
    moves: z.array(AgentPointerMoveSchema).max(AGENT_POINTER_MOVES_LISTED).readonly().default([]),
    /**
     * The newest evaluation of every version that has one, oldest version first; a version with
     * none is absent (issue #714). A server older than this field omits it, which reads as `[]`.
     */
    evaluations: z.array(AgentVersionEvaluationSchema).readonly().default([]),
  })
  .strict()
  .readonly();
export type AgentVersionListResponse = z.infer<typeof AgentVersionListResponseSchema>;

/**
 * Points an environment at a saved version (S1-06; ADR-0101; issue #440). `expectedVersion` makes
 * the move a compare-and-set (#1847): the number the environment must point at when the move runs,
 * or `null` for "must be unset". Another pointer answers `409 pointer_moved` and moves nothing;
 * absent, the move is unconditional.
 */
export const SetAgentPointerRequestSchema = z
  .object({
    environment: AgentEnvironmentSchema,
    version: AgentVersionNumberSchema,
    expectedVersion: AgentVersionNumberSchema.nullable().optional(),
  })
  .strict()
  .readonly();
export type SetAgentPointerRequest = z.infer<typeof SetAgentPointerRequestSchema>;

/** The `200` of a pointer move: the agent as it now runs, and the pointer (ADR-0101; #440). */
export const SetAgentPointerResponseSchema = z
  .object({ agent: AgentResourceSchema, pointer: AgentVersionPointerSchema })
  .strict()
  .readonly();
export type SetAgentPointerResponse = z.infer<typeof SetAgentPointerResponseSchema>;

/**
 * Points `production` at `local`'s version, or at `version` when given (issue #615). `dryRun: true`
 * decides and validates the move and writes nothing; `dryRun: false` is refused, as on a version
 * save. When the deployment's policy sets `promotion.minEvalScore`, the version's latest evaluation
 * must reach it (issue #619): otherwise `409 promotion_not_evaluated` or `409 promotion_gate_failed`,
 * and a dry run answers the same.
 */
export const PromoteAgentRequestSchema = z
  .object({ version: AgentVersionNumberSchema.optional(), dryRun: z.literal(true).optional() })
  .strict()
  .readonly();
export type PromoteAgentRequest = z.infer<typeof PromoteAgentRequestSchema>;

/**
 * Points `environment` (default `production`) back at the version before its pointer's (issue
 * #615). A rollback steps back past the version it left, so rolling back twice goes two versions
 * back, never forward again. `dryRun` is as on {@link PromoteAgentRequestSchema}.
 */
export const RollbackAgentRequestSchema = z
  .object({
    environment: AgentEnvironmentSchema.default('production'),
    dryRun: z.literal(true).optional(),
  })
  .strict()
  .readonly();
export type RollbackAgentRequest = z.infer<typeof RollbackAgentRequestSchema>;
export type RollbackAgentRequestInput = z.input<typeof RollbackAgentRequestSchema>;

/**
 * The `200` of a promote or a rollback (issue #615): the environment's version before and after
 * the move, and whether it was saved (`false` for a dry run). `from` is `null` when the environment
 * had no pointer. `bar` is the promotion gate's bar the move passed (issue #619): `null` when the
 * deployment sets none, and always on a rollback, which is never gated. An older server omits it.
 */
export const AgentPointerMoveResponseSchema = z
  .object({
    environment: AgentEnvironmentSchema,
    from: AgentVersionNumberSchema.nullable(),
    to: AgentVersionNumberSchema,
    saved: z.boolean(),
    bar: z.number().min(0).max(1).nullable().default(null),
  })
  .strict()
  .readonly();
export type AgentPointerMoveResponse = z.infer<typeof AgentPointerMoveResponseSchema>;

/**
 * Creates an agent from its first version. The agent's name is `version.body.definition.agent.name`;
 * the strict object refuses the legacy `CreateAgentInput` keys (`name`, `instructions`, …), so the
 * two request shapes never overlap (ADR-0101; issue #440).
 */
export const CreateAgentFromVersionRequestSchema = z
  .object({ version: AgentVersionDraftSchema, dryRun: z.literal(true).optional() })
  .strict()
  .readonly();
export type CreateAgentFromVersionRequest = z.infer<typeof CreateAgentFromVersionRequestSchema>;
export type CreateAgentFromVersionRequestInput = z.input<
  typeof CreateAgentFromVersionRequestSchema
>;

/** The `201` of a create-from-version: the agent and its version `1` (ADR-0101; issue #440). */
export const CreateAgentFromVersionResponseSchema = z
  .object({ agent: AgentResourceSchema, version: AgentVersionResourceSchema })
  .strict()
  .readonly();
export type CreateAgentFromVersionResponse = z.infer<typeof CreateAgentFromVersionResponseSchema>;

/**
 * Problem codes the version routes (S1-05, S1-06) answer, with the status each travels under
 * (ADR-0101, ADR-0108; issue #440). A code another table already owns keeps that table's status,
 * read from it rather than retyped. RBAC's `forbidden` stays in `COMMON_PROBLEM_CODES`.
 */
export const AGENT_VERSION_PROBLEM_CODES = {
  /** The agent id in the route's path is not a UUID — what every `/api/agents/:id` route answers. */
  invalid_agent_id: 400,
  /**
   * The body is not a version request; each `details` entry is one parse issue,
   * `<dotted.path>: <message>` (`(root)` for the body itself).
   */
  invalid_agent_version: 400,
  /** The definition's policy names an engine this deployment does not register. */
  unsupported_engine: AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
  /** The definition's policy asks for `permissionMode: 'bypassPermissions'`. */
  dangerous_permission_mode_refused: AGENT_POLICY_PROBLEM_CODES.dangerous_permission_mode_refused,
  /** The agent the route names does not exist in this workspace. */
  agent_not_found: AGENT_POLICY_PROBLEM_CODES.agent_not_found,
  /** This deployment has no policy store, so a definition's policy cannot be checked or saved. */
  agent_policy_not_configured: AGENT_POLICY_PROBLEM_CODES.agent_policy_not_configured,
  /**
   * The version number the request names does not exist; `details` is `[version:<n>]`. The release
   * model's `version_not_found` (issue #615).
   */
  agent_version_not_found: 404,
  /** Another save took the version number an in-process create named; start over (#1848). */
  agent_version_number_taken: 409,
  /** A promote's source, `local`, points at no version, so there is nothing to promote (#615). */
  no_pointer: 409,
  /** A rollback's environment has no history entry before its pointer (issue #615). */
  nothing_to_roll_back: 409,
  /**
   * A pointer move's `expectedVersion` is not what the environment points at now (#1847); `details`
   * is `[environment:<environment>, current:<n|none>]`. Read the agent again and decide anew.
   */
  pointer_moved: 409,
  /**
   * The deployment's policy sets a promotion bar, and the version has no evaluation; `details` is
   * `[version:<n>, bar:<bar>]` (issue #619).
   */
  promotion_not_evaluated: 409,
  /**
   * The version's latest evaluation passed less than the bar's share of its cases; `details` is
   * `[version:<n>, score:<score>, bar:<bar>, case:<name>…]`, the failing cases in order (#619).
   */
  promotion_gate_failed: 409,
  /**
   * The version lists the local tool host's connector (`AW_DEV_TOOLS_CONNECTOR`), so it
   * runs code tools that only `aw dev` serves, and an environment other than `local` cannot run
   * them (ADR-0115); `details` is `[connector:aw-dev-tools, environment:<environment>]`.
   */
  code_tool_needs_host: 422,
  /**
   * A code tool in the version declares `allowedDomains`, which the deployment's tool sandbox
   * cannot enforce (ADR-0120 LC4, issue #1018); `details` is `[tool:<name>…]`, the tools in body
   * order. Remove the domains or deploy where the tool sandbox enforces them.
   */
  network_policy_unsupported: 422,
  /**
   * The version lists a `stdio` MCP connector, which runs only in a per-session tool sandbox
   * (ADR-0118 TS6) or as a local child under `aw dev`, and no environment other than `local`
   * can start a tool sandbox yet; `details` is `[connector:<name>…, environment:<environment>]`,
   * the connectors in body order.
   */
  stdio_connector_needs_tool_sandbox: 422,
  /**
   * The version pins a code-tool bundle this workspace does not hold (issue #790); `details` is
   * `[tool_bundle:<digest>]` for each such digest, in body order. Upload the bundle first
   * (`POST /api/tool-bundles`).
   */
  tool_bundle_unknown: 422,
  /** This deployment has no store for tool bundles, so a version that pins one cannot be checked. */
  tool_bundles_not_configured: TOOL_BUNDLE_PROBLEM_CODES.tool_bundles_not_configured,
  /** Names in the definition do not exist here; each `details` entry is `<kind>:<name>`. */
  agent_definition_references_missing:
    AGENT_DEFINITION_PROBLEM_CODES.agent_definition_references_missing,
  /** A name in the definition matches more than one resource; each entry is `<kind>:<name>`. */
  agent_definition_reference_ambiguous:
    AGENT_DEFINITION_PROBLEM_CODES.agent_definition_reference_ambiguous,
  /** The engine cannot honour an assigned connector or skill; `details` is the capability. */
  engine_capability_unsupported: AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
  /**
   * The version would nest subagents (ADR-0133 D14: one level, refused both ways). A subagent it
   * names cannot be used: no agent of that name in this workspace, or that agent itself declares
   * subagents. Or the agent being saved is already another agent's subagent, so it may not declare
   * any. `details` is `subagent:<name>` per unusable subagent, in body order, then `parent:<name>`
   * per agent that names this one, sorted.
   */
  agent_subagent_unusable: 422,
  /** The version changes the engine in a way that would widen the agent; each entry is the item. */
  engine_switch_would_widen: AGENT_POLICY_PROBLEM_CODES.engine_switch_would_widen,
  /**
   * The version asks for more than the deployment's policy ceiling allows (C14, ADR-0102 SD6,
   * issue #524); `details` are the C14 widenings. Answered whatever the caller's role.
   */
  policy_cannot_widen: AGENT_POLICY_PROBLEM_CODES.policy_cannot_widen,
  /**
   * A pointer move or a create-from-version would give the workspace two surfaces of one name
   * (C9); `details` is `[surface:<name>]` for each such name.
   */
  surface_name_taken: 409,
  /**
   * The agent name the version defines is already another agent's in this workspace
   * (create-from-version; a pointer move that renames the agent) — the same unique key and status
   * legacy `POST`/`PATCH /api/agents` answer. No `details` (issue #480; S1-09, issue #447).
   */
  agent_name_conflict: 409,
  /** An assigned file is not in this workspace; `details` is `[<id>]` (resource assignments). */
  unknown_file: 400,
  /** An assigned skill is not in this workspace; `details` is `[<id>]`. */
  unknown_skill: 400,
  /** An assigned skill is being deleted and cannot be assigned any more; `details` is `[<id>]`. */
  skill_deleting: 409,
  /** An assigned connector is not in this workspace; `details` is `[<id>]`. */
  unknown_connector: 400,
  /**
   * A `storage://<connection>/<folder>` grant names a folder outside the connection's allowed
   * folders; `details` are the refused paths in body order (the storage design, §05).
   */
  storage_connection_prefix_not_allowed:
    STORAGE_CONNECTION_PROBLEM_CODES.storage_connection_prefix_not_allowed,
  /** A `read-write` storage grant names a connection that is read-only; `details` as above. */
  storage_connection_write_not_allowed:
    STORAGE_CONNECTION_PROBLEM_CODES.storage_connection_write_not_allowed,
} as const;
export type AgentVersionProblemCode = keyof typeof AGENT_VERSION_PROBLEM_CODES;

/** The base64 length of a {@link TOOL_BUNDLE_MAX_BYTES} payload. */
const TOOL_BUNDLE_MAX_BASE64_LENGTH = Math.ceil(TOOL_BUNDLE_MAX_BYTES / 3) * 4;

/** A flat character-class run: unlike a grouped pattern it cannot exhaust the stack on 11 MB. */
const TOOL_BUNDLE_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

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

/** One tool of a session's sandbox: what the tool host serves, and the bundle it runs. */
export const ToolSandboxToolSchema = z
  .object({
    name: ToolOperationNameSchema,
    description: z.string().min(1).max(2048),
    inputSchema: z.record(z.string(), z.unknown()).readonly(),
    timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS),
    digest: ToolBundleDigestSchema,
    bundleBase64: z
      .string()
      .min(1)
      .max(TOOL_BUNDLE_MAX_BASE64_LENGTH)
      .regex(TOOL_BUNDLE_BASE64_PATTERN, 'must be standard padded base64'),
  })
  .strict()
  .readonly();

/** The most tools one session's tool sandbox serves. */
export const TOOL_SANDBOX_TOOLS_MAX = 64;

const NPM_PACKAGE_NAME = String.raw`(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*`;
const EXACT_SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
/** `<package>@<exact version>`: a range, a tag or `latest` is not a pin. */
const PINNED_NPM_PACKAGE = new RegExp(`^${NPM_PACKAGE_NAME}@${EXACT_SEMVER}$`, 'u');

/**
 * One `stdio` MCP server of a session's sandbox (ADR-0118 TS6): launched once, behind the same
 * front as the tools, at `/stdio/<name>/mcp`. The command is pinned: `npx`, then optionally `-y`,
 * then `<package>@<exact version>`, then the server's own arguments. A secret never travels in
 * `args`; the server gets the sandbox's environment (TS4).
 */
const ToolSandboxStdioServerSchema = z
  .object({
    name: ToolOperationNameSchema,
    command: z.literal('npx'),
    args: z.array(z.string().max(1024)).min(1).max(64).readonly(),
    timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS),
  })
  .strict()
  .readonly()
  .superRefine((server, context) => {
    const [first, second] = server.args;
    const pinned = first === '-y' ? second : first;
    if (pinned === undefined || !PINNED_NPM_PACKAGE.test(pinned)) {
      context.addIssue({
        code: 'custom',
        path: ['args'],
        message: 'must name a package pinned to an exact version: [-y] <package>@<x.y.z>',
      });
    }
  });

/**
 * What the runner hands a tool sandbox (ADR-0118 TS2, TS4, TS6): the tools and `stdio` servers to
 * serve and `env`, which is the sandbox's whole environment, exactly the secrets the session's
 * tools and servers declared. It is written into the sandbox as a file, never passed as an
 * argument or an image environment variable.
 */
export const ToolSandboxManifestSchema = z
  .object({
    tools: z.array(ToolSandboxToolSchema).max(TOOL_SANDBOX_TOOLS_MAX).readonly(),
    stdioServers: z
      .array(ToolSandboxStdioServerSchema)
      .max(TOOL_SANDBOX_TOOLS_MAX)
      .readonly()
      .default([]),
    env: z.record(SecretNameSchema, z.string().max(65_536)).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((manifest, context) => {
    if (manifest.tools.length + manifest.stdioServers.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'must serve a tool or a server',
      });
    }
    const seen = new Set<string>();
    manifest.stdioServers.forEach((server, index) => {
      if (seen.has(server.name)) {
        context.addIssue({
          code: 'custom',
          path: ['stdioServers', index, 'name'],
          message: 'must be unique',
        });
      }
      seen.add(server.name);
    });
  });
export type ToolSandboxManifest = z.infer<typeof ToolSandboxManifestSchema>;

/**
 * What a run request tells the runner about its session's tool sandbox (ADR-0118 TS2, TS3, TS4,
 * TS5): `key` identifies the session's tool set (a changed key replaces the sandbox), `manifest` is
 * what to serve, `allowedDomains` the union the sandbox may reach, and `run` the run and the
 * per-run bearer token the gateway will present for it.
 */
export const ToolSandboxRequestSchema = z
  .object({
    key: z.string().min(1).max(128),
    manifest: ToolSandboxManifestSchema,
    allowedDomains: ToolAllowedDomainsSchema,
    run: z
      .object({ runId: z.string().min(1).max(128), token: z.string().min(16).max(256) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ToolSandboxRequest = z.infer<typeof ToolSandboxRequestSchema>;
