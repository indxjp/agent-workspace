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
  approvalOverlapsGate,
  CLAUDE_GRANT_SHELL_DENIALS,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  claudeDeniedToolsFor,
  claudeReadOnlyGrantDenials,
  claudeRulePath,
} from '@indx-workspace/contracts/agents';
import type { AgentPermissions, AgentToolPolicy } from '@indx-workspace/contracts/agents';
import { normaliseGrants, type EngineFileGrant } from '@agent-workspace/engine';

import type { CompiledSdkOptions } from './options.js';

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

/** The text before a glob rule's first `*` or `?`, or `null` for a rule whose tool name has none. */
function globPrefix(rule: string): string | null {
  const head = rule.split('(', 1)[0] ?? rule;
  const index = head.search(/[*?]/u);
  return index === -1 ? null : head.slice(0, index);
}

/**
 * The Claude tools a `requireApproval` rule may name: the ones the SDK sends through `canUseTool` in
 * `permissionMode: 'default'`, plus every connector tool (`mcp__…`).
 *
 * Pitfall: in `default` mode the SDK runs its read-only tools (`Read`, `Glob`, `Grep`, …) without
 * calling `canUseTool`, so a gate on one of them would be accepted and never asked. This is an
 * allowlist rather than a denylist so a tool a later SDK adds fails closed instead of running
 * ungated.
 */
export const CLAUDE_APPROVABLE_TOOLS: readonly string[] = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

/**
 * Is `rule` a connector gate Claude Code's own rule matcher can match: an exact connector tool name,
 * or exactly `mcp__<server>__*`? A partial glob (`mcp__gh__*_issue`, `mcp__gh__x?y`) is not: the
 * `ask` rule a gated run compiles it to would never match, so a workspace allow rule would settle
 * the call before `canUseTool`.
 */
function isConnectorGate(rule: string): boolean {
  if (!rule.startsWith('mcp__')) return false;
  const rest = rule.slice('mcp__'.length);
  if (!/[*?]/u.test(rest)) return true;
  const server = rest.slice(0, -'__*'.length);
  return rest.endsWith('__*') && !/[*?]/u.test(server) && !server.includes('__');
}

/**
 * The `requireApproval` rules the compile refuses, in order: a tool `canUseTool` would never be
 * asked about (see {@link CLAUDE_APPROVABLE_TOOLS}), or a connector glob Claude Code cannot match
 * (see {@link isConnectorGate}).
 */
export function unapprovableRules(requireApproval: readonly string[]): readonly string[] {
  return requireApproval.filter(
    (rule) => !isConnectorGate(rule) && !CLAUDE_APPROVABLE_TOOLS.includes(rule),
  );
}

/**
 * Move out of `autoApprove` every rule that could approve a tool `requireApproval` gates.
 *
 * `allowedTools` bypasses `canUseTool`: a rule left in it would auto-approve a gated call without
 * asking, which is what an assigned connector's `mcp__<server>__*` does to a gated tool of that
 * server, and what an `Edit(//…)` rule does to a gated `Write` (Claude Code checks every file write
 * against `Edit` rules). A rule is moved when it overlaps a gated rule by `approvalOverlapsGate`, or
 * when it and a gated rule are both globs whose literal prefixes are prefix-compatible, which
 * over-approximates glob intersection (`mcp__gh__a*` against `mcp__gh__*b`) and closes the partial
 * glob case `conflictingApprovalRules` leaves open. Over-moving only costs an extra decision in
 * `canUseTool`; under-moving would skip an approval.
 *
 * `deferred` keeps the moved rules in order: `canUseTool` still allows a tool they cover that no
 * gated rule names, so an unattended run keeps what the wildcard used to approve.
 */
export function splitApprovals(
  autoApprove: readonly string[],
  requireApproval: readonly string[],
): { readonly allowedTools: readonly string[]; readonly deferred: readonly string[] } {
  if (requireApproval.length === 0) return { allowedTools: autoApprove, deferred: [] };
  const gatedPrefixes = requireApproval.flatMap((rule) => globPrefix(rule) ?? []);
  const overlapsGate = (rule: string): boolean => {
    if (requireApproval.some((gated) => approvalOverlapsGate(rule, gated))) return true;
    const prefix = globPrefix(rule);
    return (
      prefix !== null &&
      gatedPrefixes.some((gated) => gated.startsWith(prefix) || prefix.startsWith(gated))
    );
  };
  return {
    allowedTools: autoApprove.filter((rule) => !overlapsGate(rule)),
    deferred: autoApprove.filter(overlapsGate),
  };
}

/**
 * Does `rule` deny editing `target`, an absolute path in Claude's POSIX form?
 *
 * Read the way Claude Code reads it: only an `Edit(…)` path rule is consulted for a file write, and
 * only `//` makes its path absolute. Any other anchor answers `false`, so a rule this check cannot
 * place counts as protecting nothing rather than as protecting the grant.
 */
function editRuleCovers(rule: string, target: string): boolean {
  if (!rule.startsWith('Edit(//') || !rule.endsWith(')')) return false;
  const pattern = rule.slice('Edit(/'.length, -1);
  if (pattern.endsWith('/**')) {
    const root = pattern.slice(0, -3);
    return target === root || target.startsWith(`${root}/`);
  }
  return target === pattern;
}

/**
 * Does a compiled Claude options object let the agent write `path` (workspace-relative)?
 *
 * The adapter's own reading of its own tool grammar, which is what the conformance kit asks when it
 * checks that a read-only grant is not writable and that a permission switch is honoured: a write
 * is possible when no `Edit(//…)` rule covers the path and some of {@link CLAUDE_WRITE_TOOLS} is not
 * denied by name, or when a shell tool is not denied at all. A path this adapter cannot normalise answers `false` — nothing the
 * engine could be told to write there would be inside the workspace.
 */
export function claudeOptionsAllowWrite(options: CompiledSdkOptions, path: string): boolean {
  const normalised = normaliseGrants([{ kind: 'file', path, access: 'read-write' }]);
  if (!normalised.ok) return false;
  const target = `${claudeRulePath(options.cwd)}/${normalised.grants[0]?.path ?? ''}`;
  const deny = options.disallowedTools;
  const editDenied = deny.some((rule) => editRuleCovers(rule, target));
  const writeToolsRemoved = CLAUDE_WRITE_TOOLS.every((tool) => deny.includes(tool));
  if (!editDenied && !writeToolsRemoved) return true;
  return !CLAUDE_SHELL_TOOLS.every((tool) => deny.includes(tool));
}

/**
 * The Claude tools each of §17 Step 4's four switches governs, so the conformance kit can ask an
 * adapter whether its compiled options still honour one.
 *
 * It is the *read-back* half of {@link compileClaudeToolPolicy}, and it is deliberately not derived
 * from `CLAUDE_PERMISSION_TOOL_DENIALS` by a loop over the same table: the kit's question is "does
 * this compile forbid what the switch forbids", and answering it from the very table the compile
 * used would make the scenario a tautology. It asks about one representative tool per switch, by
 * name, the way a person checking the run would.
 */
const CLAUDE_PERMISSION_WITNESS_TOOLS = {
  readFiles: 'Read',
  writeFiles: 'Write',
  runCommands: 'Bash',
  unrestrictedNetwork: 'WebFetch',
} as const;

/**
 * Does a compiled Claude options object still allow what this permission switch governs?
 *
 * The conformance kit's `permissionAllowed`. A switch that is off must leave its witness tool
 * denied outright — not narrowed over a path, not merely un-approved, since `allowedTools` grants
 * and does not restrict (R-01 §10).
 */
export function claudeOptionsAllowPermission(
  options: CompiledSdkOptions,
  permission: keyof typeof CLAUDE_PERMISSION_WITNESS_TOOLS,
): boolean {
  const tool = CLAUDE_PERMISSION_WITNESS_TOOLS[permission];
  return !options.disallowedTools.includes(tool);
}
