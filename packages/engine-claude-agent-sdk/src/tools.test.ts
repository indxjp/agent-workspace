/**
 * The Claude tool mapping (ENG-04b, #325).
 *
 * This is where #324's Deviation 7 is discharged, and the assertions are written as the *old*
 * behaviour rather than as the new code's shape: every case below states what
 * `apps/web/server/compose/run-request.ts`'s `toolPolicyFor` / `agentConfigFor` /
 * `applyFileGrantPolicy` produced before the move, so a difference in the compiled lists is a
 * failing test rather than a changed run.
 *
 * The array *order* is asserted with `toEqual`, never with `toContain`, because `allowedTools` and
 * `disallowedTools` reach the SDK as arrays and this unit's claim is that they are byte-identical.
 */
import { describe, expect, it } from 'vitest';

import type { AgentPermissions, AgentToolPolicy } from '@indx-workspace/contracts/agents';
import { RESERVED_MCP_SERVER_KEYS } from '@indx-workspace/contracts/tool-connectors';

import {
  CLAUDE_SHELL_TOOLS,
  CLAUDE_WRITE_TOOLS,
  claudeFileGrantDenials,
  claudeMcpAutoApprovals,
  claudeOptionsAllowPermission,
  claudeOptionsAllowWrite,
  compileClaudeToolPolicy,
  splitApprovals,
  unapprovableRules,
} from './tools.js';
import type { CompiledSdkOptions } from './options.js';
import { CLAUDE_SKILL_SCRIPT_SERVER } from './skill-script.js';

const ALL_ON: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

const NO_SHELL: AgentPermissions = { ...ALL_ON, runCommands: false };

const STORED: AgentToolPolicy = {
  base: ['Read', 'Grep'],
  autoApprove: ['Read'],
  deny: ['WebFetch'],
  permissionMode: 'dontAsk',
  allowDangerouslySkipPermissions: false,
};

const CWD = '/workspace/tenant-a/session-1';

describe('compileClaudeToolPolicy with no stored policy', () => {
  it('is the permission floor and nothing else — the pre-ENG-04b `toolPolicyFor` answer', () => {
    expect(
      compileClaudeToolPolicy(NO_SHELL, { stored: null, fileGrantDeny: [], mcpServers: {} }),
    ).toEqual({
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash', 'BashOutput', 'KillShell'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    });
  });

  it('auto-approves every assigned connector, in sorted record-key order', () => {
    const compiled = compileClaudeToolPolicy(ALL_ON, {
      stored: null,
      fileGrantDeny: [],
      mcpServers: { zulip: {}, asana: {}, github: {} },
    });
    // Sorted, not in record order: `allowedTools` is compared byte for byte and a JavaScript
    // object's key order is an accident of how the record was built.
    expect(compiled.autoApprove).toEqual(['mcp__asana__*', 'mcp__github__*', 'mcp__zulip__*']);
  });

  it('builds the approval from the record key the SDK derives tool names from', () => {
    expect(claudeMcpAutoApprovals({ 'connector-9f3': {} })).toEqual(['mcp__connector-9f3__*']);
    expect(claudeMcpAutoApprovals({})).toEqual([]);
  });

  it('keeps the skill-script server out of the keys a connector may take (#1109)', () => {
    // Compose keys an MCP connector by its name unless the name is reserved here; a rename of the
    // server must change that list, or a connector named like it would replace the server.
    expect(RESERVED_MCP_SERVER_KEYS).toContain(CLAUDE_SKILL_SCRIPT_SERVER);
  });
});

describe('compileClaudeToolPolicy with a stored policy (S-13: strictly narrowing)', () => {
  it('unions the permission floor into the stored deny rather than letting it replace them', () => {
    const compiled = compileClaudeToolPolicy(NO_SHELL, {
      stored: STORED,
      fileGrantDeny: [],
      mcpServers: {},
    });
    // Stored first, then the floor — the order `agentConfigFor` produced.
    expect(compiled.deny).toEqual(['WebFetch', 'Bash', 'BashOutput', 'KillShell']);
    expect(compiled.base).toEqual(['Read', 'Grep']);
    expect(compiled.permissionMode).toBe('dontAsk');
  });

  it('cannot re-grant a tool the permission checkboxes deny', () => {
    // A Builder who auto-approves `Bash` on an agent whose `runCommands` is off gets an approval
    // for a tool that is also denied — and `disallowedTools` wins in the SDK (R-01 §10). The
    // approval is kept rather than dropped, exactly as it was before the move.
    const compiled = compileClaudeToolPolicy(NO_SHELL, {
      stored: { ...STORED, autoApprove: ['Bash'] },
      fileGrantDeny: [],
      mcpServers: {},
    });
    expect(compiled.deny).toContain('Bash');
    expect(compiled.autoApprove).toEqual(['Bash']);
  });

  it('de-duplicates in order, so a rule the stored policy and the floor share appears once', () => {
    const compiled = compileClaudeToolPolicy(NO_SHELL, {
      stored: { ...STORED, deny: ['Bash', 'WebFetch'] },
      fileGrantDeny: [],
      mcpServers: {},
    });
    expect(compiled.deny).toEqual(['Bash', 'WebFetch', 'BashOutput', 'KillShell']);
  });

  it('keeps a stored dangerous flag and mode rather than overriding them with the floor', () => {
    const compiled = compileClaudeToolPolicy(ALL_ON, {
      stored: {
        ...STORED,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
      fileGrantDeny: [],
      mcpServers: {},
    });
    expect(compiled.permissionMode).toBe('bypassPermissions');
    expect(compiled.allowDangerouslySkipPermissions).toBe(true);
  });
});

describe('claudeFileGrantDenials', () => {
  it('denies the write tools over each read-only grant and the shell tools once', () => {
    const derived = claudeFileGrantDenials(
      CWD,
      [
        { kind: 'file', path: 'notes/plan.md', access: 'read' },
        { kind: 'directory', path: 'docs', access: 'read' },
        { kind: 'file', path: 'scratch.md', access: 'read-write' },
      ],
      '.claude',
    );
    // Byte-identical to what compose's `applyFileGrantPolicy` writes, which is what lets the two be
    // de-duplicated into one list.
    expect(derived).toEqual({
      ok: true,
      deny: [
        `Edit(/${CWD}/notes/plan.md)`,
        `Edit(/${CWD}/docs/**)`,
        'Bash',
        'BashOutput',
        'KillShell',
      ],
    });
  });

  it('writes a Windows working directory in the POSIX form Claude Code matches against', () => {
    const derived = claudeFileGrantDenials(
      'C:\\aw\\s\\',
      [{ kind: 'directory', path: 'docs', access: 'read' }],
      '.claude',
    );
    expect(derived.ok && derived.deny[0]).toBe('Edit(//c/aw/s/docs/**)');
  });

  it('denies nothing when no grant is read-only', () => {
    expect(
      claudeFileGrantDenials(
        CWD,
        [{ kind: 'file', path: 'a.md', access: 'read-write' }],
        '.claude',
      ),
    ).toEqual({ ok: true, deny: [] });
    expect(claudeFileGrantDenials(CWD, [], '.claude')).toEqual({ ok: true, deny: [] });
  });

  it('normalises the path before writing a rule over it', () => {
    const derived = claudeFileGrantDenials(
      CWD,
      [{ kind: 'directory', path: './docs/../docs/', access: 'read' }],
      '.claude',
    );
    expect(derived.ok && derived.deny[0]).toBe(`Edit(/${CWD}/docs/**)`);
  });

  it('refuses a grant that escapes the workspace or names the engine configuration directory', () => {
    for (const path of ['../../etc', '/etc/passwd', '.claude/settings.json', 'x/../.claude/x']) {
      const refused = claudeFileGrantDenials(
        CWD,
        [{ kind: 'file', path, access: 'read' }],
        '.claude',
      );
      expect(refused.ok, path).toBe(false);
    }
  });

  it('folds the grant denials in after the floor, so a granted run keeps its floor order', () => {
    const grants = claudeFileGrantDenials(
      CWD,
      [{ kind: 'file', path: 'secret.md', access: 'read' }],
      '.claude',
    );
    if (!grants.ok) throw new Error(grants.reason);
    expect(
      compileClaudeToolPolicy(NO_SHELL, {
        stored: null,
        fileGrantDeny: grants.deny,
        mcpServers: {},
      }).deny,
    ).toEqual(['Bash', 'BashOutput', 'KillShell', `Edit(/${CWD}/secret.md)`]);
  });
});

describe("reading a compiled options object back through this adapter's own grammar", () => {
  function options(deny: readonly string[]): CompiledSdkOptions {
    return {
      cwd: CWD,
      env: {},
      settingSources: ['project'],
      strictMcpConfig: true,
      mcpServers: {},
      permissionMode: 'default',
      allowedTools: [],
      disallowedTools: deny,
    };
  }

  it('sees a write as possible when any write tool is left and a shell tool is available', () => {
    expect(claudeOptionsAllowWrite(options([]), 'docs/a.md')).toBe(true);
    expect(claudeOptionsAllowWrite(options(['Write']), 'docs/a.md')).toBe(true);
  });

  it('sees a write as impossible when every write tool and every shell tool is denied', () => {
    expect(
      claudeOptionsAllowWrite(options([...CLAUDE_WRITE_TOOLS, ...CLAUDE_SHELL_TOOLS]), 'docs/a.md'),
    ).toBe(false);
  });

  it('reads a path-scoped denial as covering the path and its descendants, by segment', () => {
    const deny = [`Edit(/${CWD}/docs/**)`, ...CLAUDE_SHELL_TOOLS];
    expect(claudeOptionsAllowWrite(options(deny), 'docs/a.md')).toBe(false);
    expect(claudeOptionsAllowWrite(options(deny), 'docs/deep/b.md')).toBe(false);
    // `docs-private` starts with `docs` as text and is a different directory as a path.
    expect(claudeOptionsAllowWrite(options(deny), 'docs-private/b.md')).toBe(true);
  });

  it('reads only an absolute Edit rule as protecting a path, the way Claude Code does', () => {
    // A single leading `/` anchors at the settings source, so `Edit(<cwd>/docs/**)` would mean
    // `<cwd>/<cwd>/docs/**`; and Claude Code never consults a `Write(path)` rule.
    for (const unmatched of [`Edit(${CWD}/docs/**)`, `Write(/${CWD}/docs/**)`]) {
      expect(
        claudeOptionsAllowWrite(options([unmatched, ...CLAUDE_SHELL_TOOLS]), 'docs/a.md'),
        unmatched,
      ).toBe(true);
    }
  });

  it('answers false for a path it cannot normalise, rather than guessing', () => {
    expect(claudeOptionsAllowWrite(options([]), '../../etc/passwd')).toBe(false);
  });

  it('reads each permission switch back off the witness tool the compile denies', () => {
    const off = compileClaudeToolPolicy(
      { readFiles: false, writeFiles: false, runCommands: false, unrestrictedNetwork: false },
      { stored: null, fileGrantDeny: [], mcpServers: {} },
    );
    const on = compileClaudeToolPolicy(ALL_ON, {
      stored: null,
      fileGrantDeny: [],
      mcpServers: {},
    });
    for (const permission of [
      'readFiles',
      'writeFiles',
      'runCommands',
      'unrestrictedNetwork',
    ] as const) {
      expect(claudeOptionsAllowPermission(options(off.deny), permission), permission).toBe(false);
      expect(claudeOptionsAllowPermission(options(on.deny), permission), permission).toBe(true);
    }
  });
});

describe('unapprovableRules (ADR-0145)', () => {
  it('refuses a partial connector glob, which Claude Code permission rules cannot match', () => {
    expect(unapprovableRules(['mcp__github__*_issue', 'mcp__gh__a*b', 'mcp__gh__x?y'])).toEqual([
      'mcp__github__*_issue',
      'mcp__gh__a*b',
      'mcp__gh__x?y',
    ]);
  });

  it('accepts a whole-server glob and an exact connector tool', () => {
    expect(unapprovableRules(['mcp__gh__*', 'mcp__gh__create_issue', 'Bash'])).toEqual([]);
  });
});

describe('splitApprovals (ADR-0145)', () => {
  it('leaves autoApprove untouched without requireApproval', () => {
    expect(splitApprovals(['Read', 'mcp__gh__*'], [])).toEqual({
      allowedTools: ['Read', 'mcp__gh__*'],
      deferred: [],
    });
  });

  it('moves a rule that covers a gated tool out of allowedTools, keeping the rest', () => {
    expect(splitApprovals(['Read', 'mcp__gh__*'], ['mcp__gh__push'])).toEqual({
      allowedTools: ['Read'],
      deferred: ['mcp__gh__*'],
    });
    expect(splitApprovals(['mcp__gh__get_*', 'Read'], ['mcp__gh__*'])).toEqual({
      allowedTools: ['Read'],
      deferred: ['mcp__gh__get_*'],
    });
  });

  it('moves a rule that names the gated tool itself', () => {
    expect(splitApprovals(['Write', 'Read'], ['Write'])).toEqual({
      allowedTools: ['Read'],
      deferred: ['Write'],
    });
  });

  it('moves partial globs whose prefixes are compatible, which conflictingApprovalRules misses', () => {
    expect(splitApprovals(['mcp__gh__a*'], ['mcp__gh__*b'])).toEqual({
      allowedTools: [],
      deferred: ['mcp__gh__a*'],
    });
  });

  it('moves an Edit rule out of allowedTools when any file-writing tool is gated', () => {
    for (const gated of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(splitApprovals(['Edit(//ws/**)', 'Edit', 'Read'], [gated])).toEqual({
        allowedTools: ['Read'],
        deferred: ['Edit(//ws/**)', 'Edit'],
      });
    }
  });

  it('keeps a glob on another server in allowedTools', () => {
    expect(splitApprovals(['mcp__jira__*'], ['mcp__gh__push'])).toEqual({
      allowedTools: ['mcp__jira__*'],
      deferred: [],
    });
  });
});
