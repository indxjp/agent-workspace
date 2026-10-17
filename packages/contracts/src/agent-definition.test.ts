import { describe, expect, it } from 'vitest';

import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_KIND,
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_DEFINITION_PROBLEM_CODES,
  AGENT_NAME_MAX_LENGTH,
  AgentDefinitionSchema,
  type AgentDefinition,
} from './agents.js';

const definition: AgentDefinition = {
  apiVersion: AGENT_DEFINITION_API_VERSION,
  kind: AGENT_DEFINITION_KIND,
  agent: {
    name: 'Support triage',
    instructions: 'Answer support mail.',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    model: 'claude-sonnet-4-5',
    modelConnectionName: 'anthropic-prod',
    runtimeProfileName: null,
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: ['mcp__crm__*'],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['triage'] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  policySource: 'stored',
  resources: {
    files: [{ path: 'docs/playbook.md', access: 'read' }],
    skills: ['triage'],
    connectors: ['crm'],
  },
};

function withoutPolicySource(value: object): unknown {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'policySource'));
}

function withAgent(patch: Record<string, unknown>): unknown {
  return { ...definition, agent: { ...definition.agent, ...patch } };
}

describe('AgentDefinitionSchema', () => {
  it('accepts a complete, name-keyed definition', () => {
    expect(AgentDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it('pins the apiVersion and the kind', () => {
    expect(AgentDefinitionSchema.safeParse({ ...definition, apiVersion: 'v2' }).success).toBe(
      false,
    );
    expect(AgentDefinitionSchema.safeParse({ ...definition, kind: 'Agent' }).success).toBe(false);
  });

  it('refuses a credential smuggled in under any key, at every level', () => {
    expect(AgentDefinitionSchema.safeParse({ ...definition, credentials: 'sk-x' }).success).toBe(
      false,
    );
    expect(AgentDefinitionSchema.safeParse(withAgent({ apiKey: 'sk-x' })).success).toBe(false);
    const resources = { ...definition.resources, connectors: [{ name: 'crm', token: 't' }] };
    expect(AgentDefinitionSchema.safeParse({ ...definition, resources }).success).toBe(false);
  });

  it('refuses ids where names belong', () => {
    expect(AgentDefinitionSchema.safeParse(withAgent({ modelConnectionId: 'x' })).success).toBe(
      false,
    );
    const resources = { ...definition.resources, skillIds: ['id'] };
    expect(AgentDefinitionSchema.safeParse({ ...definition, resources }).success).toBe(false);
  });

  it('refuses missing fields and the pre-ADR-0065 provider discriminant', () => {
    const noPolicy = { ...definition, policy: undefined };
    expect(AgentDefinitionSchema.safeParse(noPolicy).success).toBe(false);
    const legacy = {
      ...definition,
      policy: { ...definition.policy, engine: undefined, provider: 'claude-agent-sdk' },
    };
    expect(AgentDefinitionSchema.safeParse(legacy).success).toBe(false);
  });

  it('bounds names, skill slugs and reference counts', () => {
    const longName = 'x'.repeat(AGENT_NAME_MAX_LENGTH + 1);
    expect(AgentDefinitionSchema.safeParse(withAgent({ name: longName })).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse(withAgent({ name: '' })).success).toBe(false);
    const badSkill = { ...definition.resources, skills: ['Not A Slug'] };
    expect(AgentDefinitionSchema.safeParse({ ...definition, resources: badSkill }).success).toBe(
      false,
    );
    const many = Array.from({ length: AGENT_DEFINITION_MAX_REFERENCES + 1 }, (_, i) => `c${i}`);
    const tooMany = { ...definition.resources, connectors: many };
    expect(AgentDefinitionSchema.safeParse({ ...definition, resources: tooMany }).success).toBe(
      false,
    );
    const pathAt = (length: number): unknown => ({
      ...definition,
      resources: { ...definition.resources, files: [{ path: 'p'.repeat(length), access: 'read' }] },
    });
    expect(
      AgentDefinitionSchema.safeParse(pathAt(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH)).success,
    ).toBe(true);
    expect(
      AgentDefinitionSchema.safeParse(pathAt(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH + 1)).success,
    ).toBe(false);
  });

  it('refuses an allowlist naming a skill resources.skills does not assign', () => {
    const policy = {
      ...definition.policy,
      skills: { mode: 'allowlist', names: ['triage', 'extra'] },
    };
    const result = AgentDefinitionSchema.safeParse({ ...definition, policy });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'policy.skills.names.1',
    ]);
  });

  it('reads an absent policySource as stored, and refuses an unknown one', () => {
    const handWritten = withoutPolicySource(definition);
    expect(AgentDefinitionSchema.parse(handWritten).policySource).toBe('stored');
    expect(
      AgentDefinitionSchema.parse({ ...definition, policySource: 'compiled' }).policySource,
    ).toBe('compiled');
    expect(
      AgentDefinitionSchema.safeParse({ ...definition, policySource: 'derived' }).success,
    ).toBe(false);
  });

  it('publishes every problem code with the status it travels under', () => {
    expect(AGENT_DEFINITION_PROBLEM_CODES).toEqual({
      invalid_agent_definition: 400,
      unsupported_engine: 400,
      agent_definition_references_missing: 422,
      agent_definition_reference_ambiguous: 409,
      agent_definition_reference_unresolvable: 409,
      agent_definition_import_incomplete: 409,
    });
  });
});

/**
 * ADR-0076 D2: `agentworkspace.dev/v1` is a promise to every file already written. This fixture is
 * frozen — written out literally, not built from the schema's constants — and must keep parsing
 * unchanged. A change to `AgentDefinitionSchema`, `AgentPolicySchema` or `AgentPermissionsSchema`
 * that breaks it needs a new `apiVersion`, not an edit here.
 */
describe('the frozen agentworkspace.dev/v1 fixture', () => {
  const frozen = {
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'AgentDefinition',
    agent: {
      name: 'Release notes writer',
      instructions: 'Summarise merged pull requests.',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      model: null,
      modelConnectionName: null,
      runtimeProfileName: 'default-docker',
    },
    policy: {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: ['Read', 'mcp__github__*'],
        deny: ['Bash', 'WebFetch'],
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'allowlist', names: ['changelog'] },
      limits: { maxTurns: 40, maxBudgetUsd: 2.5 },
    },
    policySource: 'stored',
    resources: {
      files: [
        { path: 'notes/template.md', access: 'read' },
        { path: 'notes/out', access: 'read-write' },
      ],
      skills: ['changelog'],
      connectors: ['github'],
    },
  } as const;

  it('keeps parsing, value for value', () => {
    expect(AgentDefinitionSchema.parse(frozen)).toEqual(frozen);
  });

  it('keeps parsing without the optional policySource', () => {
    const withoutSource = withoutPolicySource(frozen);
    expect(AgentDefinitionSchema.parse(withoutSource)).toEqual(frozen);
  });
});
