import { z } from 'zod';

import { AGENT_PERMISSION_KEYS } from './agents/permissions.js';
import type { AgentPermissionKey, AgentPermissions } from './agents/permissions.js';
import type { EngineCapabilities, EngineId } from './engines.js';

// ── Engine-native constants ──────────────────────────────────────────────────────────────
// The control plane names these tools when it carries an engine switch's narrowing across, and
// `apps/web` may never import an engine adapter, so they live beside the catalogue entry that
// owns them. `./agents.ts` re-exports every one of them by name.

/**
 * Which Claude tools each of §17 Step 4's four switches removes when it is off.
 *
 * §6 maps "Tool permissions → allowedTools", and R-01 §10 established that this is incomplete:
 * `allowedTools` **auto-approves**, it does not restrict, so an agent whose `readFiles` is false
 * but whose tool surface still exposes `Read` can read files the moment a permission prompt is
 * answered — and a run with no interactive user has no one to answer it. So a switch that is off
 * maps onto `deny` (the SDK's `disallowedTools`), which removes the definition rather than
 * withholding an approval. `docs/adr/W1-COMP-01-permissions-map-onto-deny-not-allow.md` records it.
 *
 * **This is a floor, not the finished §17 Step 4 mapping.** `AgentPermissionsSchema` is four
 * booleans and the SDK's surface is much larger; a fifth capability added to the checkbox set and
 * not here would be ungoverned. The compiler will not catch that — the record below is keyed by
 * {@link AgentPermissionKey}, so it *will* catch a key added to the permission set and not to this
 * table, which is the half a type can hold.
 *
 * ## Why this table is in `packages/contracts` and not in the Claude adapter (ENG-04b, #325)
 *
 * The tool *names* are `@anthropic-ai/claude-agent-sdk`'s, so the natural home would be
 * `packages/engine-claude-agent-sdk` — and ENG-04b moved everything else about the Claude tool
 * mapping there. This table cannot follow, because it has a second caller the adapter cannot
 * serve: `GET /api/agents/:id/policy` answers the Claude arm of `AgentPolicySchema` for an
 * agent whose `policy` column is NULL, and `apps/web` may never import an engine adapter
 * (`dependency-cruiser.config.mjs`). A restatement in the control plane would be two spellings of
 * one security decision, which is the drift this repository refuses. So the table lives beside the
 * Claude arm whose grammar it is written in, and both the control plane and the adapter read the
 * same one. `docs/adr/0072-the-claude-tool-mapping-and-skills-live-in-the-claude-adapter.md`
 * records it; ADR-0136 moved the table into the catalogue's Claude section.
 */
export const CLAUDE_PERMISSION_TOOL_DENIALS: Readonly<
  Record<AgentPermissionKey, readonly string[]>
> = {
  readFiles: ['Read', 'Glob', 'Grep'],
  writeFiles: ['Write', 'Edit', 'NotebookEdit'],
  runCommands: ['Bash', 'BashOutput', 'KillShell'],
  unrestrictedNetwork: ['WebFetch', 'WebSearch'],
};

/**
 * The Claude tools this permission set removes, in {@link AGENT_PERMISSION_KEYS}' order.
 *
 * The order is part of the answer and not an incidental: the compiled `disallowedTools` array is
 * compared byte for byte against what the platform produced before ENG-04b
 * (`formal/AgentWorkspace/Theorems/Refinement/EngineToolPolicy.lean`), so iterating the declared
 * key order rather than `Object.keys` is what makes that comparison stable.
 */
export function claudeDeniedToolsFor(permissions: AgentPermissions): readonly string[] {
  return AGENT_PERMISSION_KEYS.filter((key) => !permissions[key]).flatMap(
    (key) => ENGINE_CATALOGUE['claude-agent-sdk'].permissionTools[key],
  );
}

/** The Claude shell tools a read-only file grant removes: a redirect writes past any path rule. */
export const CLAUDE_GRANT_SHELL_DENIALS = ['Bash', 'BashOutput', 'KillShell'] as const;

/**
 * The Claude denials that make read-only file grants read-only, for the run whose working
 * directory is `cwd`: one `Edit(//<cwd>/<path>)` rule per grant (`/**` added for a directory),
 * then {@link CLAUDE_GRANT_SHELL_DENIALS}.
 *
 * Claude Code checks file writes against `Edit(path)` rules only — a `Write(path)` or
 * `NotebookEdit(path)` rule is accepted, never consulted, and warned about at startup — and only
 * `//path` is absolute: a single leading `/` anchors at the rule's settings source, so a rule
 * written as `Edit(<absolute cwd>/x)` would mean `<cwd>/<cwd>/x` and match nothing
 * (code.claude.com/docs/en/permissions, "Read and Edit"; R-01 §10). A Windows `cwd` is written in
 * the POSIX form Claude Code matches against, `C:\w` as `/c/w`.
 *
 * Shared by the control plane's compose-side guard and the Claude adapter, which de-duplicate the
 * two into one list; both pass only the grants whose access is `read`.
 */
export function claudeReadOnlyGrantDenials(
  cwd: string,
  readOnly: readonly { readonly path: string; readonly kind: 'file' | 'directory' }[],
): readonly string[] {
  if (readOnly.length === 0) return [];
  const root = claudeRulePath(cwd);
  return [
    ...readOnly.map(
      (grant) => `Edit(/${root}/${grant.path}${grant.kind === 'directory' ? '/**' : ''})`,
    ),
    ...CLAUDE_GRANT_SHELL_DENIALS,
  ];
}

/** An absolute path in the POSIX form Claude Code matches rules against, without a trailing `/`. */
export function claudeRulePath(absolute: string): string {
  return absolute
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/u, (_drive, letter: string) => `/${letter.toLowerCase()}`)
    .replace(/\/+$/u, '');
}

/** The reasoning efforts the OpenAI Agents arm accepts (ENG-09, #308). */
export const OPENAI_AGENTS_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type OpenAiAgentsReasoningEffort = (typeof OPENAI_AGENTS_REASONING_EFFORTS)[number];

/**
 * Every function tool the OpenAI Agents adapter can offer, in the order its plan lists them
 * (ENG-09, #308).
 *
 * The names are the adapter's (`packages/engine-openai-agents/src/tools.ts` builds one SDK function
 * tool per name), and they live here for the reason {@link CLAUDE_PERMISSION_TOOL_DENIALS} does:
 * the control plane has to name them when it carries an engine switch's narrowing across
 * (`translatePolicyForEngineSwitch`), and `apps/web` may never import an engine adapter. The
 * adapter reads these two constants rather than restating them.
 */
export const OPENAI_AGENTS_TOOL_NAMES = [
  'read_file',
  'list_files',
  'search_files',
  'apply_patch',
  'shell',
] as const;
export type OpenAiAgentsToolName = (typeof OPENAI_AGENTS_TOOL_NAMES)[number];

/** Which of §17 Step 4's switches grants each OpenAI Agents tool. */
export const OPENAI_AGENTS_TOOL_PERMISSION: Readonly<
  Record<OpenAiAgentsToolName, AgentPermissionKey>
> = {
  read_file: 'readFiles',
  list_files: 'readFiles',
  search_files: 'readFiles',
  apply_patch: 'writeFiles',
  shell: 'runCommands',
};

/**
 * The thinking levels the pi arm accepts (ENG-08, #307): pi's own `ThinkingLevel`, minus `xhigh`,
 * which pi clamps to the model and which no model reached through the gateway exposes.
 */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * Every built-in pi tool the pi adapter can offer, in the order its plan lists them (ENG-08, #307).
 *
 * pi's own names (`read`, `write`, `edit`, `bash` — `createAgentSession`'s `tools` allowlist). They
 * live here for the reason {@link OPENAI_AGENTS_TOOL_NAMES} does: the control plane names them when
 * it carries an engine switch's narrowing across, and `apps/web` may never import an adapter.
 */
export const PI_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const;
export type PiToolName = (typeof PI_TOOL_NAMES)[number];

/** Which of §17 Step 4's switches grants each pi tool. */
export const PI_TOOL_PERMISSION: Readonly<Record<PiToolName, AgentPermissionKey>> = {
  read: 'readFiles',
  write: 'writeFiles',
  edit: 'writeFiles',
  bash: 'runCommands',
};

/**
 * Every Mastra workspace tool the Mastra adapter can offer, in the order its plan lists them
 * (ENG-10, #309).
 *
 * Mastra's own names (`WORKSPACE_TOOLS` in `@mastra/core/workspace`), kept rather than renamed so
 * a transcript names the tool Mastra's documentation describes. They live here for the reason
 * {@link PI_TOOL_NAMES} does: the control plane names them when it carries an engine switch's
 * narrowing across, and `apps/web` may never import an adapter. The skill tools Mastra adds for a
 * workspace with skills (`skill`, `skill_search`, `skill_read`) are not listed: no permission
 * switch governs them, and they read only the skills the platform placed.
 */
export const MASTRA_TOOL_NAMES = [
  'mastra_workspace_read_file',
  'mastra_workspace_list_files',
  'mastra_workspace_grep',
  'mastra_workspace_file_stat',
  'mastra_workspace_write_file',
  'mastra_workspace_edit_file',
  'mastra_workspace_mkdir',
  'mastra_workspace_delete',
  'mastra_workspace_execute_command',
  'mastra_workspace_get_process_output',
  'mastra_workspace_kill_process',
] as const;
export type MastraToolName = (typeof MASTRA_TOOL_NAMES)[number];

/** Which of §17 Step 4's switches grants each Mastra workspace tool. */
export const MASTRA_TOOL_PERMISSION: Readonly<Record<MastraToolName, AgentPermissionKey>> = {
  mastra_workspace_read_file: 'readFiles',
  mastra_workspace_list_files: 'readFiles',
  mastra_workspace_grep: 'readFiles',
  mastra_workspace_file_stat: 'readFiles',
  mastra_workspace_write_file: 'writeFiles',
  mastra_workspace_edit_file: 'writeFiles',
  mastra_workspace_mkdir: 'writeFiles',
  mastra_workspace_delete: 'writeFiles',
  mastra_workspace_execute_command: 'runCommands',
  mastra_workspace_get_process_output: 'runCommands',
  mastra_workspace_kill_process: 'runCommands',
};

/**
 * The largest `toolCallConcurrency` the Mastra arm accepts (ENG-10, #309). Mastra's own default is
 * 10; the ceiling only keeps a stored policy from asking for an unbounded fan-out of tool calls.
 */
export const MASTRA_TOOL_CALL_CONCURRENCY_MAX = 16;

// ── The catalogue ────────────────────────────────────────────────────────────────────────

/** How an arm states narrowing: Claude's tool grammar (`tools`) or `withheldPermissions`. */
export const ENGINE_NARROWINGS = ['tool-rules', 'withheld-permissions'] as const;
export type EngineNarrowing = (typeof ENGINE_NARROWINGS)[number];

/** How an engine shows the model an MCP tool (S2-02f seam check 2). */
export const MCP_TOOL_NAME_FORMS = ['mcp__server__tool', 'server_tool', 'tool'] as const;
export type McpToolNameForm = (typeof MCP_TOOL_NAME_FORMS)[number];

/** How an engine's session-state stream keys are shaped. */
export const SESSION_STREAM_KEY_SCHEMES = ['project-key-prefixed', 'opaque'] as const;
export type SessionStreamKeyScheme = (typeof SESSION_STREAM_KEY_SCHEMES)[number];

/** The entry fields an engine can use as its session-entry idempotency key. */
export const SESSION_ENTRY_KEY_FIELDS = ['uuid', 'id', 'key'] as const;
export type SessionEntryKeyField = (typeof SESSION_ENTRY_KEY_FIELDS)[number];

export interface EngineCatalogueEntry<TSettings extends z.ZodRawShape = z.ZodRawShape> {
  /** Shown by `GET /api/engines` and the UI. */
  readonly displayName: string;
  /** What the adapter honours. The adapter and the web registry both read this one copy. */
  readonly capabilities: EngineCapabilities;
  /**
   * Engine-native settings an author chooses, in wire key order, every field `.optional()`. They
   * are the `defineAgent({ engine: { id, ...settings } })` keys, the policy arm's native fields and
   * the run-request arm the adapter parses.
   */
  readonly settings: TSettings;
  readonly narrowing: EngineNarrowing;
  /** Every tool this engine declares, grouped by the switch that governs it, in the engine's order. */
  readonly permissionTools: Readonly<Record<AgentPermissionKey, readonly string[]>>;
  readonly mcpToolName: McpToolNameForm;
  readonly sessionStreamKey: SessionStreamKeyScheme;
  /** The entry field the session store upserts on, or null for append-only (R-01 §7). */
  readonly sessionEntryKey: SessionEntryKeyField | null;
  /**
   * Whether the engine can be asked for output shaped by a JSON Schema (ADR-0143). Kept here, not
   * in `capabilities`, until the public `structuredOutput` capability key lands with the run
   * contract's `outputSchema` field: a new capability key changes the `GET /api/engines` body.
   */
  readonly structuredOutput: boolean;
  /**
   * Whether the engine can stop a run on a tool call that needs a person's approval (ADR-0145 D5).
   * Kept here, not in `capabilities`, until the public approval slice (P5-4) lands: a new
   * capability key changes the `GET /api/engines` body.
   */
  readonly approvals: boolean;
}

/**
 * The tools of `table`, grouped by the switch that grants each, in the order `table` declares them.
 * Spelling the four keys out keeps the result typed without a cast.
 */
function permissionToolsOf(
  table: Readonly<Record<string, AgentPermissionKey>>,
): Readonly<Record<AgentPermissionKey, readonly string[]>> {
  const governedBy = (key: AgentPermissionKey): string[] =>
    Object.keys(table).filter((tool) => table[tool] === key);
  return {
    readFiles: governedBy('readFiles'),
    writeFiles: governedBy('writeFiles'),
    runCommands: governedBy('runCommands'),
    unrestrictedNetwork: governedBy('unrestrictedNetwork'),
  };
}

/**
 * The one place an engine is described (ADR-0136): its display name, capabilities, native
 * settings, how it states narrowing, the tools each permission switch governs, how it shows the
 * model an MCP tool and how its session-state stream keys are shaped. Keyed by {@link EngineId}, so
 * an id without an entry is a type error.
 *
 * The SDK **version** is deliberately not here: it is a build fact of the adapter, and
 * `apps/web/server/engines/registry.ts` keeps its restatement, checked against the manifests.
 *
 * Capabilities by engine:
 *
 * * `claude-agent-sdk` (as R-01 measured them): `fork` and `streamingText` are `false` because
 *   neither is reachable through this platform today — the capability set states what a deployment
 *   can be *asked* for, not what the third-party SDK could be configured to do. `maxTurns` and
 *   `maxBudget` are `native`: the SDK enforces both itself. `wireProtocols` is Anthropic Messages
 *   alone, the only ingress the gateway serves a Claude run over.
 * * `openai-agents` (ADR-0074): `skills: false` is a refusal, not a gap: a skill on this engine is
 *   refused by name. `maxBudget: 'adapter'` is **provisional** (ADR-0074 D7): the adapter prices
 *   the usage the gateway reports back and stops the run `max_budget`, until #342 moves the cap
 *   into the gateway. `wireProtocols` lists Responses first, so `resolveWireProtocol` picks it for
 *   an OpenAI-family connection and Anthropic Messages for an Anthropic-family one.
 * * `pi` (ADR-0081): `mcp: false` is a refusal, not a gap: pi has no MCP client, and an agent with
 *   a connector is refused by name rather than bridged. `maxTurns` and `maxBudget` are `'adapter'`:
 *   the adapter counts `turn_end` and prices each response with the port's provisional table
 *   (ADR-0074 D7). `wireProtocols` is Anthropic Messages alone until the gateway serves OpenAI
 *   dialects to pi.
 * * `mastra` (ADR-0084): `fork: false` is a refusal, not a gap: a Mastra thread is continued, never
 *   branched. `maxTurns` is `'native'` (Mastra's `maxSteps`); `maxBudget` is `'adapter'`, priced
 *   with the port's provisional table (ADR-0074 D7). `wireProtocols` lists Anthropic Messages
 *   first and both OpenAI dialects after it: Mastra takes an explicit AI SDK provider for each, so
 *   every connection is reached in its own native dialect and the gateway never translates.
 *
 * `structuredOutput` is `true` for every engine but `pi`: `claude-agent-sdk` hands the schema to its
 * `outputFormat` option, `openai-agents` to `outputType` and `mastra` to `structuredOutput`. `pi`
 * alone refuses an output schema by name.
 * `approvals` is `true` for `claude-agent-sdk` alone (its `canUseTool` callback, ADR-0145 D5); the other
 * three refuse `requireApproval`. Claude gates only the tools its SDK asks `canUseTool` about: `Bash`,
 * `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` and connector tools
 * (`mcp__…`), never `Read`, `Glob` or `Grep`.
 */
export const ENGINE_CATALOGUE = {
  'claude-agent-sdk': {
    displayName: 'Claude Agent SDK',
    capabilities: {
      mcp: true,
      skills: true,
      subagents: true,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
    settings: {},
    narrowing: 'tool-rules',
    permissionTools: CLAUDE_PERMISSION_TOOL_DENIALS,
    mcpToolName: 'mcp__server__tool',
    sessionStreamKey: 'project-key-prefixed',
    // R-01 §7: "retries can redeliver, so `append()` must upsert on `entry.uuid`".
    sessionEntryKey: 'uuid',
    structuredOutput: true,
    approvals: true,
  },
  'openai-agents': {
    displayName: 'OpenAI Agents SDK',
    capabilities: {
      mcp: true,
      skills: false,
      subagents: true,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'adapter',
      wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
    },
    settings: {
      /**
       * Engine-native: the Responses API's `reasoning.effort`, as the OpenAI Agents SDK's
       * `modelSettings.reasoning.effort` takes it. Absent means the model's own default.
       */
      reasoningEffort: z.enum(OPENAI_AGENTS_REASONING_EFFORTS).optional(),
      /** Engine-native: the SDK's `modelSettings.parallelToolCalls`. Absent means its default. */
      parallelToolCalls: z.boolean().optional(),
    },
    narrowing: 'withheld-permissions',
    permissionTools: permissionToolsOf(OPENAI_AGENTS_TOOL_PERMISSION),
    mcpToolName: 'tool',
    sessionStreamKey: 'opaque',
    // Its entries carry no key (`packages/engine-openai-agents/src/session.ts` appends wrapped
    // items), so the store is append-only; a key invented from an id-looking field would claim an
    // idempotency the engine never promised.
    sessionEntryKey: null,
    structuredOutput: true,
    approvals: false,
  },
  pi: {
    displayName: 'pi coding agent',
    capabilities: {
      mcp: false,
      skills: true,
      subagents: false,
      resume: true,
      fork: true,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'adapter',
      maxBudget: 'adapter',
      wireProtocols: ['anthropic-messages'],
    },
    settings: {
      /** Engine-native: pi's `thinkingLevel`, clamped by pi to the model. Absent means `off`. */
      thinkingLevel: z.enum(PI_THINKING_LEVELS).optional(),
    },
    narrowing: 'withheld-permissions',
    permissionTools: permissionToolsOf(PI_TOOL_PERMISSION),
    mcpToolName: 'tool',
    sessionStreamKey: 'opaque',
    // pi's JSONL lines each carry an `id`, unique within the session (its header's is the session
    // id), and `packages/engine-pi` mirrors each line once (ENG-08, #307).
    sessionEntryKey: 'id',
    structuredOutput: false,
    approvals: false,
  },
  mastra: {
    displayName: 'Mastra',
    capabilities: {
      mcp: true,
      skills: true,
      subagents: true,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: true,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'adapter',
      wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
    },
    settings: {
      /**
       * Engine-native: Mastra's `toolCallConcurrency`, the number of tool calls one step may run
       * at once. Absent means Mastra's own default.
       */
      toolCallConcurrency: z.number().int().min(1).max(MASTRA_TOOL_CALL_CONCURRENCY_MAX).optional(),
    },
    narrowing: 'withheld-permissions',
    permissionTools: permissionToolsOf(MASTRA_TOOL_PERMISSION),
    mcpToolName: 'server_tool',
    sessionStreamKey: 'opaque',
    // `packages/engine-mastra` journals a Mastra thread as one entry per record, keyed `thread` or
    // `message:<id>`, so a message Mastra updates replaces its entry in place (ENG-10, #309).
    sessionEntryKey: 'key',
    structuredOutput: true,
    approvals: false,
  },
} as const satisfies { readonly [E in EngineId]: EngineCatalogueEntry };

export type EngineCatalogue = typeof ENGINE_CATALOGUE;

/** The engines whose arm states narrowing in Claude's tool grammar. */
export type ToolRulesEngineId = {
  [E in EngineId]: EngineCatalogue[E]['narrowing'] extends 'tool-rules' ? E : never;
}[EngineId];

/** The engines whose arm states narrowing as `withheldPermissions`. */
export type WithholdingEngineId = Exclude<EngineId, ToolRulesEngineId>;

export function isWithholdingEngine(id: EngineId): id is WithholdingEngineId {
  return ENGINE_CATALOGUE[id].narrowing === 'withheld-permissions';
}

/**
 * The strict object of one engine's settings: adapters parse their run-policy arm with it, and a
 * portable agent's `extensions.engines[id]` is validated against it.
 */
export function engineSettingsSchema<E extends EngineId>(
  engine: E,
): z.ZodObject<EngineCatalogue[E]['settings'], z.core.$strict> {
  return z.object(ENGINE_CATALOGUE[engine].settings).strict();
}

/** `mcp__<server>__<tool>`, `<server>_<tool>` or `<tool>`. */
export function mcpToolName(form: McpToolNameForm, server: string, tool: string): string {
  switch (form) {
    case 'mcp__server__tool':
      return `mcp__${server}__${tool}`;
    case 'server_tool':
      return `${server}_${tool}`;
    case 'tool':
      return tool;
  }
}
