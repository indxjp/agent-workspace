/**
 * `packages/engine-claude-agent-sdk/src/boundary.ts` — **the** Claude Agent SDK boundary (§42).
 *
 * This is the only file in `apps/` and `packages/` that may `import`
 * `@anthropic-ai/claude-agent-sdk`. `tests/no-sdk-import.test.ts` asserts that over the whole
 * tracked tree — as of ENG-04 (#303) it does so from a **table** of
 * `{ third-party SDK → the one file allowed to import it }`, one row per engine adapter, with
 * the same set equality and the same `.d.ts`-leak check applied to every row. So the claim keeps
 * its meaning when a second adapter is added: the second engine gets a row, not an exception.
 *
 * ENG-04 moved this file here from `apps/runner/src/claude.ts` **without behaviour change**. That
 * is the unit's defining constraint and the formal half of it is
 * `formal/AgentWorkspace/Theorems/Refinement/EnginePortCompile.lean`. What the move buys is that
 * the runner no longer imports an SDK boundary at all: it looks an engine up in
 * `apps/runner/src/engines.ts` and talks to `@agent-workspace/engine`'s port, so adding an
 * engine is adding a package.
 *
 * Three jobs, and deliberately no fourth (§53 — there is no agent loop, planner, tool executor
 * or conversation engine here, and there must never be one):
 *
 *   1. **Translate.** {@link toSdkOptions} turns the plain object `packages/core`'s compile step
 *      produces (`CompiledSdkOptions`, spec §5) into the SDK's own `Options`. `packages/core`
 *      cannot type-check itself against `Options` — it is forbidden from importing the SDK — so
 *      this function is the one place the two types actually meet, and it is where a readonly
 *      array becomes a mutable one and an optional field becomes present-or-absent.
 *   2. **Wrap.** {@link startRun} calls `query()` once and hands back its stream.
 *   3. **Normalise.** Every raw `SDKMessage` goes through `classifySdkEvent` — the union
 *      W1-CORE-01 defined — before it leaves this file.
 *
 * ## The import site is not the boundary; the emitted `.d.ts` is
 *
 * A file that imports the SDK privately and then puts an SDK type on an exported signature has
 * moved the import site, not removed it: every consumer still needs the SDK's declarations to
 * type-check. The first version of this file did exactly that — `toSdkOptions` returned
 * `Options` and the overlay's `sessionStore` was the SDK's `SessionStore`, so
 * `tsc --emitDeclarationOnly` produced a `claude.d.ts` that imported the package.
 *
 * So the SDK's types are confined to module-private declarations here. What the exported surface
 * carries instead is platform-owned: {@link TranscriptMirror} (restated field for field from the
 * SDK's `SessionStore`, with the compiler checking both directions of assignability at
 * `instrumentSessionStore`), {@link TranslatedSdkOptions} for the translated object, and
 * `ClassifiedSdkEvent` from `packages/core` for the stream. `tests/no-sdk-import.test.ts` emits
 * this file's declarations and asserts the result contains no SDK module specifier, because an
 * `import`-statement scan cannot see a type that travels in a `.d.ts`.
 *
 * ## The two claims this file refuses to make quietly
 *
 * **Session durability (spec §14.9, a release blocker).** R-01 §6 verified live that a session's
 * state is, by default, one JSONL file at `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/<id>.jsonl`
 * inside the sandbox. A `sessionStore` is a *mirror*, not a replacement, and its writes are
 * best-effort: 3 attempts, then the batch is dropped and a `system/mirror_error` event is
 * emitted while the run carries on. So {@link ClaudeRun.sessionDurability} answers `durable:
 * true` only because a scenario passed — a store was supplied, its `append()` calls were
 * observed to resolve, the stream ran to a `result`, and no batch was dropped. Every other
 * answer is `durable: false` **with the reason named** (ADR-0015).
 *
 * **The tenant skill surface (R-01 contradiction 6) — narrowed here, not closed.** Three separate
 * facts, and only the first is fixed by this file:
 *
 *   - `settingSources: []` does *not* empty the surface. R-01's probe 2 ran with
 *     `settingSources: []` and `system/init` still reported the bundled Claude Code skills.
 *     `skills` is the lever, so a compiled options object that omits `skills` does not mean "no
 *     opinion", it means "the tenant's agent inherits whatever the CLI bundles" — and
 *     {@link toSdkOptions} rejects it rather than forwarding it. Same for `tools`, which is the
 *     field that actually restricts (R-01 §10).
 *   - `skills: []` closes only the **model-invoked** path: the `Skill` tool refuses a name that is
 *     not on the list. **User-typed `/name` dispatch is not closed by any option value** — R-01 §8
 *     says so ("*A skills allowlist is therefore not a security boundary for user-typed
 *     prompts*"), and this task probed it: with `skills: []` compiled from
 *     `{ mode: 'allowlist', names: [] }`, a tenant prompt of `/dataviz` still loaded that bundled
 *     skill. {@link startRun} passes the tenant's `prompt` straight to `query()`, so the tenant
 *     controls that path. Closing it needs prompt-level dispatch filtering, which this platform
 *     does not have; it is an open spec §7/§25 item and a declared gap on this task's PR, not
 *     something this file may claim.
 *   - `system/init.skills` is **insensitive** to the `skills` option — the same list is reported
 *     with `skills: []` and with `skills: 'all'` — so R-01 §8's advice to "confirm what loaded by
 *     reading `system/init` → `skills`" does not work, and the platform cannot audit its own skill
 *     scoping from the event stream.
 *
 * The evidence for the last two is in the "Evidence" section of
 * `docs/adr/W1-RN-01-session-durability-is-a-verdict.md`.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig as SdkMcpServerConfig,
  type Options as SdkOptions,
  type SDKMessage,
  type SessionStore,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { classifySdkEvent, type ClassifiedSdkEvent } from '@agent-workspace/run-protocol';
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import {
  EngineRefusalError,
  executeRunSkillScript,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptToolDescription,
  type SessionDurabilityVerdict,
  type SkillScriptSetup,
} from '@agent-workspace/engine';

import type { ClaudeApprovalGate, CompiledMcpServerConfig, CompiledSdkOptions } from './options.js';
import { claudeSessionScope } from './scope.js';
import {
  CLAUDE_SEARCH_FILES_INPUT,
  executeFileSearch,
  type FileSearchSetup,
  SEARCH_FILES_DESCRIPTION,
  SEARCH_FILES_TOOL,
} from './file-search.js';
import {
  CLAUDE_HANDOFF_INPUT,
  HANDOFF_DESCRIPTION,
  HANDOFF_RESULT_TEXT,
  HANDOFF_TOOL,
  type RecordedHandoff,
} from './handoff.js';
import {
  CLAUDE_SKILL_SCRIPT_INPUT,
  CLAUDE_SKILL_SCRIPT_SERVER,
  nodeSkillScriptHost,
} from './skill-script.js';

/** Name a value in a rejection message without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  return `a value of type ${typeof value}`;
}

/** The message of a thrown value, without assuming it is an `Error`. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return `non-Error thrown: ${describe(error)}`;
}

// ── 1. Translation: CompiledSdkOptions → the SDK's Options ──────────────────────────────

/**
 * One `mcpServers` entry, translated.
 *
 * Total by construction and it says what it rejects. The two arms are discriminated on `type`,
 * with `undefined` folded into the stdio arm because R-01 §9 records `type` as optional there
 * and only there. Anything else — including the `streamable-http` alias that `McpServerConfig`
 * in `packages/core` normalises away on save — is refused by name rather than passed through to
 * a `query()` call that would fail somewhere less legible.
 */
function toSdkMcpServer(name: string, config: CompiledMcpServerConfig): SdkMcpServerConfig {
  const type = config.type;
  if (type === 'http' || type === 'sse') {
    return {
      type,
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
      ...(config.tools === undefined
        ? {}
        : {
            tools: config.tools.map((tool) => ({
              name: tool.name,
              ...(tool.permission_policy === undefined
                ? {}
                : { permission_policy: tool.permission_policy }),
              ...(tool.org_max_permission === undefined
                ? {}
                : { org_max_permission: tool.org_max_permission }),
            })),
          }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
      ...(config.alwaysLoad === undefined ? {} : { alwaysLoad: config.alwaysLoad }),
    };
  }
  if (type === 'stdio' || type === undefined) {
    return {
      type: 'stdio',
      command: config.command,
      ...(config.args === undefined ? {} : { args: [...config.args] }),
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout }),
      ...(config.alwaysLoad === undefined ? {} : { alwaysLoad: config.alwaysLoad }),
    };
  }
  // Not reachable from `CompiledMcpServerConfig` today; reached the moment the union grows and
  // this function does not. A silent pass-through here is a connector the platform believes it
  // configured and the SDK did something else with.
  const unhandled: never = type;
  throw new EngineRefusalError(
    'engine_policy_invalid',
    `mcpServers[${JSON.stringify(name)}] declares transport ${describe(unhandled)}, which this SDK boundary does not translate.`,
  );
}

function toSdkMcpServers(
  servers: CompiledSdkOptions['mcpServers'],
): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) out[name] = toSdkMcpServer(name, config);
  return out;
}

/**
 * A real string array, checked element by element.
 *
 * `Array.isArray` alone is not enough here for two separate reasons, and they point the same
 * way. Statically it narrows to `any[]`, which spreads into the SDK's `string[]` unchecked —
 * the lint rule that objects to that is right to. Dynamically, the value crossing this boundary
 * came from a database row via a plain structural type, so "it is an array" is not "it is an
 * array of strings". ADR-0015: parse before you compare.
 */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/**
 * `tools` — the SDK field that decides what the model can see at all (R-01 §10).
 *
 * `undefined` is rejected, not defaulted. Spec §6's mapping table says "Tool permissions →
 * `allowedTools`", and R-01 §10 established that `allowedTools` only *auto-approves*; omitting
 * `tools` hands the run the SDK's own default surface, which for a multi-tenant control plane
 * is the permissive branch taken because nothing objected. `CompiledSdkOptions` types the key
 * as optional; this boundary is stricter than the type on purpose, and the ADR says so.
 */
function toSdkTools(tools: CompiledSdkOptions['tools']): NonNullable<SdkOptions['tools']> {
  if (tools === undefined) {
    throw new EngineRefusalError(
      'engine_policy_invalid',
      'the compiled options carry no `tools`. Omitting it gives the run the SDK\'s default tool surface rather than the agent\'s configured one; emit an explicit list, or { type: "preset", preset: "claude_code" } (R-01 §10).',
    );
  }
  if (isStringArray(tools)) return [...tools];
  if (tools.type === 'preset' && tools.preset === 'claude_code') {
    return { type: 'preset', preset: 'claude_code' };
  }
  throw new EngineRefusalError(
    'engine_policy_invalid',
    'the compiled options carry a `tools` value this boundary cannot translate: expected an array of tool rules, or { type: "preset", preset: "claude_code" }.',
  );
}

/**
 * `skills` — the only lever that narrows a tenant's skill surface, and it narrows one path of two.
 *
 * `undefined` is rejected for the reason in this file's header: `settingSources` does not empty
 * the surface, so "no `skills` key" is not "no skills", it is "the bundled Claude Code skills,
 * plus whatever `settingSources` loaded". Spec §7 and §25 assume otherwise.
 *
 * What an explicit value buys is bounded, and the rejection message says so rather than letting
 * the caller infer a closed surface: `[]` makes the `Skill` **tool** refuse every name, and does
 * nothing about a tenant prompt that dispatches `/name` directly (R-01 §8, re-probed by this
 * task). Neither this function nor any other option value closes that path.
 */
function toSdkAgents(
  agents: NonNullable<CompiledSdkOptions['agents']>,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => {
      // Assigned by name, not spread: a spread escapes the excess-property check, so an SDK
      // rename of an optional field would be dropped silently instead of failing the build.
      const definition: AgentDefinition = { description: agent.description, prompt: agent.prompt };
      if (agent.model !== undefined) definition.model = agent.model;
      if (agent.disallowedTools !== undefined) {
        definition.disallowedTools = [...agent.disallowedTools];
      }
      return [name, definition];
    }),
  );
}

function toSdkSkills(skills: CompiledSdkOptions['skills']): NonNullable<SdkOptions['skills']> {
  if (skills === undefined) {
    throw new EngineRefusalError(
      'engine_policy_invalid',
      "the compiled options carry no `skills`. settingSources does not empty a tenant's skill surface — R-01's probe 2 ran with settingSources: [] and still loaded the bundled Claude Code skills — so an absent `skills` key silently grants them. Emit 'all' or an explicit allowlist (which may be []). Note what [] does and does not buy: it closes the model-invoked Skill tool, and it does NOT close user-typed /name dispatch, which no option value closes (R-01 §8).",
    );
  }
  if (skills === 'all') return 'all';
  if (isStringArray(skills)) return [...skills];
  throw new EngineRefusalError(
    'engine_policy_invalid',
    `\`skills\` must be 'all' or an array of names; got ${describe(skills)}.`,
  );
}

// ── The exported surface: platform-owned types only ──────────────────────────────────────

/**
 * The key the SDK hands a transcript mirror for one session.
 *
 * Restated here rather than re-exported from the SDK. See this file's header: a type that
 * travels out on an exported signature puts the SDK back into every consumer's type-check, which
 * is the thing §42 exists to prevent. The field list is the SDK's `SessionKey`, and
 * {@link instrumentSessionStore} makes the compiler check that the two stay interchangeable.
 */
export type TranscriptKey = {
  /** Spec §25's tenant key. Set from `CLAUDE_CODE_PROJECT_DIR_NAME`; never the default cwd. */
  projectKey: string;
  sessionId: string;
  /** Absent for the main transcript; set for a subagent's. Opaque — use it as a key suffix. */
  subpath?: string;
};

/** One JSONL transcript line as a mirror observes it. The SDK's `SessionStoreEntry`, restated. */
export type TranscriptEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [field: string]: unknown;
};

/** The SDK's `SessionSummaryEntry`, restated. `data` is SDK-owned and must be stored verbatim. */
type TranscriptSessionSummary = {
  sessionId: string;
  mtime: number;
  data: Record<string, unknown>;
};

/**
 * The durable transcript mirror of spec §20 — the SDK's `SessionStore`, restated in
 * platform-owned types.
 *
 * `append` and `load` are required; the rest are optional in the SDK and stay optional here, so
 * an adapter that implements only the required pair is accepted by both. A caller supplies one of
 * these **without importing the SDK**: that is the §42 claim exercised rather than asserted, and
 * the live probe in `docs/adr/W1-RN-01-session-durability-is-a-verdict.md` is a caller that does
 * exactly that with a ten-line plain object.
 */
export type TranscriptMirror = {
  append(key: TranscriptKey, entries: TranscriptEntry[]): Promise<void>;
  load(key: TranscriptKey): Promise<TranscriptEntry[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries?(projectKey: string): Promise<TranscriptSessionSummary[]>;
  delete?(key: TranscriptKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

/**
 * The translated options object, as everything outside this file is allowed to see it.
 *
 * Deliberately **not** the SDK's `Options`. Naming that type here would re-export the SDK's
 * declarations to every consumer of this module (see the header). Nothing outside this file may
 * call `query()`, so nothing outside this file needs a value that is assignable to `Options`;
 * what a caller or a test wants from this function is to read the keys it produced, and
 * `Readonly<Record<string, unknown>>` is exactly that. The compiler still checks the real shape —
 * {@link buildSdkOptions}, module-private, is annotated with the SDK type.
 */
type TranslatedSdkOptions = Readonly<Record<string, unknown>>;

/** What the runner may add to a compiled options object. Nothing here comes from a tenant. */
export type SdkOptionOverlay = {
  /** Spec §20's durable mirror. Absent means the transcript lives only inside the sandbox. */
  readonly sessionStore?: TranscriptMirror;
  /** Spec §14.3's `POST /interrupt`, and the only cancellation this boundary offers. */
  readonly abortController?: AbortController;
  /** `run_skill_script` (ADR-0137): offered as an in-process MCP server when present. */
  readonly skillScript?: SkillScriptSetup;
  /** `search_files` (ADR-0147): offered on the same in-process MCP server when present. */
  readonly fileSearch?: FileSearchSetup;
  /** ADR-0145's gate and the run state it records into; `canUseTool` is set only when it gates a tool. */
  readonly approval?: { readonly gate: ClaudeApprovalGate; readonly state: ApprovalState };
  /** `handoff_to_person` (ADR-0145 D4): offered on the same in-process MCP server; `record` is called by the tool. */
  readonly handoff?: { readonly record: (handoff: RecordedHandoff) => void };
};

/**
 * The in-process MCP server that carries `run_skill_script`, `search_files` and
 * `handoff_to_person`; the SDK type stays in this file. The run's `signal` stops a running script or
 * search.
 */
function agentWorkspaceServer(
  overlay: Pick<SdkOptionOverlay, 'skillScript' | 'fileSearch' | 'handoff'>,
  signal: AbortSignal | undefined,
): SdkMcpServerConfig {
  const { skillScript, fileSearch, handoff } = overlay;
  return createSdkMcpServer({
    name: CLAUDE_SKILL_SCRIPT_SERVER,
    tools: [
      ...(skillScript === undefined
        ? []
        : [
            tool(
              RUN_SKILL_SCRIPT_TOOL,
              skillScriptToolDescription(skillScript),
              CLAUDE_SKILL_SCRIPT_INPUT.shape,
              async (input) => {
                const { text, isError } = await executeRunSkillScript(
                  nodeSkillScriptHost,
                  skillScript,
                  input,
                  signal,
                );
                return { content: [{ type: 'text' as const, text }], isError };
              },
            ),
          ]),
      ...(fileSearch === undefined
        ? []
        : [
            tool(
              SEARCH_FILES_TOOL,
              SEARCH_FILES_DESCRIPTION,
              CLAUDE_SEARCH_FILES_INPUT.shape,
              async (input) => {
                const { text, isError } = await executeFileSearch(fileSearch, input, signal);
                return { content: [{ type: 'text' as const, text }], isError };
              },
            ),
          ]),
      ...(handoff === undefined
        ? []
        : [
            tool(HANDOFF_TOOL, HANDOFF_DESCRIPTION, CLAUDE_HANDOFF_INPUT.shape, (input) => {
              handoff.record({ reason: input.reason });
              return Promise.resolve({
                content: [{ type: 'text' as const, text: HANDOFF_RESULT_TEXT }],
              });
            }),
          ]),
    ],
  });
}

/**
 * The flag-tier settings a gated run starts with (ADR-0145 D3).
 *
 * `settingSources: ['project']` loads the workspace's `.claude/settings.json`, whose
 * `permissions.allow` rules and hooks can settle a call before `canUseTool` is asked. Each gate is
 * therefore also an `ask` rule, which Claude Code evaluates before every allow rule from any source,
 * and settings hooks are off: Claude Code folds PreToolUse hook decisions as deny > defer > ask >
 * allow but does not document a hook's `allow` as yielding to an `ask` rule. The flag tier outranks
 * project settings, so the workspace cannot turn either back.
 */
function gatedRunSettings(requireApproval: readonly string[]): Settings {
  return { permissions: { ask: [...requireApproval] }, disableAllHooks: true };
}

/**
 * Translate the compile step's output into the SDK's `Options`.
 *
 * Module-private, and annotated with the SDK's own type on purpose: this is where the compiler
 * checks the *types*, the assertion `packages/core` cannot make. `tests/sdk-surface.test.ts`
 * checks the compiled *key names* against the shipped `sdk.d.ts` as text; this function is what
 * makes the SDK renaming or reshaping a field stop this file from compiling, which is exactly
 * what §42 asks the boundary to buy. {@link toSdkOptions} is the same function with the SDK type
 * taken off the exported signature.
 */
function buildSdkOptions(compiled: CompiledSdkOptions, overlay: SdkOptionOverlay): SdkOptions {
  const { approval } = overlay;
  const canUseTool: CanUseTool | undefined =
    approval === undefined || approval.gate.requireApproval.length === 0
      ? undefined
      : (toolName, input, { toolUseID }) =>
          Promise.resolve(
            decideToolPermission(approval.gate, approval.state, toolName, input, toolUseID),
          );
  return {
    cwd: compiled.cwd,
    // R-01 §3's first trap: `env` REPLACES the subprocess environment. `compiled.env` is
    // already the complete environment `packages/core` decided on — including the two session
    // scope variables — so nothing is merged in here.
    env: { ...compiled.env },
    settingSources: [...compiled.settingSources],
    strictMcpConfig: compiled.strictMcpConfig,
    mcpServers: {
      ...toSdkMcpServers(compiled.mcpServers),
      ...(overlay.skillScript === undefined &&
      overlay.fileSearch === undefined &&
      overlay.handoff === undefined
        ? {}
        : {
            [CLAUDE_SKILL_SCRIPT_SERVER]: agentWorkspaceServer(
              overlay,
              overlay.abortController?.signal,
            ),
          }),
    },
    permissionMode: compiled.permissionMode,
    allowedTools: [...compiled.allowedTools],
    disallowedTools: [...compiled.disallowedTools],
    tools: toSdkTools(compiled.tools),
    skills: toSdkSkills(compiled.skills),
    ...(compiled.agents === undefined ? {} : { agents: toSdkAgents(compiled.agents) }),
    ...(compiled.model === undefined ? {} : { model: compiled.model }),
    ...(compiled.systemPrompt === undefined ? {} : { systemPrompt: { ...compiled.systemPrompt } }),
    ...(compiled.maxTurns === undefined ? {} : { maxTurns: compiled.maxTurns }),
    ...(compiled.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: compiled.maxBudgetUsd }),
    ...(compiled.sessionId === undefined ? {} : { sessionId: compiled.sessionId }),
    ...(compiled.resume === undefined ? {} : { resume: compiled.resume }),
    ...(compiled.forkSession === undefined ? {} : { forkSession: compiled.forkSession }),
    ...(compiled.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: compiled.allowDangerouslySkipPermissions }),
    ...(compiled.outputFormat === undefined
      ? {}
      : {
          outputFormat: { type: 'json_schema', schema: { ...compiled.outputFormat.schema } },
        }),
    ...(overlay.sessionStore === undefined ? {} : { sessionStore: overlay.sessionStore }),
    ...(overlay.abortController === undefined ? {} : { abortController: overlay.abortController }),
    ...(canUseTool === undefined || approval === undefined
      ? {}
      : { canUseTool, settings: gatedRunSettings(approval.gate.requireApproval) }),
  };
}

/**
 * {@link buildSdkOptions}, with the SDK's `Options` taken off the signature.
 *
 * Exported so a unit test can read what the translation produced without importing the SDK to do
 * it. See {@link TranslatedSdkOptions} for why the return type is what it is.
 */
export function toSdkOptions(
  compiled: CompiledSdkOptions,
  overlay: SdkOptionOverlay = {},
): TranslatedSdkOptions {
  return buildSdkOptions(compiled, overlay);
}

/**
 * The failure a run ends with when the SDK gave up getting an answer that matches the requested
 * schema, or `null` for any other event (ADR-0143). The message is fixed: it never repeats the
 * schema or model text.
 */
export function structuredOutputFailure(event: ClassifiedSdkEvent): Error | null {
  if (event.kind !== 'result' || event.subtype !== 'error_max_structured_output_retries') {
    return null;
  }
  return new Error(
    'output_schema_unsatisfied: the model could not produce an answer that matches the requested output schema.',
  );
}

// ── 2. Durability: an answer that is only ever `true` because something passed ───────────

/**
 * Whether this run's conversation survives the sandbox (spec §14.9, §20).
 *
 * The type itself is `@agent-workspace/engine`'s {@link SessionDurabilityVerdict} — ENG-04 moved
 * it to the port, because "can this conversation be resumed after the sandbox is gone?" is a
 * question every engine has to answer and not a Claude one. The alias is kept so this module's
 * existing consumers read the same name they always did.
 *
 * Two arms, and the `false` arm always carries a sentence. There is no "probably fine": §14.9
 * calls a session that lives only in `CLAUDE_CONFIG_DIR` a release blocker, so the platform
 * must be able to say *which* runs it may offer a resume for and which it may not.
 */
export type SessionDurability = SessionDurabilityVerdict;

/** The call a run stopped on. The tool's arguments appear only in `canonicalCall`, never in a message. */
export type ApprovalRequest = {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly canonicalCall: string;
};

/**
 * What the approval gate remembers about one run. `consumed` holds single use within this
 * execution; across executions the control plane holds it, by stamping the continuation's approvals
 * consumed when the run starts and never queueing it again (ADR-0151). The gateway keeps its own
 * durable record per call (`runs.consumed_tool_calls`, ADR-0145 D2.1), because it runs the write.
 */
export type ApprovalState = {
  readonly consumed: Set<string>;
  request: ApprovalRequest | null;
};

type PermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: true };

/**
 * `canUseTool`, as a pure decision (ADR-0145 D2.1, D5). Only reached for a call no `allowedTools`
 * rule or `disallowedTools` rule already settled.
 *
 * A gated call runs only when its exact canonical text was approved, and each approval is good for
 * one call. A gated call that is not approved records itself and denies with `interrupt`, which ends
 * the run; the first one wins, because the model may issue several in one turn. A call to a tool the
 * gate does not name is denied, except for the `deferred` auto-approvals `splitApprovals` moved out of
 * `allowedTools`, which are allowed here — unscoped ones only: this decision reads the tool name, so a
 * scoped rule such as `Edit(//ws/**)` allowing here would allow the tool over every path.
 */
export function decideToolPermission(
  gate: ClaudeApprovalGate,
  state: ApprovalState,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
): PermissionDecision {
  if (!needsApproval(gate.requireApproval, toolName)) {
    const unscoped = gate.deferred.filter((rule) => !rule.includes('('));
    return needsApproval(unscoped, toolName)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `${toolName} is not allowed by this agent's tool policy.` };
  }
  let call: string;
  try {
    call = canonicalCall(toolName, input);
  } catch {
    return {
      behavior: 'deny',
      message: `approval_required: the arguments of ${toolName} are not JSON, so the call cannot be approved.`,
    };
  }
  if (gate.approvedToolCalls.includes(call)) {
    if (state.consumed.has(call)) {
      return {
        behavior: 'deny',
        message: `approval_already_used: the approval for this ${toolName} call was already used.`,
      };
    }
    state.consumed.add(call);
    return { behavior: 'allow', updatedInput: input };
  }
  if (gate.approvedToolCalls.length > 0) {
    return {
      behavior: 'deny',
      message: `approval_call_mismatch: ${toolName} was called with arguments nobody approved.`,
    };
  }
  state.request ??= { toolName, toolUseId, canonicalCall: call };
  return {
    behavior: 'deny',
    interrupt: true,
    message: `approval_required: ${toolName} needs a person's approval before it runs.`,
  };
}

type RunState = {
  readonly approval: ApprovalState;
  /** The first `handoff_to_person` call of the run; later calls are ignored. */
  handoff: RecordedHandoff | null;
  readonly storeConfigured: boolean;
  appendsSettled: number;
  appendsInFlight: number;
  readonly appendFailures: string[];
  readonly mirrorErrors: string[];
  sawResult: boolean;
  exhausted: boolean;
  failure: string | null;
};

function newRunState(storeConfigured: boolean): RunState {
  return {
    approval: { consumed: new Set(), request: null },
    handoff: null,
    storeConfigured,
    appendsSettled: 0,
    appendsInFlight: 0,
    appendFailures: [],
    mirrorErrors: [],
    sawResult: false,
    exhausted: false,
    failure: null,
  };
}

/**
 * Read a `system/mirror_error` envelope without trusting its shape.
 *
 * R-01 §4 records that the SDK emits fields the `.d.ts` does not declare, so the envelope is
 * parsed defensively rather than cast. What matters is that a batch was dropped; the text is
 * for the operator.
 */
function describeMirrorError(event: Record<string, unknown>): string {
  const error = typeof event['error'] === 'string' ? event['error'] : 'no error text';
  const key = event['key'];
  if (typeof key !== 'object' || key === null || Array.isArray(key)) return error;
  const record = key as Record<string, unknown>;
  const projectKey = typeof record['projectKey'] === 'string' ? record['projectKey'] : '?';
  const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : '?';
  const subpath = typeof record['subpath'] === 'string' ? `/${record['subpath']}` : '';
  return `${projectKey}/${sessionId}${subpath}: ${error}`;
}

/**
 * The durability verdict for a finished run.
 *
 * Read this as one long "no, because …" list ending in a single "yes, and here is the evidence".
 * ADR-0015: the run is durable because a scenario passed — a store was configured, its writes
 * were observed to resolve, none was dropped, and the stream reached a `result` — never because
 * no failure was seen.
 */
function verdict(state: RunState): SessionDurability {
  if (!state.exhausted) {
    return {
      durable: false,
      reason:
        'the event stream has not been exhausted. Durability is asserted about a completed run; a stream still open, or abandoned by the consumer before it ended, may have transcript batches that were never mirrored.',
    };
  }
  if (state.failure !== null) {
    return { durable: false, reason: `the run stream ended in an error: ${state.failure}` };
  }
  if (!state.storeConfigured) {
    return {
      durable: false,
      reason:
        'no sessionStore was supplied, so this session exists only as <CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sessionId>.jsonl inside the sandbox (R-01 §6, verified live). Spec §14.9: destroying the sandbox destroys the conversation, and the session id in Postgres is not enough to resume it.',
    };
  }
  if (state.mirrorErrors.length > 0) {
    return {
      durable: false,
      reason: `the SDK emitted ${String(state.mirrorErrors.length)} system/mirror_error event(s): a batch of transcript entries was dropped after 3 attempts and has no surviving copy in the store. First: ${state.mirrorErrors[0] ?? '(none recorded)'}`,
    };
  }
  if (state.appendFailures.length > 0) {
    return {
      durable: false,
      reason: `${String(state.appendFailures.length)} sessionStore.append() call(s) rejected. The SDK retries, but a run whose mirror rejected cannot be claimed durable. First: ${state.appendFailures[0] ?? '(none recorded)'}`,
    };
  }
  if (state.appendsInFlight > 0) {
    return {
      durable: false,
      reason: `${String(state.appendsInFlight)} sessionStore.append() call(s) were still in flight when the stream ended; their outcome is unknown.`,
    };
  }
  if (!state.sawResult) {
    return {
      durable: false,
      reason:
        "the stream ended without a 'result' event, so the run did not reach a terminal state and the transcript may be incomplete.",
    };
  }
  if (state.appendsSettled === 0) {
    return {
      durable: false,
      reason:
        'a sessionStore was configured but it received no append() call, so nothing about this session was mirrored out of the sandbox.',
    };
  }
  return { durable: true, mirroredBatches: state.appendsSettled };
}

/**
 * Both directions of "{@link TranscriptMirror} and the SDK's `SessionStore` are the same type".
 *
 * The alias resolves to `A` when each type is assignable to the other, and to `never` otherwise —
 * so writing `SameShapeAs<TranscriptMirror, SessionStore>` in a signature *is* `TranscriptMirror`
 * plus a proof, and a divergence collapses the parameter to `never`, at which point the one call
 * site below stops compiling. (Mutual `extends` clauses on the type parameters themselves would
 * read better and are rejected as a circular constraint; the bracketed `[A] extends [B]` form
 * also stops the check distributing over a union.)
 *
 * It has to be checked somewhere, because the platform type is hand-copied from the SDK's: if a
 * patch release adds a required method to `SessionStore`, or if someone narrows
 * {@link TranscriptMirror} so a legitimate adapter no longer satisfies it, this file must stop
 * compiling rather than diverge quietly. It is deliberately **not** exported — an exported alias
 * naming `SessionStore` would put the SDK straight back into the emitted `.d.ts`, which is the
 * defect this whole arrangement exists to fix.
 */
type SameShapeAs<A, B> = [A] extends [B] ? ([B] extends [A] ? A : never) : never;

/**
 * Wrap the caller's store so the boundary can *observe* the mirror rather than assume it.
 *
 * Methods are bound rather than spread: `{ ...store }` copies own enumerable properties only,
 * which silently drops the prototype methods of a class-based adapter (the SDK's own
 * `InMemorySessionStore` is one) and produces a store that throws on first use.
 *
 * `append` re-throws. The SDK owns the retry policy and the `mirror_error` it emits after the
 * third failure; swallowing the rejection here would convert a dropped batch into a silent one.
 */
function instrumentSessionStore(
  store: SameShapeAs<TranscriptMirror, SessionStore>,
  state: RunState,
): SessionStore {
  const append = store.append.bind(store);
  const load = store.load.bind(store);
  const listSessions = store.listSessions?.bind(store);
  const listSessionSummaries = store.listSessionSummaries?.bind(store);
  const remove = store.delete?.bind(store);
  const listSubkeys = store.listSubkeys?.bind(store);
  return {
    async append(key, entries) {
      state.appendsInFlight += 1;
      try {
        await append(key, entries);
        state.appendsSettled += 1;
      } catch (error) {
        state.appendFailures.push(describeError(error));
        throw error;
      } finally {
        state.appendsInFlight -= 1;
      }
    },
    load,
    ...(listSessions === undefined ? {} : { listSessions }),
    ...(listSessionSummaries === undefined ? {} : { listSessionSummaries }),
    ...(remove === undefined ? {} : { delete: remove }),
    ...(listSubkeys === undefined ? {} : { listSubkeys }),
  };
}

// ── 3. The run ──────────────────────────────────────────────────────────────────────────

/** What the runner supplies around one run. Nothing here is tenant-controlled. */
export type RunDeps = SdkOptionOverlay;

/** One in-flight run. The only thing that crosses this boundary is `ClassifiedSdkEvent`. */
export type ClaudeRun = {
  /**
   * The normalised event stream. Every raw `SDKMessage` has been through `classifySdkEvent`,
   * so an unrecognised `type`/`subtype` arrives as `system-unknown` / `unknown` and is
   * forwarded opaquely (R-01 §4: the union grows in patch releases), while an event that is
   * not an object, or whose discriminant is not a string, arrives as `malformed` with a reason
   * — it is never quietly forwarded as though it had been understood.
   */
  readonly events: AsyncGenerator<ClassifiedSdkEvent, void, void>;
  /** See {@link SessionDurability}. Meaningful once `events` has been exhausted. */
  sessionDurability(): SessionDurability;
  /** The call the run stopped on for want of approval, or `null`. Meaningful once `events` has ended. */
  approvalRequest(): ApprovalRequest | null;
  /** The handoff the model asked for, or `null`. Meaningful once the run's `result` event has arrived. */
  handoff(): RecordedHandoff | null;
  /**
   * Cancel the run. This is `AbortController.abort()`, not `Query.interrupt()`: `interrupt()`
   * is a control request and the SDK supports control requests only in streaming-input mode,
   * which this boundary does not use (spec §5's example passes a string prompt).
   */
  abort(reason?: unknown): void;
};

async function* normalise(
  source: AsyncIterable<SDKMessage>,
  state: RunState,
): AsyncGenerator<ClassifiedSdkEvent, void, void> {
  try {
    for await (const raw of source) {
      const event = classifySdkEvent(raw);
      if (event.kind === 'system' && event.subtype === 'mirror_error') {
        state.mirrorErrors.push(describeMirrorError(event.event));
      } else if (event.kind === 'result' || event.kind === 'result-unknown') {
        state.sawResult = true;
      }
      yield event;
    }
    // Set only here, after the loop drained normally. A consumer that `break`s out leaves this
    // false, and the durability verdict then refuses on "not exhausted" rather than answering
    // from a partial run.
    state.exhausted = true;
  } catch (error) {
    state.exhausted = true;
    state.failure = describeError(error);
    throw error;
  }
}

/** What {@link startRun} needs: the adapter's own compile output, plus what that output omits. */
export type ClaudeRunStart = {
  readonly runId: string;
  readonly projectKey: string;
  readonly prompt: string;
  readonly options: CompiledSdkOptions;
  /** Present when the agent requires approval for some tool (`CompiledClaudeRun.approval`). */
  readonly approval?: ClaudeApprovalGate | undefined;
  /** Present when the agent offers `handoff_to_person` (`CompiledClaudeRun.handoff`). */
  readonly handoff?: true | undefined;
};

/**
 * Start one run from the options `compileRunRequest` produced.
 *
 * The input is the adapter's own compiled output, which `compileRunRequest` already parsed, so
 * nothing is parsed or compiled again here: a second compile could disagree with the one
 * `compile()` approved.
 *
 * The tenant session scope is still asserted, explicitly. This is the check spec §25 rests on
 * and R-01 §7 records that both of the SDK's failure modes here are *silent* — an invalid
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, or one set without `CLAUDE_CONFIG_DIR`, is ignored and the
 * session is keyed under the sanitised `cwd`, colliding with every other tenant on the same
 * workspace path. A check that cannot run must fail; this one runs where the run starts.
 *
 * Throws `Error` on a scope the boundary refuses. There is no partial-success return: a run
 * whose configuration could not be validated must not start, and must not start *with defaults*
 * either.
 */
export function startRun(start: ClaudeRunStart, deps: RunDeps = {}): ClaudeRun {
  // ENG-04b: the scope is *derived* now, from `cwd` and the platform's project key, because the
  // config directory is this engine's own (`./scope.ts`). The assertion is unchanged: the pair the
  // SDK will be given is checked before the run starts, because both of the SDK's failure modes
  // here are silent.
  const scope = claudeSessionScope(start.options.cwd, start.projectKey);
  if (!scope.ok) {
    throw new Error(`refusing to start run ${start.runId}: ${scope.reason}`);
  }

  const state = newRunState(deps.sessionStore !== undefined);
  const abortController = deps.abortController ?? new AbortController();
  const overlay: SdkOptionOverlay = {
    abortController,
    ...(deps.skillScript === undefined ? {} : { skillScript: deps.skillScript }),
    ...(deps.fileSearch === undefined ? {} : { fileSearch: deps.fileSearch }),
    ...(deps.sessionStore === undefined
      ? {}
      : { sessionStore: instrumentSessionStore(deps.sessionStore, state) }),
    ...(start.approval === undefined
      ? {}
      : { approval: { gate: start.approval, state: state.approval } }),
    ...(start.handoff === undefined
      ? {}
      : {
          handoff: {
            record: (handoff) => {
              state.handoff ??= handoff;
            },
          },
        }),
  };

  // `buildSdkOptions`, not the exported `toSdkOptions`: `query()` needs the value at the SDK's
  // own `Options` type, and the export deliberately no longer carries it.
  //
  // `start.prompt` reaches `query()` unfiltered. That is what makes user-typed `/name` skill
  // dispatch a tenant-controlled path this boundary does not close — see the header's third
  // skill-surface bullet, and the declared gap on this task's PR.
  const session = query({
    prompt: start.prompt,
    options: buildSdkOptions(start.options, overlay),
  });

  return {
    events: normalise(session, state),
    sessionDurability: () => verdict(state),
    approvalRequest: () => state.approval.request,
    handoff: () => state.handoff,
    abort: (reason?: unknown) => {
      abortController.abort(reason);
    },
  };
}
