/**
 * `@agent-workspace/engine-claude-agent-sdk` — the compile step of spec §5.
 *
 * §5: *"The platform configuration should simply compile UI/database settings into Claude Agent
 * SDK options."* That sentence is this file, and it is deliberately the whole of this file.
 * There is no agent loop, no planner, no tool executor and no conversation engine here (§53);
 * there is one pure function from a stored {@link RunRequest} to a plain options object, and
 * `./boundary.ts` passes that object through to `query()`.
 *
 * Moved here from `packages/core/src/config.ts` by ENG-04 (#303), with the behaviour unchanged —
 * that is this unit's whole claim about the Claude engine, and
 * `formal/AgentWorkspace/Theorems/Refinement/EnginePortCompile.lean` is where it is stated
 * formally. What changed is *where it lives*: the compile step turns the platform's portable
 * agent configuration into **one engine's** options, so it belongs to that engine's adapter. The
 * day a second adapter exists, `packages/core` holding a Claude-shaped compile would be the
 * reason the second one could not be added without editing it.
 *
 * ## What ENG-04b (#325) added here
 *
 * Three translations the *control plane* used to perform and now does not, because each of them
 * writes in a vocabulary only this engine speaks:
 *
 *   * the **tool policy** — `./tools.ts`'s `compileClaudeToolPolicy`, from the portable permission
 *     switches, the stored engine arm, the read-only file grants and the assigned connectors;
 *   * the **tenant session scope** — `./scope.ts`'s `claudeSessionScope`, which derives
 *     `CLAUDE_CONFIG_DIR` from `cwd` instead of receiving it;
 *   * the **engine arm's parse** — `./policy.ts`'s `ClaudeRunPolicy`.
 *
 * All three are byte-identical in outcome to what compose produced before the move, which is the
 * refinement theorem `formal/AgentWorkspace/Theorems/Refinement/EngineToolPolicy.lean` states and
 * `tests/formal/engine-tool-policy.test.ts` replays against this function.
 *
 * **Nothing here imports `@anthropic-ai/claude-agent-sdk`** — §42 makes `./boundary.ts` the
 * single import site, and `tests/no-sdk-import.test.ts` enforces it as a set equality over the
 * whole tracked tree. The consequence of not importing the SDK is that TypeScript cannot check
 * the object below against the SDK's own `Options` type. `tests/sdk-surface.test.ts` closes
 * that gap by reading the installed `sdk.d.ts` as text and asserting every key this module can
 * emit against it, with its optionality, so an upstream rename breaks a test rather than a run.
 *
 * ## A.11, on this path (W3-CP-09, generalised by ENG-04)
 *
 * This is the one place every driver's Claude run ultimately passes through on its way to the
 * SDK — `local` calls it in this process, and a containerised driver's runtime image calls the
 * same `./boundary.ts`, which calls this function. So two of A.11's five unconditional variables
 * are derived here, the same way `CLAUDE_CONFIG_DIR` already is: `runId` and `sessionId` are
 * already fields of `RunRequest`, so `AGENT_WORKSPACE_RUN_ID` and `AGENT_WORKSPACE_SESSION_ID`
 * need nothing this schema does not already carry.
 *
 * `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (§26's model gateway) are **not** derived here.
 * On today's private contract compose still writes both into `env`
 * (`apps/web/server/compose/run-request.ts`) and this function passes them through with the rest
 * of it. {@link RunRequest.gateway}, the connection the port hands every adapter
 * programmatically, is carried on the contract and read for one thing only: its `token` is what
 * the A.11 check below compares every credential-shaped variable against. Translating `gateway`
 * into the CLI's two variables — which only the Claude adapter will ever do, because the SDK's
 * bundled CLI is a subprocess that reads its credential out of its environment — is deferred to
 * the unit that stops compose writing them into `env` (ENG-04's private-contract v2; declared on
 * the PR and in ADR-0070). `./engine.ts`'s `claudeGatewayEnv` states the pair for that unit.
 *
 * What *is* fully enforceable here, and is: A.11's *"Provider master credentials never enter a
 * sandbox"* — checked below as a positive assertion on the compiled environment, not left to
 * every caller's discipline. The check is `@agent-workspace/engine`'s
 * `sandboxEnvironmentVerdict`, which states the rule as a property of the environment rather
 * than as this one provider's spelling of a key, so a second adapter inherits it.
 */
import {
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  RunRequest,
  type SdkSettingSource,
} from '@agent-workspace/core';
import { sandboxEnvironmentVerdict } from '@agent-workspace/engine';
import { claudeDeniedToolsFor, type AgentToolPolicy } from '@indx-workspace/contracts/agents';

import type { CompiledMcpServerConfig, CompiledSdkAgent, CompiledSdkOptions } from './options.js';
import { ClaudeRunPolicy } from './policy.js';
import { claudeSessionScope } from './scope.js';
import { CLAUDE_PRESET_TOOLS, compileClaudeToolPolicy } from './tools.js';

/**
 * `settingSources` for every platform-launched run.
 *
 * `'project'` must be present: R-01 §8 and the contract summary both record that
 * `.claude/skills/` and `CLAUDE.md` inside the workspace are loaded only when the `project`
 * source is enabled, and spec §7 materialises a tenant's skills exactly there. `'user'` and
 * `'local'` are excluded because they read the sandbox image's own home directory, which is
 * platform-owned and must not be able to add tools or instructions to a tenant's run.
 *
 * Note what this does **not** do (R-01 contradiction 6): restricting `settingSources` does not
 * empty a tenant's skill surface. The bundled Claude Code skills load regardless. The lever for
 * that is `skills`, which is why `AgentSkillPolicy` exists.
 */
export const PLATFORM_SETTING_SOURCES: readonly SdkSettingSource[] = ['project'];

/**
 * `strictMcpConfig: true` on every run.
 *
 * R-01 §9: without it the SDK also loads the workspace's own `.mcp.json`, user settings,
 * plugins and on-disk agent frontmatter. *"For a multi-tenant control plane,
 * `strictMcpConfig: true` should be the default, or a tenant's workspace files can inject
 * connectors we never registered."* Spec §8's connector list is only the truth if this is on.
 */
export const PLATFORM_STRICT_MCP_CONFIG = true;

/** The two environment variables {@link compileRunRequest} derives, never copies. */
export const SESSION_SCOPE_ENV_VARS = [
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CODE_PROJECT_DIR_NAME_ENV,
] as const;

/**
 * A.11's `AGENT_WORKSPACE_RUN_ID` / `AGENT_WORKSPACE_SESSION_ID` — the platform's own run and
 * Claude-session identifiers, "echoed in every event and log line" and "for resume" respectively.
 * Named here rather than folded into {@link SESSION_SCOPE_ENV_VARS}: that constant is the tenant
 * *session scope* pair (`apps/runner/src/index.ts`'s `runnerBaseEnvironment` documents it as
 * exactly two keys), and these two are a different A.11 concern — identity, not scope — so
 * extending the existing constant would make that file's own comment wrong without this task
 * being able to fix it (`index.ts` is outside this task's `Owns` globs). A future task that wants
 * a container's base environment to also exclude these two can filter by this array without
 * either file needing to change the other's meaning.
 */
export const A11_IDENTITY_ENV_VARS = [
  'AGENT_WORKSPACE_RUN_ID',
  'AGENT_WORKSPACE_SESSION_ID',
] as const;

const AGENT_WORKSPACE_RUN_ID_ENV = A11_IDENTITY_ENV_VARS[0];
const AGENT_WORKSPACE_SESSION_ID_ENV = A11_IDENTITY_ENV_VARS[1];

/**
 * A.11: *"Provider master credentials never enter a sandbox."*
 *
 * Kept as a named export because `compile.test.ts` and `packages/core`'s `RunEnvironment` both
 * spell it, and one spelling of a forbidden key is the point. The *check* is no longer written
 * here, though: ENG-04 moved it to `@agent-workspace/engine`'s `sandboxEnvironmentVerdict`,
 * which states the rule as a property of the environment — no `ANTHROPIC_API_KEY`, and every
 * `*_API_KEY` / `*_AUTH_TOKEN` holding this run's own gateway token — rather than as one
 * provider's spelling. A second adapter inherits the rule instead of re-deriving it.
 */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Compile one stored run request into the SDK options object.
 *
 * The argument is re-parsed rather than trusted. `RunRequest` is a type, and a type is a
 * compile-time claim: the value actually reaching this function came from a database row, an
 * HTTP body or a queue message. ADR-0015's first rule is to parse before comparing, so the
 * parse happens here even when the caller has already done it — the cost is microseconds and
 * the alternative is a compile step that reads a field that was never checked.
 *
 * Throws `ZodError` on an invalid request. That is deliberate and is the ADR-0015 shape: a run
 * whose configuration could not be validated must not start, and must not start *with defaults*
 * either. There is no partial-success return.
 */
export function compileRunRequest(request: RunRequest): CompiledSdkOptions {
  const parsed = RunRequest.parse(request);
  const { portable, session } = parsed;

  // ENG-04b: the engine arm, parsed here and not cast. `compile` in `./engine.ts` parses it too
  // and answers `engine_policy_invalid` from the result; this parse is the one that runs on every
  // path into the SDK, including `./boundary.ts`'s `startRun`.
  const policy = ClaudeRunPolicy.parse(parsed.policy);

  // The tenant session scope, derived rather than received (see `./scope.ts`). A `configDir` the
  // SDK would silently ignore is a cross-tenant session collision, so it is refused here rather
  // than compiled.
  const derived = claudeSessionScope(parsed.cwd, parsed.projectKey);
  if (!derived.ok) {
    throw new Error(`compileRunRequest: refusing to compile this run — ${derived.reason}`);
  }
  const scope = derived.scope;

  // The Claude tool policy, compiled from the portable permissions, the stored arm, the grant
  // denials and the assigned connectors. `./tools.ts` documents the order, which is the surface
  // ENG-04b's refinement theorem is about.
  const tools = compileClaudeToolPolicy(portable.permissions, {
    stored: policy.tools,
    fileGrantDeny: policy.fileGrantDeny,
    mcpServers: portable.mcpServers,
  });

  // `options.env` REPLACES the subprocess environment — it is not merged with `process.env`
  // (R-01 §3, a breaking change in SDK 0.2.113). `parsed.env` is therefore the complete
  // environment the runner decided on, and this function adds four derived values on top: the
  // two-variable tenant session scope `RunEnvironment` already refuses to let the caller set for
  // itself, plus A.11's `AGENT_WORKSPACE_RUN_ID` / `AGENT_WORKSPACE_SESSION_ID`, read off this
  // same `RunRequest`'s own `runId` / `sessionId` fields rather than copied from `parsed.env`
  // (which cannot set them: they are derived, always last, so they always win).
  const env: Record<string, string> = {
    ...parsed.env,
    [CLAUDE_CONFIG_DIR_ENV]: scope.configDir,
    [CLAUDE_CODE_PROJECT_DIR_NAME_ENV]: scope.projectKey,
    [AGENT_WORKSPACE_RUN_ID_ENV]: parsed.runId,
    [AGENT_WORKSPACE_SESSION_ID_ENV]: parsed.sessionId,
  };

  // A.11: "Provider master credentials never enter a sandbox." ADR-0015's explicit `else`: this
  // is not a warning and not a strip-and-continue, because either of those would start a run
  // whose environment the caller believed was safe. The check is written against the assembled
  // `env`, not against `parsed.env` alone, so it also catches a future edit to this function
  // that adds a derived entry without noticing what it collides with.
  //
  // `gateway.token` is what the second half of the rule compares against: a variable spelled
  // like a credential and holding something other than this run's own gateway token is a
  // provider credential by definition, whatever it is called. A request with no `gateway` — the
  // shape every pre-ENG-04 caller sends — is checked against the `ANTHROPIC_AUTH_TOKEN` it
  // already carries, so the rule applies to today's requests rather than waiting for the
  // private contract's v2. See `packages/engine/src/sandbox-env.ts`.
  const runToken = parsed.gateway?.token ?? env['ANTHROPIC_AUTH_TOKEN'] ?? '';
  const sandbox = sandboxEnvironmentVerdict(env, runToken);
  if (!sandbox.ok) {
    throw new Error(`compileRunRequest: refusing to compile this run — ${sandbox.reason}`);
  }

  const mcpServers: Record<string, CompiledMcpServerConfig> = { ...portable.mcpServers };
  const subagents = portable.subagents ?? [];
  if (subagents.length > 0 && removesDelegationTool(tools)) {
    throw new SubagentToolRemovedError(
      "the agent's tool policy removes Agent, so its subagents could never be called",
    );
  }

  const options: CompiledSdkOptions = {
    cwd: parsed.cwd,
    env,
    settingSources: PLATFORM_SETTING_SOURCES,
    strictMcpConfig: PLATFORM_STRICT_MCP_CONFIG,
    mcpServers,
    permissionMode: tools.permissionMode,
    // §6 maps "Tool permissions → allowedTools". R-01 §10 established that is incomplete:
    // `allowedTools` auto-approves and does not restrict. All three lists are emitted, and
    // `base` — the SDK's `tools` — is the one that decides what the model can see at all.
    // docs/adr/W1-CORE-01-tool-permissions-correct-spec-6.md.
    allowedTools: tools.autoApprove,
    disallowedTools: tools.deny,
    tools: tools.base === 'claude_code_preset' ? [...CLAUDE_PRESET_TOOLS] : tools.base,
    skills: portable.skills.mode === 'all' ? 'all' : portable.skills.names,
    ...(subagents.length === 0
      ? {}
      : {
          agents: Object.fromEntries(
            subagents.map((subagent) => [subagent.name, compileSubagent(subagent, tools.deny)]),
          ),
        }),
    ...(tools.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(portable.model === null ? {} : { model: portable.model }),
    // §17 Step 1's "Instructions" is an *addition* to Claude Code's own system prompt, not a
    // replacement: a tenant writing "You help employees answer questions..." is not asking for
    // an agent that has forgotten how to use its tools. R-01 §3 option 63 gives the preset
    // shape that appends. An empty instructions field emits nothing at all rather than an
    // empty append, matching what the `agents.instructions` column means by "".
    ...(portable.instructions.trim().length === 0
      ? {}
      : {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: portable.instructions,
          },
        }),
    ...(portable.limits.maxTurns === null ? {} : { maxTurns: portable.limits.maxTurns }),
    ...(portable.limits.maxBudgetUsd === null
      ? {}
      : { maxBudgetUsd: portable.limits.maxBudgetUsd }),
    // R-01 §6: `sessionId` cannot be combined with `resume` unless `forkSession` is also set.
    // The three arms of `RunSessionMode` are exactly the three legal combinations, so this
    // switch is total and cannot emit an illegal pair.
    ...compileSessionMode(session),
  };

  return options;
}

/** Thrown when subagents are declared but the parent's tool policy removes the tool that calls them. */
export class SubagentToolRemovedError extends Error {}

/**
 * The SDK's delegation tool: the model reaches an `agents` entry only by calling it.
 *
 * VERIFY: the pinned `sdk.d.ts` types tool names as `string`, so no type can pin this one. The
 * name is from https://code.claude.com/docs/en/agent-sdk/subagents, and `./boundary.test.ts`
 * checks it against the pinned `sdk-tools.d.ts` (`AgentInput` in `ToolInputSchemas`).
 */
export const CLAUDE_DELEGATION_TOOL = 'Agent';

function removesDelegationTool(tools: AgentToolPolicy): boolean {
  return (
    tools.deny.includes(CLAUDE_DELEGATION_TOOL) ||
    (tools.base !== 'claude_code_preset' && !tools.base.includes(CLAUDE_DELEGATION_TOOL))
  );
}

/**
 * One subagent as an `agents` entry. It inherits the parent's tools, so only what its own
 * permissions deny beyond the parent's is listed; the parent's denials already apply.
 */
function compileSubagent(
  subagent: NonNullable<RunRequest['portable']['subagents']>[number],
  parentDeny: readonly string[],
): CompiledSdkAgent {
  const own = claudeDeniedToolsFor(subagent.permissions).filter(
    (rule) => !parentDeny.includes(rule),
  );
  return {
    description: subagent.description,
    prompt: subagent.instructions,
    ...(subagent.model === null ? {} : { model: subagent.model }),
    ...(own.length === 0 ? {} : { disallowedTools: own }),
  };
}

type CompiledSessionOptions = Pick<CompiledSdkOptions, 'sessionId' | 'resume' | 'forkSession'>;

function compileSessionMode(session: RunRequest['session']): CompiledSessionOptions {
  switch (session.kind) {
    // R-01 §6: minting the UUID ourselves removes the race between the Postgres row and the
    // arrival of `system/init`.
    case 'fresh':
      return { sessionId: session.sessionId };
    case 'resume':
      return { resume: session.resume };
    case 'fork':
      return { resume: session.resume, sessionId: session.sessionId, forkSession: true };
    default: {
      // Total by exhaustiveness, and it says so out loud: if a fourth arm is added to
      // `RunSessionMode` and not handled here, `never` stops accepting it and this stops
      // compiling. It never silently returns "no session options", which would start a fresh
      // conversation in place of a resume.
      const unreachable: never = session;
      throw new Error(`unhandled run session mode: ${JSON.stringify(unreachable)}`);
    }
  }
}
