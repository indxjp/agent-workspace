import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
} from './agents.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { AgentPolicyLimitsSchema } from './agents/policy.js';
import {
  AW_CONTROL_SERVER,
  BUILDER_DEFAULT_LIMITS,
  BUILDER_MODEL,
  BUILDER_REFUSAL_CODES,
  BUILDER_RUN_LIMITS,
  BUILDER_TOOLS,
  BUILDER_TOOL_NAMES,
  BUILDER_TOOL_SDK_METHODS,
  BuilderToolInputSchemas,
  BuilderToolOutputSchemas,
  type BuilderDecision,
  type BuilderRefusalCode,
  type BuilderToolName,
} from './builder.js';

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
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  policySource: 'stored',
  resources: { files: [], skills: [], connectors: [] },
};
const body = { definition };

const A = '11111111-1111-4111-8111-111111111111';
const EVAL_CASE = { name: 'a', input: 'Where is order 1?', expect: { contains: ['ok'] } };

describe('the Builder vocabulary (#1844 slice 2)', () => {
  it('gives every tool a wire-safe name, an input schema and an output schema', () => {
    expect(BUILDER_TOOL_NAMES).toEqual(Object.keys(BUILDER_TOOLS));
    expect(BUILDER_TOOL_NAMES).toHaveLength(6);
    for (const name of BUILDER_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z_]{1,64}$/);
      expect(BuilderToolInputSchemas[name]).toBeDefined();
      expect(BuilderToolOutputSchemas[name]).toBeDefined();
      expect(BUILDER_TOOL_SDK_METHODS[name]).toBeDefined();
    }
    expect(AW_CONTROL_SERVER).toBe('aw-control');
  });

  it('refuses an extra identity key on every input schema', () => {
    const minimal: Record<BuilderToolName, unknown> = {
      catalog_list: {},
      examples_get: {},
      draft_check: { body },
      draft_save: { body },
      evals_run: { agentId: A, version: 1, cases: [EVAL_CASE] },
      trial_run: { agentId: A, version: 1, input: 'hi' },
    };
    for (const name of BUILDER_TOOL_NAMES) {
      for (const key of ['workspaceId', 'principal', 'role', 'via']) {
        const result = BuilderToolInputSchemas[name].safeParse({
          ...(minimal[name] as object),
          [key]: 'x',
        });
        expect(result.success, `${name} accepted ${key}`).toBe(false);
        expect(
          result.error?.issues.map((issue) => issue.code),
          `${name} ${key}`,
        ).toEqual(['unrecognized_keys']);
      }
    }
  });

  it('requires cases on evals_run, so a call without them is refused before it can be approved', () => {
    const schema = BuilderToolInputSchemas.evals_run;
    expect(schema.safeParse({ agentId: A, version: 1, cases: [EVAL_CASE] }).success).toBe(true);
    const missing = schema.safeParse({ agentId: A, version: 1 });
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([['cases']]);
  });

  it('requires baseVersion exactly when draft_save names an agent', () => {
    const schema = BuilderToolInputSchemas.draft_save;
    const missing = schema.safeParse({ agentId: A, body });
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([['baseVersion']]);
    const orphan = schema.safeParse({ baseVersion: 2, body });
    expect(orphan.error?.issues.map((issue) => issue.path)).toEqual([['baseVersion']]);
    expect(schema.safeParse({ agentId: A, baseVersion: 2, body }).success).toBe(true);
    expect(schema.safeParse({ body }).success).toBe(true);
  });

  it('parses a well-formed output', () => {
    const parsed = BuilderToolOutputSchemas.draft_save.safeParse({
      ok: true,
      agentId: A,
      version: 3,
      pointer: 'local',
      awCommand: 'aw agents push',
    });
    expect(parsed.success).toBe(true);
  });

  it('bounds the trial input and shows the matching aw command in every output', () => {
    expect(
      BuilderToolInputSchemas.trial_run.safeParse({
        agentId: A,
        version: 1,
        input: 'x'.repeat(100_000),
      }).success,
    ).toBe(false);
    for (const name of BUILDER_TOOL_NAMES) {
      expect(BuilderToolOutputSchemas[name].safeParse({ ok: true }).success).toBe(false);
    }
  });

  it('defines the closed refusal list with a status and a fix each', () => {
    expect(Object.keys(BUILDER_REFUSAL_CODES)).toHaveLength(21);
    for (const entry of Object.values(BUILDER_REFUSAL_CODES)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.fix.length).toBeGreaterThan(0);
    }
    expect(BUILDER_DEFAULT_LIMITS).toEqual({
      maxFailedChecksInARow: 5,
      maxToolCallsPerRun: 50,
      trialBudgetUsd: 0.3,
      creationsPerWorkspacePerDay: 20,
      toolOutputMaxBytes: 32_768,
    });
  });

  it('pins the Builder model and gives a run limits the agent policy accepts', () => {
    expect(BUILDER_MODEL).toBe('claude-sonnet-5-5');
    expect(AgentPolicyLimitsSchema.parse(BUILDER_RUN_LIMITS)).toEqual(BUILDER_RUN_LIMITS);
  });

  it('forces an exhaustive switch over decisions and refusal codes', () => {
    const describeDecision = (decision: BuilderDecision): string => {
      switch (decision.kind) {
        case 'refuse':
          return refusal(decision.code);
        case 'ask':
          return decision.question;
        case 'run':
          return decision.tool;
        default:
          return decision satisfies never;
      }
    };
    const refusal = (code: BuilderRefusalCode): string => {
      switch (code) {
        case 'builder_disabled':
        case 'no_caller':
        case 'not_permitted':
        case 'read_only_client':
        case 'not_owner':
        case 'forbidden':
        case 'invalid_arguments':
        case 'unknown_tool':
        case 'check_limit_reached':
        case 'tool_call_limit_reached':
        case 'budget_exceeded':
        case 'quota_exceeded':
        case 'pointer_moved':
        case 'creator_cannot_widen':
        case 'depth_limit':
        case 'not_allowed_to_build':
        case 'approval_required':
        case 'builder_model_unavailable':
        case 'invalid_trial_input':
        case 'invalid_run_limits':
        case 'trial_not_stopped':
          return code;
        default:
          return code satisfies never;
      }
    };
    expect(describeDecision({ kind: 'run', tool: 'catalog_list' })).toBe('catalog_list');
    expectTypeOf<BuilderRefusalCode>().toEqualTypeOf<keyof typeof BUILDER_REFUSAL_CODES>();
  });
});
