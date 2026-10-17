import { describe, expect, it } from 'vitest';

import {
  AGENT_PERMISSION_KEYS,
  AGENT_POLICY_PROBLEM_CODES,
  AgentGrantsSchema,
  AgentPolicyResponseSchema,
  AgentPolicySchema,
  AgentSkillPolicySchema,
  AgentToolPolicySchema,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  claudeBaseToolPolicyFor,
  claudeDeniedToolsFor,
  CreateAgentWithAssignmentsResponseSchema,
  PortablePolicyBaseSchema,
  type PortablePolicyBase,
} from './agents.js';

describe('AGENT_POLICY_PROBLEM_CODES', () => {
  it('maps every code to its status, the ceiling refusal included (issue #524)', () => {
    expect(AGENT_POLICY_PROBLEM_CODES).toEqual({
      invalid_policy: 400,
      invalid_body: 400,
      unsupported_engine: 400,
      dangerous_permission_mode_refused: 400,
      agent_not_found: 404,
      skill_not_assigned: 409,
      engine_capability_unsupported: 422,
      engine_switch_would_widen: 422,
      policy_cannot_widen: 403,
      agent_policy_not_configured: 503,
    });
  });
});

describe('AgentGrantsSchema', () => {
  const principalId = '11111111-1111-4111-8111-111111111111';

  it('accepts a strict list of unique principal UUIDs, including an empty replacement', () => {
    expect(AgentGrantsSchema.parse({ principalIds: [principalId] })).toEqual({
      principalIds: [principalId],
    });
    expect(AgentGrantsSchema.safeParse({ principalIds: [] }).success).toBe(true);
  });

  it('rejects malformed, duplicate, missing, and unknown fields', () => {
    expect(AgentGrantsSchema.safeParse({ principalIds: ['principal-1'] }).success).toBe(false);
    expect(AgentGrantsSchema.safeParse({ principalIds: [principalId, principalId] }).success).toBe(
      false,
    );
    expect(AgentGrantsSchema.safeParse({}).success).toBe(false);
    expect(AgentGrantsSchema.safeParse({ principalIds: [], extra: true }).success).toBe(false);
  });

  it('canonicalizes principal ids before enforcing uniqueness', () => {
    expect(
      AgentGrantsSchema.parse({ principalIds: ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'] }),
    ).toEqual({ principalIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
    expect(
      AgentGrantsSchema.safeParse({
        principalIds: [
          'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ],
      }).success,
    ).toBe(false);
  });
});

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['support'] },
    limits: { maxTurns: null, maxBudgetUsd: null },
    ...overrides,
  };
}

describe('AgentPolicySchema', () => {
  it('accepts a well-formed claude-agent-sdk policy', () => {
    expect(AgentPolicySchema.safeParse(policy()).success).toBe(true);
  });

  it('accepts a mode: all skill policy and non-null limits', () => {
    const parsed = AgentPolicySchema.safeParse(
      policy({ skills: { mode: 'all' }, limits: { maxTurns: 40, maxBudgetUsd: 12.5 } }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a wrong or absent engine', () => {
    expect(AgentPolicySchema.safeParse(policy({ engine: 'pi' })).success).toBe(false);
    const withoutEngine = Object.fromEntries(
      Object.entries(policy()).filter(([key]) => key !== 'engine'),
    );
    expect(AgentPolicySchema.safeParse(withoutEngine).success).toBe(false);
  });

  it('rejects the pre-ADR-0065 `provider` discriminant outright', () => {
    const legacy = {
      ...Object.fromEntries(Object.entries(policy()).filter(([key]) => key !== 'engine')),
      provider: 'claude-agent-sdk',
    };
    expect(AgentPolicySchema.safeParse(legacy).success).toBe(false);
    // Nor as an extra key alongside the new one: `provider` means the model provider now.
    expect(AgentPolicySchema.safeParse(policy({ provider: 'claude-agent-sdk' })).success).toBe(
      false,
    );
  });

  it('carries the portable core every engine arm must honour', () => {
    const parsed = PortablePolicyBaseSchema.safeParse({
      skills: { mode: 'all' },
      limits: { maxTurns: 10, maxBudgetUsd: null },
    });
    expect(parsed.success).toBe(true);
    const base: PortablePolicyBase | undefined = parsed.data;
    expect(base?.skills.mode).toBe('all');
    // Engine-native fields are not part of the portable base.
    expect(
      PortablePolicyBaseSchema.safeParse({
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
        tools: policy()['tools'],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(AgentPolicySchema.safeParse({ ...policy(), extra: true }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    const withoutLimits = Object.fromEntries(
      Object.entries(policy()).filter(([key]) => key !== 'limits'),
    );
    expect(AgentPolicySchema.safeParse(withoutLimits).success).toBe(false);
  });

  describe('limits bounds', () => {
    it('rejects maxTurns of 0, a negative value, or a non-integer', () => {
      for (const maxTurns of [0, -1, 1.5]) {
        expect(
          AgentPolicySchema.safeParse(policy({ limits: { maxTurns, maxBudgetUsd: null } })).success,
        ).toBe(false);
      }
    });

    it('rejects maxBudgetUsd of 0 or negative', () => {
      for (const maxBudgetUsd of [0, -5]) {
        expect(
          AgentPolicySchema.safeParse(policy({ limits: { maxTurns: null, maxBudgetUsd } })).success,
        ).toBe(false);
      }
    });

    it('accepts both limits as null', () => {
      expect(
        AgentPolicySchema.safeParse(policy({ limits: { maxTurns: null, maxBudgetUsd: null } }))
          .success,
      ).toBe(true);
    });
  });

  describe('skills union', () => {
    it('accepts { mode: "all" } with no names field', () => {
      expect(AgentToolPolicySchema).toBeDefined();
      expect(AgentSkillPolicySchema.safeParse({ mode: 'all' }).success).toBe(true);
    });

    it('accepts { mode: "allowlist", names: [] }', () => {
      expect(AgentSkillPolicySchema.safeParse({ mode: 'allowlist', names: [] }).success).toBe(true);
    });

    it('rejects an unknown mode', () => {
      expect(AgentSkillPolicySchema.safeParse({ mode: 'none' }).success).toBe(false);
    });

    it('rejects a skill name outside the skill name grammar', () => {
      expect(
        AgentSkillPolicySchema.safeParse({ mode: 'allowlist', names: ['Not Valid!'] }).success,
      ).toBe(false);
    });
  });

  describe('the bypassPermissions cross-field rule', () => {
    it('refuses bypassPermissions without allowDangerouslySkipPermissions', () => {
      const result = AgentPolicySchema.safeParse(
        policy({
          tools: {
            base: 'claude_code_preset',
            autoApprove: [],
            deny: [],
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: false,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('refuses allowDangerouslySkipPermissions with any other mode', () => {
      const result = AgentPolicySchema.safeParse(
        policy({
          tools: {
            base: 'claude_code_preset',
            autoApprove: [],
            deny: [],
            permissionMode: 'default',
            allowDangerouslySkipPermissions: true,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('accepts bypassPermissions paired with allowDangerouslySkipPermissions: true', () => {
      const result = AgentPolicySchema.safeParse(
        policy({
          tools: {
            base: 'claude_code_preset',
            autoApprove: [],
            deny: [],
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          },
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('tool rule grammar', () => {
    it('rejects an unanchored wildcard in a granting position', () => {
      const result = AgentPolicySchema.safeParse(
        policy({
          tools: {
            base: 'claude_code_preset',
            autoApprove: ['*'],
            deny: [],
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('accepts an unanchored wildcard in deny, and an anchored MCP wildcard in autoApprove', () => {
      const result = AgentPolicySchema.safeParse(
        policy({
          tools: {
            base: 'claude_code_preset',
            autoApprove: ['mcp__github__*'],
            deny: ['*'],
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts a single "_" inside an MCP server name and refuses a leading "_" (SD13)', () => {
      const withRule = (rule: string) =>
        AgentPolicySchema.safeParse(
          policy({
            tools: {
              base: 'claude_code_preset',
              autoApprove: [rule],
              deny: [],
              permissionMode: 'default',
              allowDangerouslySkipPermissions: false,
            },
          }),
        ).success;
      expect(withRule('mcp__orders_2__*')).toBe(true);
      expect(withRule('mcp__t_42_things__select')).toBe(true);
      expect(withRule('mcp___a__*')).toBe(false);
    });
  });
});

describe('AgentPolicyResponseSchema', () => {
  it('wraps the policy as { policy }', () => {
    expect(AgentPolicyResponseSchema.safeParse({ policy: policy() }).success).toBe(true);
    expect(AgentPolicyResponseSchema.safeParse(policy()).success).toBe(false);
  });

  it('accepts connectorNames, display-only and optional, and nothing else extra', () => {
    const names = { 'connector-11111111-1111-4111-8111-111111111111': 'file-finder' };
    expect(
      AgentPolicyResponseSchema.safeParse({ policy: policy(), connectorNames: names }).success,
    ).toBe(true);
    expect(
      AgentPolicyResponseSchema.safeParse({ policy: policy(), connectorNames: { a: 1 } }).success,
    ).toBe(false);
    expect(AgentPolicyResponseSchema.safeParse({ policy: policy(), extra: 1 }).success).toBe(false);
  });
});

describe('CreateAgentWithAssignmentsResponseSchema', () => {
  const agent = {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    name: 'Support',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    createdBy: null,
    ownerPrincipalId: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
  };
  const assignments = { files: [], skillIds: [], connectorIds: [] };

  it('accepts { agent, assignments }', () => {
    expect(CreateAgentWithAssignmentsResponseSchema.safeParse({ agent, assignments }).success).toBe(
      true,
    );
  });

  it('rejects a bare agent with no assignments key', () => {
    expect(CreateAgentWithAssignmentsResponseSchema.safeParse(agent).success).toBe(false);
  });
});

describe('the Claude permission floor (ENG-04b, #325)', () => {
  const ALL_ON = {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  } as const;
  const ALL_OFF = {
    readFiles: false,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  } as const;

  it('denies nothing when every §17 Step 4 permission is granted', () => {
    expect(claudeDeniedToolsFor(ALL_ON)).toEqual([]);
    expect(claudeBaseToolPolicyFor(ALL_ON).deny).toEqual([]);
  });

  it('removes the tool definitions rather than withholding an approval', () => {
    // R-01 §10: `allowedTools` auto-approves and does not restrict, so a permission that is off
    // must reach `deny` (the SDK's `disallowedTools`) or it is not enforced at all in an
    // unattended run.
    const policy = claudeBaseToolPolicyFor(ALL_OFF);
    expect(policy.autoApprove).toEqual([]);
    expect([...policy.deny]).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'NotebookEdit',
      'Bash',
      'BashOutput',
      'KillShell',
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('maps one permission at a time — writeFiles off does not deny Bash', () => {
    expect([...claudeDeniedToolsFor({ ...ALL_ON, writeFiles: false })]).toEqual([
      'Write',
      'Edit',
      'NotebookEdit',
    ]);
  });

  it('never asks for bypassPermissions', () => {
    for (const permissions of [ALL_ON, ALL_OFF]) {
      const policy = claudeBaseToolPolicyFor(permissions);
      expect(policy.base).toBe('claude_code_preset');
      expect(policy.permissionMode).toBe('default');
      expect(policy.allowDangerouslySkipPermissions).toBe(false);
    }
  });

  it('answers a policy the published Claude arm accepts, so a GET cannot serve an invalid one', () => {
    expect(AgentToolPolicySchema.safeParse(claudeBaseToolPolicyFor(ALL_OFF)).success).toBe(true);
  });

  it('has a denial list for every permission key, so a fifth switch cannot be ungoverned', () => {
    // Keyed by `AgentPermissionKey`, so a missing key is a type error as well as a test failure —
    // but the table's *order* is what the compiled `disallowedTools` array is compared byte for
    // byte against, and only a test can hold that.
    expect(Object.keys(CLAUDE_PERMISSION_TOOL_DENIALS)).toEqual([...AGENT_PERMISSION_KEYS]);
    for (const key of AGENT_PERMISSION_KEYS) {
      expect(CLAUDE_PERMISSION_TOOL_DENIALS[key].length).toBeGreaterThan(0);
    }
  });
});
