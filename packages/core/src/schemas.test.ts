import {
  AgentToolPolicySchema,
  DenyingToolRuleSchema,
  GrantingToolRuleSchema,
} from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import {
  AgentSkillPolicy,
  CreateRuntimeProfileInput,
  DEFAULT_RUN_ENGINE,
  McpServerConfig,
  PortableAgentConfig,
  RunRequest,
  RuntimeProfile,
  SkillName,
  TenantSessionScope,
  classifyRunCost,
  classifySdkEvent,
  runtimeDriverIds,
  validateTenantSessionScope,
} from './schemas.js';
import { sdkSystemSubtypes } from './types.js';
import { runtimeProfileDrivers } from './db/schema/runtime-profiles.js';

/**
 * A fully-canonical agent: every optional and defaulted field present, so `parse(value)` is
 * expected to be deep-equal to `value` and the round-trip assertion means something.
 *
 * Not exported. `config.test.ts` restates it instead of importing it: importing one test module
 * from another runs its `describe` blocks a second time.
 */
const canonicalAgent = {
  name: 'Customer Support Agent',
  instructions: 'You help employees answer questions...',
  model: 'claude-sonnet-4-5',
  permissions: {
    readFiles: true,
    writeFiles: true,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  skills: { mode: 'allowlist', names: ['customer-support'] },
  mcpServers: {
    jira: {
      type: 'http',
      url: 'https://jira.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    },
    search: { command: '/usr/bin/search-mcp', args: ['--stdio'] },
  },
  limits: { maxTurns: 20, maxBudgetUsd: 5 },
} as const;

const canonicalRunRequest = {
  runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
  sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
  cwd: '/workspace',
  prompt: 'Summarise the open Jira issues.',
  projectKey: 'tenant-a',
  portable: canonicalAgent,
  policy: { tools: null, fileGrantDeny: [] },
  session: { kind: 'fresh', sessionId: 'c101d922-3c4b-4a12-9b1e-0a1b2c3d4e5f' },
  env: { PATH: '/usr/bin', HOME: '/home/agent' },
} as const;

describe('types round-trip through their Zod schemas', () => {
  it('parses a canonical agent back to itself', () => {
    const parsed = PortableAgentConfig.parse(canonicalAgent);
    expect(parsed).toEqual(canonicalAgent);
    expect(PortableAgentConfig.parse(parsed)).toEqual(parsed);
  });

  it('accepts a runtimeProfileId — present, explicitly null, or absent — as §17 Step 5', () => {
    const withProfile = {
      ...canonicalAgent,
      runtimeProfileId: 'b6c1b6d8-6b1a-4a8e-9b1a-1c2d3e4f5a6b',
    };
    expect(PortableAgentConfig.parse(withProfile)).toEqual(withProfile);
    expect(PortableAgentConfig.parse({ ...canonicalAgent, runtimeProfileId: null })).toEqual({
      ...canonicalAgent,
      runtimeProfileId: null,
    });
    // Absent entirely — the shape every fixture predating this field still has, including
    // `packages/core/src/config.test.ts`'s, which this task does not own.
    expect(PortableAgentConfig.parse(canonicalAgent)).toEqual(canonicalAgent);
  });

  it('accepts up to 20 strict subagents and leaves a body without the key unchanged', () => {
    const sub = {
      name: 'billing-specialist',
      description: 'Answers billing questions.',
      instructions: 'You answer billing questions.',
      model: null,
      permissions: canonicalAgent.permissions,
    };
    const withSubagents = { ...canonicalAgent, subagents: [sub] };
    expect(PortableAgentConfig.parse(withSubagents)).toEqual(withSubagents);
    expect(PortableAgentConfig.parse(canonicalAgent)).not.toHaveProperty('subagents');
    expect(
      PortableAgentConfig.safeParse({ ...canonicalAgent, subagents: [{ ...sub, colour: 'blue' }] })
        .success,
    ).toBe(false);
    expect(
      PortableAgentConfig.safeParse({ ...canonicalAgent, subagents: [{ ...sub, description: '' }] })
        .success,
    ).toBe(false);
    expect(
      PortableAgentConfig.safeParse({
        ...canonicalAgent,
        subagents: Array.from({ length: 21 }, () => sub),
      }).success,
    ).toBe(false);
  });

  it('parses a canonical run request back to itself, with the engine defaulted in', () => {
    const parsed = RunRequest.parse(canonicalRunRequest);
    // ENG-04 (#303): `engine` defaults rather than being required, so a control plane that has
    // not been redeployed yet keeps composing a body a new runner accepts. The round trip is
    // therefore *up to* the default, and the second parse is what proves the default is stable
    // — a default that changed a value it had already supplied would not be a default.
    expect(parsed).toEqual({ ...canonicalRunRequest, engine: DEFAULT_RUN_ENGINE });
    expect(RunRequest.parse(parsed)).toEqual(parsed);
  });

  it('keeps an engine a caller named rather than overriding it with the default', () => {
    const named = { ...canonicalRunRequest, engine: 'some-future-engine' };
    // The runner's registry decides whether an id names an installed adapter; this schema's job
    // is to carry it unchanged. Silently rewriting it here would run the request on an engine
    // its author did not choose.
    expect(RunRequest.parse(named).engine).toBe('some-future-engine');
    expect(() => RunRequest.parse({ ...canonicalRunRequest, engine: '' })).toThrow();
  });

  it('accepts the gateway connection ENG-04 added, and refuses a malformed one', () => {
    const gateway = {
      baseUrl: 'https://gateway.example',
      token: 'run-scoped-token',
      protocol: 'anthropic-messages',
    };
    expect(RunRequest.parse({ ...canonicalRunRequest, gateway }).gateway).toEqual(gateway);
    // Absent is legal — a pre-ENG-04 body still parses, which is the whole point of the field
    // being optional during the rollout window.
    expect(RunRequest.parse(canonicalRunRequest).gateway).toBeUndefined();
    for (const bad of [
      { ...gateway, baseUrl: 'gateway.example' },
      { ...gateway, token: '' },
      { ...gateway, protocol: '' },
      { ...gateway, extra: 'x' },
    ]) {
      expect(() => RunRequest.parse({ ...canonicalRunRequest, gateway: bad })).toThrow();
    }
  });

  it('rejects an unknown key rather than dropping it', () => {
    expect(() => PortableAgentConfig.parse({ ...canonicalAgent, colour: 'blue' })).toThrow();
    expect(() => RunRequest.parse({ ...canonicalRunRequest, priority: 1 })).toThrow();
  });

  it('accepts every session mode and only the three legal shapes', () => {
    const resume = { kind: 'resume', resume: canonicalRunRequest.session.sessionId } as const;
    const fork = {
      kind: 'fork',
      resume: resume.resume,
      sessionId: canonicalRunRequest.sessionId,
    } as const;
    expect(RunRequest.parse({ ...canonicalRunRequest, session: resume }).session).toEqual(resume);
    expect(RunRequest.parse({ ...canonicalRunRequest, session: fork }).session).toEqual(fork);
    // `resume` alongside a `sessionId` without declaring a fork is exactly the combination the
    // SDK rejects (R-01 §6), and the union makes it unrepresentable.
    expect(() =>
      RunRequest.parse({
        ...canonicalRunRequest,
        session: {
          kind: 'resume',
          resume: resume.resume,
          sessionId: canonicalRunRequest.sessionId,
        },
      }),
    ).toThrow();
  });
});

/** Spec §15.1, every field present — the same completeness discipline `canonicalAgent` uses. */
const canonicalRuntimeProfile = {
  id: 'b6c1b6d8-6b1a-4a8e-9b1a-1c2d3e4f5a6b',
  name: 'Standard',
  driver: 'docker',
  runtimeConnectionId: 'a1b2c3d4-1111-2222-3333-444455556666',
  cpu: 1,
  memoryMb: 1024,
  diskMb: 5120,
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  persistPaths: ['/workspace/output'],
  timeoutSeconds: 3600,
  idleTimeoutSeconds: 600,
  driverConfig: { note: 'default' },
} as const;

describe('RuntimeProfile (spec §15.1)', () => {
  it('parses a canonical profile back to itself', () => {
    const parsed = RuntimeProfile.parse(canonicalRuntimeProfile);
    expect(parsed).toEqual(canonicalRuntimeProfile);
  });

  it('accepts a profile with none of the optional fields set', () => {
    const minimal = {
      id: canonicalRuntimeProfile.id,
      name: canonicalRuntimeProfile.name,
      driver: canonicalRuntimeProfile.driver,
      networkPolicy: canonicalRuntimeProfile.networkPolicy,
      filesystem: canonicalRuntimeProfile.filesystem,
    };
    expect(RuntimeProfile.parse(minimal)).toEqual(minimal);
  });

  it('rejects an unknown key rather than dropping it', () => {
    expect(() => RuntimeProfile.parse({ ...canonicalRuntimeProfile, extra: true })).toThrow();
  });

  it('rejects a driver outside §14.2’s catalogue', () => {
    expect(() =>
      RuntimeProfile.parse({ ...canonicalRuntimeProfile, driver: 'my-own-cloud' }),
    ).toThrow();
  });

  it('rejects a networkPolicy or filesystem outside their closed sets', () => {
    expect(() =>
      RuntimeProfile.parse({ ...canonicalRuntimeProfile, networkPolicy: 'firewalled' }),
    ).toThrow();
    expect(() =>
      RuntimeProfile.parse({ ...canonicalRuntimeProfile, filesystem: 'read-mostly' }),
    ).toThrow();
  });

  it('rejects fractional byte and timeout limits before a profile can reach the runner', () => {
    for (const [field, value] of [
      ['memoryMb', 512.5],
      ['diskMb', 1024.5],
      ['timeoutSeconds', 30.5],
      ['idleTimeoutSeconds', 10.5],
    ] as const) {
      expect(() => RuntimeProfile.parse({ ...canonicalRuntimeProfile, [field]: value })).toThrow();
    }
  });

  it('CreateRuntimeProfileInput accepts the profile without its id', () => {
    const { id, ...withoutId } = canonicalRuntimeProfile;
    expect(id.length).toBeGreaterThan(0);
    expect(CreateRuntimeProfileInput.parse(withoutId)).toEqual(withoutId);
    expect(() => CreateRuntimeProfileInput.parse(canonicalRuntimeProfile)).toThrow();
  });

  it('keeps its driver catalogue equal to the database schema’s independent copy', () => {
    // Two copies of §14.2's ten drivers exist because `packages/core` may add no dependency on
    // `packages/runtime` this level (ADR-0041) and a database CHECK cannot reference a TypeScript
    // type either. This is what stops them drifting silently: a driver added to one and not the
    // other fails here rather than at a driver task's integration.
    expect([...runtimeDriverIds].sort()).toEqual([...runtimeProfileDrivers].sort());
  });
});

const UNANCHORED_WILDCARD = (rule: string): string =>
  `${JSON.stringify(rule)} is an unanchored wildcard. R-01 §10: the SDK ignores it in an allow list with a startup warning, so it grants nothing. Name the tools, or anchor it as 'mcp__<server>__*'.`;

/** The first issue message a rule schema gives for `input`, or `null` when it accepts. */
function ruleMessage(schema: typeof GrantingToolRuleSchema, input: unknown): string | null {
  const result = schema.safeParse(input);
  return result.success ? null : (result.error.issues[0]?.message ?? '');
}

describe('the tool-rule schemas implement the grammar R-01 §10 records', () => {
  it('accepts bare, scoped and anchored-MCP-glob rules', () => {
    for (const rule of [
      'Read',
      'mcp__github__get_issue',
      'Bash(ls *)',
      'Edit(//secrets/**)',
      'mcp__puppeteer__*',
    ]) {
      expect(ruleMessage(GrantingToolRuleSchema, rule), rule).toBeNull();
      expect(ruleMessage(DenyingToolRuleSchema, rule), rule).toBeNull();
    }
  });

  it('rejects malformed rules by name, with the sentence that says what was wrong', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [42, 'Invalid input: expected string, received number'],
      [null, 'Invalid input: expected string, received null'],
      [undefined, 'Invalid input: expected string, received undefined'],
      ['', 'a tool rule must not be empty'],
      [' Read', 'the tool rule " Read" has leading or trailing whitespace'],
      ['Read(', `the tool rule "Read(" opens a specifier with '(' but never closes it`],
      [
        'Read()',
        'the tool rule "Read()" has an empty specifier; drop the parentheses to mean "every call"',
      ],
      ['Read(a)b)', `the tool rule "Read(a)b)" has a ')' inside its specifier`],
      ['(x)', `the tool rule "(x)" has no tool name before '('`],
      [
        'mcp__github',
        `"mcp__github" names an MCP server but no tool; write 'mcp__github__<tool>' or 'mcp__github__*'`,
      ],
      ['mcp__a_', '"mcp__a_" names the MCP server "a_", which is not a valid server name'],
      [
        'mcp__a__b_*(x)',
        `"mcp__a__b_*(x)" combines an MCP tool glob with a '(specifier)', which the rule grammar does not support`,
      ],
      [
        '1Tool',
        '"1Tool" is not a tool name: expected a letter followed by letters, digits or underscores',
      ],
    ];
    for (const [input, message] of cases) {
      expect(ruleMessage(GrantingToolRuleSchema, input), String(input)).toBe(message);
      expect(ruleMessage(DenyingToolRuleSchema, input), String(input)).toBe(message);
    }
  });

  it('refuses an unanchored wildcard where it would grant nothing, and allows it where it removes', () => {
    // The asymmetry is the whole point: in an allow list the SDK ignores `*` with a startup
    // warning, so storing one would record a permission that does not exist.
    expect(ruleMessage(GrantingToolRuleSchema, '*')).toBe(UNANCHORED_WILDCARD('*'));
    expect(ruleMessage(GrantingToolRuleSchema, 'mcp__*')).toBe(UNANCHORED_WILDCARD('mcp__*'));
    expect(GrantingToolRuleSchema.safeParse('mcp__github__get_*').success).toBe(true);
    expect(DenyingToolRuleSchema.safeParse('*').success).toBe(true);
    expect(DenyingToolRuleSchema.safeParse('mcp__*').success).toBe(true);
    expect(DenyingToolRuleSchema.safeParse('Read(').success).toBe(false);
  });
});

describe('AgentToolPolicySchema pairs bypassPermissions with its explicit flag', () => {
  const base = {
    base: 'claude_code_preset',
    autoApprove: ['Read'],
    deny: [],
    permissionMode: 'bypassPermissions',
  };

  it('refuses bypassPermissions without allowDangerouslySkipPermissions', () => {
    const message =
      "permissionMode 'bypassPermissions' requires allowDangerouslySkipPermissions: true (R-01 §10). Set it deliberately or choose another mode.";
    const refused = AgentToolPolicySchema.safeParse({
      ...base,
      allowDangerouslySkipPermissions: false,
    });
    expect(refused.success ? null : refused.error.issues.map((issue) => issue.message)).toEqual([
      message,
    ]);
    // The default is `false`, so omitting the flag must not become a way to get the mode.
    const omitted = AgentToolPolicySchema.safeParse(base);
    expect(omitted.success ? null : omitted.error.issues.map((issue) => issue.message)).toEqual([
      message,
    ]);
  });

  it('accepts it when the flag is set deliberately', () => {
    expect(
      AgentToolPolicySchema.safeParse({ ...base, allowDangerouslySkipPermissions: true }).success,
    ).toBe(true);
  });

  it('refuses the flag under any other mode', () => {
    const refused = AgentToolPolicySchema.safeParse({
      ...base,
      permissionMode: 'dontAsk',
      allowDangerouslySkipPermissions: true,
    });
    expect(refused.success ? null : refused.error.issues.map((issue) => issue.message)).toEqual([
      "allowDangerouslySkipPermissions is only meaningful with permissionMode 'bypassPermissions'; this policy uses 'dontAsk'.",
    ]);
  });
});

describe('skills are scoped by the skills option, not by settingSources', () => {
  it('accepts an empty allowlist — the only lever that lets Claude invoke none', () => {
    expect(AgentSkillPolicy.parse({ mode: 'allowlist', names: [] })).toEqual({
      mode: 'allowlist',
      names: [],
    });
    expect(AgentSkillPolicy.parse({ mode: 'all' })).toEqual({ mode: 'all' });
  });

  it('rejects the skill names the SDK would reject at spawn, and path traversal', () => {
    for (const good of ['customer-support', 'code_review', 'plugin:skill']) {
      expect(SkillName.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ['', ' x', 'x ', '*', 'a:*', '/abs', 'a\\b', 'a(b)', 'a,b', '..', '../etc']) {
      expect(SkillName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('MCP connector configuration', () => {
  it("normalises the JSON alias 'streamable-http' to the only spelling the SDK's type declares", () => {
    expect(
      McpServerConfig.parse({ type: 'streamable-http', url: 'https://example.com/mcp' }),
    ).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('accepts stdio without an explicit type, and sse with one', () => {
    expect(McpServerConfig.parse({ command: 'srv' })).toEqual({ command: 'srv' });
    expect(McpServerConfig.parse({ type: 'sse', url: 'https://example.com/e' })).toEqual({
      type: 'sse',
      url: 'https://example.com/e',
    });
  });

  it('refuses a timeout the SDK would ignore, and the instance-carrying sdk arm', () => {
    // R-01 §9: a per-server timeout below 1000 ms is ignored, so storing one stores a lie.
    expect(McpServerConfig.safeParse({ command: 'srv', timeout: 500 }).success).toBe(false);
    expect(McpServerConfig.safeParse({ command: 'srv', timeout: 1000 }).success).toBe(true);
    expect(McpServerConfig.safeParse({ type: 'sdk', name: 'x' }).success).toBe(false);
  });

  it('refuses a server name that would make mcp__<server>__<tool> ambiguous', () => {
    expect(
      PortableAgentConfig.safeParse({ ...canonicalAgent, mcpServers: { a__b: { command: 'x' } } })
        .success,
    ).toBe(false);
  });

  it('accepts a single "_" inside a server name and still refuses "__" or an edge "_" (SD13)', () => {
    const accepts = (name: string) =>
      PortableAgentConfig.safeParse({ ...canonicalAgent, mcpServers: { [name]: { command: 'x' } } })
        .success;
    expect(accepts('orders_2')).toBe(true);
    expect(accepts('t_42_things')).toBe(true);
    for (const name of ['a__b', 'a_', '_a', '_']) expect(accepts(name), name).toBe(false);
    expect(GrantingToolRuleSchema.safeParse('mcp__orders_2__*').success).toBe(true);
  });
});

describe('validateTenantSessionScope covers both of the SDK’s silent failure modes', () => {
  it('accepts a scope the SDK would honour', () => {
    const verdict = validateTenantSessionScope({ projectKey: 'tenant-a', configDir: '/cfg' });
    expect(verdict).toEqual({ ok: true, projectKey: 'tenant-a', configDir: '/cfg' });
  });

  it('rejects a name the SDK would silently ignore (failure mode 2)', () => {
    for (const bad of ['', 'tenant a', 'tenant.a', 'x'.repeat(65), 'con', 'COM3', 'lpt0', 'nul']) {
      const verdict = validateTenantSessionScope({ projectKey: bad, configDir: '/cfg' });
      expect(verdict.ok, JSON.stringify(bad)).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toContain('CLAUDE_CODE_PROJECT_DIR_NAME');
    }
  });

  it('rejects a missing or empty config dir (failure mode 1)', () => {
    for (const configDir of [undefined, null, '', '   ', 7]) {
      const verdict = validateTenantSessionScope({ projectKey: 'tenant-a', configDir });
      expect(verdict.ok, JSON.stringify(configDir)).toBe(false);
      expect(verdict.ok ? '' : verdict.reason).toContain('CLAUDE_CONFIG_DIR');
    }
  });

  it('rejects a scope that is not an object at all rather than reading fields off it', () => {
    for (const bad of [undefined, null, 'tenant-a', ['tenant-a']]) {
      expect(validateTenantSessionScope(bad).ok).toBe(false);
    }
  });

  it('is the same rule the schema applies', () => {
    expect(
      TenantSessionScope.safeParse({ projectKey: 'tenant a', configDir: '/cfg' }).success,
    ).toBe(false);
    expect(TenantSessionScope.safeParse({ projectKey: 'tenant-a', configDir: '' }).success).toBe(
      false,
    );
    expect(
      TenantSessionScope.safeParse({ projectKey: 'tenant-a', configDir: '/cfg' }).success,
    ).toBe(true);
  });
});

describe('classifySdkEvent forwards the unknown and rejects the malformed', () => {
  it('recognises every system subtype this platform transcribed', () => {
    for (const subtype of sdkSystemSubtypes) {
      const classified = classifySdkEvent({ type: 'system', subtype, session_id: 's', uuid: 'u' });
      expect(classified.kind, subtype).toBe('system');
    }
  });

  it('forwards an unknown system subtype opaquely and never throws', () => {
    // R-01 §4: probe 2 received `system/thinking_tokens` from a run that set no thinking
    // options, and new subtypes ship in patch releases. This is the default branch the note
    // requires, exercised on a subtype that does not exist today.
    const event = { type: 'system', subtype: 'some_future_subtype', payload: { a: 1 } };
    const classified = classifySdkEvent(event);
    expect(classified.kind).toBe('system-unknown');
    expect(classified.kind === 'system-unknown' ? classified.subtype : '').toBe(
      'some_future_subtype',
    );
    expect(classified.kind === 'system-unknown' ? classified.event : null).toBe(event);
  });

  it('forwards an unknown top-level type opaquely', () => {
    const classified = classifySdkEvent({ type: 'some_future_type' });
    expect(classified.kind).toBe('unknown');
  });

  it('marks result events as the only carriers of usage', () => {
    const ok = classifySdkEvent({ type: 'result', subtype: 'success' });
    expect(ok.kind).toBe('result');
    expect(ok.kind === 'result' ? ok.carriesUsage : false).toBe(true);
    const future = classifySdkEvent({ type: 'result', subtype: 'error_future' });
    expect(future.kind).toBe('result-unknown');
    expect(classifySdkEvent({ type: 'assistant' }).kind).toBe('event');
  });

  it('rejects a malformed envelope by name instead of forwarding it as understood', () => {
    for (const bad of [undefined, null, 'result', 42, ['result'], {}, { type: 7 }]) {
      const classified = classifySdkEvent(bad);
      expect(classified.kind, JSON.stringify(bad)).toBe('malformed');
      expect(classified.kind === 'malformed' ? classified.reason : '').not.toBe('');
    }
    // A `system` event with no string subtype must NOT fall through to the opaque-forward path.
    expect(classifySdkEvent({ type: 'system' }).kind).toBe('malformed');
    expect(classifySdkEvent({ type: 'result', subtype: null }).kind).toBe('malformed');
  });

  it('never throws, whatever it is handed', () => {
    const cyclic: Record<string, unknown> = { type: 'system', subtype: 'init' };
    cyclic['self'] = cyclic;
    expect(() => classifySdkEvent(cyclic)).not.toThrow();
    expect(() => classifySdkEvent(Symbol('x'))).not.toThrow();
    expect(() => classifySdkEvent(() => undefined)).not.toThrow();
  });
});

describe('classifyRunCost refuses to present a guess as money', () => {
  it('prices a run whose costBasis is list or managed', () => {
    expect(classifyRunCost({ costUSD: 0.04, costBasis: 'list' })).toEqual({
      priced: true,
      costUsd: 0.04,
      basis: 'list',
    });
    // R-01 §4: an absent costBasis is to be read as 'list'.
    expect(classifyRunCost({ costUSD: 0 })).toEqual({ priced: true, costUsd: 0, basis: 'list' });
  });

  it("declares an 'unknown' basis unpriced rather than showing $0.00", () => {
    const verdict = classifyRunCost({ costUSD: 0.04, costBasis: 'unknown' });
    expect(verdict.priced).toBe(false);
    expect(verdict.priced ? '' : verdict.reason).toContain('unknown');
  });

  it('does not let NaN, Infinity or a negative cost reach a comparison as money', () => {
    for (const costUSD of [Number.NaN, Number.POSITIVE_INFINITY, -1, '0.04', null, undefined]) {
      expect(classifyRunCost({ costUSD }).priced, String(costUSD)).toBe(false);
    }
    expect(classifyRunCost(undefined).priced).toBe(false);
    expect(classifyRunCost({ costUSD: 1, costBasis: 'invoiced' }).priced).toBe(false);
  });
});
