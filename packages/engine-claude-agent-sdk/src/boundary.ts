import { randomUUID } from 'node:crypto';

import {
  describe,
  describeError,
  type SessionDurability,
  type RunState,
  newRunState,
  observeSdkEvent,
  verdict,
} from './run-state.js';
export type { SessionDurability } from './run-state.js';
import { type ApprovalRequest, type ApprovalState, decideToolPermission } from './permissions.js';
export { type ApprovalRequest, type ApprovalState, decideToolPermission } from './permissions.js';
/**
 * The sole Claude Agent SDK import boundary. Public signatures use platform-owned types;
 * tests/no-sdk-import.test.ts also verifies the emitted declarations.
 *
 * Compiled tools and skills must be explicit. A skill allowlist restricts model-invoked tools,
 * but cannot restrict user-typed slash commands or reveal loaded skills through system/init
 * (docs/adr/W1-RN-01-session-durability-is-a-verdict.md).
 * A transcript mirror proves durability only after successful writes and a completed stream.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type CanUseTool,
  type McpServerConfig as SdkMcpServerConfig,
  type Options as SdkOptions,
  type SessionStore,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { classifySdkEvent, type ClassifiedSdkEvent } from '@agent-workspace/run-protocol';

import {
  EngineRefusalError,
  executeRunSkillScript,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptToolDescription,
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

function toSdkMcpTool(tool: import('./options.js').CompiledMcpToolPolicy) {
  return {
    name: tool.name,
    ...(tool.permission_policy === undefined ? {} : { permission_policy: tool.permission_policy }),
    ...(tool.org_max_permission === undefined
      ? {}
      : { org_max_permission: tool.org_max_permission }),
  };
}

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
            tools: config.tools.map(toSdkMcpTool),
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
 * The flag-tier settings a run with a stored gate starts with (ADR-0145 D3).
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
          outputFormat: {
            type: 'json_schema',
            schema: withoutMetaSchema(compiled.outputFormat.schema),
          },
        }),
    ...(overlay.sessionStore === undefined ? {} : { sessionStore: overlay.sessionStore }),
    ...(overlay.abortController === undefined ? {} : { abortController: overlay.abortController }),
    ...(canUseTool === undefined || approval === undefined ? {} : { canUseTool }),
    // Only a stored gate is also an `ask` rule; Run commands' own rule is not (#2091, `ask`).
    ...(approval === undefined || approval.gate.ask.length === 0
      ? {}
      : { settings: gatedRunSettings(approval.gate.ask) }),
  };
}

/**
 * A copy of a run's output schema without its top-level `$schema`. ADR-0143 fixes the dialect at
 * draft 2020-12 and lets a schema name it (`z.toJSONSchema` does), but Claude Code's `--json-schema`
 * validator loads no 2020-12 meta-schema and refuses a schema that references it ("no schema with
 * key or ref"), ending the run before the model is asked. The dialect is already settled by the
 * contract, so the reference carries nothing the CLI needs.
 */
function withoutMetaSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema };
  delete copy['$schema'];
  return copy;
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

/**
 * How long the SDK's stream may stay open after the run's `result` before the run ends without
 * it. With a string prompt the `result` is the CLI's last message, and the stream closes as the
 * CLI exits; a CLI that lingers instead (for example on a connection to an MCP server it never
 * finishes closing) would otherwise hold the run open until its credential expires (issue #2076).
 */
export const RESULT_LINGER_MS = 5_000;

/** What {@link normalise} does when the stream lingers past its `result`. */
export type ResultLinger = {
  /** {@link RESULT_LINGER_MS} outside tests. */
  readonly ms: number;
  /** Stop the SDK and its CLI: the run's abort. */
  readonly abort: (reason: Error) => void;
};

const LINGERED = Symbol('lingered');

/** `next`, or {@link LINGERED} when it has not settled within `ms`. */
async function within<T>(next: Promise<T>, ms: number): Promise<T | typeof LINGERED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof LINGERED>((resolve) => {
    timer = setTimeout(() => {
      resolve(LINGERED);
    }, ms);
  });
  try {
    return await Promise.race([next, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SDK's messages, each through `classifySdkEvent`. Once a `result` has arrived, a stream that
 * does not end within `linger.ms` is ended here: the SDK is aborted, and the run ends with the
 * result it reached, as though the stream had drained.
 */
export function normalise(
  source: AsyncIterable<unknown>,
  linger: ResultLinger,
  state: RunState = newRunState(false),
): AsyncGenerator<ClassifiedSdkEvent, void, void> {
  return normaliseInto(source, linger, state);
}

/**
 * {@link normalise} with the rest of what {@link startRun} wires around it: `mirror` instrumented
 * as the SDK's `sessionStore`, and the durability verdict over both. `startRun` hands the
 * instrumented store to `query()`; a test calls its `append` itself, as the SDK would.
 */
export function normaliseMirrored(
  source: AsyncIterable<unknown>,
  linger: ResultLinger,
  mirror: TranscriptMirror,
): {
  readonly events: AsyncGenerator<ClassifiedSdkEvent, void, void>;
  readonly sessionStore: TranscriptMirror;
  readonly sessionDurability: () => SessionDurability;
} {
  const state = newRunState(true);
  return {
    events: normaliseInto(source, linger, state),
    sessionStore: instrumentSessionStore(mirror, state),
    sessionDurability: () => verdict(state),
  };
}

/**
 * A `system/permission_denied` message for each call `canUseTool` refused by policy since the last
 * one, in the SDK's own shape (`SDKPermissionDeniedMessage`). The SDK sends this message when it
 * refuses a call itself; it sends nothing when `canUseTool` refuses, so without this a run whose
 * gate exists (#2091) would lose the console's "did not run" notice (#2207). Reported before the
 * next SDK message, which is the refused call's tool result. `session_id` is the one the SDK's own
 * messages carry.
 */
function* deniedEvents(state: RunState, next: unknown): Generator<ClassifiedSdkEvent> {
  const calls = state.approval.denied.splice(0);
  if (calls.length === 0) return;
  const record = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : {};
  const sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : '';
  for (const call of calls) {
    yield classifySdkEvent({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: call.toolName,
      tool_use_id: call.toolUseId,
      decision_reason_type: 'rule',
      message: call.message,
      uuid: randomUUID(),
      session_id: sessionId,
    });
  }
}

async function* normaliseInto(
  source: AsyncIterable<unknown>,
  linger: ResultLinger,
  state: RunState,
): AsyncGenerator<ClassifiedSdkEvent, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  let open = true;
  try {
    for (;;) {
      const next = iterator.next();
      const step = state.sawResult ? await within(next, linger.ms) : await next;
      if (step === LINGERED) {
        // The pending read settles (or rejects) once the abort reaches the SDK; nobody awaits it.
        next.catch(() => undefined);
        state.lingered = true;
        linger.abort(
          new Error(`the SDK stream stayed open ${String(linger.ms)} ms after the run's result`),
        );
        break;
      }
      if (step.done === true) {
        open = false;
        break;
      }
      yield* deniedEvents(state, step.value);
      const event = classifySdkEvent(step.value);
      observeSdkEvent(state, event);
      yield event;
    }
    yield* deniedEvents(state, undefined);
    // Set only here, after the loop drained normally or lingered past its `result`. A consumer
    // that `break`s out leaves this false, and the durability verdict then refuses on "not
    // exhausted" rather than answering from a partial run. A lingered stream is over for the run,
    // but `state.lingered` keeps the verdict from reading it as drained.
    state.exhausted = true;
  } catch (error) {
    open = false;
    state.exhausted = true;
    state.failure = describeError(error);
    throw error;
  } finally {
    // What `for await` does on an early exit: close the source. Not awaited, since a source that
    // lingered may answer `return()` only after its pending read.
    if (open) iterator.return?.().catch(() => undefined);
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
    events: normaliseInto(
      session,
      {
        ms: RESULT_LINGER_MS,
        abort: (reason) => {
          abortController.abort(reason);
        },
      },
      state,
    ),
    sessionDurability: () => verdict(state),
    approvalRequest: () => state.approval.request,
    handoff: () => state.handoff,
    abort: (reason?: unknown) => {
      abortController.abort(reason);
    },
  };
}
