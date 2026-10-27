import { describe, expect, it } from 'vitest';

import { ClaudeRunPolicy } from './policy.js';

const tools = {
  base: ['Read'],
  autoApprove: [],
  deny: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
};

function issuesOf(value: unknown): readonly { path: string; message: string }[] | null {
  const result = ClaudeRunPolicy.safeParse(value);
  return result.success
    ? null
    : result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('ClaudeRunPolicy parses its tools arm with the contracts grammar', () => {
  it('accepts a well-formed policy and a null one', () => {
    expect(ClaudeRunPolicy.safeParse({ tools }).success).toBe(true);
    expect(ClaudeRunPolicy.safeParse({ tools: null }).success).toBe(true);
  });

  it('refuses an unanchored wildcard in the allow list', () => {
    expect(
      issuesOf({ tools: { base: ['*'], autoApprove: [], deny: [], permissionMode: 'default' } }),
    ).toEqual([
      {
        path: 'tools.base.0',
        message: `"*" is an unanchored wildcard. R-01 §10: the SDK ignores it in an allow list with a startup warning, so it grants nothing. Name the tools, or anchor it as 'mcp__<server>__*'.`,
      },
    ]);
  });

  it('refuses bypassPermissions without allowDangerouslySkipPermissions: true', () => {
    expect(issuesOf({ tools: { ...tools, permissionMode: 'bypassPermissions' } })).toEqual([
      {
        path: 'tools.allowDangerouslySkipPermissions',
        message:
          "permissionMode 'bypassPermissions' requires allowDangerouslySkipPermissions: true (R-01 §10). Set it deliberately or choose another mode.",
      },
    ]);
  });

  it('refuses a malformed fileGrantDeny rule', () => {
    expect(issuesOf({ tools: null, fileGrantDeny: ['Read('] })).toEqual([
      {
        path: 'fileGrantDeny.0',
        message: `the tool rule "Read(" opens a specifier with '(' but never closes it`,
      },
    ]);
  });
});

describe('ClaudeRunPolicy handoff (ADR-0145 D4)', () => {
  it('defaults to off and accepts the opt-in', () => {
    expect(ClaudeRunPolicy.parse({ tools: null }).handoff).toBe(false);
    expect(ClaudeRunPolicy.parse({ tools: null, handoff: true }).handoff).toBe(true);
    expect(ClaudeRunPolicy.safeParse({ tools: null, handoff: 'yes' }).success).toBe(false);
  });
});

describe('ClaudeRunPolicy approval fields (ADR-0145)', () => {
  it('defaults both to empty', () => {
    const parsed = ClaudeRunPolicy.parse({ tools: null });
    expect(parsed.requireApproval).toEqual([]);
    expect(parsed.approvedToolCalls).toEqual([]);
  });

  it('accepts whole-tool rules and approved call texts', () => {
    expect(
      ClaudeRunPolicy.safeParse({
        tools: null,
        requireApproval: ['Write', 'mcp__gh__push'],
        approvedToolCalls: ['{"input":{},"name":"Write"}'],
      }).success,
    ).toBe(true);
  });

  it('refuses a scoped rule, because approval is decided by tool name', () => {
    const issues = issuesOf({ tools: null, requireApproval: ['Bash(git push *)'] });
    expect(issues?.map((issue) => issue.path)).toEqual(['requireApproval.0']);
    expect(issues?.[0]?.message).toContain('name the whole tool');
  });

  it('refuses an empty approved call text', () => {
    expect(issuesOf({ tools: null, approvedToolCalls: [''] })?.[0]?.path).toBe(
      'approvedToolCalls.0',
    );
  });
});
