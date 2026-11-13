/**
 * Reading a compiled Claude options object back through this adapter's own tool grammar: what the
 * conformance kit asks to learn whether a read-only grant stays unwritable and a permission switch
 * stays honoured.
 *
 * Split out of `./tools.ts`, which holds the forward mapping these functions read back.
 */
import { claudeRulePath } from '@indx-workspace/contracts/agents';
import { normaliseGrants } from '@agent-workspace/engine';

import type { CompiledSdkOptions } from './options.js';
import { CLAUDE_SHELL_TOOLS, CLAUDE_WRITE_TOOLS } from './tools.js';

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
