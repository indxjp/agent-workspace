import { AGENT_PERMISSION_KEYS, type AgentPermissionKey } from './permissions.js';
import { isWithholdingArm, type AgentPolicy, type WithholdingArm } from './policy.js';
import { TOOL_RULE_MCP_PREFIX, parseAgentToolRule, toolRuleHead } from './tool-rules.js';
import {
  CLAUDE_PERMISSION_TOOL_DENIALS,
  ENGINE_CATALOGUE,
  type ToolRulesEngineId,
  type WithholdingEngineId,
} from '../engine-catalogue.js';

// ── Engine switch: carry the narrowing across (ADR-0074 D12, PR #339) ─────────────────────

/** One narrowing the old arm carried, and how the new arm says it. */
export interface EngineSwitchCarriedItem {
  /**
   * What the old arm said: a `tools.deny` rule verbatim, `tools.base`, `permissionMode: <mode>`, or
   * `withheldPermissions: <key>`.
   */
  readonly from: string;
  /** The new engine's tools it removes, by the names that engine declares. */
  readonly tools: readonly string[];
}

/**
 * The outcome of {@link translatePolicyForEngineSwitch}. `absent` lists old denials whose tool the
 * new engine does not have at all, so there is nothing to deny: they stay absent. `refused` lists
 * old denials the new arm cannot express; a switch with any is `engine_switch_would_widen`.
 */
export type EngineSwitchTranslation =
  | {
      readonly ok: true;
      readonly policy: AgentPolicy;
      readonly carried: readonly EngineSwitchCarriedItem[];
      readonly absent: readonly string[];
    }
  | {
      readonly ok: false;
      readonly refused: readonly string[];
      readonly carried: readonly EngineSwitchCarriedItem[];
      readonly absent: readonly string[];
    };

type ClaudeArm = Extract<AgentPolicy, { engine: ToolRulesEngineId }>;

/** The switches some tool of `engine` governs, in {@link AGENT_PERMISSION_KEYS} order. */
function governedKeys(engine: WithholdingEngineId): readonly AgentPermissionKey[] {
  return AGENT_PERMISSION_KEYS.filter(
    (key) => ENGINE_CATALOGUE[engine].permissionTools[key].length > 0,
  );
}

/**
 * The switches `permissionMode: 'plan'` takes away. The Claude adapter forwards the mode to the
 * SDK verbatim (ADR-0072), and the SDK's semantics (R-01 §3/§10) decide what each mode narrows:
 *
 *   * `plan` — the SDK plans and does not act: no edits and no commands, so `writeFiles` and
 *     `runCommands` are withheld. Reading stays.
 *   * `dontAsk` — anything not pre-approved is denied outright, so a switch is kept only when every
 *     Claude tool it governs is named bare in `autoApprove` (see {@link claudeKeyNarrowings}).
 *
 * `default`, `acceptEdits` and `auto` govern prompting, not which tools exist, and
 * `bypassPermissions` cannot be stored through the route. None of them narrows.
 */
const PLAN_MODE_WITHHELD: readonly AgentPermissionKey[] = ['writeFiles', 'runCommands'];

/** Every reason the Claude arm keeps `key`'s tools from an agent, by what the arm said. */
function claudeKeyNarrowings(arm: ClaudeArm, key: AgentPermissionKey): readonly string[] {
  const governed = CLAUDE_PERMISSION_TOOL_DENIALS[key];
  const reasons: string[] = [];
  for (const rule of arm.tools.deny) {
    if (governed.includes(toolRuleHead(rule))) reasons.push(rule);
  }
  const { base, autoApprove, permissionMode } = arm.tools;
  if (base !== 'claude_code_preset' && !governed.every((name) => base.includes(name))) {
    reasons.push('tools.base');
  }
  if (permissionMode === 'plan' && PLAN_MODE_WITHHELD.includes(key)) {
    reasons.push('permissionMode: plan');
  }
  if (permissionMode === 'dontAsk' && !governed.every((name) => autoApprove.includes(name))) {
    reasons.push('permissionMode: dontAsk');
  }
  return reasons;
}

/** Whether the OpenAI arm has no way to say this `tools.deny` rule. */
function claudeDenialIsUntranslatable(rule: string): boolean {
  const kind = parseAgentToolRule(rule).kind;
  return (
    kind === 'wildcard' ||
    kind === 'mcp-glob' ||
    kind === 'invalid' ||
    toolRuleHead(rule).startsWith(TOOL_RULE_MCP_PREFIX)
  );
}

/** Group `(from, tools)` pairs by `from`, first appearance first, tools deduplicated. */
function groupCarried(
  pairs: readonly (readonly [string, readonly string[]])[],
): EngineSwitchCarriedItem[] {
  const byFrom = new Map<string, string[]>();
  for (const [from, tools] of pairs) {
    const list = byFrom.get(from) ?? [];
    for (const tool of tools) if (!list.includes(tool)) list.push(tool);
    byFrom.set(from, list);
  }
  return [...byFrom].map(([from, tools]) => ({ from, tools }));
}

/** The arm `next` with exactly `withheld` withheld; `next` itself when nothing changes. */
function withWithheld(
  next: WithholdingArm,
  withheld: ReadonlySet<AgentPermissionKey>,
): WithholdingArm {
  const withheldPermissions = AGENT_PERMISSION_KEYS.filter((key) => withheld.has(key));
  return withheldPermissions.length === 0 && next.withheldPermissions === undefined
    ? next
    : { ...next, withheldPermissions };
}

function claudeToWithholding(previous: ClaudeArm, next: WithholdingArm): EngineSwitchTranslation {
  const refused = previous.tools.deny.filter(claudeDenialIsUntranslatable);
  const pairs: (readonly [string, readonly string[]])[] = [];
  const withheld = new Set<AgentPermissionKey>(next.withheldPermissions ?? []);
  for (const key of governedKeys(next.engine)) {
    const reasons = claudeKeyNarrowings(previous, key);
    if (reasons.length === 0) continue;
    withheld.add(key);
    for (const reason of reasons)
      pairs.push([reason, ENGINE_CATALOGUE[next.engine].permissionTools[key]]);
  }
  const carriedFrom = new Set(pairs.map(([from]) => from));
  const absent = previous.tools.deny.filter(
    (rule) => !carriedFrom.has(rule) && !refused.includes(rule),
  );
  const carried = groupCarried(pairs);
  if (refused.length > 0) return { ok: false, refused, carried, absent };
  return { ok: true, policy: withWithheld(next, withheld), carried, absent };
}

function withholdingToClaude(previous: WithholdingArm, next: ClaudeArm): EngineSwitchTranslation {
  const deny = [...next.tools.deny];
  const pairs: (readonly [string, readonly string[]])[] = [];
  const withheld = previous.withheldPermissions ?? [];
  for (const key of AGENT_PERMISSION_KEYS) {
    if (!withheld.includes(key)) continue;
    const tools = CLAUDE_PERMISSION_TOOL_DENIALS[key];
    for (const tool of tools) if (!deny.includes(tool)) deny.push(tool);
    pairs.push([`withheldPermissions: ${key}`, tools]);
  }
  const policy: ClaudeArm =
    deny.length === next.tools.deny.length ? next : { ...next, tools: { ...next.tools, deny } };
  return { ok: true, policy, carried: groupCarried(pairs), absent: [] };
}

/**
 * Between two withholding arms (`openai-agents`, `pi` and `mastra`) the narrowing is the same statement on
 * both sides, so every withheld switch is carried verbatim — including one the new engine governs
 * no tool with (`unrestrictedNetwork`), because compose narrows the run's permissions by it.
 */
function withholdingToWithholding(
  previous: WithholdingArm,
  next: WithholdingArm,
): EngineSwitchTranslation {
  const withheld = new Set<AgentPermissionKey>(next.withheldPermissions ?? []);
  const pairs: (readonly [string, readonly string[]])[] = [];
  for (const key of AGENT_PERMISSION_KEYS) {
    if (!(previous.withheldPermissions ?? []).includes(key)) continue;
    withheld.add(key);
    pairs.push([`withheldPermissions: ${key}`, ENGINE_CATALOGUE[next.engine].permissionTools[key]]);
  }
  return {
    ok: true,
    policy: withWithheld(next, withheld),
    carried: groupCarried(pairs),
    absent: [],
  };
}

/**
 * Carry an engine switch's narrowing across (ADR-0074 D12, the Owner's decision on PR #339).
 *
 * `previous` is the stored policy, `next` the one replacing it. When the two name the same engine
 * nothing is translated: a `PUT` replaces the policy, which is how an owner widens on purpose. When
 * the engine changes, whatever the old arm withheld is written into the new arm, so a switch can
 * never hand the agent a tool its owner took away:
 *
 * | `claude-agent-sdk` said                                     | `openai-agents`, `pi` or `mastra` withholds |
 * | ----------------------------------------------------------- | --------------------------------- |
 * | `deny` of `Read`, `Glob` or `Grep` (bare or scoped)         | `readFiles`: the readers          |
 * | `deny` of `Write`, `Edit` or `NotebookEdit` (bare or scoped)| `writeFiles`: `apply_patch` / `write`, `edit` |
 * | `deny` of `Bash`, `BashOutput` or `KillShell` (bare or scoped) | `runCommands`: `shell` / `bash` |
 * | a `base` list missing any tool a switch governs             | that switch                     |
 * | `permissionMode: 'plan'`                                    | `writeFiles` and `runCommands`  |
 * | `permissionMode: 'dontAsk'`, a switch's tools not all in `autoApprove` | that switch          |
 * | `deny` of a tool this engine does not have (`WebFetch`, …)  | nothing: it stays absent        |
 * | `deny` of an MCP tool, an MCP glob or a wildcard            | **refused**                     |
 *
 * A scoped denial (`Bash(git push:*)`) withholds the whole tool: this engine has no specifier
 * grammar, and the narrower reading is the safe one. The reverse switch writes each withheld
 * switch's {@link CLAUDE_PERMISSION_TOOL_DENIALS} into `tools.deny`, which is exact. Between
 * `openai-agents`, `pi` (ENG-08, #307) and `mastra` (ENG-10, #309) `withheldPermissions` is carried
 * verbatim.
 *
 * The result never allows a tool the old arm denied: the Lean theorem
 * `AgentWorkspace.Theorems.Invariants.EngineSwitch.the_switch_never_widens_the_tool_plan` states
 * it, and `tests/formal/engine-openai-agents.test.ts` replays its `engine-switch.json` vectors
 * against this function. It is pure, so the route enforces it and `aw agents update --engine` can
 * show it before applying it.
 */
export function translatePolicyForEngineSwitch(
  previous: AgentPolicy,
  next: AgentPolicy,
): EngineSwitchTranslation {
  if (previous.engine === next.engine) return { ok: true, policy: next, carried: [], absent: [] };
  if (!isWithholdingArm(previous)) {
    return !isWithholdingArm(next)
      ? { ok: true, policy: next, carried: [], absent: [] }
      : claudeToWithholding(previous, next);
  }
  if (!isWithholdingArm(next)) return withholdingToClaude(previous, next);
  return withholdingToWithholding(previous, next);
}
