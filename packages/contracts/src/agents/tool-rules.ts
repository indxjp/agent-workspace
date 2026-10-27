import { z } from 'zod';

import type { AgentPermissions } from './permissions.js';
import { claudeDeniedToolsFor } from '../engine-catalogue.js';

// ── Agent policy (S-13; spec §5.9, §17 Step 4) ──────────────────────────────────────────

/**
 * Glob metacharacters and name grammar the SDK's tool-rule syntax recognises (R-01 §10). This is
 * the only copy: `packages/core` and the Claude adapter import it from here (the contracts package
 * itself imports neither, so it stays a dependency-light, framework-free wire layer).
 */
const TOOL_RULE_GLOB_CHARS = /[*?]/;
const TOOL_RULE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A single `_` between two other characters is allowed; `__` and an edge `_` are not (SD13). */
const TOOL_RULE_MCP_SERVER_NAME = /^[A-Za-z0-9](?:_?[A-Za-z0-9-])*$/;
export const TOOL_RULE_MCP_PREFIX = 'mcp__';

type ParsedAgentToolRule =
  | { readonly kind: 'bare' }
  | { readonly kind: 'scoped' }
  | { readonly kind: 'mcp-glob' }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Parse one `allowedTools` / `disallowedTools` / `tools` entry against the R-01 §10 grammar. */
export function parseAgentToolRule(input: string): ParsedAgentToolRule {
  if (input.length === 0) return { kind: 'invalid', reason: 'a tool rule must not be empty' };
  if (input !== input.trim()) {
    return {
      kind: 'invalid',
      reason: `the tool rule ${JSON.stringify(input)} has leading or trailing whitespace`,
    };
  }

  let head = input;
  let specifier: string | null = null;
  const open = input.indexOf('(');
  if (open !== -1) {
    if (!input.endsWith(')')) {
      return {
        kind: 'invalid',
        reason: `the tool rule ${JSON.stringify(input)} opens a specifier with '(' but never closes it`,
      };
    }
    head = input.slice(0, open);
    specifier = input.slice(open + 1, -1);
    if (head.length === 0) {
      return {
        kind: 'invalid',
        reason: `the tool rule ${JSON.stringify(input)} has no tool name before '('`,
      };
    }
    if (specifier.length === 0) {
      return {
        kind: 'invalid',
        reason: `the tool rule ${JSON.stringify(input)} has an empty specifier; drop the parentheses to mean "every call"`,
      };
    }
    if (specifier.includes(')')) {
      return {
        kind: 'invalid',
        reason: `the tool rule ${JSON.stringify(input)} has a ')' inside its specifier`,
      };
    }
  }

  if (head.startsWith(TOOL_RULE_MCP_PREFIX)) {
    const rest = head.slice(TOOL_RULE_MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    const server = sep === -1 ? rest : rest.slice(0, sep);
    const tool = sep === -1 ? null : rest.slice(sep + 2);
    if (server.length === 0 || TOOL_RULE_GLOB_CHARS.test(server)) return { kind: 'wildcard' };
    if (!TOOL_RULE_MCP_SERVER_NAME.test(server)) {
      return {
        kind: 'invalid',
        reason: `${JSON.stringify(input)} names the MCP server ${JSON.stringify(server)}, which is not a valid server name`,
      };
    }
    if (tool === null || tool.length === 0) {
      return {
        kind: 'invalid',
        reason: `${JSON.stringify(input)} names an MCP server but no tool; write 'mcp__${server}__<tool>' or 'mcp__${server}__*'`,
      };
    }
    if (TOOL_RULE_GLOB_CHARS.test(tool)) {
      if (specifier !== null) {
        return {
          kind: 'invalid',
          reason: `${JSON.stringify(input)} combines an MCP tool glob with a '(specifier)', which the rule grammar does not support`,
        };
      }
      return { kind: 'mcp-glob' };
    }
    return specifier === null ? { kind: 'bare' } : { kind: 'scoped' };
  }

  if (TOOL_RULE_GLOB_CHARS.test(head)) return { kind: 'wildcard' };
  if (!TOOL_RULE_TOOL_NAME.test(head)) {
    return {
      kind: 'invalid',
      reason: `${JSON.stringify(head)} is not a tool name: expected a letter followed by letters, digits or underscores`,
    };
  }
  return specifier === null ? { kind: 'bare' } : { kind: 'scoped' };
}

/** A rule's tool name: everything before its `(specifier)`. */
export function toolRuleHead(rule: string): string {
  const open = rule.indexOf('(');
  return open === -1 ? rule : rule.slice(0, open);
}

/**
 * A rule that is allowed to *grant* something: `tools` and `allowedTools`. Rejects an unanchored
 * wildcard — R-01 §10: the SDK ignores it in an allow list with a startup warning, so it grants
 * nothing, and storing one would be storing a permission nobody actually has.
 */
export const GrantingToolRuleSchema = z.string().superRefine((value, ctx) => {
  const parsed = parseAgentToolRule(value);
  if (parsed.kind === 'invalid') {
    ctx.addIssue({ code: 'custom', message: parsed.reason });
    return;
  }
  if (parsed.kind === 'wildcard') {
    ctx.addIssue({
      code: 'custom',
      message: `${JSON.stringify(value)} is an unanchored wildcard. R-01 §10: the SDK ignores it in an allow list with a startup warning, so it grants nothing. Name the tools, or anchor it as 'mcp__<server>__*'.`,
    });
  }
});

/** Whether `toolName` matches `glob`, where `*` is any run of characters and `?` any one. */
function globMatches(glob: string, toolName: string): boolean {
  const source = Array.from(glob, (char) => {
    if (char === '*') return '[\\s\\S]*';
    if (char === '?') return '[\\s\\S]';
    return char.replace(/[\\^$.+()[\]{}|]/g, '\\$&');
  }).join('');
  return new RegExp(`^${source}$`, 'u').test(toolName);
}

/**
 * Whether `rule` names `toolName`, by tool name alone. A glob head (`mcp__gh__*`) matches by
 * pattern, any other rule by equality. A scoped rule (`Bash(git *)`) covers its whole tool: this
 * decision never sees the call's input, and over-matching asks too often where under-matching would
 * skip an approval.
 */
function ruleCoversTool(rule: string, toolName: string): boolean {
  const head = toolRuleHead(rule);
  return TOOL_RULE_GLOB_CHARS.test(head) ? globMatches(head, toolName) : head === toolName;
}

/**
 * Whether a call to `toolName` needs a human's approval under `rules` (ADR-0145 D3). The one
 * decision: the engine's `canUseTool` and the gateway's write backstop both call it, so they cannot
 * disagree. Pure; it reads the tool name only.
 */
export function needsApproval(rules: readonly string[], toolName: string): boolean {
  return rules.some((rule) => ruleCoversTool(rule, toolName));
}

/**
 * A rule that is allowed to *require approval*: `engine.requireApproval` (ADR-0145 D3). A granting
 * rule, minus the scoped form: {@link needsApproval} decides by tool name, so `Bash(git push *)`
 * could only be honoured by gating every `Bash` call, and a rule is refused rather than widened.
 */
export const RequireApprovalRuleSchema = GrantingToolRuleSchema.superRefine((value, ctx) => {
  const kind = parseAgentToolRule(value).kind;
  if (kind === 'scoped') {
    ctx.addIssue({
      code: 'custom',
      message: `${JSON.stringify(value)} has a '(specifier)'. Approval is decided by tool name, so name the whole tool: ${JSON.stringify(toolRuleHead(value))}.`,
    });
  }
  // Claude Code permission rules match a connector tool only by exact name or `mcp__<server>__*`, so
  // the `ask` rule a partial glob compiles to would never match and a workspace allow rule would win.
  if (kind === 'mcp-glob') {
    const rest = value.slice(TOOL_RULE_MCP_PREFIX.length);
    const server = rest.slice(0, rest.indexOf('__'));
    if (rest !== `${server}__*`) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(value)} is a partial connector glob. Claude Code matches a connector tool only by its exact name or by 'mcp__${server}__*', so name the tool or gate the whole server.`,
      });
    }
  }
});

/**
 * The Claude tools an `Edit` / `Edit(path)` allow rule approves: Claude Code checks every built-in
 * file write against `Edit` rules, so `autoApprove: ['Edit(//ws/**)']` approves a `Write` call too.
 */
const CLAUDE_EDIT_RULE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Whether the auto-approval `approved` and the gate `required` could both match one tool: each is
 * tested against the other's tool name, and an `Edit` rule against every tool it approves
 * ({@link CLAUDE_EDIT_RULE_TOOLS}).
 */
export function approvalOverlapsGate(approved: string, required: string): boolean {
  const approvedHead = toolRuleHead(approved);
  return (
    ruleCoversTool(approved, toolRuleHead(required)) ||
    ruleCoversTool(required, approvedHead) ||
    (approvedHead === 'Edit' &&
      CLAUDE_EDIT_RULE_TOOLS.some((tool) => ruleCoversTool(required, tool)))
  );
}

/**
 * The indexes of `requireApproval` rules that also match an `autoApprove` rule (ADR-0145 D3: "a tool
 * that matches both lists is refused when the agent is saved"), by {@link approvalOverlapsGate}.
 */
export function conflictingApprovalRules(
  autoApprove: readonly string[],
  requireApproval: readonly string[],
): number[] {
  // ponytail: two partial globs (`mcp__gh__a*`, `mcp__gh__*b`) can overlap unreported; safe at run time
  // because the Claude adapter's `splitApprovals` also moves prefix-compatible globs. Upgrade: glob intersection.
  const conflicts: number[] = [];
  for (const [index, required] of requireApproval.entries()) {
    if (autoApprove.some((approved) => approvalOverlapsGate(approved, required))) {
      conflicts.push(index);
    }
  }
  return conflicts;
}

/**
 * The canonical JSON text of a JSON value (RFC 8785): object members sorted by UTF-16 code unit,
 * no whitespace, numbers and strings as ECMAScript serialises them (`-0` is `0`). Anything that is
 * not JSON throws rather than being dropped or coerced, so two different values never share a key.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${String(value)} is not a JSON number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`array hole at index ${index}`);
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('only plain objects are JSON values');
    }
    const members = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`a ${typeof value} is not a JSON value`);
}

/**
 * The canonical text of one tool call, `{"input":…,"name":…}` in RFC 8785 canonical JSON, so one
 * approval binds a tool name and its exact arguments (ADR-0145 D2.1). It is not hashed; the digest is
 * taken where the request is stored.
 *
 * @throws {TypeError} when `input` is not a JSON value (`undefined`, a non-finite number, a bigint, a
 *   function, a symbol, a non-plain object such as a `Date` or `Map`, an array hole). A caller deciding
 *   whether to run a call must treat the throw as "needs approval", never as "allowed".
 */
export function canonicalCall(name: string, input: unknown): string {
  return canonicalJson({ input, name });
}

/** A rule that is allowed to *remove* something: `disallowedTools`. The wildcard arm is legitimate here. */
export const DenyingToolRuleSchema = z.string().superRefine((value, ctx) => {
  const parsed = parseAgentToolRule(value);
  if (parsed.kind === 'invalid') ctx.addIssue({ code: 'custom', message: parsed.reason });
});

/**
 * The SDK's `PermissionMode`, verbatim from `sdk.d.ts` (R-01 §3, §10). The only copy of the list;
 * `tests/sdk-surface.test.ts` pins it to the installed `sdk.d.ts`.
 */
export const AGENT_TOOL_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;
export type AgentToolPermissionMode = (typeof AGENT_TOOL_PERMISSION_MODES)[number];
export const AgentToolPermissionModeSchema = z.enum(AGENT_TOOL_PERMISSION_MODES);

/**
 * §17 Step 4's SDK-facing detail. The four checkboxes are only the human-facing summary, and spec
 * §6's mapping table is incomplete where it says "Tool permissions → `allowedTools`": R-01 §10
 * established that `allowedTools` only auto-approves — it does not restrict, and it does not
 * constrain `bypassPermissions`. Restriction requires `base` and/or `deny`, and the locked-down
 * pairing is an allow-list plus `permissionMode: 'dontAsk'`; the correction is recorded in
 * `docs/adr/W1-CORE-01-tool-permissions-correct-spec-6.md`.
 *
 *   * `base` is the SDK's `tools`: the surface the model can see at all, and the field that
 *     restricts. `'claude_code_preset'` compiles to the Claude adapter's `CLAUDE_PRESET_TOOLS`
 *     allow-list, not the SDK's whole `claude_code` preset (BH061-010).
 *   * `autoApprove` is its `allowedTools`: auto-approvals. Grants no tool that `base` does not
 *     expose.
 *   * `deny` is its `disallowedTools`: hard removals — the definition never reaches the model.
 *
 * R-01 §10: `bypassPermissions` additionally requires `allowDangerouslySkipPermissions: true`,
 * and nothing else may set that flag. This is the only copy of the cross-field rule.
 */
export const AgentToolPolicySchema = z
  .object({
    base: z.union([z.literal('claude_code_preset'), z.array(GrantingToolRuleSchema).readonly()]),
    autoApprove: z.array(GrantingToolRuleSchema).readonly(),
    deny: z.array(DenyingToolRuleSchema).readonly(),
    permissionMode: AgentToolPermissionModeSchema,
    allowDangerouslySkipPermissions: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bypassing = value.permissionMode === 'bypassPermissions';
    if (bypassing && !value.allowDangerouslySkipPermissions) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowDangerouslySkipPermissions'],
        message:
          "permissionMode 'bypassPermissions' requires allowDangerouslySkipPermissions: true (R-01 §10). Set it deliberately or choose another mode.",
      });
    }
    if (!bypassing && value.allowDangerouslySkipPermissions) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowDangerouslySkipPermissions'],
        message: `allowDangerouslySkipPermissions is only meaningful with permissionMode 'bypassPermissions'; this policy uses '${value.permissionMode}'.`,
      });
    }
  })
  .readonly();

export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>;

/**
 * The Claude tool policy an agent with **no stored policy** runs under: the permission floor, and
 * nothing else.
 *
 * `base` stays the Claude Code preset because §5 makes the SDK's own tool surface the product, and
 * `permissionMode` stays `default` because every other mode is a decision a screen has to offer
 * before anything may take it. `allowDangerouslySkipPermissions` is never set — R-01 §10 makes it
 * the one flag `bypassPermissions` additionally requires, and nothing in this platform has a
 * reason to reach for either.
 *
 * `autoApprove` is empty here on purpose: the `mcp__<server>__*` approvals a run gets for its
 * assigned connectors are a *run-time* layer applied by the engine adapter, not a property of the
 * agent's stored policy. See {@link AgentPolicySchema}'s note about what `GET` does not show.
 */
export function claudeBaseToolPolicyFor(permissions: AgentPermissions): AgentToolPolicy {
  return {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: claudeDeniedToolsFor(permissions),
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  };
}
