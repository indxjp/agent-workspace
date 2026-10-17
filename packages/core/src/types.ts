/**
 * `@agent-workspace/core` — the SDK-facing type surface (spec §5, §6, §17).
 *
 * Everything in this file is **transcribed** from
 * the R-01 research note (maintained privately)
 * and its machine-readable companion `R-01-options.json`. Nothing here is invented: R-01 went
 * through three fact-check rounds so that this file would not have to guess an option name, an
 * event name or a field. `tests/sdk-surface.test.ts` re-asserts every constant below against
 * the shipped `sdk.d.ts` of the pinned SDK, so a transcription slip — or an upstream rename —
 * breaks a test rather than production.
 *
 * **This file does not import `@anthropic-ai/claude-agent-sdk`, and must never start.**
 * Spec §42 makes `apps/runner/src/claude.ts` the single import site. The compile step of §5
 * therefore produces a *plain object* whose keys happen to be SDK option names; `claude.ts`
 * passes it through. The price is that TypeScript cannot check our object against the SDK's
 * `Options` type here — which is exactly the hole `tests/sdk-surface.test.ts` fills, by reading
 * the installed `sdk.d.ts` as text.
 */

// ── The event stream (R-01 §4) ──────────────────────────────────────────────────────────

/**
 * Every top-level `type` discriminant of `SDKMessage`, from R-01 §4's table.
 *
 * R-01 §4's implementer rule: **discriminate on `type` first**, then on `subtype` for
 * `system` and `result`.
 */
export const sdkEventTypes = [
  'assistant',
  'user',
  'result',
  'system',
  'stream_event',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
  'prompt_suggestion',
  'conversation_reset',
] as const;
export type SdkEventType = (typeof sdkEventTypes)[number];

/**
 * The `system` subtypes declared by the pinned SDK, in R-01 §4's table order.
 *
 * **This list is open and known to be open.** R-01 §4 records that probe 2 received
 * `system/thinking_tokens` from a run that set no thinking options, and that new subtypes
 * arrive in patch releases. {@link classifySdkEvent} therefore forwards an unrecognised
 * subtype opaquely instead of throwing — see `ClassifiedSdkEvent`'s `system-unknown` arm.
 */
export const sdkSystemSubtypes = [
  'init',
  'compact_boundary',
  'status',
  'api_retry',
  'control_request_progress',
  'model_refusal_fallback',
  'model_refusal_no_fallback',
  'local_command_output',
  'hook_started',
  'hook_progress',
  'hook_response',
  'plugin_install',
  'task_notification',
  'task_started',
  'task_updated',
  'task_progress',
  'background_tasks_changed',
  'thinking_tokens',
  'session_state_changed',
  'worker_shutting_down',
  'commands_changed',
  'notification',
  'files_persisted',
  'memory_recall',
  'elicitation_complete',
  'permission_denied',
  'mirror_error',
  'informational',
] as const;
export type SdkSystemSubtype = (typeof sdkSystemSubtypes)[number];

/** The `result` subtypes (R-01 §4), across the success arm and the error arm. */
export const sdkResultSubtypes = [
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
] as const;
export type SdkResultSubtype = (typeof sdkResultSubtypes)[number];

/**
 * Every named leaf type of the `SDKMessage` union, with `SDKResultMessage` expanded into its
 * two arms rather than carried as the alias (R-01 §4). The union's own membership is asserted
 * against the installed `sdk.d.ts`; the size of this list is not stated here because a number in
 * a comment cannot be checked (ADR-0016).
 *
 * Carried as data rather than as prose so `tests/sdk-surface.test.ts` can assert each one is
 * still declared by the installed `sdk.d.ts`.
 */
export const sdkMessageTypeNames = [
  'SDKAssistantMessage',
  'SDKUserMessage',
  'SDKUserMessageReplay',
  'SDKResultSuccess',
  'SDKResultError',
  'SDKSystemMessage',
  'SDKPartialAssistantMessage',
  'SDKCompactBoundaryMessage',
  'SDKStatusMessage',
  'SDKAPIRetryMessage',
  'SDKControlRequestProgressMessage',
  'SDKModelRefusalFallbackMessage',
  'SDKModelRefusalNoFallbackMessage',
  'SDKLocalCommandOutputMessage',
  'SDKHookStartedMessage',
  'SDKHookProgressMessage',
  'SDKHookResponseMessage',
  'SDKPluginInstallMessage',
  'SDKToolProgressMessage',
  'SDKAuthStatusMessage',
  'SDKTaskNotificationMessage',
  'SDKTaskStartedMessage',
  'SDKTaskUpdatedMessage',
  'SDKTaskProgressMessage',
  'SDKBackgroundTasksChangedMessage',
  'SDKThinkingTokensMessage',
  'SDKSessionStateChangedMessage',
  'SDKWorkerShuttingDownMessage',
  'SDKCommandsChangedMessage',
  'SDKNotificationMessage',
  'SDKFilesPersistedEvent',
  'SDKToolUseSummaryMessage',
  'SDKMemoryRecallMessage',
  'SDKRateLimitEvent',
  'SDKElicitationCompleteMessage',
  'SDKPermissionDeniedMessage',
  'SDKPromptSuggestionMessage',
  'SDKMirrorErrorMessage',
  'SDKInformationalMessage',
  'SDKConversationResetMessage',
] as const;

/**
 * Whether an event with this `type` discriminant carries the cost figure §35 records per run.
 *
 * `total_cost_usd` is declared on exactly the two `type: 'result'` arms of `SDKMessage`
 * (R-01 §4). Stated as a predicate rather than as a comment so the runner cannot read
 * `total_cost_usd` off an event that never carries one and silently record 0.
 *
 * This is about **cost**, not about the token counters. `usage` is also declared on the
 * `system` / `task_progress` message, which carries no cost figure — so this predicate returning
 * `false` for `'system'` is correct and deliberate.
 *
 * `tests/sdk-surface.test.ts` derives the answer from the installed `sdk.d.ts` — it expands the
 * `SDKMessage` union, collects the `type` discriminant of every arm declaring `total_cost_usd`,
 * and requires this function to agree — so an upstream move of the field breaks a test rather
 * than a billing row. It has no production caller yet; `apps/runner/src/claude.ts` (W1-RN-01) is
 * the intended one.
 */
export function sdkEventCarriesUsage(type: string): boolean {
  return type === 'result';
}

/**
 * The envelope every `SDKMessage` carries (R-01 §4: *"Every member carries `uuid: UUID` and
 * `session_id: string`"*). Kept minimal on purpose: the platform forwards the event body
 * opaquely and reads only what §35's per-run record needs.
 */
export type SdkEventEnvelope = {
  readonly type: string;
  readonly session_id?: unknown;
  readonly uuid?: unknown;
  readonly [key: string]: unknown;
};

/**
 * The result of classifying one raw event off the SDK's iterator.
 *
 * The shape is deliberately **total**. ADR-0015 forbids a classifier that falls through to a
 * pass path when its input is malformed, so there are two distinct "not recognised" arms and
 * they mean different things:
 *
 *   * `system-unknown` / `unknown` — well-formed, but naming a discriminant this build does
 *     not know. R-01 §4 establishes that the union grows in patch releases, so this is the
 *     expected case and the event is **forwarded opaquely**.
 *   * `malformed` — not an object, or missing a discriminant that must be a string. The event
 *     is **rejected and the reason is named**. It is never forwarded as if it were understood.
 */
export type ClassifiedSdkEvent =
  | {
      readonly kind: 'system';
      readonly subtype: SdkSystemSubtype;
      readonly event: SdkEventEnvelope;
    }
  | { readonly kind: 'system-unknown'; readonly subtype: string; readonly event: SdkEventEnvelope }
  | {
      readonly kind: 'result';
      readonly subtype: SdkResultSubtype;
      readonly carriesUsage: true;
      readonly event: SdkEventEnvelope;
    }
  | {
      readonly kind: 'result-unknown';
      readonly subtype: string;
      readonly carriesUsage: true;
      readonly event: SdkEventEnvelope;
    }
  | {
      readonly kind: 'event';
      readonly type: Exclude<SdkEventType, 'system' | 'result'>;
      readonly event: SdkEventEnvelope;
    }
  | { readonly kind: 'unknown'; readonly type: string; readonly event: SdkEventEnvelope }
  | { readonly kind: 'malformed'; readonly reason: string; readonly event: unknown };

/**
 * `ModelUsage` (R-01 §4, condensed from `sdk.d.ts:1307-1333`) — the field the `.d.ts` names as
 * *"the correct field for token/cost accounting"*.
 *
 * Three traps R-01 §4 records and this platform must respect, restated where they will be
 * read: `thinkingTokens` is **already counted inside `outputTokens`**; the record key is not
 * stable, so aggregate on `canonicalModel`; and results are cumulative within one `query()`
 * call, so take the latest and never sum.
 */
export type SdkModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens?: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUSD: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly canonicalModel?: string;
  readonly provider?: string;
  readonly costBasis?: 'list' | 'managed' | 'unknown';
};

/**
 * Whether a `ModelUsage` row may be shown to a user as money.
 *
 * R-01 §4: `costBasis: 'unknown'` means no pricing row matched the model id and `costUSD` is a
 * guess at the *default* model's rate. Spec §12 forbids presenting that as a number, so the
 * answer is a two-arm result and the caller has to handle the unpriced arm — it cannot get a
 * confident `$0.00` by ignoring a flag.
 */
export type RunCostVerdict =
  | { readonly priced: true; readonly costUsd: number; readonly basis: 'list' | 'managed' }
  | { readonly priced: false; readonly reason: string };

// ── Tool permissions (R-01 §3 and §10) ──────────────────────────────────────────────────

/** `SettingSource` (R-01 §3 option 57). */
export const sdkSettingSources = ['user', 'project', 'local'] as const;
export type SdkSettingSource = (typeof sdkSettingSources)[number];

// ── Session identity (R-01 §6, §7) ──────────────────────────────────────────────────────

/**
 * The two environment variables that decide which tenant namespace a session's transcript is
 * keyed under (R-01 §7). Named here so the compile step and the validator cannot disagree
 * about the spelling.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_CODE_PROJECT_DIR_NAME_ENV = 'CLAUDE_CODE_PROJECT_DIR_NAME';

/**
 * The verdict of {@link validateTenantSessionScope}.
 *
 * There is no third "probably fine" arm, and `ok: false` always carries a reason, because both
 * of the SDK's failure modes here are **silent**: an invalid `CLAUDE_CODE_PROJECT_DIR_NAME`,
 * or a missing `CLAUDE_CONFIG_DIR`, does not throw — it falls back to the sanitised `cwd`,
 * which is precisely the cross-tenant key collision the override exists to prevent (R-01 §7
 * rules 1 and 2). A run must not start on a scope this function rejected.
 */
export type TenantSessionScopeVerdict =
  | { readonly ok: true; readonly projectKey: string; readonly configDir: string }
  | { readonly ok: false; readonly reason: string };

// ── The neutral agent frames (ENG-03, #302) ─────────────────────────────────────────────

/**
 * The closed set of neutral frame names, and the tool kinds and stop reasons they carry.
 *
 * This is the runner-and-control-plane copy of `@indx-workspace/contracts`' `AGENT_FRAME_NAMES`,
 * `AGENT_TOOL_KINDS` and `AGENT_STOP_REASONS`, **in the same order**, restated by hand
 * like `modelProviders`, and held together by `apps/web/server/sdk-conformance.test.ts`, which
 * compares them against the contracts' lists.
 *
 * The consequence is stated rather than hidden: TypeScript cannot check {@link toAgentFrames}'s
 * output against the contract's Zod union here. `apps/web/server/sdk-conformance.test.ts` fills
 * that hole by parsing every frame this module produces through `AgentFrameSchema`, so drift breaks
 * a test rather than a stream; the mapping's own cases are in `packages/core/src/agent-frames.test.ts`.
 */
export const agentFrameNames = [
  'agent.session',
  'agent.message',
  'agent.message.delta',
  'agent.tool.call',
  'agent.tool.result',
  'agent.usage',
  'agent.result',
  'agent.native',
  'agent.malformed',
] as const;
export type AgentFrameName = (typeof agentFrameNames)[number];

/** See {@link agentFrameNames}. ACP's tool-call kinds. */
export const agentToolKinds = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'mcp',
  'other',
] as const;
export type AgentToolKind = (typeof agentToolKinds)[number];

/** See {@link agentFrameNames}. ACP's prompt-turn stop reasons. */
export const agentStopReasons = [
  'end_turn',
  'max_turns',
  'max_budget',
  'refusal',
  'cancelled',
  'error',
] as const;
export type AgentStopReason = (typeof agentStopReasons)[number];

/** One block of an {@link AgentMessageFrame}: what the model said, or what it thought first. */
export type AgentMessageBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string };

/** The two fields every neutral frame carries: which engine produced it, and what it said. */
type AgentFrameBase = {
  readonly engine: string;
  readonly raw: unknown;
};

export type AgentSessionFrame = AgentFrameBase & {
  readonly frame: 'agent.session';
  readonly engineSessionId: string;
  readonly model: string | null;
};

export type AgentMessageFrame = AgentFrameBase & {
  readonly frame: 'agent.message';
  readonly messageId: string | null;
  readonly role: 'assistant' | 'user';
  readonly blocks: readonly AgentMessageBlock[];
};

export type AgentMessageDeltaFrame = AgentFrameBase & {
  readonly frame: 'agent.message.delta';
  readonly messageId: string | null;
  readonly block: 'text' | 'reasoning';
  readonly text: string;
};

export type AgentToolCallFrame = AgentFrameBase & {
  readonly frame: 'agent.tool.call';
  readonly toolCallId: string;
  readonly name: string;
  readonly kind: AgentToolKind;
  readonly input: unknown;
};

export type AgentToolResultFrame = AgentFrameBase & {
  readonly frame: 'agent.tool.result';
  readonly toolCallId: string;
  readonly status: 'completed' | 'failed';
  readonly output: string;
  readonly isError: boolean;
};

export type AgentUsageFrame = AgentFrameBase & {
  readonly frame: 'agent.usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly reasoningTokens: number | null;
};

export type AgentResultFrame = AgentFrameBase & {
  readonly frame: 'agent.result';
  readonly stopReason: AgentStopReason;
  readonly turns: number | null;
  readonly engineCostUsd: number | null;
};

export type AgentNativeFrame = AgentFrameBase & {
  readonly frame: 'agent.native';
  readonly type: string;
  readonly payload: unknown;
};

export type AgentMalformedFrame = AgentFrameBase & {
  readonly frame: 'agent.malformed';
  readonly reason: string;
};

export type AgentFrame =
  | AgentSessionFrame
  | AgentMessageFrame
  | AgentMessageDeltaFrame
  | AgentToolCallFrame
  | AgentToolResultFrame
  | AgentUsageFrame
  | AgentResultFrame
  | AgentNativeFrame
  | AgentMalformedFrame;

/**
 * Compile-time proof that {@link agentFrameNames} lists exactly the `frame` discriminants of
 * {@link AgentFrame} — the device {@link CompiledSdkOptionKeysAreExhaustive} uses, for the same
 * reason: a frame added to the union and not to the array would otherwise reach the wire under a
 * name no consumer was told about.
 */
export type AgentFrameNamesAreExhaustive =
  Exclude<AgentFrame['frame'], AgentFrameName> extends never
    ? Exclude<AgentFrameName, AgentFrame['frame']> extends never
      ? true
      : ['not a frame of AgentFrame:', Exclude<AgentFrameName, AgentFrame['frame']>]
    : ['missing from agentFrameNames:', Exclude<AgentFrame['frame'], AgentFrameName>];

/** See {@link AgentFrameNamesAreExhaustive}. Exported so it is not an unused local. */
export const AGENT_FRAME_NAMES_ARE_EXHAUSTIVE: AgentFrameNamesAreExhaustive = true;
