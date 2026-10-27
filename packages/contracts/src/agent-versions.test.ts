import { describe, expect, it } from 'vitest';

import {
  AGENT_ENVIRONMENTS,
  AGENT_POINTER_MOVES_LISTED,
  AGENT_VERSION_NUMBER_MAX,
  AGENT_VERSION_PROBLEM_CODES,
  AGENT_VERSION_SURFACES_MAX,
  AGENT_VERSION_VIAS,
  CLIENT_AGENT_VERSION_VIAS,
  AgentPointerMoveResponseSchema,
  AgentVersionBodySchema,
  AgentVersionCheckResponseSchema,
  AgentVersionDraftSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  AgentVersionSummarySchema,
  AgentVersionToolBundleSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentFromVersionResponseSchema,
  CreateAgentVersionRequestSchema,
  PromoteAgentRequestSchema,
  RollbackAgentRequestSchema,
  SetAgentPointerRequestSchema,
  SetAgentPointerResponseSchema,
  ToolSandboxManifestSchema,
  ToolSandboxRequestSchema,
  TOOL_BUNDLE_MAX_BYTES,
  TOOL_BUNDLE_PROBLEM_CODES,
  ToolBundleDigestSchema,
  UploadToolBundleRequestSchema,
  UploadToolBundleResponseSchema,
  type AgentVersionResource,
} from './agent-versions.js';
import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  AGENT_DEFINITION_PROBLEM_CODES,
  AGENT_POLICY_PROBLEM_CODES,
  type AgentDefinition,
  type AgentResource,
} from './agents.js';
import type { SurfaceDefinition } from './surfaces.js';

const DIGEST = 'a'.repeat(64);

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

function surface(name: string, agent = definition.agent.name): SurfaceDefinition {
  return { name, agent, theme: { colour: '#2f5fd0' } };
}

const agent: AgentResource = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  workspaceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  name: 'Support triage',
  instructions: 'Answer support mail.',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: definition.agent.permissions,
  createdBy: null,
  ownerPrincipalId: 'b3a0c2f4-1d2e-4f5a-8b6c-7d8e9f0a1b2c',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const resource: AgentVersionResource = {
  id: '9b2d3c4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  agentId: agent.id,
  workspaceId: agent.workspaceId,
  number: 1,
  summary: 'First version',
  via: 'aw-push',
  body: { definition, surfaces: [surface('main')] },
  createdByPrincipalId: agent.ownerPrincipalId,
  createdAt: '2026-10-02T00:00:00.000Z',
};

function issuePaths(result: {
  success: boolean;
  error?: { issues: readonly { path: readonly PropertyKey[] }[] };
}): readonly string[] {
  if (result.success || result.error === undefined) throw new Error('expected a refusal');
  return result.error.issues.map((issue) => issue.path.map(String).join('.'));
}

describe('AgentVersionBodySchema', () => {
  it('parses a real exported AgentDefinition unchanged inside a body, with surfaces defaulting to []', () => {
    const parsed = AgentVersionBodySchema.parse({ definition });
    expect(parsed.definition).toEqual(definition);
    expect(parsed).toEqual({ definition, surfaces: [] });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('parses a body with surfaces unchanged', () => {
    const body = { definition, surfaces: [surface('main'), surface('help')] };
    expect(AgentVersionBodySchema.parse(body)).toEqual(body);
  });

  it('refuses more surfaces than the maximum', () => {
    const surfaces = Array.from({ length: AGENT_VERSION_SURFACES_MAX + 1 }, (_, index) =>
      surface(`s-${index}`),
    );
    expect(surfaces).toHaveLength(17);
    expect(issuePaths(AgentVersionBodySchema.safeParse({ definition, surfaces }))).toEqual([
      'surfaces',
    ]);
  });

  it('refuses duplicate surface names at the second one', () => {
    const result = AgentVersionBodySchema.safeParse({
      definition,
      surfaces: [surface('main'), surface('help'), surface('main')],
    });
    expect(issuePaths(result)).toEqual(['surfaces.2.name']);
  });

  it('refuses a surface that names a different agent', () => {
    const result = AgentVersionBodySchema.safeParse({
      definition,
      surfaces: [surface('main'), surface('help', 'another-agent')],
    });
    expect(issuePaths(result)).toEqual(['surfaces.1.agent']);
  });

  it('refuses an invalid surface inside the body at its path', () => {
    const result = AgentVersionBodySchema.safeParse({
      definition,
      surfaces: [{ ...surface('main'), audience: 'public' }],
    });
    expect(issuePaths(result)).toEqual(['surfaces.0']);
  });

  it('refuses an unknown key', () => {
    expect(AgentVersionBodySchema.safeParse({ definition, extra: true }).success).toBe(false);
  });

  it('keeps toolBundles absent from a body that has none, and parses one that has', () => {
    expect(AgentVersionBodySchema.parse({ definition })).not.toHaveProperty('toolBundles');
    const toolBundles = [
      { tool: 'lookup', digest: DIGEST },
      { tool: 'refund', digest: 'b'.repeat(64) },
    ];
    expect(AgentVersionBodySchema.parse({ definition, toolBundles }).toolBundles).toEqual(
      toolBundles,
    );
  });

  it('refuses a malformed digest, an unknown key and a second bundle for one tool', () => {
    const parse = (toolBundles: readonly unknown[]): readonly string[] =>
      issuePaths(AgentVersionBodySchema.safeParse({ definition, toolBundles }));
    expect(parse([{ tool: 'lookup', digest: DIGEST.toUpperCase() }])).toEqual([
      'toolBundles.0.digest',
    ]);
    expect(parse([{ tool: 'lookup', digest: 'abc' }])).toEqual(['toolBundles.0.digest']);
    expect(parse([{ tool: 'lookup', digest: DIGEST, path: 'x' }])).toEqual(['toolBundles.0']);
    expect(parse([{ tool: 'a b', digest: DIGEST }])).toEqual(['toolBundles.0.tool']);
    expect(
      parse([
        { tool: 'lookup', digest: DIGEST },
        { tool: 'lookup', digest: 'b'.repeat(64) },
      ]),
    ).toEqual(['toolBundles.1.tool']);
  });
});

describe('description, subagents and knowledge (ADR-0133)', () => {
  const parse = (extra: Record<string, unknown>) =>
    AgentVersionBodySchema.safeParse({ definition, ...extra });

  it('keeps all three keys absent from a body that sets none', () => {
    const parsed = AgentVersionBodySchema.parse({ definition });
    for (const key of ['description', 'subagents', 'knowledge']) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it('parses a body with all three', () => {
    const extra = {
      description: 'Triage inbound support mail.',
      subagents: [{ name: 'billing' }, { name: 'refunds' }],
      knowledge: [
        { kind: 'files', paths: ['docs/playbook.md'] },
        { kind: 'connector', name: 'crm' },
      ],
    };
    const result = parse(extra);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject(extra);
  });

  it('refuses a description over the portable maximum', () => {
    expect(parse({ description: 'x'.repeat(1_024) }).success).toBe(true);
    expect(issuePaths(parse({ description: 'x'.repeat(1_025) }))).toEqual(['description']);
    expect(issuePaths(parse({ description: '' }))).toEqual(['description']);
  });

  it('refuses a repeated subagent and the agent itself, at the entry', () => {
    expect(issuePaths(parse({ subagents: [{ name: 'a' }, { name: 'b' }, { name: 'a' }] }))).toEqual(
      ['subagents.2.name'],
    );
    expect(issuePaths(parse({ subagents: [{ name: definition.agent.name }] }))).toEqual([
      'subagents.0.name',
    ]);
  });

  it('refuses more subagents than the portable maximum', () => {
    const subagents = Array.from({ length: 21 }, (_, index) => ({ name: `agent-${index}` }));
    expect(issuePaths(parse({ subagents }))).toEqual(['subagents']);
  });

  it('refuses a url knowledge source and an unknown key', () => {
    const url = parse({ knowledge: [{ kind: 'url', url: 'https://example.com/docs' }] });
    expect(url.success).toBe(false);
    expect(issuePaths(url)[0]).toMatch(/^knowledge\.0/u);
    expect(
      parse({ knowledge: [{ kind: 'files', paths: ['docs/playbook.md'], extra: 1 }] }).success,
    ).toBe(false);
  });

  it('refuses a knowledge file that is not granted, at its path', () => {
    const result = parse({
      knowledge: [{ kind: 'files', paths: ['docs/playbook.md', 'docs/other.md'] }],
    });
    expect(issuePaths(result)).toEqual(['knowledge.0.paths.1']);
  });

  it('refuses a knowledge connector that is not in resources.connectors', () => {
    expect(issuePaths(parse({ knowledge: [{ kind: 'connector', name: 'wiki' }] }))).toEqual([
      'knowledge.0.name',
    ]);
  });

  it('refuses a repeated knowledge connector, at the entry', () => {
    const crm = { kind: 'connector', name: 'crm' };
    expect(issuePaths(parse({ knowledge: [crm, crm] }))).toEqual(['knowledge.1']);
  });
});

describe('tool bundles (#790)', () => {
  it('records the declaration a hosted tool sandbox serves, and keeps an old entry valid (#791)', () => {
    const declared = {
      tool: 'lookup',
      digest: DIGEST,
      description: 'Look up an order',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      timeoutMs: 5000,
      secrets: ['ORDERS_API_KEY'],
      allowedDomains: ['api.example.com', '*.example.org'],
    };
    expect(AgentVersionToolBundleSchema.parse(declared)).toEqual(declared);
    expect(AgentVersionToolBundleSchema.parse({ tool: 'lookup', digest: DIGEST })).toEqual({
      tool: 'lookup',
      digest: DIGEST,
    });
  });

  it.each([
    ['a secret value', { secrets: ['sk-live-123'] }],
    ['a reserved secret name', { secrets: ['PORT'] }],
    ['a repeated secret', { secrets: ['A_KEY', 'A_KEY'] }],
    ['a bare * domain', { allowedDomains: ['*'] }],
    ['a domain with a comma', { allowedDomains: ['a.com,b.com'] }],
    ['a repeated domain', { allowedDomains: ['a.com', 'a.com'] }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['an unknown key', { env: 'x' }],
  ])('refuses %s in a bundle entry (#791)', (_label, change) => {
    expect(
      AgentVersionToolBundleSchema.safeParse({ tool: 'lookup', digest: DIGEST, ...change }).success,
    ).toBe(false);
  });

  it('accepts exactly a 64-character lower-case hex digest', () => {
    expect(ToolBundleDigestSchema.safeParse(DIGEST).success).toBe(true);
    expect(ToolBundleDigestSchema.safeParse(DIGEST.slice(1)).success).toBe(false);
    expect(ToolBundleDigestSchema.safeParse(`${DIGEST}0`).success).toBe(false);
    expect(ToolBundleDigestSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });

  it('parses an upload as strict, padded, non-empty base64 within the byte ceiling', () => {
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk=' }).success).toBe(true);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: '' }).success).toBe(false);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk' }).success).toBe(false);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: 'aGk=', x: 1 }).success).toBe(
      false,
    );
    const oversize = 'A'.repeat(Math.ceil(TOOL_BUNDLE_MAX_BYTES / 3) * 4 + 4);
    expect(UploadToolBundleRequestSchema.safeParse({ contentBase64: oversize }).success).toBe(
      false,
    );
  });

  it('parses the upload answer and refuses a non-positive size', () => {
    const bundle = { digest: DIGEST, sizeBytes: 12 };
    expect(UploadToolBundleResponseSchema.parse({ bundle, created: true })).toEqual({
      bundle,
      created: true,
    });
    expect(
      UploadToolBundleResponseSchema.safeParse({
        bundle: { ...bundle, sizeBytes: 0 },
        created: true,
      }).success,
    ).toBe(false);
  });

  it('maps its problem codes and shares the not-configured status with versions', () => {
    expect(TOOL_BUNDLE_PROBLEM_CODES).toEqual({
      invalid_tool_bundle: 400,
      tool_bundle_too_large: 413,
      tool_bundle_not_found: 404,
      tool_bundles_not_configured: 503,
    });
    expect(AGENT_VERSION_PROBLEM_CODES.tool_bundles_not_configured).toBe(
      TOOL_BUNDLE_PROBLEM_CODES.tool_bundles_not_configured,
    );
  });
});

describe('AgentVersionSummarySchema', () => {
  it('accepts 1 and 200 characters', () => {
    expect(AgentVersionSummarySchema.safeParse('a').success).toBe(true);
    expect(AgentVersionSummarySchema.safeParse('a'.repeat(200)).success).toBe(true);
  });

  it.each([
    '',
    'a'.repeat(201),
    'line\nbreak',
    'zero\u200bwidth',
    'bell\u0007',
    '   ',
    ' leading',
    'trailing ',
    '\u00a0nbsp',
  ])('refuses %j', (summary) => {
    expect(AgentVersionSummarySchema.safeParse(summary).success).toBe(false);
  });
});

describe('AgentVersionDraftSchema and CreateAgentVersionRequestSchema', () => {
  const draft = { body: { definition }, summary: 'First version', via: 'aw-push' };

  it('accepts a draft and a request with and without dryRun: true', () => {
    expect(AgentVersionDraftSchema.parse(draft)).toEqual({
      ...draft,
      body: { definition, surfaces: [] },
    });
    expect(CreateAgentVersionRequestSchema.parse({ ...draft, dryRun: true }).dryRun).toBe(true);
    expect(CreateAgentVersionRequestSchema.parse(draft).dryRun).toBeUndefined();
  });

  it('refuses via cli', () => {
    expect(issuePaths(AgentVersionDraftSchema.safeParse({ ...draft, via: 'cli' }))).toEqual([
      'via',
    ]);
  });

  it("refuses via 'builder' in a draft and a request: only the Builder itself may save it", () => {
    expect(issuePaths(AgentVersionDraftSchema.safeParse({ ...draft, via: 'builder' }))).toEqual([
      'via',
    ]);
    expect(
      issuePaths(CreateAgentVersionRequestSchema.safeParse({ ...draft, via: 'builder' })),
    ).toEqual(['via']);
    expect(CLIENT_AGENT_VERSION_VIAS).toEqual(['ui', 'aw-push', 'api']);
  });

  it('refuses a summary of 0 or 201 characters', () => {
    expect(issuePaths(AgentVersionDraftSchema.safeParse({ ...draft, summary: '' }))).toEqual([
      'summary',
    ]);
    expect(
      issuePaths(AgentVersionDraftSchema.safeParse({ ...draft, summary: 'a'.repeat(201) })),
    ).toEqual(['summary']);
  });

  it('refuses dryRun: false', () => {
    expect(
      issuePaths(CreateAgentVersionRequestSchema.safeParse({ ...draft, dryRun: false })),
    ).toEqual(['dryRun']);
  });

  it('refuses dryRun on a draft', () => {
    expect(AgentVersionDraftSchema.safeParse({ ...draft, dryRun: true }).success).toBe(false);
  });
});

describe('pointers', () => {
  it.each(['local', 'production'])('accepts the %s environment', (environment) => {
    expect(SetAgentPointerRequestSchema.parse({ environment, version: 3 })).toEqual({
      environment,
      version: 3,
    });
  });

  it('refuses environment preview', () => {
    expect(
      issuePaths(SetAgentPointerRequestSchema.safeParse({ environment: 'preview', version: 1 })),
    ).toEqual(['environment']);
  });

  it('accepts the PostgreSQL integer maximum as a version', () => {
    expect(
      SetAgentPointerRequestSchema.parse({
        environment: 'local',
        version: AGENT_VERSION_NUMBER_MAX,
      }),
    ).toEqual({ environment: 'local', version: 2_147_483_647 });
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER])('refuses version %s', (version) => {
    expect(
      issuePaths(SetAgentPointerRequestSchema.safeParse({ environment: 'local', version })),
    ).toEqual(['version']);
  });

  it.each([undefined, null, 3, AGENT_VERSION_NUMBER_MAX])(
    'accepts expectedVersion %s (#1847)',
    (expectedVersion) => {
      const request = {
        environment: 'local',
        version: 2,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      };
      expect(SetAgentPointerRequestSchema.parse(request)).toEqual(request);
    },
  );

  it.each([0, -1, 1.5, 2_147_483_648, '3', true])('refuses expectedVersion %s (#1847)', (value) => {
    expect(
      issuePaths(
        SetAgentPointerRequestSchema.safeParse({
          environment: 'local',
          version: 2,
          expectedVersion: value,
        }),
      ),
    ).toEqual(['expectedVersion']);
  });

  it('refuses an unknown key beside expectedVersion', () => {
    expect(
      SetAgentPointerRequestSchema.safeParse({
        environment: 'local',
        version: 2,
        expectedVersion: 1,
        expected: 1,
      }).success,
    ).toBe(false);
  });

  it('round-trips the pointer response', () => {
    const response = {
      agent,
      pointer: { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
    };
    expect(SetAgentPointerResponseSchema.parse(response)).toEqual(response);
  });
});

describe('CreateAgentFromVersionRequestSchema', () => {
  const version = { body: { definition }, summary: 'First version', via: 'ui' };

  it('accepts a version and an optional dryRun: true', () => {
    expect(CreateAgentFromVersionRequestSchema.safeParse({ version }).success).toBe(true);
    expect(CreateAgentFromVersionRequestSchema.safeParse({ version, dryRun: true }).success).toBe(
      true,
    );
    expect(
      issuePaths(CreateAgentFromVersionRequestSchema.safeParse({ version, dryRun: false })),
    ).toEqual(['dryRun']);
  });

  it("refuses via 'builder' in the nested version", () => {
    expect(
      issuePaths(
        CreateAgentFromVersionRequestSchema.safeParse({
          version: { ...version, via: 'builder' },
        }),
      ),
    ).toEqual(['version.via']);
  });

  it('refuses the legacy name and instructions keys', () => {
    const result = CreateAgentFromVersionRequestSchema.safeParse({
      version,
      name: 'Support triage',
      instructions: 'Answer support mail.',
    });
    if (result.success) throw new Error('expected a refusal');
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        path: [],
        keys: ['name', 'instructions'],
      }),
    ]);
  });

  it('refuses a legacy CreateAgentInput body', () => {
    expect(
      CreateAgentFromVersionRequestSchema.safeParse({
        name: 'Support triage',
        instructions: 'Answer support mail.',
        modelConnectionId: null,
        model: null,
        runtimeProfileId: null,
        permissions: definition.agent.permissions,
      }).success,
    ).toBe(false);
  });
});

describe('responses', () => {
  it('round-trips a version resource', () => {
    expect(AgentVersionResourceSchema.parse(resource)).toEqual(resource);
  });

  it('refuses a version resource numbered 0 or with an unknown key', () => {
    expect(issuePaths(AgentVersionResourceSchema.safeParse({ ...resource, number: 0 }))).toEqual([
      'number',
    ]);
    expect(
      AgentVersionResourceSchema.safeParse({ ...resource, updatedAt: resource.createdAt }).success,
    ).toBe(false);
  });

  it('round-trips the list response', () => {
    const list = {
      items: [resource],
      pointers: [
        { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
        { environment: 'production', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      materialised: 1,
      evaluations: [{ version: 1, score: 0.9, passed: 9, total: 10 }],
      moves: [
        {
          environment: 'production',
          number: 1,
          reason: 'promote',
          movedByPrincipalId: 'principal-1',
          movedAt: '2026-10-02T00:00:00.000Z',
        },
        {
          environment: 'local',
          number: 1,
          reason: 'set',
          movedByPrincipalId: null,
          movedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    expect(AgentVersionListResponseSchema.parse(list)).toEqual(list);
    const edited = { ...list, materialised: null };
    expect(AgentVersionListResponseSchema.parse(edited)).toEqual(edited);
  });

  it('reads a listing without moves (an older server) as no moves, and caps them (#615)', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    expect(AgentVersionListResponseSchema.parse(list)).toEqual({
      ...list,
      moves: [],
      evaluations: [],
    });
    const move = {
      environment: 'local',
      number: 1,
      reason: 'rollback',
      movedByPrincipalId: null,
      movedAt: '2026-10-01T00:00:00.000Z',
    };
    const tooMany = Array.from({ length: AGENT_POINTER_MOVES_LISTED + 1 }, () => move);
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, moves: tooMany })),
    ).toEqual(['moves']);
    expect(
      issuePaths(
        AgentVersionListResponseSchema.safeParse({ ...list, moves: [{ ...move, reason: 'push' }] }),
      ),
    ).toEqual(['moves.0.reason']);
  });

  it('refuses an evaluation with no cases, a score above 1 or an unknown key (#714)', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    const evaluation = { version: 1, score: 0.9, passed: 9, total: 10 };
    const issues = (evaluations: unknown[]): readonly string[] =>
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, evaluations }));
    expect(issues([{ ...evaluation, total: 0 }])).toEqual(['evaluations.0.total']);
    expect(issues([{ ...evaluation, score: 1.5 }])).toEqual(['evaluations.0.score']);
    expect(issues([{ ...evaluation, failing: [] }])).toEqual(['evaluations.0']);
    expect(issues([{ ...evaluation, version: 0 }])).toEqual(['evaluations.0.version']);
  });

  it('requires the materialised version, a number or null', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ items: [resource], pointers: [] })),
    ).toEqual(['materialised']);
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, materialised: 0 })),
    ).toEqual(['materialised']);
  });

  it('refuses a list response with two pointers for one environment', () => {
    const list = {
      items: [resource],
      pointers: [
        { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
        { environment: 'local', number: 2, updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      materialised: 2,
    };
    expect(issuePaths(AgentVersionListResponseSchema.safeParse(list))).toEqual([
      'pointers.1.environment',
    ]);
  });

  it('refuses a version resource numbered above the PostgreSQL integer maximum', () => {
    expect(
      issuePaths(
        AgentVersionResourceSchema.safeParse({ ...resource, number: AGENT_VERSION_NUMBER_MAX + 1 }),
      ),
    ).toEqual(['number']);
  });

  it('round-trips the check response and refuses ok: false', () => {
    expect(AgentVersionCheckResponseSchema.parse({ ok: true, number: 2 })).toEqual({
      ok: true,
      number: 2,
    });
    expect(AgentVersionCheckResponseSchema.safeParse({ ok: false, number: 2 }).success).toBe(false);
    expect(AgentVersionCheckResponseSchema.safeParse({ ok: true, number: 0 }).success).toBe(false);
  });

  it('round-trips the create-from-version response', () => {
    const response = { agent, version: resource };
    expect(CreateAgentFromVersionResponseSchema.parse(response)).toEqual(response);
  });
});

describe('promote and rollback (#615)', () => {
  it('accepts an empty promote, a version and a dry run; refuses dryRun false and unknown keys', () => {
    expect(PromoteAgentRequestSchema.parse({})).toEqual({});
    expect(PromoteAgentRequestSchema.parse({ version: 3, dryRun: true })).toEqual({
      version: 3,
      dryRun: true,
    });
    expect(issuePaths(PromoteAgentRequestSchema.safeParse({ dryRun: false }))).toEqual(['dryRun']);
    expect(issuePaths(PromoteAgentRequestSchema.safeParse({ version: 0 }))).toEqual(['version']);
    expect(PromoteAgentRequestSchema.safeParse({ environment: 'production' }).success).toBe(false);
  });

  it('rolls production back by default, and refuses preview, dryRun false and unknown keys', () => {
    expect(RollbackAgentRequestSchema.parse({})).toEqual({ environment: 'production' });
    expect(RollbackAgentRequestSchema.parse({ environment: 'local', dryRun: true })).toEqual({
      environment: 'local',
      dryRun: true,
    });
    expect(issuePaths(RollbackAgentRequestSchema.safeParse({ environment: 'preview' }))).toEqual([
      'environment',
    ]);
    expect(issuePaths(RollbackAgentRequestSchema.safeParse({ dryRun: false }))).toEqual(['dryRun']);
    expect(RollbackAgentRequestSchema.safeParse({ version: 1 }).success).toBe(false);
  });

  it('answers from and to, with from null for an environment that had no pointer', () => {
    const moved = { environment: 'production', from: null, to: 7, saved: false, bar: 0.9 };
    expect(AgentPointerMoveResponseSchema.parse(moved)).toEqual(moved);
    expect(AgentPointerMoveResponseSchema.safeParse({ ...moved, extra: true }).success).toBe(false);
  });

  it('reads an older server without bar as no bar (issue #619)', () => {
    const moved = { environment: 'production', from: 6, to: 7, saved: true };
    expect(AgentPointerMoveResponseSchema.parse(moved)).toEqual({ ...moved, bar: null });
    expect(AgentPointerMoveResponseSchema.safeParse({ ...moved, bar: 1.5 }).success).toBe(false);
  });
});

describe('constants', () => {
  it('exports the ADR-0101 lists', () => {
    expect(AGENT_VERSION_VIAS).toEqual(['ui', 'aw-push', 'api', 'builder']);
    expect(AGENT_ENVIRONMENTS).toEqual(['local', 'production']);
    expect(AGENT_VERSION_SURFACES_MAX).toBe(16);
  });
});

describe('AGENT_VERSION_PROBLEM_CODES', () => {
  it('maps every code to its status', () => {
    expect(AGENT_VERSION_PROBLEM_CODES).toEqual({
      invalid_agent_id: 400,
      invalid_agent_version: 400,
      unsupported_engine: 400,
      dangerous_permission_mode_refused: 400,
      agent_not_found: 404,
      agent_policy_not_configured: 503,
      agent_version_not_found: 404,
      agent_version_number_taken: 409,
      no_pointer: 409,
      nothing_to_roll_back: 409,
      pointer_moved: 409,
      promotion_not_evaluated: 409,
      promotion_gate_failed: 409,
      code_tool_needs_host: 422,
      network_policy_unsupported: 422,
      stdio_connector_needs_tool_sandbox: 422,
      tool_bundle_unknown: 422,
      tool_bundles_not_configured: 503,
      agent_definition_references_missing: 422,
      agent_definition_reference_ambiguous: 409,
      agent_subagent_unusable: 422,
      engine_capability_unsupported: 422,
      engine_switch_would_widen: 422,
      policy_cannot_widen: 403,
      surface_name_taken: 409,
      agent_name_conflict: 409,
      unknown_file: 400,
      unknown_skill: 400,
      skill_deleting: 409,
      unknown_connector: 400,
      storage_connection_prefix_not_allowed: 403,
      storage_connection_write_not_allowed: 403,
    });
  });

  it('keeps each reused status equal to its source table', () => {
    expect(AGENT_VERSION_PROBLEM_CODES.unsupported_engine).toBe(
      AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.dangerous_permission_mode_refused).toBe(
      AGENT_POLICY_PROBLEM_CODES.dangerous_permission_mode_refused,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_not_found).toBe(
      AGENT_POLICY_PROBLEM_CODES.agent_not_found,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_policy_not_configured).toBe(
      AGENT_POLICY_PROBLEM_CODES.agent_policy_not_configured,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.engine_capability_unsupported).toBe(
      AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.engine_switch_would_widen).toBe(
      AGENT_POLICY_PROBLEM_CODES.engine_switch_would_widen,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.policy_cannot_widen).toBe(
      AGENT_POLICY_PROBLEM_CODES.policy_cannot_widen,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing).toBe(
      AGENT_DEFINITION_PROBLEM_CODES.agent_definition_references_missing,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_definition_reference_ambiguous).toBe(
      AGENT_DEFINITION_PROBLEM_CODES.agent_definition_reference_ambiguous,
    );
  });
});

describe('ToolSandboxRequestSchema', () => {
  const digest = 'a'.repeat(64);
  const request = {
    key: 'tools-1',
    manifest: {
      tools: [
        {
          name: 'get_order',
          description: 'Looks up an order.',
          inputSchema: { type: 'object' },
          timeoutMs: 5_000,
          digest,
          bundleBase64: btoa('export default () => 1;'),
        },
      ],
      env: { ORDERS_API_KEY: 'sk-live' },
    },
    allowedDomains: ['api.example.com'],
    run: { runId: 'run_1', token: 'a-run-token-0123456789' },
  };

  it('accepts a session tool set with its secrets, domains and run token', () => {
    expect(ToolSandboxRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ['no tools', { ...request, manifest: { ...request.manifest, tools: [] } }],
    [
      'an environment name that is not a secret name',
      { ...request, manifest: { ...request.manifest, env: { 'not a name': 'x' } } },
    ],
    [
      'a bundle that is not base64',
      {
        ...request,
        manifest: {
          ...request.manifest,
          tools: [{ ...request.manifest.tools[0], bundleBase64: 'not base64!' }],
        },
      },
    ],
    ['a short token', { ...request, run: { runId: 'run_1', token: 'short' } }],
    ['an unknown key', { ...request, extra: true }],
  ])('refuses %s', (_name, value) => {
    expect(ToolSandboxRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe('ToolSandboxManifestSchema stdio servers', () => {
  const server = {
    name: 'fixture',
    command: 'npx',
    args: ['-y', '@scope/pkg@1.2.3'],
    timeoutMs: 30_000,
  };
  const manifest = { tools: [], stdioServers: [server], env: {} };
  const parse = (value: unknown) => ToolSandboxManifestSchema.safeParse(value);

  it('accepts a pinned npx server with no tools, and a tools-only manifest', () => {
    expect(parse(manifest).success).toBe(true);
    expect(
      parse({ ...manifest, stdioServers: [{ ...server, args: ['pkg@1.0.0-rc.1', '--x'] }] })
        .success,
    ).toBe(true);
    const tools = [
      {
        name: 'get_order',
        description: 'Looks up an order.',
        inputSchema: { type: 'object' },
        timeoutMs: 5_000,
        digest: 'a'.repeat(64),
        bundleBase64: btoa('export default () => 1;'),
      },
    ];
    const parsed = parse({ tools, env: {} });
    expect(parsed.success && parsed.data.stdioServers).toEqual([]);
  });

  it.each([
    ['an unpinned package', ['pkg']],
    ['a range', ['pkg@^1.2.3']],
    ['a tag', ['-y', 'pkg@latest']],
    ['a partial version', ['pkg@1.2']],
    ['no package', ['-y']],
    ['a flag in the package position', ['--yes', 'pkg@1.2.3']],
    ['a url', ['https://example.com/pkg.tgz@1.2.3']],
  ])('refuses %s and names the field, not the value', (_name, args) => {
    const refused = parse({ ...manifest, stdioServers: [{ ...server, args }] });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'stdioServers.0.args',
    ]);
  });

  it.each([
    ['a command that is not npx', { ...manifest, stdioServers: [{ ...server, command: 'node' }] }],
    [
      'a server name that is not a path segment',
      { ...manifest, stdioServers: [{ ...server, name: 'a/b' }] },
    ],
    ['duplicate server names', { ...manifest, stdioServers: [server, server] }],
    ['nothing to serve', { tools: [], stdioServers: [], env: {} }],
    ['an unknown key on a server', { ...manifest, stdioServers: [{ ...server, env: {} }] }],
  ])('refuses %s', (_name, value) => {
    expect(parse(value).success).toBe(false);
  });
});
