/**
 * The Claude tool mapping (ENG-04b, #325).
 *
 * §17 Step 4 collects four checkboxes and §8 assigns connectors. Neither is a Claude concept: a
 * permission is a sentence about what an agent may do, and a connector is an MCP server. What *is*
 * a Claude concept is every name this module produces — `Read`, `Glob`, `Bash`, `WebFetch`,
 * `Edit(//workspace/x/docs/**)`, `mcp__file-finder__*` — and until this unit the control plane
 * produced them, in `apps/web/server/compose/run-request.ts`. That is the thing #324 recorded as
 * its Deviation 7: a second engine would have received its tool policy written in the Claude Agent
 * SDK's vocabulary, and would have had to guess what the platform meant by it.
 *
 * So the mapping lives here, behind the port, and the control plane sends the portable core.
 *
 * ## What is mapped, in what order, and why the order is part of the answer
 *
 * {@link compileClaudeToolPolicy} folds four inputs into one {@link AgentToolPolicy}:
 *
 *   1. **the stored policy arm** (`policy.tools`), or nothing when the agent's `policy` column is
 *      NULL. It is the Builder's own narrowing and comes first because it was written first;
 *   2. **the permission floor** — {@link claudeDeniedToolsFor}, from `packages/contracts`, whose own
 *      doc comment explains why that table is there rather than here;
 *   3. **the read-only file grants**, as `Edit(//…)` denials plus the shell denials a redirect
 *      would otherwise walk around;
 *   4. **the assigned connectors**, as `mcp__<server>__*` auto-approvals.
 *
 * The concatenation order and the de-duplication are *the* compatibility surface of this unit:
 * `disallowedTools` and `allowedTools` are arrays on the wire to the SDK, and ENG-04b's claim is
 * that they are byte-identical to what the control plane produced before the move — for every
 * agent, with a stored policy or without. `formal/AgentWorkspace/Theorems/Refinement/EngineToolPolicy.lean`
 * states that as a theorem and `tests/formal/engine-tool-policy.test.ts` replays it, so a reordering
 * here is a failed proof rather than a silently different run.
 *
 * ## Union, never replace
 *
 * A stored policy may restrict an agent past its permission checkboxes and may never widen it past
 * them (`docs/adr/SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column.md`). That is
 * why (2), (3) and (4) are *added* to (1) rather than defaulted-to-when-absent: a Builder who stores
 * `deny: []` does not thereby re-grant `Bash` to an agent whose `runCommands` is off.
 */
import {
  CLAUDE_GRANT_SHELL_DENIALS,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  claudeDeniedToolsFor,
  claudeReadOnlyGrantDenials,
  claudeRulePath,
  needsApproval,
} from '@indx-workspace/contracts/agents';
import type { AgentPermissions, AgentToolPolicy } from '@indx-workspace/contracts/agents';
import { normaliseGrants, type EngineFileGrant } from '@agent-workspace/engine';

export { CLAUDE_APPROVABLE_TOOLS, splitApprovals, unapprovableRules } from './approval-rules.js';

/**
 * The Claude tools that write a file. Claude Code checks all three against `Edit(path)` rules, so
 * a read-only grant is one `Edit(//…)` denial; denied by bare name, each removes only itself.
 */
export const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;

/**
 * The Claude shell tools, denied outright whenever any read-only grant exists: a shell redirect
 * writes a file without passing through any `Edit(path)` rule.
 */
export const CLAUDE_SHELL_TOOLS = CLAUDE_GRANT_SHELL_DENIALS;

/**
 * The built-in tools `claude_code_preset` compiles to (BH061-010). The SDK's own preset is the whole
 * Claude Code surface, including subagents, cron, worktrees and messaging, which no permission
 * switch governs; so the preset is this allow-list instead: every tool a switch governs (a switch
 * that is off still removes its own through `deny`), plus `Skill` for the agent's skills,
 * `TodoWrite` for planning, `ToolSearch` to load deferred connector tools and the two MCP resource
 * readers for assigned connectors. None of the extra five acts outside the run.
 */
export const CLAUDE_PRESET_TOOLS: readonly string[] = [
  ...Object.values(CLAUDE_PERMISSION_TOOL_DENIALS).flat(),
  'Skill',
  'TodoWrite',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/** The policy an agent with no stored one starts from. See `packages/contracts`' Claude arm. */
const CLAUDE_TOOL_POLICY_FLOOR = {
  base: 'claude_code_preset',
  autoApprove: [],
  deny: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
} as const satisfies AgentToolPolicy;

/**
 * `mcp__<server>__*` for every connector assigned to this run, in sorted record-key order.
 *
 * Connector assignment is the explicit workspace grant, and a run is unattended: leaving an
 * assigned MCP tool at the SDK's interactive default makes every real invocation fail with a
 * permission prompt nobody can answer (R-01 §9, §10). Sorted rather than in record order because
 * `allowedTools` is compared byte for byte and a JavaScript object's key order is an accident of
 * how the record was built.
 */
export function claudeMcpAutoApprovals(
  mcpServers: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.keys(mcpServers)
    .toSorted()
    .map((name) => `mcp__${name}__*`);
}

/**
 * The Claude denials one run's read-only file grants produce.
 *
 * Each read-only grant denies `Edit(//<cwd>/<path>)` — and everything under it, for a directory
 * grant — and *any* read-only grant denies {@link CLAUDE_SHELL_TOOLS}. Both sides build the rules
 * with `@indx-workspace/contracts`' `claudeReadOnlyGrantDenials`, which documents the rule grammar,
 * so the control plane's `applyFileGrantPolicy` writes the same list and the two de-duplicate.
 *
 * Grants are normalised first (`@agent-workspace/engine`'s `normaliseGrants`), so a grant that
 * escapes the workspace, is absolute, or names this engine's own configuration directory refuses
 * the run rather than compiling a rule over a path the rule does not mean.
 */
export function claudeFileGrantDenials(
  cwd: string,
  grants: readonly EngineFileGrant[],
  protectedConfigDirectory: string,
):
  | { readonly ok: true; readonly deny: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  const normalised = normaliseGrants(grants, protectedConfigDirectory);
  if (!normalised.ok) {
    return { ok: false, reason: `a file grant cannot be compiled: ${normalised.reason}` };
  }
  const readOnly = normalised.grants.filter((grant) => grant.access === 'read');
  return { ok: true, deny: claudeReadOnlyGrantDenials(cwd, readOnly) };
}

/** What {@link compileClaudeToolPolicy} is given besides the portable permissions. */
export type ClaudeToolPolicyInputs = {
  /** The agent's stored narrowing, or `null` when its `policy` column is NULL. */
  readonly stored: AgentToolPolicy | null;
  /** The read-only file grants' denials, from the control plane and from this adapter. */
  readonly fileGrantDeny: readonly string[];
  /** The connectors assigned to this run, by record key. */
  readonly mcpServers: Readonly<Record<string, unknown>>;
};

/**
 * The tool policy one Claude run is compiled with.
 *
 * See the module header for the order of the four inputs and why it is load-bearing. `deny` and
 * `autoApprove` are de-duplicated **in order**, so a rule the control plane already sent and this
 * adapter derives again appears once, at the position it first appeared.
 */
export function compileClaudeToolPolicy(
  permissions: AgentPermissions,
  inputs: ClaudeToolPolicyInputs,
): AgentToolPolicy {
  const stored = inputs.stored ?? CLAUDE_TOOL_POLICY_FLOOR;
  return {
    base: stored.base === 'claude_code_preset' ? 'claude_code_preset' : [...stored.base],
    autoApprove: [
      ...new Set([...stored.autoApprove, ...claudeMcpAutoApprovals(inputs.mcpServers)]),
    ],
    deny: [
      ...new Set([...stored.deny, ...claudeDeniedToolsFor(permissions), ...inputs.fileGrantDeny]),
    ],
    permissionMode: stored.permissionMode,
    allowDangerouslySkipPermissions: stored.allowDangerouslySkipPermissions,
  };
}

/**
 * The shell tool **Run commands** asks about (#2091): `['Bash']` when a command that Claude Code
 * would stop to ask about should reach a person, else `[]`.
 *
 * Without it, Run commands only keeps `Bash` out of `disallowedTools`. In `permissionMode: 'default'`
 * Claude Code runs a read-only command on its own and asks about one that writes; with nobody to
 * ask, the SDK refused it and the run still ended Completed. This rule joins the approval gate, so
 * that call pauses the run and the console shows Approve / Reject (ADR-0145).
 *
 * It is not an `ask` rule (see `ClaudeApprovalGate.ask`): Claude Code still runs a read-only
 * command, and an `allowedTools` rule such as `Bash(npm test)` still runs its command, without
 * asking. Only a call Claude Code would have refused reaches `canUseTool`.
 *
 * Left out when the switch is off, when `Bash` is denied (a read-only file grant denies it) or
 * auto-approved whole (every command already runs, as the gallery agents declare), when the base
 * list does not offer it, when a stored `requireApproval` already gates it, and in any mode but
 * `default`, which is the only mode that asks `canUseTool`.
 */
export function claudeCommandApprovalRules(
  permissions: AgentPermissions,
  tools: AgentToolPolicy,
  requireApproval: readonly string[],
): readonly string[] {
  if (!permissions.runCommands || tools.permissionMode !== 'default') return [];
  if (tools.deny.includes('Bash') || tools.autoApprove.includes('Bash')) return [];
  if (needsApproval(requireApproval, 'Bash')) return [];
  if (tools.base !== 'claude_code_preset' && !tools.base.includes('Bash')) return [];
  return ['Bash'];
}

/**
 * The allow rule **Write files** adds: `['Edit(//<cwd>/**)']` when the agent may write files, else
 * `[]`.
 *
 * In `permissionMode: 'default'` Claude Code asks before every `Write`, `Edit` and `NotebookEdit`.
 * A run has nobody to answer that prompt, so an agent with Write files on had every file write
 * refused ("Did not run: Write"), its memory file included (ADR-0163). The switch is the person's
 * grant, as an assigned connector is (`claudeMcpAutoApprovals`), so it is an allow rule. An `Edit`
 * rule covers all three tools, and it is scoped to the workspace: a write outside it still asks,
 * so it is still refused.
 *
 * A deny rule still wins over it, so a read-only file grant (`Edit(//<cwd>/<path>)` in `deny`) keeps
 * its path read-only. Left out when the switch is off, when one of the write tools is denied by name
 * (a read-only switch on another arm, or the stored policy), when the base list offers none of them,
 * when a stored `requireApproval` gates one of them (an allow rule would run the call without
 * asking `canUseTool`), and in any mode but `default` (`acceptEdits` already allows these, `plan`
 * withholds Write files).
 */
export function claudeWriteFilesApprovals(
  permissions: AgentPermissions,
  tools: AgentToolPolicy,
  requireApproval: readonly string[],
  cwd: string,
): readonly string[] {
  if (!permissions.writeFiles || tools.permissionMode !== 'default') return [];
  if (CLAUDE_WRITE_TOOLS.some((tool) => tools.deny.includes(tool))) return [];
  if (CLAUDE_WRITE_TOOLS.some((tool) => needsApproval(requireApproval, tool))) return [];
  if (
    tools.base !== 'claude_code_preset' &&
    !CLAUDE_WRITE_TOOLS.some((tool) => tools.base.includes(tool))
  ) {
    return [];
  }
  return [`Edit(/${claudeRulePath(cwd)}/**)`];
}

/**
 * Paths in the workspace Write files never reaches, because Claude Code loads them on the next run
 * (`settingSources: ['project']`): its settings and skills, `.mcp.json`, and project memory
 * (`CLAUDE.md`, also in a subdirectory). Mirrors the ejected program's `WORKSPACE_KEPT`. Without
 * them, content the agent read could write instructions that every later turn in the session
 * obeys, unseen in the chat.
 */
const CLAUDE_WORKSPACE_KEPT: readonly string[] = [
  '.claude/**',
  '.mcp.json',
  'CLAUDE.md',
  '**/CLAUDE.md',
];

/**
 * The deny rules that go with {@link claudeWriteFilesApprovals}: the same rules, for the same
 * `cwd`, that keep the files Claude Code loads as instructions out of the workspace allow rule. A
 * deny wins over the allow rule.
 */
export function claudeWriteFilesDenials(cwd: string): readonly string[] {
  return CLAUDE_WORKSPACE_KEPT.map((path) => `Edit(/${claudeRulePath(cwd)}/${path})`);
}
