/**
 * `@indx-workspace/sdk/define` — agents and surfaces as code (issue #445, contract C3).
 *
 * A project's `agents/*.ts` and `surfaces/*.ts` describe what runs with {@link defineAgent},
 * {@link defineSurface}, the tools {@link mcp}, {@link openapiTool} and {@link postgresTool}, the
 * references {@link skill}, {@link builtinSkill}, {@link files} and {@link secret}; {@link toAgentVersionBody} turns
 * them into the body of an agent version, which `aw check` dry-runs and `aw push` saves.
 *
 * - **Checked when defined.** Each function validates its input with the contract's own schemas
 *   and throws {@link DefinitionError} at once; a value it returns is branded, frozen and known to
 *   be valid. The brand is a registered symbol, so a value from one copy of the SDK passes another
 *   copy's {@link isDefinedAgent} and {@link isDefinedSurface}.
 * - **Isomorphic.** No Node.js module is imported: the same definitions load in Node, a bundler
 *   and a browser.
 * - **`model: 'default'`** (or no model) is sent as the model connection named `default`, which
 *   the server resolves to the workspace's connection of that name, else the deployment default
 *   (contract C7).
 * - **Compiled or stored policy.** A `claude-agent-sdk` agent with no `limits` gets the policy the
 *   server compiles from its permissions and skills (`policySource: 'compiled'`); any `limits`, or
 *   any other engine, gives a stored policy.
 * - **Tools.** `mcp()` names an MCP connector the workspace already has. `openapiTool()` (an
 *   HTTP API from an OpenAPI document; its writes are implicitly approval-gated) and
 *   `postgresTool()` (read-only tables) become
 *   catalog connectors of their `name`; {@link toolDefinitionsOf} gives the bodies that register
 *   them, and every tool is named in the version's `resources.connectors` (contract C15).
 * - **Code tools.** `defineTool()` declares a function tool (a JSON Schema input, a `run` path); the
 *   run file is never imported by the loader. `z` is re-exported for the input schema.
 * - **Secrets by name.** A credential is always a reference, {@link secret} or a plain
 *   `{ secret: NAME }`, never a value (contract C10). A reserved name such as `PORT` is refused.
 * - **Default engine.** An agent with no `engine` runs on `options.defaultEngine`, the project's
 *   `engine` (contract C12), else `claude-agent-sdk`.
 * - **Description, subagents, knowledge.** `description` says what the agent is for. `subagents`
 *   names the agents it may delegate to, one level deep (a `defineAgent()` value or a name).
 *   `knowledge` is {@link KnowledgeSource}s: files, which are also granted to the agent, or an
 *   `mcp()` tool's connector. Subagents are declared and validated here; no engine runs them yet.
 *
 * @packageDocumentation
 */
export {
  defineAgent,
  isDefinedAgent,
  type DefineAgentInput,
  type DefineLimits,
  type DefinePermissions,
  type DefineTool,
  type DefinedAgent,
  type EngineChoice,
  type EngineSettings,
  type InstructionsSource,
  type KnowledgeSource,
  type ModelReference,
} from './agent.js';
export { defineSurface, isDefinedSurface, type DefinedSurface } from './surface.js';
export {
  CODE_TOOL_DEFAULT_TIMEOUT_MS,
  CODE_TOOL_MAX_TIMEOUT_MS,
  builtinSkill,
  defineTool,
  files,
  isCodeTool,
  isOpenApiTool,
  isPostgresTool,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  skill,
  type CodeTool,
  type CodeToolDeclaration,
  type CodeToolInput,
  type DefinedSecret,
  type FileAccess,
  type FileGrant,
  type McpTool,
  type OpenApiTool,
  type OpenApiToolAuth,
  type OpenApiToolInput,
  type PostgresTool,
  type PostgresToolInput,
  type SkillReference,
  type ToolRun,
  type ToolRunContext,
} from './references.js';
export { z } from 'zod';
export {
  agentFromVersionBody,
  toolModulesOf,
  type AgentFromVersionBody,
  type AgentVersionSource,
  type ToolModuleExport,
  type VersionBodyDrop,
} from './from-version-body.js';
export {
  toAgentVersionBody,
  toolDefinitionsOf,
  type OpenApiToolDefinition,
  type PostgresToolDefinition,
  type ToAgentVersionBodyOptions,
  type ToolCredentialReference,
  type ToolDefinition,
} from './version-body.js';
export { DefinitionError, type DefinitionIssue } from './errors.js';
