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
import { RunRequest, type SdkSettingSource } from '@agent-workspace/run-protocol';
import { AGENT_MEMORY_FILE, agentMemoryEnabled } from '@indx-workspace/contracts/agents';

import { compileApprovals, compileToolsWithWriteApprovals } from './compile-approvals.js';
import { compileRunEnvironment } from './compile-environment.js';
import { assertSubagentsCallable, compileSubagents } from './compile-subagents.js';
import { CLAUDE_HANDOFF_TOOL } from './handoff.js';
import type { CompiledClaudeRun, CompiledSdkOptions } from './options.js';
import { ClaudeRunPolicy } from './policy.js';
import { claudeSessionScope } from './scope.js';
import { CLAUDE_PRESET_TOOLS } from './tools.js';

export {
  A11_IDENTITY_ENV_VARS,
  ANTHROPIC_API_KEY_ENV,
  SESSION_SCOPE_ENV_VARS,
} from './compile-environment.js';
export { CLAUDE_DELEGATION_TOOL, SubagentToolRemovedError } from './compile-subagents.js';

/**
 * The one system-prompt line a run that keeps a memory folder is given (ADR-0163): it names the
 * file and nothing else. The engine reads and writes the file with its own tools; the platform
 * searches, ranks and injects nothing.
 */
export const CLAUDE_MEMORY_INSTRUCTION =
  `Keep durable facts for later sessions in ${AGENT_MEMORY_FILE}: read it before you start, ` +
  'and update it when you learn something worth remembering.';

/** The instructions the system prompt appends: the agent's, then the memory line when it is on. */
function appendedInstructions(portable: RunRequest['portable']): string {
  if (!agentMemoryEnabled(portable.permissions)) return portable.instructions;
  return portable.instructions.trim().length === 0
    ? CLAUDE_MEMORY_INSTRUCTION
    : `${portable.instructions}\n\n${CLAUDE_MEMORY_INSTRUCTION}`;
}

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
export function compileRunRequest(request: RunRequest): CompiledClaudeRun {
  const parsed = RunRequest.parse(request);
  const { portable } = parsed;

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

  const tools = compileToolsWithWriteApprovals(parsed, policy);
  const approvals = compileApprovals(parsed, policy, tools);
  const env = compileRunEnvironment(parsed, derived.scope);
  const subagents = portable.subagents ?? [];
  assertSubagentsCallable(subagents, tools);

  return {
    cwd: parsed.cwd,
    env,
    settingSources: PLATFORM_SETTING_SOURCES,
    strictMcpConfig: PLATFORM_STRICT_MCP_CONFIG,
    mcpServers: { ...portable.mcpServers },
    permissionMode: tools.permissionMode,
    // §6 maps "Tool permissions → allowedTools". R-01 §10 established that is incomplete:
    // `allowedTools` auto-approves and does not restrict. All three lists are emitted, and
    // `base` — the SDK's `tools` — is the one that decides what the model can see at all.
    // docs/adr/W1-CORE-01-tool-permissions-correct-spec-6.md.
    //
    // `allowedTools` bypasses `canUseTool`, so a rule that could approve a gated tool is moved
    // out of it by `splitApprovals` and decided by the callback instead.
    allowedTools: policy.handoff
      ? [...approvals.allowedTools, CLAUDE_HANDOFF_TOOL]
      : approvals.allowedTools,
    disallowedTools: tools.deny,
    tools: tools.base === 'claude_code_preset' ? [...CLAUDE_PRESET_TOOLS] : tools.base,
    skills: portable.skills.mode === 'all' ? 'all' : portable.skills.names,
    ...compileSubagents(subagents, tools.deny),
    ...(tools.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(portable.model === null ? {} : { model: portable.model }),
    ...compileSystemPrompt(appendedInstructions(portable)),
    ...(portable.limits.maxTurns === null ? {} : { maxTurns: portable.limits.maxTurns }),
    ...(portable.limits.maxBudgetUsd === null
      ? {}
      : { maxBudgetUsd: portable.limits.maxBudgetUsd }),
    // R-01 §6: `sessionId` cannot be combined with `resume` unless `forkSession` is also set.
    // The three arms of `RunSessionMode` are exactly the three legal combinations, so this
    // switch is total and cannot emit an illegal pair.
    ...compileSessionMode(parsed.session),
    ...(policy.handoff ? { handoff: true as const } : {}),
    ...(approvals.gate === null ? {} : { approval: approvals.gate }),
  };
}

/**
 * §17 Step 1's "Instructions" is an *addition* to Claude Code's own system prompt, not a
 * replacement: a tenant writing "You help employees answer questions..." is not asking for
 * an agent that has forgotten how to use its tools. R-01 §3 option 63 gives the preset
 * shape that appends. An empty instructions field emits nothing at all rather than an
 * empty append, matching what the `agents.instructions` column means by "". A run that keeps
 * a memory folder appends one more line naming its file (ADR-0163).
 */
function compileSystemPrompt(appended: string): Pick<CompiledSdkOptions, 'systemPrompt'> {
  if (appended.trim().length === 0) return {};
  return {
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: appended },
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
