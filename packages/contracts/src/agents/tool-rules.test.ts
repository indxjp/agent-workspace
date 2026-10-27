import { describe, expect, it } from 'vitest';

import {
  RequireApprovalRuleSchema,
  canonicalCall,
  conflictingApprovalRules,
  needsApproval,
} from './tool-rules.js';

describe('needsApproval', () => {
  it('matches a bare rule by exact tool name', () => {
    expect(needsApproval(['Write'], 'Write')).toBe(true);
    expect(needsApproval(['Write'], 'WriteFile')).toBe(false);
    expect(needsApproval(['Write'], 'Rewrite')).toBe(false);
  });

  it('gives false for no rules', () => {
    expect(needsApproval([], 'Write')).toBe(false);
  });

  it('matches an MCP glob rule by pattern', () => {
    expect(needsApproval(['mcp__gh__*'], 'mcp__gh__create_issue')).toBe(true);
    expect(needsApproval(['mcp__gh__*'], 'mcp__ghx__a')).toBe(false);
    expect(needsApproval(['mcp__gh__*'], 'mcp__gh')).toBe(false);
    expect(needsApproval(['mcp__gh__create_?ssue'], 'mcp__gh__create_issue')).toBe(true);
    expect(needsApproval(['mcp__gh__create_?ssue'], 'mcp__gh__create_issues')).toBe(false);
  });

  it('treats regular-expression characters in a name literally', () => {
    expect(needsApproval(['mcp__a.b__*'], 'mcp__a.b__x')).toBe(true);
    expect(needsApproval(['mcp__a.b__*'], 'mcp__aXb__x')).toBe(false);
  });

  it('covers the whole tool for a scoped rule', () => {
    expect(needsApproval(['Bash(git push *)'], 'Bash')).toBe(true);
    expect(needsApproval(['Bash(git push *)'], 'Read')).toBe(false);
  });

  it('matches when any rule does', () => {
    expect(needsApproval(['Edit', 'mcp__gh__*'], 'mcp__gh__x')).toBe(true);
  });
});

function withHole(): number[] {
  const list = [1, 2, 3];
  Reflect.deleteProperty(list, 1);
  return list;
}

describe('canonicalCall', () => {
  it('sorts object keys at every depth, including inside arrays', () => {
    expect(canonicalCall('T', { b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe(
      canonicalCall('T', { a: { c: 3, d: [{ x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it('keeps array order significant', () => {
    expect(canonicalCall('T', [1, 2])).not.toBe(canonicalCall('T', [2, 1]));
  });

  it('writes the name and the input with no whitespace', () => {
    expect(canonicalCall('Write', { path: 'a b', n: [1, null, true] })).toBe(
      '{"input":{"n":[1,null,true],"path":"a b"},"name":"Write"}',
    );
  });

  it('binds the tool name', () => {
    expect(canonicalCall('Read', { a: 1 })).not.toBe(canonicalCall('Write', { a: 1 }));
  });

  it('writes numbers as ECMAScript does', () => {
    expect(canonicalCall('T', [-0, 1e21, 0.1, 4.5, 2e-3])).toBe(
      '{"input":[0,1e+21,0.1,4.5,0.002],"name":"T"}',
    );
  });

  it('sorts keys by UTF-16 code unit', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const keys = Array.from(
      canonicalCall('T', input).matchAll(/"((?:[^"\\]|\\.)*)":"[A-Z]/g),
      (match) => match[1],
    ).slice(0, -1);
    expect(keys).toEqual(['\\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
  });

  it('matches the RFC 8785 section 3.2.2 example', () => {
    const input = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '\u20ac$\u000F\nA\'B"\\"/',
      literals: [null, true, false],
    };
    expect(canonicalCall('T', input)).toBe(
      '{"input":{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\"/"},"name":"T"}',
    );
  });

  it.each([
    ['an undefined member', { a: undefined }],
    ['an undefined input', undefined],
    ['an array hole', withHole()],
    ['NaN', { a: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a bigint', { a: 1n }],
    ['a function', { a: () => 1 }],
    ['a symbol', { a: Symbol('s') }],
    ['a Date', { a: new Date(0) }],
    ['a Map', new Map()],
  ])('throws TypeError for %s', (_label, input) => {
    expect(() => canonicalCall('T', input)).toThrow(TypeError);
  });
});

describe('RequireApprovalRuleSchema', () => {
  it.each(['Write', 'mcp__gh__*', 'mcp__gh__create_issue'])('accepts %s', (rule) => {
    expect(RequireApprovalRuleSchema.safeParse(rule).success).toBe(true);
  });

  it.each([
    'Bash(git *)',
    '*',
    'mcp__*',
    '',
    'mcp__github__*_issue',
    'mcp__gh__a*b',
    'mcp__gh__x?y',
  ])('refuses %j', (rule) => {
    const result = RequireApprovalRuleSchema.safeParse(rule);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toEqual(expect.any(String));
  });

  it('names the whole tool in the scoped-rule refusal', () => {
    const result = RequireApprovalRuleSchema.safeParse('Bash(git *)');
    expect(result.error?.issues[0]?.message).toContain('"Bash"');
  });
});

describe('conflictingApprovalRules', () => {
  it('reports an exact duplicate', () => {
    expect(conflictingApprovalRules(['Write'], ['Read', 'Write'])).toEqual([1]);
  });

  it('reports a glob in either list that covers a bare rule in the other', () => {
    expect(conflictingApprovalRules(['mcp__gh__*'], ['mcp__gh__create_issue'])).toEqual([0]);
    expect(conflictingApprovalRules(['mcp__gh__create_issue'], ['mcp__gh__*'])).toEqual([0]);
  });

  it('reports a scoped autoApprove rule for the same tool', () => {
    expect(conflictingApprovalRules(['Bash(git *)'], ['Bash'])).toEqual([0]);
  });

  it('reports an Edit rule against every file-writing gate, since Claude Code checks writes against Edit rules', () => {
    for (const gated of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(conflictingApprovalRules(['Edit'], [gated])).toEqual([0]);
      expect(conflictingApprovalRules(['Edit(//ws/**)'], [gated])).toEqual([0]);
    }
    expect(conflictingApprovalRules(['Edit(//ws/**)'], ['Bash'])).toEqual([]);
  });

  it('reports nothing for disjoint rules', () => {
    expect(conflictingApprovalRules(['mcp__gh__*', 'Read'], ['mcp__jira__*', 'Write'])).toEqual([]);
    expect(conflictingApprovalRules([], ['Write'])).toEqual([]);
  });
});
