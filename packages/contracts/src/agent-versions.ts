import { z } from 'zod';

import { AgentResourceSchema } from './agents.js';
import { IsoDateTimeSchema } from './identifiers.js';
import { AgentEnvironmentSchema, AgentVersionNumberSchema } from './agent-versions/vocabulary.js';
import { AgentVersionDraftSchema, AgentVersionResourceSchema } from './agent-versions/body.js';

/**
 * Issue #440 (S1-02): the vocabulary of agent versions (ADR-0101). A version is an immutable,
 * numbered snapshot of one agent's definition and its surfaces (ADR-0108); an environment's
 * pointer names the version it runs. The shapes live in `./agent-versions/*`: the vocabulary, the
 * version body and its resource, the tool bundles and the tool sandbox, and the problem codes. This
 * module is their one public entry, and holds the pointer, promote, rollback and
 * create-from-version shapes.
 */
export {
  AGENT_ENVIRONMENTS,
  AGENT_VERSION_NUMBER_MAX,
  AGENT_VERSION_SUMMARY_MAX_LENGTH,
  AGENT_VERSION_SURFACES_MAX,
  AGENT_VERSION_VIAS,
  AgentEnvironmentSchema,
  AgentVersionViaSchema,
  CLIENT_AGENT_VERSION_VIAS,
  ClientAgentVersionViaSchema,
  type AgentEnvironment,
  type AgentVersionVia,
  type ClientAgentVersionVia,
} from './agent-versions/vocabulary.js';
export {
  AgentVersionBodySchema,
  AgentVersionCheckResponseSchema,
  AgentVersionDraftSchema,
  AgentVersionResourceSchema,
  AgentVersionSummarySchema,
  CreateAgentVersionRequestSchema,
  type AgentVersionBody,
  type AgentVersionBodyInput,
  type AgentVersionCheckResponse,
  type AgentVersionDraft,
  type AgentVersionDraftInput,
  type AgentVersionResource,
  type CreateAgentVersionRequest,
  type CreateAgentVersionRequestInput,
} from './agent-versions/body.js';
export {
  AgentVersionToolBundleSchema,
  TOOL_BUNDLE_DIGEST_PATTERN,
  TOOL_BUNDLE_MAX_BYTES,
  TOOL_BUNDLE_PROBLEM_CODES,
  TOOL_BUNDLE_TIMEOUT_MAX_MS,
  TOOL_SANDBOX_DECLARATION_MAX,
  ToolAllowedDomainsSchema,
  ToolBundleDigestSchema,
  ToolBundleResponseSchema,
  ToolBundleSchema,
  ToolSecretNamesSchema,
  UploadToolBundleRequestSchema,
  UploadToolBundleResponseSchema,
  type AgentVersionToolBundle,
  type ToolBundle,
  type ToolBundleProblemCode,
  type ToolBundleResponse,
  type UploadToolBundleRequest,
  type UploadToolBundleResponse,
} from './agent-versions/tool-bundles.js';
export {
  TOOL_SANDBOX_TOOLS_MAX,
  ToolSandboxManifestSchema,
  ToolSandboxRequestSchema,
  ToolSandboxToolSchema,
  type ToolSandboxManifest,
  type ToolSandboxRequest,
} from './agent-versions/tool-sandbox.js';
export {
  AGENT_VERSION_PROBLEM_CODES,
  type AgentVersionProblemCode,
} from './agent-versions/problem-codes.js';

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
