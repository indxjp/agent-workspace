import { z } from 'zod';

import { AGENT_VERSION_NUMBER_MAX } from './agent-versions.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { outputSchemaViolation } from './runs.js';

/**
 * The most cases one evaluation runs (issue #618). The server runs them one after another inside a
 * single request, so this bounds the request's length: see `agents.evaluate` in `./routes.ts`.
 */
export const EVALUATION_CASE_LIMIT = 20;

/**
 * The most cases one asynchronous evaluation run holds (issue #799). A run is advanced by a series
 * of requests, each running a few cases, so this is not bounded by one request's length: see
 * `agents.evaluationRuns.advance` in `./routes.ts`. An `evals/<agent>.yaml` file takes up to this
 * many; `aw eval` sends every file as a run, whatever its size, so each case gets its own deadline.
 */
export const EVALUATION_RUN_CASE_LIMIT = 200;

/** The longest `toolInput`, as JSON text, in characters. */
export const EVALUATION_TOOL_INPUT_MAX_LENGTH = 2048;

/** The longest `expect.output`, as JSON text, in characters. */
export const EVALUATION_OUTPUT_MAX_LENGTH = 2048;

/** The longest case `outputSchema`, as JSON text, in characters (inside ADR-0143's own limit). */
export const EVALUATION_OUTPUT_SCHEMA_MAX_LENGTH = 4096;

/** The longest case input, in characters: the prompt the case's run is started with. */
export const EVALUATION_INPUT_MAX_LENGTH = 8192;

/** The longest `judge` rubric, in characters. */
export const EVALUATION_RUBRIC_MAX_LENGTH = 2048;

/** The most strings one `contains` or `notContains` check lists, and the longest of them. */
export const EVALUATION_NEEDLES_MAX = 10;
export const EVALUATION_NEEDLE_MAX_LENGTH = 200;

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: 'must not be blank' });

const jsonObject = (max: number) =>
  z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= max, {
    message: `must be at most ${String(max)} characters as JSON`,
  });

const NeedlesSchema = z
  .array(nonBlank(EVALUATION_NEEDLE_MAX_LENGTH))
  .min(1)
  .max(EVALUATION_NEEDLES_MAX)
  .readonly();

/**
 * What a case's answer must satisfy (issue #618). Six checks and nothing else: `contains` and
 * `notContains` are case-sensitive substrings of the final answer, `tool` is the exact name of a
 * tool the run called, `output` is a part of the run's structured output, `judge` is a rubric a
 * model grades the answer against, and `awaitsApproval` says the run must stop at an approval
 * pause. At least one.
 *
 * `awaitsApproval` (issue #1569, ADR-0145) is `true` or absent. With it, a run that ends at
 * `awaiting_approval` passes the status check instead of failing `run_awaiting_approval`, and the
 * other checks run against what the run did up to the pause: `tool` and `toolInput` also match the
 * paused call, and `contains`, `notContains` and `judge` read the answer so far. A run that
 * completes without pausing fails `run_not_awaiting_approval`. The evaluation never approves: it
 * cancels the paused run after scoring. It is refused with `output`, since a paused run has no
 * structured output yet.
 *
 * `toolInput` (issue #799) narrows `tool`: some call to that tool must pass every key listed here
 * with an equal value (a subset match; keys the call also passes are ignored). It needs `tool`.
 *
 * `output` (issue #1289) is matched the same way against `RunResource.output.structured`: every key
 * listed must be present with an equal value, extra keys are ignored, arrays must be equal and in
 * order. The case needs an `outputSchema`, so its run has a structured output to match.
 */
export const EvalExpectSchema = z
  .object({
    contains: NeedlesSchema.optional(),
    notContains: NeedlesSchema.optional(),
    tool: nonBlank(256).optional(),
    toolInput: jsonObject(EVALUATION_TOOL_INPUT_MAX_LENGTH).optional(),
    output: jsonObject(EVALUATION_OUTPUT_MAX_LENGTH).optional(),
    judge: nonBlank(EVALUATION_RUBRIC_MAX_LENGTH).optional(),
    awaitsApproval: z.literal(true).optional(),
  })
  .strict()
  .refine((expect) => Object.keys(expect).length > 0, {
    message:
      'expect must name at least one of contains, notContains, tool, output, judge or awaitsApproval',
  })
  .refine((expect) => expect.toolInput === undefined || expect.tool !== undefined, {
    path: ['toolInput'],
    message: 'toolInput needs tool: the tool whose call it matches',
  })
  .refine((expect) => expect.awaitsApproval === undefined || expect.output === undefined, {
    path: ['awaitsApproval'],
    message:
      'awaitsApproval cannot be combined with output: a paused run has no structured output yet',
  })
  .readonly();
export type EvalExpect = z.infer<typeof EvalExpectSchema>;

/**
 * One case: a name, the input its run is started with, and what the answer must satisfy.
 * `outputSchema` (issue #1289) is the JSON Schema the case's run answers with (ADR-0143); it must
 * satisfy `outputSchemaViolation`, and an engine that cannot honour it refuses the case with
 * `engine_capability_unsupported`. `expect.output` needs it. `fromRun` names the rated run the
 * case was made from (`aw eval add-case`, issue #620); it is kept for traceability and never
 * scored. `tags` are labels such as `injection`, never scored; a gate over a report reads them
 * (the Builder's, issue #1848).
 */
export const EvalCaseSchema = z
  .object({
    name: nonBlank(200),
    input: nonBlank(EVALUATION_INPUT_MAX_LENGTH),
    expect: EvalExpectSchema,
    outputSchema: jsonObject(EVALUATION_OUTPUT_SCHEMA_MAX_LENGTH)
      .superRefine((schema, context) => {
        const found = outputSchemaViolation(schema);
        if (found !== null) context.addIssue({ code: 'custom', message: found.message });
      })
      .optional(),
    fromRun: UuidSchema.optional(),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
      .max(8)
      .readonly()
      .optional(),
  })
  .strict()
  .refine(
    (evalCase) => evalCase.expect.output === undefined || evalCase.outputSchema !== undefined,
    {
      path: ['expect', 'output'],
      message: "output needs outputSchema: the schema the case's run answers with",
    },
  )
  .readonly();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const evalCases = (max: number) =>
  z
    .array(EvalCaseSchema)
    .min(1)
    .max(max)
    .superRefine((cases, context) => {
      const seen = new Set<string>();
      cases.forEach((evalCase, index) => {
        if (seen.has(evalCase.name)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: `duplicate case name ${JSON.stringify(evalCase.name)}`,
          });
        }
        seen.add(evalCase.name);
      });
    })
    .readonly();

const EvalCasesSchema = evalCases(EVALUATION_CASE_LIMIT);
const EvalRunCasesSchema = evalCases(EVALUATION_RUN_CASE_LIMIT);

/**
 * `evals/<agent>.yaml`: the cases of one agent, 1 to {@link EVALUATION_RUN_CASE_LIMIT}, unique
 * names. `aw eval` runs them as an evaluation run; up to {@link EVALUATION_CASE_LIMIT} also fit one request.
 */
export const EvalCaseFileSchema = z.object({ cases: EvalRunCasesSchema }).strict().readonly();
export type EvalCaseFile = z.infer<typeof EvalCaseFileSchema>;

/** The body of `POST /api/agents/:id/evaluations`: the version to score and its cases. */
export const CreateEvaluationRequestSchema = z
  .object({
    version: z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX),
    cases: EvalCasesSchema,
  })
  .strict()
  .readonly();
export type CreateEvaluationRequest = z.infer<typeof CreateEvaluationRequestSchema>;

/**
 * The body of `POST /api/agents/:id/evaluation-runs` (issue #799): the version to score and its
 * cases, up to {@link EVALUATION_RUN_CASE_LIMIT}. Nothing runs until the run is advanced.
 */
export const CreateEvaluationRunRequestSchema = z
  .object({
    version: z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX),
    cases: EvalRunCasesSchema,
  })
  .strict()
  .readonly();
export type CreateEvaluationRunRequest = z.infer<typeof CreateEvaluationRunRequestSchema>;

/** The body of `POST /api/agents/:id/evaluation-advance` (issue #799): the run to advance. */
export const AdvanceEvaluationRunRequestSchema = z
  .object({ evaluationId: UuidSchema })
  .strict()
  .readonly();
export type AdvanceEvaluationRunRequest = z.infer<typeof AdvanceEvaluationRunRequestSchema>;

/**
 * The machine-readable case failures the server mints itself (issue #618): the case ran out of
 * the request's deadline, its run's stream could not be read, or its judge could not be reached or
 * read, or a case that expects an approval pause (issue #1569) ended without one.
 */
export const EVALUATION_CASE_FAILURE_CODES = [
  'deadline_exceeded',
  'run_stream_failed',
  'run_not_awaiting_approval',
  'judge_unavailable',
  'judge_unparseable',
] as const;
export type EvaluationCaseFailureCode = (typeof EVALUATION_CASE_FAILURE_CODES)[number];

/**
 * One case's outcome. `runId` is the run the case started, or `null` when none was started (the
 * start was refused, or the deadline had passed). `failures` is empty exactly when `passed`.
 *
 * A failure is one of {@link EVALUATION_CASE_FAILURE_CODES}; `run_<status>` for a run that ended
 * other than `completed` (`run_failed`, `run_cancelled`, `run_awaiting_approval`, …); the code a
 * failed run's error carries, when it carries one (`model_credential_rejected`, …), in place of
 * `run_failed`; a refused start's problem code, verbatim (`model_unavailable`, …); or a sentence:
 * `contains: …`, `notContains: …`, `tool: …`, `toolInput: …`, `output: …` or
 * `judge: <the judge's reason>`.
 */
export const EvaluationCaseResultSchema = z
  .object({
    name: z.string(),
    passed: z.boolean(),
    runId: UuidSchema.nullable(),
    failures: z.array(z.string()).readonly(),
  })
  .strict()
  .readonly();
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResultSchema>;

const evaluationFields = {
  id: UuidSchema,
  agentId: UuidSchema,
  version: z.number().int().min(1),
  /** `passed / total`, from 0 to 1. */
  score: z.number().min(0).max(1),
  passed: z.number().int().min(0),
  total: z.number().int().min(1),
  results: z.array(EvaluationCaseResultSchema).readonly(),
  createdAt: IsoDateTimeSchema,
};

/** One stored evaluation: every case of one request, scored against one version. */
export const EvaluationResourceSchema = z.object(evaluationFields).strict().readonly();
export type EvaluationResource = z.infer<typeof EvaluationResourceSchema>;

/** Where an evaluation run is: `running` until every case has a result, then `completed`. */
export const EVALUATION_RUN_STATUSES = ['running', 'completed'] as const;
export type EvaluationRunStatus = (typeof EVALUATION_RUN_STATUSES)[number];

/**
 * An evaluation run (issue #799): an evaluation with its progress. While `running`, `results`
 * holds the cases finished so far in case order, `passed` counts the passing ones among them and
 * `total` is every case of the run, so `results.length` of `total` have run; `score` is
 * `passed / total` and final only once `completed`, when the run is the stored evaluation that the
 * promotion gate reads.
 */
export const EvaluationRunResourceSchema = z
  .object({ ...evaluationFields, status: z.enum(EVALUATION_RUN_STATUSES) })
  .strict()
  .readonly();
export type EvaluationRunResource = z.infer<typeof EvaluationRunResourceSchema>;

/**
 * The refusals of `POST /api/agents/:id/evaluations`. A refused start of the first case answers
 * that start's refusal and stores nothing: a code from `RUN_START_PROBLEM_CODES` (`./runs.ts`), or
 * one of the two below that a fresh session's start can also answer. `session_engine_mismatch`
 * cannot happen, since every case opens a fresh session.
 */
export const EVALUATION_PROBLEM_CODES = {
  invalid_body: 400,
  invalid_agent_id: 400,
  agent_not_found: 404,
  agent_version_not_found: 404,
  agent_policy_not_configured: 503,
  run_api_not_configured: 503,
  /** The first case's fresh session needs an engine image this deployment has not installed. */
  engine_not_installed: 422,
  /** The first case's fresh session could not be opened for the agent. */
  session_not_usable: 409,
  /** No evaluation of this agent has that id (issue #799). */
  evaluation_not_found: 404,
  /** Another request is advancing this run; retry in a moment (issue #799). */
  evaluation_run_busy: 409,
} as const;
export type EvaluationProblemCode = keyof typeof EVALUATION_PROBLEM_CODES;
