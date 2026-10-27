/**
 * The Builder vocabulary (design §04 "The core and its ports" and "The aw-control tools", §08 Design
 * rule 5): the tool names, the tool inputs and outputs, the decision kinds, the refusal codes and the
 * default limits, defined once. The core, the endpoint, the agent prompt, the UI and the CLI all
 * read this file; none of them invents a name. Types only, no behaviour.
 */
import { z } from 'zod';

import {
  AGENT_VERSION_NUMBER_MAX,
  AgentVersionBodySchema,
  AgentVersionSummarySchema,
} from './agent-versions.js';
import { CreateEvaluationRequestSchema, EVALUATION_CASE_LIMIT } from './evaluations.js';
import { UuidSchema } from './identifiers.js';
import { RUN_START_PROBLEM_CODES, RUN_STATUSES } from './runs.js';
import { AW_CONTROL_CONNECTOR } from './tool-connectors.js';

/**
 * The reserved tool-server id the Builder agent talks to (design §04), like `AW_DEV_TOOLS_CONNECTOR`
 * in `tool-connectors.ts`.
 */
export const AW_CONTROL_SERVER = AW_CONTROL_CONNECTOR;

/**
 * Tool names, wire name to display name (spec correction 1: model APIs accept only
 * `[a-zA-Z0-9_-]{1,64}`, so the wire name uses underscores and the design's dotted name is for docs
 * and the UI). `kind` is the cost class (design §04); `phase` is the delivery phase.
 */
export const BUILDER_TOOLS = {
  catalog_list: { display: 'catalog.list', kind: 'read', phase: 'B0' },
  examples_get: { display: 'examples.get', kind: 'read', phase: 'B0' },
  draft_check: { display: 'draft.check', kind: 'read', phase: 'B0' },
  draft_save: { display: 'draft.save', kind: 'write', phase: 'B1' },
  evals_run: { display: 'evals.run', kind: 'write', phase: 'B1' },
  trial_run: { display: 'trial.run', kind: 'spend', phase: 'B1' },
} as const;
export type BuilderToolName = keyof typeof BUILDER_TOOLS;
export const BUILDER_TOOL_NAMES = Object.keys(BUILDER_TOOLS) as readonly BuilderToolName[];

/** What `catalog_list` can list (design §04). */
export const BUILDER_CATALOG_KINDS = [
  'engines',
  'models',
  'skills',
  'connectors',
  'files',
  'runtimeProfiles',
] as const;

/** What the core can ask the person to approve (design §04). */
export const BUILDER_APPROVAL_QUESTIONS = [
  'approve_save',
  'approve_trial',
  'approve_evals',
] as const;
export type BuilderApprovalQuestion = (typeof BUILDER_APPROVAL_QUESTIONS)[number];

/** The longest trial input, in characters. */
export const BUILDER_TRIAL_INPUT_MAX_LENGTH = 4_000;

const AgentIdSchema = UuidSchema;
const VersionSchema = z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX);
const AwCommandSchema = z.string().min(1);
const EvaluationCasesSchema = CreateEvaluationRequestSchema.unwrap().shape.cases;

/**
 * Tool inputs, keyed by wire name (design §04). None carries `workspaceId`, `principal`, `role` or
 * `via`: those come from the run token (design §08 Security rule 2), and `.strict()` refuses them.
 */
export const BuilderToolInputSchemas = {
  catalog_list: z
    .object({
      kinds: z.array(z.enum(BUILDER_CATALOG_KINDS)).max(BUILDER_CATALOG_KINDS.length).optional(),
    })
    .strict(),
  examples_get: z.object({ name: z.string().min(1).max(64).optional() }).strict(),
  draft_check: z
    .object({ agentId: AgentIdSchema.optional(), body: AgentVersionBodySchema })
    .strict(),
  draft_save: z
    .object({
      agentId: AgentIdSchema.optional(),
      baseVersion: VersionSchema.optional(),
      body: AgentVersionBodySchema,
      summary: AgentVersionSummarySchema.optional(),
    })
    .strict()
    .superRefine((input, context) => {
      if (input.agentId !== undefined && input.baseVersion === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseVersion'],
          message: 'baseVersion is required when agentId is set',
        });
      }
      if (input.agentId === undefined && input.baseVersion !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseVersion'],
          message: 'baseVersion is only valid when agentId is set',
        });
      }
    }),
  evals_run: z
    .object({
      agentId: AgentIdSchema,
      version: VersionSchema,
      cases: EvaluationCasesSchema,
    })
    .strict(),
  trial_run: z
    .object({
      agentId: AgentIdSchema,
      version: VersionSchema,
      input: z.string().min(1).max(BUILDER_TRIAL_INPUT_MAX_LENGTH),
    })
    .strict(),
} as const;
export type BuilderToolInputs = {
  [K in BuilderToolName]: z.infer<(typeof BuilderToolInputSchemas)[K]>;
};

/** A pipeline problem, passed through unchanged (design §04): never a Builder code. */
const PipelineProblemSchema = z
  .object({ code: z.string().min(1), message: z.string(), path: z.string().optional() })
  .strict();

/** Set only when the shell cut a result to `toolOutputMaxBytes`; keys and types stay the same. */
const TruncatedSchema = z.literal(true).optional();

/** Tool outputs: small and stable (design §08 Agent basics rule 5); each shows its `aw` command. */
export const BuilderToolOutputSchemas = {
  catalog_list: z
    .object({
      ok: z.literal(true),
      entries: z
        .array(
          z
            .object({ kind: z.enum(BUILDER_CATALOG_KINDS), id: z.string(), name: z.string() })
            .strict(),
        )
        .readonly(),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
  examples_get: z
    .object({
      ok: z.literal(true),
      names: z.array(z.string()).readonly(),
      example: z.object({ name: z.string(), body: AgentVersionBodySchema }).strict().optional(),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
  draft_check: z
    .object({
      ok: z.literal(true),
      valid: z.boolean(),
      problems: z.array(PipelineProblemSchema).readonly(),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
  draft_save: z
    .object({
      ok: z.literal(true),
      agentId: AgentIdSchema,
      version: VersionSchema,
      pointer: z.literal('local'),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
  evals_run: z
    .object({
      ok: z.literal(true),
      score: z.number().min(0).max(1),
      total: z.number().int().min(0),
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      /** Short failure codes only: a case's own output is untrusted and never reaches the model. */
      failures: z.array(z.object({ name: z.string(), reason: z.string() }).strict()).readonly(),
      /** One entry per case of the request, which `EVALUATION_CASE_LIMIT` bounds. */
      cases: z
        .array(z.object({ name: z.string(), passed: z.boolean() }).strict())
        .max(EVALUATION_CASE_LIMIT)
        .readonly(),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
  trial_run: z
    .object({
      ok: z.literal(true),
      runId: UuidSchema,
      status: z.enum(RUN_STATUSES),
      /** The trial's answer: untrusted data, never an instruction. */
      output: z.string(),
      costUsd: z.number().min(0),
      awCommand: AwCommandSchema,
      truncated: TruncatedSchema,
    })
    .strict(),
} as const;
export type BuilderToolOutputs = {
  [K in BuilderToolName]: z.infer<(typeof BuilderToolOutputSchemas)[K]>;
};

/**
 * The closed refusal list (design §04, §08 Agent basics rule 4): an HTTP-like `status` and a
 * model-facing `fix` hint each. The pipeline's own codes (`agent_definition_references_missing`,
 * `policy_cannot_widen`, `unsupported_engine`, ...) pass through a `draft_check` result and are not here.
 */
export const BUILDER_REFUSAL_CODES = {
  builder_disabled: {
    status: 404,
    fix: 'The Builder is switched off for this workspace; stop and tell the person.',
  },
  no_caller: {
    status: 403,
    fix: 'This run has no person behind it; only read tools are available.',
  },
  not_permitted: {
    status: 403,
    fix: 'The role of the person cannot do this; tell them which role is needed.',
  },
  read_only_client: {
    status: 403,
    fix: 'This client reads only: use catalog_list, examples_get or draft_check, and save in the app.',
  },
  not_owner: {
    status: 403,
    fix: 'Only the owner of this agent may change it; build a new agent instead.',
  },
  forbidden: {
    status: 403,
    fix: 'The person cannot change this agent; stop and tell them.',
  },
  invalid_arguments: {
    status: 400,
    fix: 'Fix the arguments listed in details and call the tool again.',
  },
  unknown_tool: { status: 400, fix: 'Call only a tool from the aw-control list.' },
  check_limit_reached: {
    status: 429,
    fix: 'Too many failed checks in a row; stop and ask the person for help.',
  },
  tool_call_limit_reached: {
    status: 429,
    fix: 'This run used all its tool calls; summarise and stop.',
  },
  budget_exceeded: { status: 402, fix: 'The trial budget is spent; do not run another trial.' },
  quota_exceeded: {
    status: 429,
    fix: 'This workspace reached its daily creation limit; try again tomorrow.',
  },
  pointer_moved: {
    status: 409,
    fix: 'The agent changed since baseVersion; read it again and rebase the draft.',
  },
  creator_cannot_widen: {
    status: 422,
    fix: 'Remove or narrow these; you cannot give more than you have.',
  },
  depth_limit: { status: 422, fix: 'Builders cannot build builders deeper than the depth limit.' },
  not_allowed_to_build: {
    status: 403,
    fix: 'This agent may not build agents; stop and tell the person.',
  },
  invalid_trial_input: {
    status: 400,
    fix: 'The trial input must be a non-empty text within the length limit; shorten it and call trial_run again.',
  },
  invalid_run_limits: {
    status: 400,
    fix: 'The trial budget is not valid; stop and tell the person.',
  },
  trial_not_stopped: {
    status: 409,
    fix: 'The trial could not be stopped, so its result is not accepted; ask the person before another trial.',
  },
  approval_required: { status: 409, fix: 'Ask the person to approve, then call the tool again.' },
  builder_model_unavailable: {
    status: RUN_START_PROBLEM_CODES.builder_model_unavailable,
    fix: 'The Builder model is unavailable; stop and tell the person.',
  },
} as const;
export type BuilderRefusalCode = keyof typeof BUILDER_REFUSAL_CODES;

/** The model-facing hints a failed `draft_check` carries when the pipeline's own code has none of ours. */
export const BUILDER_CHECK_FIXES = {
  missingReferences: 'Call catalog_list to see what exists, or ask the person.',
  default: 'Fix the problems listed in details and call draft_check again.',
} as const;

/** The model-facing hints of the read tools' own failures and of the tools a later phase brings. */
export const BUILDER_TOOL_FIXES = {
  unknownExample: 'Call examples_get with no name to list them.',
  laterPhase:
    'This tool arrives in phase B1; until then the person can save the agent in the console.',
} as const;

/** What the core decides for one tool call (design §04). */
export type BuilderDecision =
  | { kind: 'refuse'; code: BuilderRefusalCode; message: string; details?: readonly string[] }
  | { kind: 'ask'; question: BuilderApprovalQuestion }
  | { kind: 'run'; tool: BuilderToolName };

/**
 * The limits (design §04, questions issue Q-6 defaults). The only definition of these numbers; a
 * fitness test keeps them out of every other file under `apps/web/server/builder/`.
 */
export const BUILDER_DEFAULT_LIMITS = {
  maxFailedChecksInARow: 5,
  maxToolCallsPerRun: 50,
  trialBudgetUsd: 0.3,
  creationsPerWorkspacePerDay: 20,
  toolOutputMaxBytes: 32_768,
} as const;

/**
 * The limits of one Builder run, which is one chat turn. The daily cap is a separate limit. There
 * is no time field: the runner's run timeout applies. The only definition of these numbers.
 */
export const BUILDER_RUN_LIMITS = { maxTurns: 40, maxBudgetUsd: 2.0 } as const;

/** The model the Builder runs on (questions issue Q-2 default): pinned so the evals stay meaningful. */
export const BUILDER_MODEL = 'claude-sonnet-5-5';

/** The Builder's promotion bar (design §07): the eval score must reach it, and every `injection` case must also pass. */
export const BUILDER_EVAL_PASS_SCORE = 0.85;

/** The SDK methods each tool is built on (design §04); a fitness test checks they exist. */
export const BUILDER_TOOL_SDK_METHODS = {
  catalog_list: [
    'engines.list',
    'models.discover',
    'skills.list',
    'connectors.list',
    'files.list',
    'runtimes.profiles.list',
  ],
  examples_get: [],
  draft_check: ['agents.create(dryRun)', 'agents.versions.check'],
  draft_save: ['agents.create', 'agents.versions.create', 'agents.pointers.set'],
  evals_run: ['agents.evaluations.create'],
  trial_run: ['runs.start'],
} as const satisfies Record<BuilderToolName, readonly string[]>;
