import { z } from 'zod';

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
  type AgentVersionBodyInput,
} from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  AgentDefinitionAgentSchema,
  claudeBaseToolPolicyFor,
  type AgentPermissions,
} from '@indx-workspace/contracts/agents';
import {
  DEFAULT_ENGINE_ID,
  EngineIdSchema,
  isEngineId,
  isWithholdingEngine,
  type EngineId,
  type WithholdingEngineId,
} from '@indx-workspace/contracts/engines';

import {
  DefineAgentInputSchema,
  isDefinedAgent,
  toolNameOf,
  type DefineAgentInput,
  type DefinedAgent,
  type EngineSettings,
} from './agent.js';
import { DefinitionError, issuesFromZod, type DefinitionIssue } from './errors.js';
import {
  isOpenApiTool,
  isPostgresTool,
  type OpenApiTool,
  type PostgresTool,
} from './references.js';
import { isDefinedSurface, type DefinedSurface } from './surface.js';

/** The model connection `model: 'default'`, or no model, names (contract C7). */
const DEFAULT_MODEL_CONNECTION = 'default';

/** What {@link toAgentVersionBody} takes beside the agent. */
export interface ToAgentVersionBodyOptions {
  /** The agent's surfaces, each made by `defineSurface()` and naming this agent. */
  readonly surfaces?: readonly DefinedSurface[] | undefined;
  /**
   * The text of the agent's `instructions: { file }`, read by the caller. Required when the
   * agent's instructions are a file reference, and refused when they are inline.
   */
  readonly instructions?: string | undefined;
  /**
   * The engine an agent with no `engine` of its own runs on: the project's `engine` (contract
   * C12). Left out, `claude-agent-sdk`. An agent's own `engine` always wins.
   */
  readonly defaultEngine?: EngineId | undefined;
}

const OptionsSchema = z
  .object({
    surfaces: z
      .array(
        z.custom<DefinedSurface>(isDefinedSurface, { error: 'must be made by defineSurface()' }),
      )
      .readonly()
      .optional(),
    instructions: AgentDefinitionAgentSchema.unwrap().shape.instructions.optional(),
    defaultEngine: EngineIdSchema.optional(),
  })
  .strict();

type PolicyInput = AgentVersionBodyInput['definition']['policy'];

function refuse(issues: readonly DefinitionIssue[], subject = 'toAgentVersionBody()'): never {
  throw new DefinitionError(subject, issues);
}

/**
 * The agent, checked again under `subject`. The brand is a global symbol anyone can attach, so the
 * agent is parsed again rather than trusted: a key it should not carry is refused here instead of
 * being silently dropped.
 */
function checkedAgent(agent: DefinedAgent, subject: string): DefineAgentInput {
  if (!isDefinedAgent(agent)) {
    refuse([{ path: 'agent', message: 'must be made by defineAgent()' }], subject);
  }
  const checked = DefineAgentInputSchema.safeParse(agent);
  if (!checked.success) refuse(issuesFromZod(checked.error, 'agent'), subject);
  return checked.data;
}

function instructionsText(agent: DefineAgentInput, resolved: string | undefined): string {
  if (typeof agent.instructions === 'string') {
    if (resolved !== undefined) {
      refuse([
        {
          path: 'options.instructions',
          message: 'the agent has inline instructions, so options.instructions would be ignored',
        },
      ]);
    }
    return agent.instructions;
  }
  if (resolved === undefined) {
    refuse([
      {
        path: 'agent.instructions',
        message: `the file ${JSON.stringify(agent.instructions.file)} is not resolved: pass its text as options.instructions`,
      },
    ]);
  }
  return resolved;
}

function modelFields(agent: DefineAgentInput): {
  modelConnectionName: string;
  model: string | null;
} {
  const model = agent.model ?? DEFAULT_MODEL_CONNECTION;
  if (typeof model === 'string') return { modelConnectionName: model, model: null };
  return { modelConnectionName: model.connection, model: model.id ?? null };
}

function permissionsOf(agent: DefineAgentInput): AgentPermissions {
  const given = agent.permissions ?? {};
  return {
    readFiles: given.readFiles ?? false,
    writeFiles: given.writeFiles ?? false,
    runCommands: given.runCommands ?? false,
    unrestrictedNetwork: given.unrestrictedNetwork ?? false,
  };
}

/** Whether `settings` is for an engine that states narrowing as `withheldPermissions`. */
function isWithholdingSettings(
  settings: EngineSettings,
): settings is Extract<EngineSettings, { readonly id: WithholdingEngineId }> {
  return isWithholdingEngine(settings.id);
}

/**
 * The policy and its source. The engine is the agent's own `engine`, else `defaultEngine` (the
 * project's `engine`, contract C12), else `claude-agent-sdk`. Compiled — exactly what the server
 * compiles from the permissions and skills — when that engine is `claude-agent-sdk` and no limit
 * has a value and no `autoApprove`, `requireApproval` or `handoff` is declared; stored otherwise, because the server compiles
 * only for its default engine, with no limits and no pre-approval. A `limits` object whose limits
 * are all left out (`{}`, `{ maxTurns: undefined }`) gives no limit.
 */
function policyOf(
  agent: DefineAgentInput,
  permissions: AgentPermissions,
  skillNames: readonly string[],
  defaultEngine: EngineId | undefined,
): { policy: PolicyInput; policySource: 'compiled' | 'stored' } {
  const settings: EngineSettings =
    typeof agent.engine === 'object'
      ? agent.engine
      : { id: agent.engine ?? defaultEngine ?? DEFAULT_ENGINE_ID };
  const skills = { mode: 'allowlist', names: [...skillNames] } as const;
  const limits = {
    maxTurns: agent.limits?.maxTurns ?? null,
    maxBudgetUsd: agent.limits?.maxBudgetUsd ?? null,
  };
  const limitGiven = limits.maxTurns !== null || limits.maxBudgetUsd !== null;
  if (!isEngineId(settings.id)) {
    return refuse([{ path: 'agent.engine', message: 'is not an engine this SDK knows' }]);
  }
  if (isWithholdingSettings(settings)) {
    const { id: engine, ...native } = settings;
    return { policy: { engine, ...native, skills, limits }, policySource: 'stored' };
  }
  const autoApprove = [...new Set(settings.autoApprove ?? [])].sort();
  const requireApproval = [...new Set(settings.requireApproval ?? [])].sort();
  const handoff = settings.handoff === true;
  return {
    policy: {
      engine: settings.id,
      tools: { ...claudeBaseToolPolicyFor(permissions), autoApprove },
      ...(requireApproval.length > 0 ? { requireApproval } : {}),
      ...(handoff ? { handoff } : {}),
      skills,
      limits,
    },
    policySource:
      limitGiven || autoApprove.length > 0 || requireApproval.length > 0 || handoff
        ? 'stored'
        : 'compiled',
  };
}

/**
 * Turns a defined agent, and its surfaces, into the body of an agent version — what `aw push`
 * saves and `aw check` dry-runs. The result is the parsed `AgentVersionBodySchema` output, so its
 * key order is fixed and two calls on the same definition are deep-equal.
 *
 * How the definition maps:
 *
 * - `model` left out or `'default'` → `modelConnectionName: 'default'`, `model: null`; the server
 *   resolves `default` to the workspace's connection of that name, else the deployment default
 *   (contract C7). Another string → that connection, `model: null`; `{ connection, id }` → that
 *   connection and model. `runtimeProfileName` is always `null`: null for the workspace's
 *   default runtime profile (none: runs are refused until the agent names one).
 * - `permissions` → all four switches, any left out `false`.
 * - `tools`, `skills` and `files` → `resources.connectors`, `resources.skills` and
 *   `resources.files`, in the order written; the skill allowlist names every assigned skill. Every
 *   tool lands in `resources.connectors` by its connector name: an `mcp()` tool's connector, an
 *   `openapiTool()` or `postgresTool()` tool's `name` (contract C15). {@link toolDefinitionsOf}
 *   gives what registers the catalog connectors.
 * - `description`, `subagents` (as `{ name }`, in the order written) and `knowledge` → the same
 *   keys, each absent when the agent leaves it out. Every `files` knowledge path the agent does
 *   not already grant is appended to `resources.files` with `read` access; a path it grants keeps
 *   its access. A `connector` source is already in `resources.connectors` through its `mcp()` tool.
 * - `engine.requireApproval` is stored as the policy's `requireApproval`, sorted and without
 *   duplicates; an empty list changes nothing.
 * - `engine.handoff: true` is stored as the policy's `handoff: true` and forces the stored policy;
 *   left out changes nothing.
 * - `engine` left out → `options.defaultEngine` (the project's `engine`, contract C12), else
 *   `claude-agent-sdk`.
 * - The policy is **compiled** (`policySource: 'compiled'`) when the engine is `claude-agent-sdk`
 *   and no limit has a value (`limits` left out, `{}` or every limit `undefined`) and no
 *   `autoApprove` or `requireApproval` rule is declared: it is then exactly the policy the server
 *   compiles from the permissions and skills, and follows later changes to them. It is **stored**
 *   otherwise — any limit with a value, any `autoApprove` rule (the policy's `tools.autoApprove`,
 *   nothing else changed), any `requireApproval` rule, `handoff: true`, or any other engine, even with no settings, since the server compiles a policy only
 *   for its default engine.
 *
 * @throws {DefinitionError} when the agent or a surface was not made by `defineAgent()` or
 *   `defineSurface()`, when `options.defaultEngine` is not an engine id, when the agent does not
 *   pass `defineAgent()`'s checks again (a value that carries the brand without having been made
 *   by it, at `agent.<path>`), when file instructions are not resolved or inline ones are given
 *   `options.instructions`, and with every issue `AgentVersionBodySchema` finds — a surface that
 *   names another agent (`surfaces.<i>.agent`) or repeats a name (`surfaces.<i>.name`) included.
 */
export function toAgentVersionBody(
  agent: DefinedAgent,
  options: ToAgentVersionBodyOptions = {},
): AgentVersionBody {
  const definition = checkedAgent(agent, 'toAgentVersionBody()');
  const parsedOptions = OptionsSchema.safeParse(options);
  if (!parsedOptions.success) refuse(issuesFromZod(parsedOptions.error, 'options'));

  const permissions = permissionsOf(definition);
  const skillNames = (definition.skills ?? []).map((entry) => entry.name);
  const skillRevisions = Object.fromEntries(
    (definition.skills ?? []).flatMap((entry) =>
      entry.revision === undefined ? [] : [[entry.name, entry.revision] as const],
    ),
  );
  const files = (definition.files ?? []).map((grant) => ({
    path: grant.path,
    access: grant.access,
  }));
  const granted = new Set(files.map((grant) => grant.path));
  for (const source of definition.knowledge ?? []) {
    if (source.kind !== 'files') continue;
    for (const path of source.paths) {
      if (!granted.has(path)) files.push({ path, access: 'read' });
      granted.add(path);
    }
  }
  const body: AgentVersionBodyInput = {
    definition: {
      apiVersion: AGENT_DEFINITION_API_VERSION,
      kind: AGENT_DEFINITION_KIND,
      agent: {
        name: definition.name,
        instructions: instructionsText(definition, parsedOptions.data.instructions),
        permissions,
        ...modelFields(definition),
        runtimeProfileName: null,
      },
      ...policyOf(definition, permissions, skillNames, parsedOptions.data.defaultEngine),
      resources: {
        files,
        skills: skillNames,
        ...(Object.keys(skillRevisions).length === 0 ? {} : { skillRevisions }),
        connectors: [...new Set((definition.tools ?? []).map(toolNameOf))],
      },
    },
    surfaces: parsedOptions.data.surfaces ?? [],
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.subagents === undefined
      ? {}
      : {
          subagents: definition.subagents.map((subagent) => ({
            name: typeof subagent === 'string' ? subagent : subagent.name,
          })),
        }),
    ...(definition.knowledge === undefined ? {} : { knowledge: definition.knowledge }),
  };
  const parsed = AgentVersionBodySchema.safeParse(body);
  if (!parsed.success) refuse(issuesFromZod(parsed.error));
  return parsed.data;
}

/** A secret reference by name, as a plain object with no brand: `{ secret: NAME }` (C10). */
export interface ToolCredentialReference {
  readonly secret: string;
}

/**
 * What registers an `openapiTool()`: the `openapi` create body of `POST /api/connectors` (C15),
 * with the unresolved `spec` in place of `document` and a secret reference in place of the
 * credential value.
 */
export interface OpenApiToolDefinition {
  readonly kind: 'openapi';
  readonly name: string;
  /** The `https:` URL or project-relative path, as written; nothing has read it. */
  readonly spec: string;
  readonly allow: readonly string[];
  readonly auth: 'none' | 'bearer' | { readonly header: string };
  readonly baseUrl?: string;
  /** The secret the credential is read from; present exactly when `auth` is not `none`. */
  readonly credential?: ToolCredentialReference;
  /** The secret that signs the identity assertion (ADR-0142 D1); absent when not opted in. */
  readonly identity?: ToolCredentialReference;
}

/**
 * What registers a `postgresTool()`: the `postgres` create body of `POST /api/connectors` (C15),
 * with a secret reference in place of the connection URL.
 */
export interface PostgresToolDefinition {
  readonly kind: 'postgres';
  readonly name: string;
  /** The secret the connection URL is read from. */
  readonly credential: ToolCredentialReference;
  readonly tables: readonly string[];
  readonly readOnly: true;
  readonly maxRows?: number;
}

/** What registers one catalog tool of an agent: see {@link toolDefinitionsOf}. */
export type ToolDefinition = OpenApiToolDefinition | PostgresToolDefinition;

function credentialOf(reference: { readonly secret: string }): ToolCredentialReference {
  return Object.freeze({ secret: reference.secret });
}

function openApiAuthFields(
  auth: OpenApiTool['auth'],
): Pick<OpenApiToolDefinition, 'auth' | 'credential'> {
  if (auth === undefined) return { auth: 'none' };
  if ('header' in auth) {
    return {
      auth: Object.freeze({ header: auth.header }),
      credential: credentialOf(auth.credential),
    };
  }
  return { auth: 'bearer', credential: credentialOf(auth) };
}

function openApiDefinition(tool: OpenApiTool): OpenApiToolDefinition {
  return Object.freeze({
    kind: 'openapi',
    name: tool.name,
    spec: tool.spec,
    allow: Object.freeze([...tool.allow]),
    ...openApiAuthFields(tool.auth),
    ...(tool.baseUrl === undefined ? {} : { baseUrl: tool.baseUrl }),
    ...(tool.identity === undefined ? {} : { identity: credentialOf(tool.identity) }),
  });
}

function postgresDefinition(tool: PostgresTool): PostgresToolDefinition {
  return Object.freeze({
    kind: 'postgres',
    name: tool.name,
    credential: credentialOf(tool.url),
    tables: Object.freeze([...tool.tables]),
    readOnly: true,
    ...(tool.maxRows === undefined ? {} : { maxRows: tool.maxRows }),
  });
}

/**
 * The catalog tools of a defined agent — every `openapiTool()` and `postgresTool()`, in the order
 * written; `mcp()` tools name connectors that already exist and are left out — as the bodies that
 * register them (contract C15). Each is the connector create body with the unresolved `spec` in
 * place of `document` and a plain `{ secret: NAME }` in place of each credential value: whoever
 * registers the tool reads the document and the secret values, then parses the result with
 * `CreateToolConnectorRequestSchema`. This reads no file and no secret value.
 *
 * @throws {DefinitionError} when the agent was not made by `defineAgent()`, or does not pass its
 *   checks again (at `agent.<path>`).
 */
export function toolDefinitionsOf(agent: DefinedAgent): readonly ToolDefinition[] {
  const definition = checkedAgent(agent, 'toolDefinitionsOf()');
  const definitions: ToolDefinition[] = [];
  for (const tool of definition.tools ?? []) {
    if (isOpenApiTool(tool)) definitions.push(openApiDefinition(tool));
    else if (isPostgresTool(tool)) definitions.push(postgresDefinition(tool));
  }
  return Object.freeze(definitions);
}
