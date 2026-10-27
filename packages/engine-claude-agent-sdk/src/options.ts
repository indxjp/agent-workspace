/**
 * The Claude Agent SDK's `Options`, as a plain structural type (spec §5).
 *
 * Moved here from `packages/core/src/types.ts` by ENG-04 (#303), unchanged. It lived in `core`
 * when the Claude Agent SDK was the only engine and "the compile step" and "the platform" were
 * the same sentence. They are not: this is one engine's option surface, and a second engine's
 * belongs to a second adapter, so a type shaped entirely by `@anthropic-ai/claude-agent-sdk`
 * belongs in the package that owns that SDK.
 *
 * It is still a plain structural type and **not** the SDK's own `Options`, for the §42 reason
 * `./boundary.ts` sets out at length: naming the SDK's type on an exported signature puts the
 * SDK's declarations into every consumer's type-check, which is the thing the boundary exists to
 * prevent. The compiler checks the real shape in exactly one place — `buildSdkOptions` in
 * `./boundary.ts`, which is module-private and annotated with the SDK type — and
 * `tests/sdk-surface.test.ts` checks every key name below against the installed `sdk.d.ts` as
 * text, including its optionality, so an upstream rename breaks a test rather than a run.
 */
import type { SdkSettingSource } from '@agent-workspace/run-protocol';
import type { McpServerRecord, McpToolPolicy } from '@indx-workspace/contracts';
import type { AgentToolPermissionMode } from '@indx-workspace/contracts/agents';

/**
 * `mcpServers` entries (R-01 §9), inferred from the one schema in `@indx-workspace/contracts`. The
 * `sdk` arm of the SDK's union is deliberately absent: it carries a live `McpServer` **instance**,
 * so it is not a thing a database row can hold.
 */
export type CompiledMcpServerConfig = McpServerRecord;

/** `McpServerToolPolicy` (R-01 §9), inferred from the same schema. */
export type CompiledMcpToolPolicy = McpToolPolicy;

/** One `agents` entry (ADR-0133 D14): a subagent the model delegates to through the `Agent` tool. */
export type CompiledSdkAgent = {
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
  readonly disallowedTools?: readonly string[];
};

/**
 * The object spec §5 calls *"compile UI/database settings into Claude Agent SDK options"*.
 *
 * Every key is an `Options` key of the pinned SDK — `tests/sdk-surface.test.ts` asserts each
 * one against the installed `sdk.d.ts` and against `R-01-options.json`, including optionality.
 */
export type CompiledSdkOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly settingSources: readonly SdkSettingSource[];
  readonly strictMcpConfig: boolean;
  readonly mcpServers: Readonly<Record<string, CompiledMcpServerConfig>>;
  readonly permissionMode: AgentToolPermissionMode;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly tools?: readonly string[] | { readonly type: 'preset'; readonly preset: 'claude_code' };
  readonly skills?: readonly string[] | 'all';
  readonly agents?: Readonly<Record<string, CompiledSdkAgent>>;
  readonly model?: string;
  readonly systemPrompt?: {
    readonly type: 'preset';
    readonly preset: 'claude_code';
    readonly append: string;
  };
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly sessionId?: string;
  readonly resume?: string;
  readonly forkSession?: boolean;
  readonly allowDangerouslySkipPermissions?: boolean;
  /** Present only when the run asked for structured output (ADR-0143). */
  readonly outputFormat?: {
    readonly type: 'json_schema';
    readonly schema: Readonly<Record<string, unknown>>;
  };
};

/**
 * What `canUseTool` decides with (ADR-0145). Carried next to {@link CompiledSdkOptions}, never in it:
 * `compiledSdkOptionKeys` must stay exactly the SDK's option keys.
 */
export type ClaudeApprovalGate = {
  /** The `requireApproval` rules: a call to a tool one of them names needs a person's approval. */
  readonly requireApproval: readonly string[];
  /** The `autoApprove` rules moved out of `allowedTools` because they could approve a gated tool. */
  readonly deferred: readonly string[];
  /** The canonical texts of the calls already approved. */
  readonly approvedToolCalls: readonly string[];
};

/**
 * {@link CompiledSdkOptions} plus the approval gate (present only when `requireApproval` is non-empty)
 * and `handoff` (present only when the agent offers `handoff_to_person`).
 */
export type CompiledClaudeRun = CompiledSdkOptions & {
  readonly approval?: ClaudeApprovalGate;
  readonly handoff?: true;
};

/**
 * Every key {@link CompiledSdkOptions} can carry, as data.
 *
 * The surface test iterates this list; a key added to the type but not to this array would be
 * a key the gate never checks against the SDK. `COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE` below
 * makes that a compile error rather than a silent hole.
 */
export const compiledSdkOptionKeys = [
  'cwd',
  'env',
  'settingSources',
  'strictMcpConfig',
  'mcpServers',
  'permissionMode',
  'allowedTools',
  'disallowedTools',
  'tools',
  'skills',
  'agents',
  'model',
  'systemPrompt',
  'maxTurns',
  'maxBudgetUsd',
  'sessionId',
  'resume',
  'forkSession',
  'allowDangerouslySkipPermissions',
  'outputFormat',
] as const satisfies readonly (keyof CompiledSdkOptions)[];
export type CompiledSdkOptionKey = (typeof compiledSdkOptionKeys)[number];

/**
 * Compile-time proof that {@link compiledSdkOptionKeys} lists *every* key of
 * {@link CompiledSdkOptions}.
 *
 * `satisfies` above proves the array contains only real keys; this proves the converse. If a
 * key is added to the type and not to the array, this alias resolves to a tuple naming the
 * missing key and the constant below stops compiling.
 */
export type CompiledSdkOptionKeysAreExhaustive =
  Exclude<keyof CompiledSdkOptions, CompiledSdkOptionKey> extends never
    ? true
    : [
        'missing from compiledSdkOptionKeys:',
        Exclude<keyof CompiledSdkOptions, CompiledSdkOptionKey>,
      ];

/** See {@link CompiledSdkOptionKeysAreExhaustive}. Exported so it is not an unused local. */
export const COMPILED_SDK_OPTION_KEYS_ARE_EXHAUSTIVE: CompiledSdkOptionKeysAreExhaustive = true;
