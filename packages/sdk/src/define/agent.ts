import { z } from 'zod';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { PORTABLE_AGENT_SUBAGENTS_MAX } from '@indx-workspace/contracts/portable-agent';
import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_MAX_REFERENCES,
  AgentDefinitionAgentSchema,
  AgentPermissionsSchema,
  AgentPolicyLimitsSchema,
  AgentPolicySchema,
  GrantingToolRuleSchema,
  claudeDeniedToolsFor,
  type AgentPermissionKey,
  type AgentPolicyLimits,
} from '@indx-workspace/contracts/agents';
import {
  ENGINE_CATALOGUE,
  ENGINE_IDS,
  EngineIdSchema,
  type EngineCatalogue,
  type EngineId,
} from '@indx-workspace/contracts/engines';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import { brand, hasBrand, type Branded, type DefineKind } from './brand.js';
import { DefinitionError, issuesFromZod } from './errors.js';
import {
  CodeToolSchema,
  FileGrantSchema,
  McpToolSchema,
  OpenApiToolInputSchema,
  PostgresToolInputSchema,
  SkillReferenceSchema,
  isCodeTool,
  isFileGrant,
  isMcpTool,
  isOpenApiTool,
  isPostgresTool,
  isSkillReference,
  type CodeTool,
  type FileGrant,
  type McpTool,
  type OpenApiTool,
  type PostgresTool,
  type SkillReference,
} from './references.js';

/**
 * Which model the agent runs on.
 *
 * - `'default'` (or leaving `model` out): the workspace's model connection named `default` when it
 *   has one, else the deployment's default model (contract C7).
 * - Any other string: the model connection of that name, on the connection's own default model.
 * - `{ connection, id }`: the named connection, on the model `id` (or the connection's default
 *   when `id` is left out).
 */
export type ModelReference =
  string | { readonly connection: string; readonly id?: string | undefined };

/** One object type for an intersection, so editors and type tests see a single shape. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** A policy arm's own input shape, as the contract's `AgentPolicySchema` accepts it. */
type PolicyArmInput<E extends EngineId> = Extract<z.input<typeof AgentPolicySchema>, { engine: E }>;

/**
 * The engine-native settings of each engine, keyed by `id`: what the contract's policy arm for
 * that engine carries beyond the portable `skills` and `limits`, the Claude tool grammar and an
 * engine switch's `withheldPermissions`. The Claude arm adds `autoApprove`: tool rules the run
 * pre-approves, so a tool the permissions grant does not stop on a permission prompt nobody can
 * answer. A rule for a tool the permissions turn off is refused.
 */
export type EngineSettings = {
  readonly [E in EngineId]: Flatten<
    { readonly id: E } & Omit<
      PolicyArmInput<E>,
      'engine' | 'skills' | 'limits' | 'tools' | 'withheldPermissions'
    > &
      (E extends 'claude-agent-sdk'
        ? { readonly autoApprove?: readonly string[] | undefined }
        : unknown)
  >;
}[EngineId];

/**
 * The engine that runs the agent loop: an engine id, or an engine id with that engine's own
 * settings (`{ id: 'openai-agents', reasoningEffort: 'high' }`, `{ id: 'pi', thinkingLevel: 'low' }`,
 * `{ id: 'mastra', toolCallConcurrency: 4 }`). Leaving it out means `claude-agent-sdk`.
 */
export type EngineChoice = EngineId | EngineSettings;

/** The four permission switches; a switch left out is off (least privilege). */
export type DefinePermissions = {
  readonly [K in AgentPermissionKey]?: boolean | undefined;
};

/** Per-run limits; a limit left out is `null`, the engine's own default. */
export type DefineLimits = {
  readonly [K in keyof AgentPolicyLimits]?: AgentPolicyLimits[K] | undefined;
};

/**
 * Instructions written inline, or a reference to a Markdown file next to the definition that the
 * project loader reads and passes to `toAgentVersionBody` as `options.instructions`. A string is
 * always the text itself, even when it ends in `.md`.
 */
export type InstructionsSource = string | { readonly file: string };

/**
 * A tool the agent may call: an MCP connector made by `mcp()`, a catalog connector made by
 * `openapiTool()` or `postgresTool()`, or a code tool made by `defineTool()`. The first three
 * share one namespace of connector names; code tools all land under the one local connector
 * `aw-dev-tools` (ADR-0115).
 */
export type DefineTool = McpTool | OpenApiTool | PostgresTool | CodeTool;

/** Whether `value` was made by `mcp()`, `openapiTool()`, `postgresTool()` or `defineTool()`. */
function isDefineTool(value: unknown): value is DefineTool {
  return isMcpTool(value) || isOpenApiTool(value) || isPostgresTool(value) || isCodeTool(value);
}

/**
 * The connector name a tool lands under in `resources.connectors`: an MCP tool's `connector`, a
 * code tool's shared `aw-dev-tools`, else the tool's `name`.
 */
export function toolNameOf(tool: DefineTool): string {
  if (isCodeTool(tool)) return AW_DEV_TOOLS_CONNECTOR;
  return isMcpTool(tool) ? tool.connector : tool.name;
}

/**
 * A knowledge source: workspace files the agent reads, or a connector it searches. Each `files`
 * path is also granted to the agent (read access unless it already has more); a `connector` must
 * be one of the agent's `mcp()` tools.
 */
export type KnowledgeSource =
  | { readonly kind: 'files'; readonly paths: readonly string[] }
  | { readonly kind: 'connector'; readonly name: string };

/**
 * One agent as code: what an `agents/*.ts` file passes to {@link defineAgent}.
 *
 * Every key not listed here is refused, as a type error and at run time.
 */
export interface DefineAgentInput {
  /** The agent's name in the workspace, 1–200 characters. Surfaces name the agent by it. */
  readonly name: string;
  /** What the agent is for, 1–1024 characters. Platforms show it; a parent agent reads it to decide when to delegate. */
  readonly description?: string | undefined;
  /**
   * Agents this one may delegate to: a `defineAgent()` value (imported from its file) or an agent
   * name, kept as the name. One level deep.
   */
  readonly subagents?: readonly (DefinedAgent | string)[] | undefined;
  /** Knowledge sources; see {@link KnowledgeSource}. */
  readonly knowledge?: readonly KnowledgeSource[] | undefined;
  /** The system prompt, inline, or `{ file: './instructions.md' }`. */
  readonly instructions: InstructionsSource;
  /** Which model runs the agent; see {@link ModelReference}. Left out, `'default'`. */
  readonly model?: ModelReference | undefined;
  /** Which engine runs the agent loop; see {@link EngineChoice}. Left out, `claude-agent-sdk`. */
  readonly engine?: EngineChoice | undefined;
  /** The permission switches; any left out are off. */
  readonly permissions?: DefinePermissions | undefined;
  /** Tools the agent may call, each made by `mcp()`, `openapiTool()`, `postgresTool()` or `defineTool()`. */
  readonly tools?: readonly DefineTool[] | undefined;
  /** Skills assigned to the agent, each made by `skill()`. */
  readonly skills?: readonly SkillReference[] | undefined;
  /** Workspace files granted to the agent, each made by `files()`. */
  readonly files?: readonly FileGrant[] | undefined;
  /** Per-run limits. Giving any a value makes the version's policy a stored one; `{}` gives none. */
  readonly limits?: DefineLimits | undefined;
}

/** What {@link defineAgent} returns: the input as written, frozen and branded. */
export type DefinedAgent = Readonly<DefineAgentInput> & Branded<'agent'>;

const AGENT_SHAPE = AgentDefinitionAgentSchema.unwrap().shape;
const ConnectionNameSchema = AGENT_SHAPE.modelConnectionName.unwrap();

/**
 * A Markdown file beside the definition: `./`, then one or more `/`-separated segments, the last
 * ending in `.md`. No empty, `.` or `..` segment, no backslash, no colon (no drive or stream
 * name), no control or format character (no bidirectional override hiding the real name).
 */
const INSTRUCTIONS_FILE_PATTERN = /^\.\/(?:[^/\\:\p{Cc}\p{Cf}]+\/)*[^/\\:\p{Cc}\p{Cf}]+\.md$/u;

// No check aborts, so the union below reports a bad path at `instructions.file`.
const InstructionsFileSchema = z
  .string()
  .max(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH)
  .regex(INSTRUCTIONS_FILE_PATTERN, "must be a relative Markdown path such as './instructions.md'")
  .refine(
    (path) =>
      path
        .split('/')
        .slice(1)
        .every((segment) => segment !== '.' && segment !== '..'),
    "must not contain a '.' or '..' segment",
  );

const InstructionsSchema = z.union(
  [AGENT_SHAPE.instructions, z.object({ file: InstructionsFileSchema }).strict().readonly()],
  {
    error: (issue) =>
      `${issue.input === undefined ? 'is required:' : 'must be'} the instructions as text, or { file: './instructions.md' }`,
  },
);

const ModelSchema = z.union(
  [
    ConnectionNameSchema,
    z
      .object({ connection: ConnectionNameSchema, id: AGENT_SHAPE.model.unwrap().optional() })
      .strict()
      .readonly(),
  ],
  {
    error:
      "must be a model connection's name, or { connection: '<connection name>', id: '<model id>' }",
  },
);

/** What a bad `engine` is told: the ids it may name, in either form. */
const ENGINE_MESSAGE = `must be an engine id (${ENGINE_IDS.map((id) => JSON.stringify(id)).join(', ')}) or { id: <engine id>, ...that engine's settings }`;

/** `ENGINE_IDS` by position, so an arm names its engine without restating the id. */
const [claudeAgentSdk, openAiAgents, pi, mastra] = ENGINE_IDS;

/** One engine's settings object: the catalogue's engine-native keys, keyed by `id`. */
function settingsArm<const E extends EngineId>(id: E) {
  const settings: EngineCatalogue[E]['settings'] = ENGINE_CATALOGUE[id].settings;
  return z
    .object({ ...settings, id: z.literal(id) })
    .strict()
    .readonly();
}

/** The Claude arm: the catalogue's settings (none) and the SDK-only `autoApprove`. */
const claudeSettingsArm = z
  .object({
    ...ENGINE_CATALOGUE[claudeAgentSdk].settings,
    autoApprove: z.array(GrantingToolRuleSchema).readonly().optional(),
    id: z.literal(claudeAgentSdk),
  })
  .strict()
  .readonly();

/** `true` when `A` and `B` are the same union of ids, else `never`. */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * `schema`, but only when its arms name exactly the ids of `ENGINE_IDS`: an engine added to the
 * list without an arm (or an arm for an id the list lacks) fails typecheck (ADR-0136).
 */
function coversEveryEngine<S extends z.ZodType<unknown, { readonly id: string }>>(
  schema: SameSet<z.input<S>['id'], EngineId> extends never ? never : S,
): S {
  return schema;
}

/** Each engine's own settings, from the catalogue; the portable and policy-only keys are not here. */
const EngineSettingsSchema = coversEveryEngine(
  z.discriminatedUnion('id', [
    claudeSettingsArm,
    settingsArm(openAiAgents),
    settingsArm(pi),
    settingsArm(mastra),
  ]),
);

/**
 * A list of branded references, no longer than the contract's `resources` lists. Each is refused
 * unless `guard` recognises it, then read once through `snapshot` into a fresh, frozen, branded
 * copy. The brand is a global symbol anyone can attach, so a forged value is checked like any
 * other, and the copy is what every later step reads: a getter cannot hand one value to the check
 * and another to `toAgentVersionBody()` or `toolDefinitionsOf()`.
 */
function referenceList<T>(
  guard: (value: unknown) => value is T,
  maker: string,
  snapshot: (value: T, context: z.core.$RefinementCtx<T>) => T,
) {
  return z
    .array(z.custom<T>(guard, { error: `must be made by ${maker}` }).transform(snapshot))
    .max(AGENT_DEFINITION_MAX_REFERENCES)
    .readonly()
    .optional();
}

/**
 * `value` parsed by `schema` into a fresh copy branded `kind`; when it does not parse, every issue
 * at its own key under the entry, and `z.NEVER`.
 */
function rebranded<S extends z.ZodType<object>, K extends DefineKind>(
  schema: S,
  kind: K,
  value: unknown,
  context: z.core.$RefinementCtx,
): Readonly<z.output<S> & Branded<K>> {
  const result = schema.safeParse(value);
  if (result.success) return brand({ ...result.data }, kind);
  for (const issue of result.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
  return z.NEVER;
}

function toolSnapshot(tool: DefineTool, context: z.core.$RefinementCtx): DefineTool {
  if (isMcpTool(tool)) return rebranded(McpToolSchema, 'mcp', tool, context);
  if (isOpenApiTool(tool)) return rebranded(OpenApiToolInputSchema, 'openapi', tool, context);
  if (isCodeTool(tool)) return rebranded(CodeToolSchema, 'code', tool, context);
  return rebranded(PostgresToolInputSchema, 'postgres', tool, context);
}

/** Refuses a second entry with the same key, at the later entry's path. */
function refuseRepeats<T>(
  context: z.core.$RefinementCtx,
  list: readonly T[] | undefined,
  key: (entry: T) => string,
  path: string,
  noun: string,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of (list ?? []).entries()) {
    const value = key(entry);
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [path, index],
        message: `repeats the ${noun} ${JSON.stringify(value)}`,
      });
    }
    seen.add(value);
  }
}

const BODY_SHAPE = AgentVersionBodySchema.unwrap().shape;

/** An agent name, or a `defineAgent()` value, kept as the name. */
const SubagentSchema = z
  .custom<DefinedAgent | string>((value) => typeof value === 'string' || isDefinedAgent(value), {
    error: 'must be an agent name or made by defineAgent()',
  })
  .transform((value) => (typeof value === 'string' ? value : value.name))
  .pipe(BODY_SHAPE.subagents.unwrap().unwrap().element.unwrap().shape.name);

/**
 * The runtime form of {@link DefineAgentInput}, built from the contract's own schemas: every
 * object is strict, so an unknown key — a setting on the wrong engine — is refused rather than
 * accepted and ignored.
 */
export const DefineAgentInputSchema = z
  .object({
    name: AGENT_SHAPE.name,
    description: BODY_SHAPE.description,
    subagents: z.array(SubagentSchema).max(PORTABLE_AGENT_SUBAGENTS_MAX).readonly().optional(),
    knowledge: BODY_SHAPE.knowledge,
    instructions: InstructionsSchema,
    model: ModelSchema.optional(),
    engine: z.union([EngineIdSchema, EngineSettingsSchema], { error: ENGINE_MESSAGE }).optional(),
    permissions: AgentPermissionsSchema.unwrap().partial().readonly().optional(),
    tools: referenceList(
      isDefineTool,
      'mcp(), openapiTool(), postgresTool() or defineTool()',
      toolSnapshot,
    ),
    skills: referenceList(isSkillReference, 'skill()', (value, context) =>
      rebranded(SkillReferenceSchema, 'skill', value, context),
    ),
    files: referenceList(isFileGrant, 'files()', (value, context) =>
      rebranded(FileGrantSchema, 'files', value, context),
    ),
    limits: AgentPolicyLimitsSchema.unwrap().partial().readonly().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Code tools share one connector, so each is told apart by its own name.
    refuseRepeats(
      context,
      value.tools,
      (tool) => (isCodeTool(tool) ? tool.name : toolNameOf(tool)),
      'tools',
      'tool name',
    );
    refuseRepeats(context, value.skills, (entry) => entry.name, 'skills', 'skill');
    refuseRepeats(context, value.files, (grant) => grant.path, 'files', 'file path');
    refuseRepeats(context, value.subagents, (name) => name, 'subagents', 'subagent');
    for (const [index, name] of (value.subagents ?? []).entries()) {
      if (name === value.name) {
        context.addIssue({
          code: 'custom',
          path: ['subagents', index],
          message: 'an agent cannot be its own subagent',
        });
      }
    }
    if (typeof value.engine === 'object' && value.engine.id === 'claude-agent-sdk') {
      const denied = new Set(
        claudeDeniedToolsFor({
          readFiles: value.permissions?.readFiles ?? false,
          writeFiles: value.permissions?.writeFiles ?? false,
          runCommands: value.permissions?.runCommands ?? false,
          unrestrictedNetwork: value.permissions?.unrestrictedNetwork ?? false,
        }),
      );
      for (const [index, rule] of (value.engine.autoApprove ?? []).entries()) {
        const tool = rule.split('(', 1)[0] ?? rule;
        if (denied.has(tool)) {
          context.addIssue({
            code: 'custom',
            path: ['engine', 'autoApprove', index],
            message: `${JSON.stringify(rule)} names a tool the permissions turn off`,
          });
        }
      }
    }
    const mcpTools = new Set((value.tools ?? []).filter(isMcpTool).map((tool) => tool.connector));
    const connectors = new Set<string>();
    for (const [index, source] of (value.knowledge ?? []).entries()) {
      if (source.kind !== 'connector') continue;
      if (!mcpTools.has(source.name)) {
        context.addIssue({
          code: 'custom',
          path: ['knowledge', index, 'name'],
          message: `the knowledge connector ${JSON.stringify(source.name)} is not one of this agent's mcp() tools`,
        });
      } else if (connectors.has(source.name)) {
        context.addIssue({
          code: 'custom',
          path: ['knowledge', index],
          message: `repeats the knowledge connector ${JSON.stringify(source.name)}`,
        });
      }
      connectors.add(source.name);
    }
  })
  .readonly() satisfies z.ZodType<DefineAgentInput>;

/**
 * Defines one agent as code. The input is checked now — names, model, engine settings, limits,
 * that every tool was made by `mcp()`, `openapiTool()`, `postgresTool()` or `defineTool()` and every skill and
 * file by `skill()` or `files()`, and that each appears once (tools by connector name, across
 * kinds) — and the result is the input as written, frozen and branded, ready for
 * `toAgentVersionBody`.
 *
 * `subagents` are kept as names (a `defineAgent()` value gives its `name`), none repeated and none
 * the agent itself; a `connector` knowledge source must be one of the agent's `mcp()` tools.
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function defineAgent(input: DefineAgentInput): DefinedAgent {
  const result = DefineAgentInputSchema.safeParse(input);
  if (!result.success) {
    throw new DefinitionError(
      'defineAgent()',
      issuesFromZod(result.error, undefined, Object.keys(DefineAgentInputSchema.unwrap().shape)),
    );
  }
  return brand({ ...result.data }, 'agent');
}

/** Whether `value` was made by {@link defineAgent} — in this copy of the SDK or another. */
export function isDefinedAgent(value: unknown): value is DefinedAgent {
  return hasBrand(value, 'agent');
}
