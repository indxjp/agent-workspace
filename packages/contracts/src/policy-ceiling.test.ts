import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  type AgentPermissions,
  type AgentPolicyLimits,
} from './agents.js';
import { CONNECTOR_NAME_MAX_LENGTH } from './connectors.js';
import {
  type EffectivePolicyConfiguration,
  meetPolicyCeiling,
  networkPolicyFloor,
  POLICY_CEILING_MODELS_MAX,
  POLICY_CEILING_TOOL_NAME_MAX_LENGTH,
  type PolicyWidening,
  policyWidenings,
  type ProjectPolicy,
  ProjectPolicyPermissionsSchema,
  ProjectPolicySchema,
} from './policy-ceiling.js';

const allOn: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

const allOff: AgentPermissions = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const effective: EffectivePolicyConfiguration = {
  permissions: { ...allOff, readFiles: true },
  limits: { maxTurns: 10, maxBudgetUsd: 1 },
  engine: 'claude-agent-sdk',
  model: 'claude-sonnet-4-5',
  tools: ['orders', 'github'],
};

function refusedPaths(value: unknown): (string | number | symbol)[][] {
  const result = ProjectPolicySchema.safeParse(value);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key])
      : [[...issue.path]],
  );
}

describe('ProjectPolicySchema (ADR-0102 SD6, issue #524)', () => {
  it('accepts every slice-2 key and an empty policy, frozen', () => {
    const policy = {
      permissions: { runCommands: false, unrestrictedNetwork: false },
      limits: { maxTurns: 20, maxBudgetUsd: 2.5 },
      engines: ['claude-agent-sdk', 'openai-agents'],
      models: ['claude-sonnet-4-5'],
      tools: ['orders'],
    };
    const parsed = ProjectPolicySchema.parse(policy);
    expect(parsed).toEqual(policy);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(ProjectPolicySchema.parse({})).toEqual({});
    expect(ProjectPolicySchema.parse({ tools: [] })).toEqual({ tools: [] });
  });

  it('keeps its permission keys equal to AGENT_PERMISSION_KEYS', () => {
    expect(Object.keys(ProjectPolicyPermissionsSchema.unwrap().shape)).toEqual([
      ...AGENT_PERMISSION_KEYS,
    ]);
  });

  it('refuses a control character in a models entry, as in tools (#524 review)', () => {
    const result = ProjectPolicySchema.safeParse({ models: ['gpt-4o\u0007\n\u001b[31mFAKE'] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['models', 0]);
    expect(result.error?.issues[0]?.message).toBe('must not contain a control character');
    expect(ProjectPolicySchema.safeParse({ models: ['gpt-4o'] }).success).toBe(true);
  });

  it('bounds tool names by the connector-name bound', () => {
    expect(POLICY_CEILING_TOOL_NAME_MAX_LENGTH).toBe(CONNECTOR_NAME_MAX_LENGTH);
  });

  it.each([
    ['maxCostPerDayUsd', { maxCostPerDayUsd: 5 }],
    ['network', { network: { allow: ['example.com'] } }],
    ['approval', { approval: 'always' }],
  ])('refuses %s at its own path as not built yet', (key, value) => {
    const result = ProjectPolicySchema.safeParse(value);
    expect(refusedPaths(value)).toEqual([[key]]);
    expect(result.error?.issues[0]?.message).toBe(
      `${key} is not built yet (ADR-0102 SD6); remove it`,
    );
  });

  it('refuses connections as an unknown key at the policy itself', () => {
    const result = ProjectPolicySchema.safeParse({ connections: ['anthropic'] });
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(result.error?.issues[0]?.path).toEqual([]);
    expect(refusedPaths({ connections: ['anthropic'] })).toEqual([['connections']]);
  });

  it('refuses a null limit, a non-positive limit and an unknown limit', () => {
    expect(refusedPaths({ limits: { maxTurns: null } })).toEqual([['limits', 'maxTurns']]);
    expect(refusedPaths({ limits: { maxBudgetUsd: 0 } })).toEqual([['limits', 'maxBudgetUsd']]);
    expect(refusedPaths({ limits: { maxTurns: 1.5 } })).toEqual([['limits', 'maxTurns']]);
    expect(refusedPaths({ limits: { maxCost: 1 } })).toEqual([['limits', 'maxCost']]);
  });

  it('refuses an unknown permission and a non-boolean switch', () => {
    expect(refusedPaths({ permissions: { browse: false } })).toEqual([['permissions', 'browse']]);
    expect(refusedPaths({ permissions: { runCommands: 'no' } })).toEqual([
      ['permissions', 'runCommands'],
    ]);
  });

  it('refuses an empty, duplicated or unknown engines list', () => {
    expect(refusedPaths({ engines: [] })).toEqual([['engines']]);
    expect(refusedPaths({ engines: ['pi', 'pi'] })).toEqual([['engines']]);
    expect(refusedPaths({ engines: ['nope'] })).toEqual([['engines', 0]]);
  });

  it('bounds models and refuses an empty or duplicated list', () => {
    expect(refusedPaths({ models: [] })).toEqual([['models']]);
    expect(refusedPaths({ models: ['m', 'm'] })).toEqual([['models']]);
    expect(refusedPaths({ models: [''] })).toEqual([['models', 0]]);
    expect(refusedPaths({ models: ['m'.repeat(AGENT_MODEL_MAX_LENGTH + 1)] })).toEqual([
      ['models', 0],
    ]);
    const tooMany = Array.from(
      { length: POLICY_CEILING_MODELS_MAX + 1 },
      (_, i) => `m${String(i)}`,
    );
    expect(refusedPaths({ models: tooMany })).toEqual([['models']]);
  });

  it('refuses a duplicated, empty, over-long or control-character tool name', () => {
    expect(refusedPaths({ tools: ['a', 'a'] })).toEqual([['tools']]);
    expect(refusedPaths({ tools: [''] })).toEqual([['tools', 0]]);
    expect(refusedPaths({ tools: ['t'.repeat(CONNECTOR_NAME_MAX_LENGTH + 1)] })).toEqual([
      ['tools', 0],
    ]);
    expect(refusedPaths({ tools: ['bad\u001bname'] })).toEqual([['tools', 0]]);
    const tooMany = Array.from(
      { length: AGENT_DEFINITION_MAX_REFERENCES + 1 },
      (_, i) => `t${String(i)}`,
    );
    expect(refusedPaths({ tools: tooMany })).toEqual([['tools']]);
  });

  it('emits a JSON Schema', () => {
    expect(() => z.toJSONSchema(ProjectPolicySchema)).not.toThrow();
  });
});

describe('ProjectPolicySchema promotion (issue #619)', () => {
  it('accepts a bar from 0 to 1', () => {
    for (const minEvalScore of [0, 0.9, 1]) {
      expect(ProjectPolicySchema.parse({ promotion: { minEvalScore } })).toEqual({
        promotion: { minEvalScore },
      });
    }
  });

  it('refuses a bar outside 0 to 1, a string and an unknown key', () => {
    for (const minEvalScore of [-0.1, 1.1, '0.9']) {
      expect(refusedPaths({ promotion: { minEvalScore } })).toEqual([
        ['promotion', 'minEvalScore'],
      ]);
    }
    expect(refusedPaths({ promotion: { minEvalScore: 1, override: true } })).toEqual([
      ['promotion', 'override'],
    ]);
  });

  it('is read by neither policyWidenings nor meetPolicyCeiling', () => {
    const ceiling: ProjectPolicy = { limits: { maxTurns: 5 }, tools: ['orders'] };
    const gated: ProjectPolicy = { ...ceiling, promotion: { minEvalScore: 1 } };
    expect(policyWidenings(effective, gated)).toEqual(policyWidenings(effective, ceiling));
    expect(meetPolicyCeiling(effective, gated)).toEqual(meetPolicyCeiling(effective, ceiling));
    expect(policyWidenings(effective, { promotion: { minEvalScore: 1 } })).toEqual([]);
  });
});

describe('policyWidenings (C14, issue #524)', () => {
  it.each<[string, ProjectPolicy, readonly PolicyWidening[]]>([
    [
      'a permission on above the ceiling',
      { permissions: { readFiles: false } },
      ['permissions.readFiles'],
    ],
    ['an explicit maxTurns above the ceiling', { limits: { maxTurns: 5 } }, ['limits.maxTurns']],
    [
      'an explicit maxBudgetUsd above the ceiling',
      { limits: { maxBudgetUsd: 0.5 } },
      ['limits.maxBudgetUsd'],
    ],
    ['an engine outside the allowlist', { engines: ['pi'] }, ['engine:claude-agent-sdk']],
    ['a model outside the allowlist', { models: ['gpt-5'] }, ['model:claude-sonnet-4-5']],
    ['a tool outside the allowlist', { tools: ['orders'] }, ['tool:github']],
  ])('gives exactly one detail for %s', (_name, ceiling, expected) => {
    expect(policyWidenings(effective, ceiling)).toEqual(expected);
  });

  it('gives every detail at once in C14 order, tools by code unit and named once', () => {
    const wide: EffectivePolicyConfiguration = {
      permissions: allOn,
      limits: { maxTurns: 100, maxBudgetUsd: 10 },
      engine: 'mastra',
      model: 'gpt-5',
      tools: ['zeta', 'Alpha', 'beta', 'zeta', 'allowed'],
    };
    const ceiling: ProjectPolicy = {
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      limits: { maxTurns: 1, maxBudgetUsd: 1 },
      engines: ['claude-agent-sdk'],
      models: ['claude-sonnet-4-5'],
      tools: ['allowed'],
    };
    expect(policyWidenings(wide, ceiling)).toEqual([
      'permissions.readFiles',
      'permissions.writeFiles',
      'permissions.runCommands',
      'permissions.unrestrictedNetwork',
      'limits.maxTurns',
      'limits.maxBudgetUsd',
      'engine:mastra',
      'model:gpt-5',
      'tool:Alpha',
      'tool:beta',
      'tool:zeta',
    ]);
    expect(policyWidenings({ ...wide, tools: [...wide.tools].reverse() }, ceiling)).toEqual(
      policyWidenings(wide, ceiling),
    );
  });

  it('gives no detail for null limits, permissions at or below the ceiling, no policy, a null model', () => {
    const tight: ProjectPolicy = {
      permissions: { writeFiles: false, readFiles: true },
      limits: { maxTurns: 1, maxBudgetUsd: 0.01 },
      models: ['other'],
    };
    const quiet: EffectivePolicyConfiguration = {
      ...effective,
      limits: { maxTurns: null, maxBudgetUsd: null },
      model: null,
    };
    expect(policyWidenings(quiet, tight)).toEqual([]);
    expect(
      policyWidenings({ ...quiet, limits: { maxTurns: 1, maxBudgetUsd: 0.01 } }, tight),
    ).toEqual([]);
    expect(policyWidenings(effective, null)).toEqual([]);
    expect(policyWidenings(effective, undefined)).toEqual([]);
    expect(policyWidenings(effective, {})).toEqual([]);
    expect(policyWidenings({ ...effective, tools: [] }, { tools: [] })).toEqual([]);
  });
});

// Exhaustive enumeration in place of a property-based library (the package has none).
const PERMISSION_VECTORS: readonly AgentPermissions[] = Array.from({ length: 16 }, (_, bits) => ({
  readFiles: (bits & 1) !== 0,
  writeFiles: (bits & 2) !== 0,
  runCommands: (bits & 4) !== 0,
  unrestrictedNetwork: (bits & 8) !== 0,
}));

/** A ceiling's permission caps: each switch absent, `false` or `true`, 3^4 vectors. */
const PERMISSION_CAPS: readonly ProjectPolicy['permissions'][] = Array.from(
  { length: 81 },
  (_, n) => {
    const choice = (digit: number): boolean | undefined =>
      [undefined, false, true][Math.floor(n / 3 ** digit) % 3];
    const caps: Record<string, boolean> = {};
    AGENT_PERMISSION_KEYS.forEach((key, digit) => {
      const value = choice(digit);
      if (value !== undefined) caps[key] = value;
    });
    return caps;
  },
);

const CAP = 10;
/** Null, below, equal and above the ceiling's cap of {@link CAP}. */
const LIMIT_GRID: readonly (number | null)[] = [null, CAP - 5, CAP, CAP + 5];
const TOOL_UNIVERSE = ['a', 'b', 'c'];
const TOOL_SUBSETS: readonly string[][] = Array.from({ length: 8 }, (_, bits) =>
  TOOL_UNIVERSE.filter((_, index) => (bits & (1 << index)) !== 0),
);

function atOrBelow(value: number | null, bound: number | null): boolean {
  if (bound === null) return true;
  return value !== null && value <= bound;
}

describe('meetPolicyCeiling (C14, issue #524)', () => {
  it('is at or below both inputs on permissions: 16 vectors x 81 caps', () => {
    const violations: string[] = [];
    for (const permissions of PERMISSION_VECTORS) {
      for (const caps of PERMISSION_CAPS) {
        const ceiling: ProjectPolicy = { permissions: caps };
        const met = meetPolicyCeiling({ ...effective, permissions }, ceiling);
        for (const key of AGENT_PERMISSION_KEYS) {
          const expected = permissions[key] && caps?.[key] !== false;
          if (met.permissions[key] !== expected)
            violations.push(JSON.stringify({ permissions, caps, key }));
        }
        if (!Object.isFrozen(met) || policyWidenings(met, ceiling).length > 0) {
          violations.push(JSON.stringify({ permissions, caps }));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('is at or below both inputs on limits: null, below, equal and above an absent or set cap', () => {
    const violations: string[] = [];
    for (const maxTurns of LIMIT_GRID) {
      for (const maxBudgetUsd of LIMIT_GRID) {
        for (const cap of [undefined, CAP]) {
          const ceiling: ProjectPolicy = {
            limits: cap === undefined ? {} : { maxTurns: cap, maxBudgetUsd: cap },
          };
          const limits: AgentPolicyLimits = { maxTurns, maxBudgetUsd };
          const met = meetPolicyCeiling({ ...effective, limits }, ceiling);
          const bound = cap ?? null;
          const ok =
            atOrBelow(met.limits.maxTurns, maxTurns) &&
            atOrBelow(met.limits.maxTurns, bound) &&
            atOrBelow(met.limits.maxBudgetUsd, maxBudgetUsd) &&
            atOrBelow(met.limits.maxBudgetUsd, bound) &&
            (maxTurns === null || met.limits.maxTurns === Math.min(maxTurns, cap ?? maxTurns)) &&
            policyWidenings(met, ceiling).length === 0;
          if (!ok) violations.push(JSON.stringify({ limits, cap, met: met.limits }));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('is at or below both inputs on tools: 8 subsets x (no allowlist or 8 allowlists)', () => {
    const violations: string[] = [];
    for (const tools of TOOL_SUBSETS) {
      for (const allow of [undefined, ...TOOL_SUBSETS]) {
        const ceiling: ProjectPolicy = allow === undefined ? {} : { tools: allow };
        const met = meetPolicyCeiling({ ...effective, tools }, ceiling);
        const expected = allow === undefined ? tools : tools.filter((tool) => allow.includes(tool));
        if (
          JSON.stringify(met.tools) !== JSON.stringify(expected) ||
          !Object.isFrozen(met.tools) ||
          policyWidenings(met, ceiling).length > 0
        ) {
          violations.push(JSON.stringify({ tools, allow, met: met.tools }));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('composes a null limit at the ceiling and keeps a lower one', () => {
    const met = meetPolicyCeiling(
      { ...effective, limits: { maxTurns: null, maxBudgetUsd: 0.5 } },
      { limits: { maxTurns: 7, maxBudgetUsd: 2 } },
    );
    expect(met.limits).toEqual({ maxTurns: 7, maxBudgetUsd: 0.5 });
    const open = meetPolicyCeiling(
      { ...effective, limits: { maxTurns: null, maxBudgetUsd: null } },
      {},
    );
    expect(open.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
  });

  it('keeps tools in input order', () => {
    const met = meetPolicyCeiling({ ...effective, tools: ['c', 'a', 'b'] }, { tools: ['b', 'c'] });
    expect(met.tools).toEqual(['c', 'b']);
    expect(meetPolicyCeiling({ ...effective, tools: ['c'] }, { tools: [] }).tools).toEqual([]);
  });

  it('returns a null or absent ceiling unchanged', () => {
    expect(meetPolicyCeiling(effective, null)).toBe(effective);
    expect(meetPolicyCeiling(effective, undefined)).toBe(effective);
  });

  it('leaves engine and model unchanged, so only their widenings survive the meet', () => {
    const wide: EffectivePolicyConfiguration = {
      permissions: allOn,
      limits: { maxTurns: 100, maxBudgetUsd: null },
      engine: 'pi',
      model: 'gpt-5',
      tools: ['x', 'y'],
    };
    const ceilings: readonly ProjectPolicy[] = [
      {},
      { permissions: { runCommands: false }, limits: { maxTurns: 3 } },
      { engines: ['claude-agent-sdk'] },
      { models: ['claude-sonnet-4-5'], tools: ['x'] },
      {
        permissions: { readFiles: false, writeFiles: false },
        limits: { maxTurns: 1, maxBudgetUsd: 1 },
        engines: ['mastra'],
        models: ['o3'],
        tools: [],
      },
    ];
    for (const ceiling of ceilings) {
      for (const model of ['gpt-5', null]) {
        const input = { ...wide, model };
        const met = meetPolicyCeiling(input, ceiling);
        expect(met.engine).toBe(input.engine);
        expect(met.model).toBe(input.model);
        expect(policyWidenings(met, ceiling)).toEqual(
          policyWidenings(input, ceiling).filter(
            (detail) => detail.startsWith('engine:') || detail.startsWith('model:'),
          ),
        );
      }
    }
  });
});

describe('networkPolicyFloor', () => {
  const hosts = ['b.example.com', 'a.example.com', 'b.example.com'];

  it.each([
    ['none', undefined, false, hosts, 'none', undefined, false],
    ['none', undefined, true, hosts, 'none', undefined, false],
    ['restricted', ['x.example.com'], false, hosts, 'restricted', ['x.example.com'], false],
    ['restricted', ['x.example.com'], true, hosts, 'restricted', ['x.example.com'], false],
    ['open', undefined, true, hosts, 'open', undefined, false],
    ['open', undefined, true, [], 'open', undefined, false],
    ['open', undefined, false, hosts, 'restricted', ['a.example.com', 'b.example.com'], true],
    ['open', undefined, false, [], 'none', undefined, true],
  ] as const)(
    '%s %j, unrestrictedNetwork=%s, hosts=%j -> %s %j (lowered=%s)',
    (
      policy,
      domains,
      unrestrictedNetwork,
      connectorHosts,
      expectedPolicy,
      expectedDomains,
      lowered,
    ) => {
      const floor = networkPolicyFloor({
        networkPolicy: policy,
        allowedDomains: domains,
        unrestrictedNetwork,
        connectorHosts,
      });
      expect(floor.networkPolicy).toBe(expectedPolicy);
      expect(floor.allowedDomains).toEqual(expectedDomains);
      expect(floor.lowered).toBe(lowered);
      expect(Object.isFrozen(floor)).toBe(true);
    },
  );
});
