import { describe, expect, it } from 'vitest';
import {
  AGENT_ENVIRONMENTS,
  AGENT_VERSION_SURFACES_MAX,
  AGENT_VERSION_VIAS,
  CLIENT_AGENT_VERSION_VIAS,
  AgentVersionBodySchema,
  AgentVersionDraftSchema,
  AgentVersionSummarySchema,
  CreateAgentVersionRequestSchema,
} from './agent-versions.js';
import { DIGEST, definition, surface, issuePaths } from './agent-versions.test-support.js';

describe('AgentVersionBodySchema: surfaces', () => {
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
});

describe('AgentVersionBodySchema: shape and tool bundles', () => {
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

const parse = (extra: Record<string, unknown>) =>
  AgentVersionBodySchema.safeParse({ definition, ...extra });

describe('description, subagents and knowledge (ADR-0133): the fields', () => {
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
});

describe('description, subagents and knowledge (ADR-0133): refusals', () => {
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

describe('constants', () => {
  it('exports the ADR-0101 lists', () => {
    expect(AGENT_VERSION_VIAS).toEqual(['ui', 'aw-push', 'api', 'builder']);
    expect(AGENT_ENVIRONMENTS).toEqual(['local', 'production']);
    expect(AGENT_VERSION_SURFACES_MAX).toBe(16);
  });
});
