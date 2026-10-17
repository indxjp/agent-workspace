/**
 * `translatePolicyForEngineSwitch` (ADR-0074 D12): an engine switch carries the old arm's narrowing
 * into the new arm and never widens what the agent may use. One case per row of the mapping table
 * on the function, then the contract itself over every combination the table can produce.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_PERMISSION_KEYS,
  AgentPolicySchema,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  MASTRA_TOOL_CALL_CONCURRENCY_MAX,
  MASTRA_TOOL_NAMES,
  MASTRA_TOOL_PERMISSION,
  OPENAI_AGENTS_TOOL_NAMES,
  OPENAI_AGENTS_TOOL_PERMISSION,
  policyNarrowedPermissions,
  translatePolicyForEngineSwitch,
  type AgentPermissions,
  type AgentPolicy,
  type AgentToolPermissionMode,
} from './agents.js';

type ClaudeArm = Extract<AgentPolicy, { engine: 'claude-agent-sdk' }>;
type OpenAiArm = Extract<AgentPolicy, { engine: 'openai-agents' }>;

const PORTABLE = {
  skills: { mode: 'allowlist', names: ['summarise'] },
  limits: { maxTurns: 8, maxBudgetUsd: null },
} as const;

function claude(
  deny: readonly string[],
  permissionMode: AgentToolPermissionMode = 'default',
  base: ClaudeArm['tools']['base'] = 'claude_code_preset',
  autoApprove: readonly string[] = [],
): ClaudeArm {
  return {
    engine: 'claude-agent-sdk',
    tools: { base, autoApprove, deny, permissionMode, allowDangerouslySkipPermissions: false },
    ...PORTABLE,
  };
}

const OPENAI: OpenAiArm = { engine: 'openai-agents', ...PORTABLE };
const PI: Extract<AgentPolicy, { engine: 'pi' }> = { engine: 'pi', ...PORTABLE };
const MASTRA: Extract<AgentPolicy, { engine: 'mastra' }> = { engine: 'mastra', ...PORTABLE };

function toOpenAi(previous: ClaudeArm): ReturnType<typeof translatePolicyForEngineSwitch> {
  return translatePolicyForEngineSwitch(previous, OPENAI);
}

function withheld(previous: ClaudeArm): readonly string[] | undefined {
  const translation = toOpenAi(previous);
  if (!translation.ok) throw new Error(`refused: ${translation.refused.join(', ')}`);
  const policy = translation.policy;
  if (policy.engine !== 'openai-agents') throw new Error('wrong arm');
  return policy.withheldPermissions;
}

describe('translatePolicyForEngineSwitch: claude-agent-sdk -> openai-agents', () => {
  it.each([
    ['Read', ['readFiles']],
    ['Glob', ['readFiles']],
    ['Grep', ['readFiles']],
    ['Write', ['writeFiles']],
    ['Edit', ['writeFiles']],
    ['NotebookEdit', ['writeFiles']],
    ['Bash', ['runCommands']],
    ['BashOutput', ['runCommands']],
    ['KillShell', ['runCommands']],
  ] as const)('a denied %s withholds %j', (rule, keys) => {
    expect(withheld(claude([rule]))).toEqual(keys);
  });

  it('names the new engine tools each denial removes, by the adapter-declared names', () => {
    const translation = toOpenAi(claude(['Bash', 'Edit', 'Read']));
    expect(translation.carried).toEqual([
      { from: 'Read', tools: ['read_file', 'list_files', 'search_files'] },
      { from: 'Edit', tools: ['apply_patch'] },
      { from: 'Bash', tools: ['shell'] },
    ]);
  });

  it('withholds the whole tool for a scoped denial: the narrower reading', () => {
    expect(withheld(claude(['Bash(git push:*)']))).toEqual(['runCommands']);
    expect(withheld(claude(['Write(/etc/**)']))).toEqual(['writeFiles']);
  });

  it("maps permissionMode 'plan' to no writes and no commands, and keeps reading", () => {
    expect(withheld(claude([], 'plan'))).toEqual(['writeFiles', 'runCommands']);
  });

  it("maps permissionMode 'dontAsk' to the switches whose tools autoApprove does not all name", () => {
    expect(
      withheld(claude([], 'dontAsk', 'claude_code_preset', ['Read', 'Glob', 'Grep', 'Bash'])),
    ).toEqual(['writeFiles', 'runCommands']);
    expect(withheld(claude([], 'dontAsk'))).toEqual(['readFiles', 'writeFiles', 'runCommands']);
  });

  it.each(['default', 'acceptEdits', 'auto'] as const)(
    "treats permissionMode '%s' as narrowing nothing",
    (mode) => {
      expect(withheld(claude([], mode))).toBeUndefined();
    },
  );

  it('withholds a switch whose tools a base list does not all expose', () => {
    expect(withheld(claude([], 'default', ['Read', 'Glob', 'Grep', 'Edit']))).toEqual([
      'writeFiles',
      'runCommands',
    ]);
  });

  it('leaves a denial of a tool the new engine does not have absent, with nothing to carry', () => {
    const translation = toOpenAi(claude(['WebFetch', 'WebSearch', 'Task']));
    expect(translation).toMatchObject({
      ok: true,
      carried: [],
      absent: ['WebFetch', 'WebSearch', 'Task'],
    });
    expect(withheld(claude(['WebFetch']))).toBeUndefined();
  });

  it.each([
    'mcp__github__delete_repo',
    'mcp__github__*',
    'mcp__github__issue(write)',
    '*',
    'Bash*',
  ])('refuses %s, which the new arm cannot express, naming it', (rule) => {
    const translation = toOpenAi(claude(['Bash', rule]));
    expect(translation.ok).toBe(false);
    if (translation.ok) return;
    expect(translation.refused).toEqual([rule]);
    expect(translation.carried).toEqual([{ from: 'Bash', tools: ['shell'] }]);
  });

  it('keeps withheld switches the new body already names, in declared key order', () => {
    const translation = translatePolicyForEngineSwitch(claude(['Bash']), {
      ...OPENAI,
      withheldPermissions: ['unrestrictedNetwork', 'readFiles'],
    });
    expect(translation.ok && translation.policy).toMatchObject({
      withheldPermissions: ['readFiles', 'runCommands', 'unrestrictedNetwork'],
    });
  });

  it('produces a policy the published schema accepts', () => {
    const translation = toOpenAi(claude(['Bash', 'Write'], 'plan'));
    expect(translation.ok).toBe(true);
    if (translation.ok)
      expect(AgentPolicySchema.parse(translation.policy)).toEqual(translation.policy);
  });
});

describe('translatePolicyForEngineSwitch: openai-agents -> claude-agent-sdk', () => {
  it.each(AGENT_PERMISSION_KEYS)('a withheld %s denies the Claude tools it governs', (key) => {
    const translation = translatePolicyForEngineSwitch(
      { ...OPENAI, withheldPermissions: [key] },
      claude(['Task']),
    );
    expect(translation.ok).toBe(true);
    if (!translation.ok || translation.policy.engine !== 'claude-agent-sdk') return;
    expect(translation.policy.tools.deny).toEqual(['Task', ...CLAUDE_PERMISSION_TOOL_DENIALS[key]]);
    expect(translation.carried).toEqual([
      { from: `withheldPermissions: ${key}`, tools: CLAUDE_PERMISSION_TOOL_DENIALS[key] },
    ]);
  });

  it('changes nothing when nothing was withheld', () => {
    const next = claude(['Bash']);
    expect(translatePolicyForEngineSwitch(OPENAI, next)).toEqual({
      ok: true,
      policy: next,
      carried: [],
      absent: [],
    });
  });
});

describe('translatePolicyForEngineSwitch: the same engine', () => {
  it('replaces verbatim: a PUT on one engine is how an owner widens on purpose', () => {
    const next = claude([]);
    expect(translatePolicyForEngineSwitch(claude(['Bash'], 'plan'), next)).toEqual({
      ok: true,
      policy: next,
      carried: [],
      absent: [],
    });
  });
});

/** The OpenAI tools a run offers under these permissions and this arm (the adapter's plan). */
function openAiTools(permissions: AgentPermissions, policy: AgentPolicy): readonly string[] {
  const narrowed = policyNarrowedPermissions(permissions, policy);
  return OPENAI_AGENTS_TOOL_NAMES.filter((name) => narrowed[OPENAI_AGENTS_TOOL_PERMISSION[name]]);
}

/** Whether the Claude arm lets every Claude tool this switch governs through, unscoped. */
function claudeAllows(permissions: AgentPermissions, arm: ClaudeArm, name: string): boolean {
  const key = OPENAI_AGENTS_TOOL_PERMISSION[name as (typeof OPENAI_AGENTS_TOOL_NAMES)[number]];
  if (!permissions[key]) return false;
  const { base, autoApprove, deny, permissionMode } = arm.tools;
  return CLAUDE_PERMISSION_TOOL_DENIALS[key].every(
    (tool) =>
      !deny.some((rule) => rule === tool || rule.startsWith(`${tool}(`)) &&
      (base === 'claude_code_preset' || base.includes(tool)) &&
      !(permissionMode === 'plan' && key !== 'readFiles') &&
      !(permissionMode === 'dontAsk' && !autoApprove.includes(tool)),
  );
}

describe('the contract: a switch never allows a tool the old arm denied', () => {
  const rules = ['Read', 'Glob', 'Edit', 'Bash(rm:*)', 'KillShell', 'WebFetch'];
  const modes: readonly AgentToolPermissionMode[] = ['default', 'plan', 'dontAsk', 'acceptEdits'];
  const bases: readonly ClaudeArm['tools']['base'][] = [
    'claude_code_preset',
    ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit'],
  ];
  const permissionSets: AgentPermissions[] = [];
  for (let bits = 0; bits < 16; bits += 1) {
    permissionSets.push({
      readFiles: (bits & 1) !== 0,
      writeFiles: (bits & 2) !== 0,
      runCommands: (bits & 4) !== 0,
      unrestrictedNetwork: (bits & 8) !== 0,
    });
  }

  it('holds over every subset of the sample denials, mode, base and permission set', () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << rules.length; mask += 1) {
      const deny = rules.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const mode of modes) {
        for (const base of bases) {
          const previous = claude(deny, mode, base, ['Read', 'Glob', 'Grep']);
          const translation = toOpenAi(previous);
          expect(translation.ok).toBe(true);
          if (!translation.ok) continue;
          for (const permissions of permissionSets) {
            for (const tool of openAiTools(permissions, translation.policy)) {
              expect(
                claudeAllows(permissions, previous, tool),
                `${tool} under ${deny.join(',')}`,
              ).toBe(true);
              checked += 1;
            }
            expect(
              policyNarrowedPermissions(permissions, translation.policy).unrestrictedNetwork,
            ).toBe(permissions.unrestrictedNetwork);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('policyNarrowedPermissions', () => {
  const all: AgentPermissions = {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  };

  it('turns off exactly the withheld switches of an openai-agents arm', () => {
    expect(
      policyNarrowedPermissions(all, { ...OPENAI, withheldPermissions: ['runCommands'] }),
    ).toEqual({ ...all, runCommands: false });
  });

  it('never turns a switch on', () => {
    const none = {
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    };
    expect(policyNarrowedPermissions(none, { ...OPENAI, withheldPermissions: [] })).toEqual(none);
  });

  it('leaves the Claude arm and a missing policy alone', () => {
    expect(policyNarrowedPermissions(all, claude(['Bash']))).toBe(all);
    expect(policyNarrowedPermissions(all, null)).toBe(all);
  });

  it('turns off exactly the withheld switches of a pi arm (ENG-08, #307)', () => {
    expect(policyNarrowedPermissions(all, { ...PI, withheldPermissions: ['runCommands'] })).toEqual(
      { ...all, runCommands: false },
    );
  });
});

// ── ENG-08 (#307, ADR-0081): the pi pairs ────────────────────────────────────────────────────

describe('translatePolicyForEngineSwitch: the pi pairs', () => {
  it('carries a Claude denial into the pi arm, naming pi tools', () => {
    const translation = translatePolicyForEngineSwitch(claude(['Bash', 'Edit', 'Read']), PI);
    expect(translation.ok).toBe(true);
    if (!translation.ok) return;
    expect(translation.policy).toEqual({
      ...PI,
      withheldPermissions: ['readFiles', 'writeFiles', 'runCommands'],
    });
    expect(translation.carried).toEqual([
      { from: 'Read', tools: ['read'] },
      { from: 'Edit', tools: ['write', 'edit'] },
      { from: 'Bash', tools: ['bash'] },
    ]);
  });

  it('carries plan mode, and refuses an MCP denial the pi arm cannot say', () => {
    const plan = translatePolicyForEngineSwitch(claude([], 'plan'), PI);
    expect(plan.ok && plan.policy.engine === 'pi' ? plan.policy.withheldPermissions : null).toEqual(
      ['writeFiles', 'runCommands'],
    );
    const mcp = translatePolicyForEngineSwitch(claude(['mcp__docs__search']), PI);
    expect(mcp).toMatchObject({ ok: false, refused: ['mcp__docs__search'] });
  });

  it("writes a pi arm's withheld switches into the Claude arm's deny list", () => {
    const translation = translatePolicyForEngineSwitch(
      { ...PI, withheldPermissions: ['runCommands'] },
      claude([]),
    );
    expect(
      translation.ok && translation.policy.engine === 'claude-agent-sdk'
        ? translation.policy.tools.deny
        : null,
    ).toEqual([...CLAUDE_PERMISSION_TOOL_DENIALS.runCommands]);
  });

  it('carries withheld switches verbatim between openai-agents and pi, in both directions', () => {
    const toPi = translatePolicyForEngineSwitch(
      { ...OPENAI, withheldPermissions: ['writeFiles', 'unrestrictedNetwork'] },
      PI,
    );
    expect(toPi).toMatchObject({
      ok: true,
      policy: { engine: 'pi', withheldPermissions: ['writeFiles', 'unrestrictedNetwork'] },
      carried: [
        { from: 'withheldPermissions: writeFiles', tools: ['write', 'edit'] },
        { from: 'withheldPermissions: unrestrictedNetwork', tools: [] },
      ],
    });
    const toOpenAiArm = translatePolicyForEngineSwitch(
      { ...PI, withheldPermissions: ['readFiles'] },
      OPENAI,
    );
    expect(toOpenAiArm).toMatchObject({
      ok: true,
      policy: { engine: 'openai-agents', withheldPermissions: ['readFiles'] },
      carried: [
        {
          from: 'withheldPermissions: readFiles',
          tools: ['read_file', 'list_files', 'search_files'],
        },
      ],
    });
  });

  it('leaves a switch that carries nothing byte-identical', () => {
    expect(translatePolicyForEngineSwitch(OPENAI, PI)).toEqual({
      ok: true,
      policy: PI,
      carried: [],
      absent: [],
    });
  });

  it('parses the pi arm and refuses an unknown key or thinking level', () => {
    expect(AgentPolicySchema.parse({ ...PI, thinkingLevel: 'high' })).toEqual({
      ...PI,
      thinkingLevel: 'high',
    });
    expect(AgentPolicySchema.safeParse({ ...PI, thinkingLevel: 'xhigh' }).success).toBe(false);
    expect(AgentPolicySchema.safeParse({ ...PI, tools: {} }).success).toBe(false);
  });
});

describe('translatePolicyForEngineSwitch: the mastra pairs', () => {
  it('carries a Claude denial into the mastra arm, naming Mastra workspace tools', () => {
    const translation = translatePolicyForEngineSwitch(claude(['Bash', 'Edit', 'Read']), MASTRA);
    expect(translation.ok).toBe(true);
    if (!translation.ok) return;
    expect(translation.policy).toEqual({
      ...MASTRA,
      withheldPermissions: ['readFiles', 'writeFiles', 'runCommands'],
    });
    expect(translation.carried).toEqual([
      {
        from: 'Read',
        tools: [
          'mastra_workspace_read_file',
          'mastra_workspace_list_files',
          'mastra_workspace_grep',
          'mastra_workspace_file_stat',
        ],
      },
      {
        from: 'Edit',
        tools: [
          'mastra_workspace_write_file',
          'mastra_workspace_edit_file',
          'mastra_workspace_mkdir',
          'mastra_workspace_delete',
        ],
      },
      {
        from: 'Bash',
        tools: [
          'mastra_workspace_execute_command',
          'mastra_workspace_get_process_output',
          'mastra_workspace_kill_process',
        ],
      },
    ]);
  });

  it('carries plan mode, and refuses an MCP denial the mastra arm cannot say', () => {
    const plan = translatePolicyForEngineSwitch(claude([], 'plan'), MASTRA);
    expect(
      plan.ok && plan.policy.engine === 'mastra' ? plan.policy.withheldPermissions : null,
    ).toEqual(['writeFiles', 'runCommands']);
    const mcp = translatePolicyForEngineSwitch(claude(['mcp__docs__search']), MASTRA);
    expect(mcp).toMatchObject({ ok: false, refused: ['mcp__docs__search'] });
  });

  it("writes a mastra arm's withheld switches into the Claude arm's deny list", () => {
    const translation = translatePolicyForEngineSwitch(
      { ...MASTRA, withheldPermissions: ['writeFiles'] },
      claude([]),
    );
    expect(
      translation.ok && translation.policy.engine === 'claude-agent-sdk'
        ? translation.policy.tools.deny
        : null,
    ).toEqual([...CLAUDE_PERMISSION_TOOL_DENIALS.writeFiles]);
  });

  it('carries withheld switches verbatim between mastra and the other withholding arms', () => {
    for (const other of [OPENAI, PI] as const) {
      const toMastra = translatePolicyForEngineSwitch(
        { ...other, withheldPermissions: ['runCommands', 'unrestrictedNetwork'] },
        MASTRA,
      );
      expect(toMastra).toMatchObject({
        ok: true,
        policy: { engine: 'mastra', withheldPermissions: ['runCommands', 'unrestrictedNetwork'] },
      });
      const back = translatePolicyForEngineSwitch(
        { ...MASTRA, withheldPermissions: ['readFiles'] },
        other,
      );
      expect(back).toMatchObject({
        ok: true,
        policy: { engine: other.engine, withheldPermissions: ['readFiles'] },
      });
    }
    expect(translatePolicyForEngineSwitch(PI, MASTRA)).toEqual({
      ok: true,
      policy: MASTRA,
      carried: [],
      absent: [],
    });
  });

  it('narrows the composed permissions by what the mastra arm withholds', () => {
    const all = { readFiles: true, writeFiles: true, runCommands: true, unrestrictedNetwork: true };
    expect(
      policyNarrowedPermissions(all, { ...MASTRA, withheldPermissions: ['unrestrictedNetwork'] }),
    ).toEqual({ ...all, unrestrictedNetwork: false });
  });

  it('parses the mastra arm and refuses an unknown key or an out-of-range concurrency', () => {
    expect(AgentPolicySchema.parse({ ...MASTRA, toolCallConcurrency: 4 })).toEqual({
      ...MASTRA,
      toolCallConcurrency: 4,
    });
    for (const bad of [0, 1.5, MASTRA_TOOL_CALL_CONCURRENCY_MAX + 1, '4']) {
      expect(AgentPolicySchema.safeParse({ ...MASTRA, toolCallConcurrency: bad }).success).toBe(
        false,
      );
    }
    expect(AgentPolicySchema.safeParse({ ...MASTRA, thinkingLevel: 'high' }).success).toBe(false);
    expect(
      AgentPolicySchema.safeParse({ ...MASTRA, memory: { semanticRecall: true } }).success,
    ).toBe(false);
  });

  it('assigns every Mastra tool to exactly one switch', () => {
    expect(Object.keys(MASTRA_TOOL_PERMISSION).sort()).toEqual([...MASTRA_TOOL_NAMES].sort());
  });
});
