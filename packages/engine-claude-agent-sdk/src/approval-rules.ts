/**
 * Which `requireApproval` rules the compile accepts, and how an approval gate splits the
 * auto-approved rules (ADR-0145).
 *
 * Split out of `./tools.ts`, which re-exports these names: the rules about what may be gated are a
 * different concern from the rules that map permissions onto Claude's tool names.
 */
import { approvalOverlapsGate } from '@indx-workspace/contracts/agents';

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
