import { describe, expect, it } from 'vitest';

import { RunRequest } from '@agent-workspace/run-protocol';
import { AGENT_TOOL_PERMISSION_MODES } from '@indx-workspace/contracts/agents';

import {
  CLAUDE_MEMORY_INSTRUCTION,
  SubagentToolRemovedError,
  compileRunRequest,
} from './compile.js';
import {
  canonicalAgent,
  canonicalPolicy,
  canonicalRunRequest,
  compileCanonical,
  request,
} from './compile.test-support.js';
import { claudeOptionsAllowWrite } from './options-readback.js';

const subagent = {
  name: 'billing-specialist',
  description: 'Answers billing questions.',
  instructions: 'You answer billing questions.',
  model: 'claude-haiku-4-5',
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: true,
  },
} as const;
const withSubagents = (policy: unknown, subagents: readonly unknown[] = [subagent]) =>
  RunRequest.parse({
    ...canonicalRunRequest,
    portable: { ...canonicalAgent, subagents },
    policy,
  });
const preset = { tools: null, fileGrantDeny: [] };

const withTools = (
  tools: Record<string, unknown>,
  policy: Record<string, unknown>,
): ReturnType<typeof compileRunRequest> => compileCanonical({ policy: { tools, ...policy } });
const defaultTools = {
  base: ['Read', 'mcp__gh__push'],
  autoApprove: ['Read', 'mcp__gh__*'],
  deny: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
};

describe('subagents', () => {
  it('emits no agents key without subagents', () => {
    expect('agents' in compileRunRequest(request)).toBe(false);
  });

  it('maps a subagent to an agents entry, denying only what its permissions add to the parent', () => {
    const options = compileRunRequest(withSubagents(preset));
    expect(options.disallowedTools).toContain('Bash');
    expect(options.agents).toEqual({
      'billing-specialist': {
        description: 'Answers billing questions.',
        prompt: 'You answer billing questions.',
        model: 'claude-haiku-4-5',
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
      },
    });
  });
});

describe('subagents without a model or disallowed tools', () => {
  it('leaves model and disallowedTools out when the subagent sets none', () => {
    const open = {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    };
    const parentOpen = RunRequest.parse({
      ...canonicalRunRequest,
      portable: {
        ...canonicalAgent,
        permissions: open,
        subagents: [{ ...subagent, model: null, permissions: open }],
      },
      policy: preset,
    });
    expect(compileRunRequest(parentOpen).agents).toEqual({
      'billing-specialist': {
        description: 'Answers billing questions.',
        prompt: 'You answer billing questions.',
      },
    });
  });

  it('throws the typed error when the tool policy removes Agent', () => {
    const denied = { tools: { ...canonicalPolicy.tools, deny: ['Agent'] }, fileGrantDeny: [] };
    expect(() => compileRunRequest(withSubagents(denied))).toThrow(SubagentToolRemovedError);
    expect(() => compileRunRequest(withSubagents(canonicalPolicy))).toThrow(
      SubagentToolRemovedError,
    );
    expect(() => compileRunRequest(withSubagents(canonicalPolicy, []))).not.toThrow();
  });
});

describe('handoff (ADR-0145 D4)', () => {
  const compileWith = (handoff: boolean): ReturnType<typeof compileRunRequest> =>
    compileCanonical({ policy: { tools: null, handoff } });

  it('auto-approves handoff_to_person and carries the flag only when on', () => {
    const on = compileWith(true);
    expect(on.allowedTools).toContain('mcp__agent-workspace__handoff_to_person');
    expect(on.handoff).toBe(true);
    const off = compileWith(false);
    expect(off.allowedTools).not.toContain('mcp__agent-workspace__handoff_to_person');
    expect('handoff' in off).toBe(false);
  });
});

describe('requireApproval (ADR-0145)', () => {
  it('carries no gate without requireApproval, so existing compiles are unchanged', () => {
    const compiled = withTools(defaultTools, {});
    expect('approval' in compiled).toBe(false);
    expect(compiled.allowedTools).toEqual(['Read', 'mcp__gh__*', 'mcp__jira__*', 'mcp__search__*']);
  });
});

describe('requireApproval: the gate and the moved rules', () => {
  it('moves rules that could approve a gated tool out of allowedTools and into the gate', () => {
    const compiled = withTools(defaultTools, {
      requireApproval: ['mcp__gh__push'],
      approvedToolCalls: ['{"input":{},"name":"mcp__gh__push"}'],
    });
    expect(compiled.allowedTools).toEqual(['Read', 'mcp__jira__*', 'mcp__search__*']);
    expect(compiled.approval).toEqual({
      requireApproval: ['mcp__gh__push'],
      deferred: ['mcp__gh__*'],
      approvedToolCalls: ['{"input":{},"name":"mcp__gh__push"}'],
      ask: ['mcp__gh__push'],
    });
  });

  it.each(AGENT_TOOL_PERMISSION_MODES.filter((mode) => mode !== 'default'))(
    'refuses permissionMode %s, which would not ask',
    (permissionMode) => {
      const allowDangerouslySkipPermissions = permissionMode === 'bypassPermissions';
      expect(() =>
        withTools(
          { ...defaultTools, permissionMode, allowDangerouslySkipPermissions },
          { requireApproval: ['Write'] },
        ),
      ).toThrow("permissionMode 'default'");
    },
  );

  it.each(['Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'])(
    'refuses gating %s, which canUseTool is never asked about',
    (tool) => {
      expect(() => withTools(defaultTools, { requireApproval: [tool] })).toThrow(
        `requireApproval cannot gate ${JSON.stringify(tool)}`,
      );
    },
  );

  it.each(['Bash', 'WebFetch', 'mcp__jira__*', 'mcp__gh__push'])(
    'compiles a gate on %s',
    (tool) => {
      expect(
        withTools(defaultTools, { requireApproval: [tool] }).approval?.requireApproval,
      ).toEqual([tool]);
    },
  );

  it('allows any permissionMode when nothing requires approval', () => {
    expect(() => compileRunRequest(request)).not.toThrow();
  });
});

describe('Run commands asks before a command it would refuse (#2091)', () => {
  const runs = (runCommands: boolean, policy: Record<string, unknown>) =>
    compileCanonical({
      portable: {
        ...canonicalAgent,
        permissions: { ...canonicalAgent.permissions, runCommands },
      },
      policy: { tools: null, ...policy },
    });

  it('gates Bash for an agent with no stored policy, without an ask rule or a moved approval', () => {
    const compiled = runs(true, {});
    expect(compiled.approval).toEqual({
      requireApproval: ['Bash'],
      deferred: [],
      approvedToolCalls: [],
      ask: [],
    });
    expect(compiled.disallowedTools).not.toContain('Bash');
    expect(compiled.allowedTools).toEqual(runs(false, {}).allowedTools);
  });

  it('carries the approved command of a continuation', () => {
    const approved = '{"input":{"command":"mkdir out"},"name":"Bash"}';
    expect(runs(true, { approvedToolCalls: [approved] }).approval?.approvedToolCalls).toEqual([
      approved,
    ]);
  });

  it('adds no gate when Run commands is off, or a read-only grant denies Bash', () => {
    expect('approval' in runs(false, {})).toBe(false);
    expect('approval' in runs(true, { fileGrantDeny: ['Bash'] })).toBe(false);
  });
});

describe('Write files writes inside the workspace without asking', () => {
  const runs = (writeFiles: boolean, policy: Record<string, unknown>) =>
    compileCanonical({
      portable: {
        ...canonicalAgent,
        permissions: { ...canonicalAgent.permissions, writeFiles },
      },
      policy: { tools: null, ...policy },
    });

  it('allows editing under cwd for an agent with no stored policy', () => {
    expect(runs(true, {}).allowedTools).toContain('Edit(//run/claude/**)');
    expect(runs(false, {}).allowedTools).not.toContain('Edit(//run/claude/**)');
  });

  it('denies the files Claude Code loads as instructions beside the workspace allow rule', () => {
    const compiled = runs(true, {});
    expect(compiled.disallowedTools).toEqual(
      expect.arrayContaining([
        'Edit(//run/claude/CLAUDE.md)',
        'Edit(//run/claude/**/CLAUDE.md)',
        'Edit(//run/claude/.claude/**)',
        'Edit(//run/claude/.mcp.json)',
      ]),
    );
    expect(claudeOptionsAllowWrite(compiled, 'CLAUDE.md')).toBe(false);
    expect(claudeOptionsAllowWrite(compiled, 'outputs/a.md')).toBe(true);
    expect(runs(false, {}).disallowedTools).not.toContain('Edit(//run/claude/CLAUDE.md)');
  });

  it('keeps a read-only grant read-only: its deny is still compiled and wins', () => {
    const grantDeny = ['Edit(//run/claude/contracts/**)', 'Bash', 'BashOutput', 'KillShell'];
    const compiled = runs(true, { fileGrantDeny: grantDeny });
    expect(compiled.allowedTools).toContain('Edit(//run/claude/**)');
    expect(compiled.disallowedTools).toEqual(expect.arrayContaining(grantDeny));
    expect(claudeOptionsAllowWrite(compiled, 'contracts/a.pdf')).toBe(false);
    expect(claudeOptionsAllowWrite(compiled, 'outputs/a.md')).toBe(true);
  });

  it('leaves a stored gate on Write to canUseTool rather than allowing the call', () => {
    const compiled = runs(true, { requireApproval: ['Write'] });
    expect(compiled.allowedTools).not.toContain('Edit(//run/claude/**)');
    expect(compiled.approval?.requireApproval).toEqual(['Write']);
  });
});

describe('the memory folder line (ADR-0163)', () => {
  const withPermissions = (permissions: Record<string, unknown>, instructions?: string) =>
    RunRequest.parse({
      ...canonicalRunRequest,
      portable: {
        ...canonicalAgent,
        permissions: { ...canonicalAgent.permissions, ...permissions },
        ...(instructions === undefined ? {} : { instructions }),
      },
    });

  it('leaves the compiled options of a run without memory exactly as they were', () => {
    const compiled = compileRunRequest(request);
    expect(compiled.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: canonicalAgent.instructions,
    });
    expect(JSON.stringify(compiled)).not.toContain('MEMORY.md');
    expect(compileRunRequest(withPermissions({}))).toEqual(compiled);
  });

  it('adds one prompt line naming memory/MEMORY.md, and changes nothing else', () => {
    const compiled = compileRunRequest(request);
    const remembering = compileRunRequest(withPermissions({ memory: 'agent' }));
    expect(remembering).toEqual({
      ...compiled,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `${canonicalAgent.instructions}\n\n${CLAUDE_MEMORY_INSTRUCTION}`,
      },
    });
    expect(CLAUDE_MEMORY_INSTRUCTION).toContain('memory/MEMORY.md');
    expect(CLAUDE_MEMORY_INSTRUCTION.split('\n')).toHaveLength(1);
  });

  it('gives an agent with no instructions the memory line alone', () => {
    expect(compileRunRequest(withPermissions({ memory: 'agent' }, '  ')).systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: CLAUDE_MEMORY_INSTRUCTION,
    });
  });

  it('adds no line when a file switch is off, because the run keeps no memory then', () => {
    const readOnly = withPermissions({ memory: 'agent', writeFiles: false });
    expect(compileRunRequest(readOnly).systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: canonicalAgent.instructions,
    });
  });

  it('compiles no engine-native memory: no agent-memory or auto-memory option', () => {
    const text = JSON.stringify(compileRunRequest(withPermissions({ memory: 'agent' })));
    expect(text).not.toMatch(/autoMemory|agent-memory|"memory":/u);
  });
});
