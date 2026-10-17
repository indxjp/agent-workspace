/**
 * The two messages between `aw` and the loader child (ADR-0111): `load`, which names the files
 * to evaluate, and `loaded`, the answer for each. The child is a separate process, so the parent
 * trusts nothing it receives: every answer is parsed here with strict schemas, and the bodies and
 * surfaces with the contracts' own.
 *
 * The child imports only the types of this module (`import type`), so it stays self-contained.
 */
import {
  AgentVersionBodySchema,
  TOOL_BUNDLE_TIMEOUT_MAX_MS,
  ToolAllowedDomainsSchema,
  ToolSecretNamesSchema,
} from '@indx-workspace/contracts/agent-versions';
import { AGENT_DEFINITION_MAX_REFERENCES } from '@indx-workspace/contracts/agents';
import { EngineIdSchema } from '@indx-workspace/contracts/engines';
import { LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES } from '@indx-workspace/contracts/local-runtime';
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import { SurfaceDefinitionSchema } from '@indx-workspace/contracts/surfaces';
import { z } from 'zod';

/** The refusals the loader makes on this machine; each is printed with the status `local`. */
const LOADER_PROBLEM_CODES = [
  'typescript_unavailable',
  'typescript_syntax_unsupported',
  'default_export_missing',
  'not_a_definition',
  'import_refused',
  'module_failed',
  'instructions_unreadable',
  'surface_agent_unknown',
  'agent_name_duplicate',
  'surface_name_duplicate',
  'loader_timeout',
] as const;

/** The most files of one kind a project may hold; far above any real project. */
export const PROJECT_FILES_MAX = 256;
const DETAILS_MAX = 64;
const DETAIL_MAX_LENGTH = 4096;

/**
 * A definition file, relative to the project root: `agents/<name>.ts` or `surfaces/<name>.ts`.
 * No separator, control or format character in the name, so a path the child is handed can only
 * name a file directly in one of the two directories.
 */
const AgentFileSchema = z
  .string()
  .max(512)
  .regex(/^agents\/[^/\\:\p{Cc}\p{Cf}]+\.ts$/u);
const SurfaceFileSchema = z
  .string()
  .max(512)
  .regex(/^surfaces\/[^/\\:\p{Cc}\p{Cf}]+\.ts$/u);

const DefinitionFileSchema = z.union([AgentFileSchema, SurfaceFileSchema]);

/** Whether `file` is a name the child may be handed; any other is refused before the fork. */
export function isDefinitionFileName(file: string): boolean {
  return DefinitionFileSchema.safeParse(file).success;
}

const DetailsSchema = z.array(z.string().max(DETAIL_MAX_LENGTH)).max(DETAILS_MAX).readonly();

/**
 * The project file a tool was declared in: a root-relative POSIX `.ts` path with no empty, `.`,
 * `..`, control or format segment, and no backslash or colon.
 */
const ToolFileSchema = z
  .string()
  .max(512)
  .regex(/^(?:[^/\\:\p{Cc}\p{Cf}]+\/)*[^/\\:\p{Cc}\p{Cf}]+\.ts$/u)
  .refine((file) => file.split('/').every((segment) => segment !== '.' && segment !== '..'));

/** The longest string or list a tool's input may carry here; the SDK re-checks every value. */
const TOOL_FIELD_MAX = 4096;
const ToolStringSchema = z.string().max(TOOL_FIELD_MAX);
const ToolListSchema = z.array(ToolStringSchema).max(TOOL_FIELD_MAX).readonly();
const SecretReferenceWireSchema = z.object({ secret: SecretNameSchema }).strict().readonly();

/**
 * One tool of an agent, as its file wrote it to `openapiTool()` or `postgresTool()` (only names of
 * secrets, never values; a `defineTool()` tool by its name alone), with the file that declares it. Shape only: the parent makes
 * each again with the SDK's own strict constructors before using it.
 */
const LoadedToolSchema = z.discriminatedUnion('kind', [
  z
    .object({
      file: ToolFileSchema,
      kind: z.literal('openapi'),
      tool: z
        .object({
          name: ToolStringSchema,
          spec: ToolStringSchema,
          allow: ToolListSchema,
          auth: z
            .union([
              SecretReferenceWireSchema,
              z
                .object({ header: ToolStringSchema, credential: SecretReferenceWireSchema })
                .strict()
                .readonly(),
            ])
            .optional(),
          baseUrl: ToolStringSchema.optional(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      file: ToolFileSchema,
      kind: z.literal('postgres'),
      tool: z
        .object({
          name: ToolStringSchema,
          url: SecretReferenceWireSchema,
          readOnly: z.literal(true),
          tables: ToolListSchema,
          maxRows: z.number().optional(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      file: ToolFileSchema,
      kind: z.literal('code'),
      tool: z
        .object({
          name: ToolStringSchema,
          run: ToolStringSchema,
          description: z.string().min(1).max(2048),
          inputSchema: z.record(z.string(), z.unknown()).readonly(),
          outputSchema: z.record(z.string(), z.unknown()).readonly().optional(),
          limits: z
            .object({ timeoutMs: z.number().int().min(1).max(TOOL_BUNDLE_TIMEOUT_MAX_MS) })
            .strict()
            .readonly(),
          secrets: ToolSecretNamesSchema.optional(),
          allowedDomains: ToolAllowedDomainsSchema.optional(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
]);
export type LoadedToolInput = z.input<typeof LoadedToolSchema>;

/**
 * Where the type stripper or the evaluator says a problem is: the file (the child's `file://` URL,
 * made root-relative before it is answered), 1-based line and column.
 */
const LocationSchema = z
  .object({
    file: z.string().min(1).max(4096),
    line: z.number().int().min(1),
    column: z.number().int().min(1),
  })
  .strict()
  .readonly();

/**
 * What the child found wrong with one file: a loader refusal (`status: null`), or a definition the
 * SDK refused — the `400 invalid_agent_version` the server's pipeline gives the same body.
 */
const ChildProblemSchema = z.union([
  z
    .object({
      status: z.null(),
      code: z.enum(LOADER_PROBLEM_CODES),
      details: DetailsSchema,
      location: LocationSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal(400),
      code: z.literal('invalid_agent_version'),
      details: DetailsSchema,
      location: LocationSchema.optional(),
    })
    .strict()
    .readonly(),
]);
export type ChildProblem = z.input<typeof ChildProblemSchema>;

export const LoadMessageSchema = z
  .object({
    type: z.literal('load'),
    root: z.string().min(1).max(4096),
    agents: z.array(AgentFileSchema).max(PROJECT_FILES_MAX).readonly(),
    surfaces: z.array(SurfaceFileSchema).max(PROJECT_FILES_MAX).readonly(),
    /** The project file's `engine`, for an agent that names none (C12). */
    defaultEngine: EngineIdSchema.optional(),
  })
  .strict()
  .readonly();
export type LoadMessage = z.input<typeof LoadMessageSchema>;

const LoadedFileSchema = z.union([
  z
    .object({
      file: AgentFileSchema,
      kind: z.literal('agent'),
      name: z.string().min(1).max(200),
      body: AgentVersionBodySchema,
      /** The names, never the values, of the secrets the agent's tools reference (SD17). */
      secrets: z.array(SecretNameSchema).max(LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES).readonly(),
      /** The agent's `openapiTool()` and `postgresTool()` tools, in the order written (C15). */
      tools: z.array(LoadedToolSchema).max(AGENT_DEFINITION_MAX_REFERENCES).readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      file: SurfaceFileSchema,
      kind: z.literal('surface'),
      surface: SurfaceDefinitionSchema,
    })
    .strict()
    .readonly(),
  z
    .object({ file: AgentFileSchema, kind: z.literal('agent'), problem: ChildProblemSchema })
    .strict()
    .readonly(),
  z
    .object({ file: SurfaceFileSchema, kind: z.literal('surface'), problem: ChildProblemSchema })
    .strict()
    .readonly(),
]);
export type LoadedFileInput = z.input<typeof LoadedFileSchema>;

export const LoadedMessageSchema = z
  .object({
    type: z.literal('loaded'),
    files: z
      .array(LoadedFileSchema)
      .max(PROJECT_FILES_MAX * 2)
      .readonly(),
  })
  .strict()
  .readonly();
export type LoadedMessage = z.output<typeof LoadedMessageSchema>;

/**
 * Sent by the child before it evaluates each file, and delivered before that file's code runs, so
 * a file that ends the child without an answer (a top-level `await` that never settles,
 * `process.exit()`) or outlasts the timeout is named.
 */
export const EvaluatingMessageSchema = z
  .object({ type: z.literal('evaluating'), file: DefinitionFileSchema })
  .strict()
  .readonly();
export type EvaluatingMessage = z.input<typeof EvaluatingMessageSchema>;
export type LoadedMessageInput = z.input<typeof LoadedMessageSchema>;
