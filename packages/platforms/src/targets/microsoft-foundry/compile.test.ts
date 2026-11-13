import {
  PORTABLE_AGENT_LIST_MAX,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import { PLATFORM_TARGETS } from '../../registry.js';

import { microsoftFoundryTarget } from './index.js';
import {
  FoundryAgentVersionBodySchema,
  FoundryEndpointPatchSchema,
  FoundryPublishPlanSchema,
} from './wire.js';

import {
  MODEL_OPTIONS,
  ROOT,
  golden,
  goldenOptions,
  parse,
  sampleWith,
  compile,
  refusalOf,
  versionOf,
  sample,
} from '../../testing/foundry-compile.fixture.test-support.js';

describe('microsoftFoundryTarget', () => {
  it('is registered and passes the platform conformance kit', () => {
    expect(PLATFORM_TARGETS).toContain(microsoftFoundryTarget);
    expect(() => runPlatformConformance(microsoftFoundryTarget)).not.toThrow();
  });

  it('matches the golden for the shared sample', () => {
    expectGoldenFiles(
      compileForPlatform(microsoftFoundryTarget, sample, goldenOptions('full')),
      golden('full'),
    );
  });

  it('accepts the publish-only projectEndpoint and compiles the same bytes', () => {
    const options = {
      ...(goldenOptions('full') as Record<string, unknown>),
      projectEndpoint: 'https://acme.services.ai.azure.com/api/projects/support',
    };
    expectGoldenFiles(compileForPlatform(microsoftFoundryTarget, sample, options), golden('full'));
  });

  it('matches the golden for the sample without a tool endpoint', () => {
    const project = parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT);
    expectGoldenFiles(
      compileForPlatform(microsoftFoundryTarget, project, goldenOptions('no-tool-endpoint')),
      golden('no-tool-endpoint'),
    );
  });

  it('is deterministic and every emitted file parses with its wire schema', () => {
    const first = compile(sample);
    expect(compile(sample)).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([
      'agents/billing-specialist.endpoint.json',
      'agents/billing-specialist.version.json',
      'agents/support-triage.version.json',
      'project.plan.json',
    ]);
    for (const file of first.files) {
      const body: unknown = JSON.parse(typeof file.content === 'string' ? file.content : '');
      if (file.path.endsWith('.version.json')) FoundryAgentVersionBodySchema.parse(body);
      else if (file.path.endsWith('.endpoint.json')) FoundryEndpointPatchSchema.parse(body);
      else FoundryPublishPlanSchema.parse(body);
    }
  });

  it('keeps secret names in the plan only and never a value', () => {
    const result = compile(sample);
    for (const file of result.files) {
      const text = typeof file.content === 'string' ? file.content : '';
      const named = text.includes('ZENDESK_TOKEN') || text.includes('ACME_TOOL_ENDPOINT_TOKEN');
      expect(named).toBe(file.path === 'project.plan.json');
    }
  });
});

describe('options and refusals', () => {
  it('refuses an unknown option key and an empty deployment name', () => {
    expect(refusalOf(sample, { extra: true }).code).toBe('platform_options_invalid');
    expect(refusalOf(sample, { modelDeployment: '' }).code).toBe('platform_options_invalid');
  });

  it('refuses a projectEndpoint that is not https', () => {
    const options = { ...MODEL_OPTIONS, projectEndpoint: 'http://acme.services.ai.azure.com' };
    expect(refusalOf(sample, options).code).toBe('platform_options_invalid');
  });

  it('refuses a projectEndpoint with a query or a fragment, as publish does', () => {
    const endpoint = 'https://acme.services.ai.azure.com/api/projects/support';
    for (const projectEndpoint of [`${endpoint}?x=1`, `${endpoint}#x`]) {
      const options = { ...MODEL_OPTIONS, projectEndpoint };
      expect(refusalOf(sample, options).code).toBe('platform_options_invalid');
    }
  });

  it('refuses when no deployment is named and an agent has no model', () => {
    const project = sampleWith({ model: undefined });
    const refusal = refusalOf(project, {});
    expect(refusal.code).toBe('platform_options_invalid');
    expect(refusal.details).toEqual([`modelDeployment: required when agent ${ROOT} has no model`]);
    expect(versionOf(compile(project), ROOT).definition.model).toBe('claude-sonnet-4-6');
  });

  it('refuses a name Foundry does not accept, and a 64-character name', () => {
    const rename = (name: string): PortableProject => ({
      ...sample,
      root: name,
      agents: sample.agents.map((agent) => (agent.name === ROOT ? { ...agent, name } : agent)),
    });
    const refusal = refusalOf(rename('Support_Triage'));
    expect(refusal.code).toBe('platform_limit_exceeded');
    expect(refusal.details).toEqual(['agents[0].name']);
    expect(refusalOf(rename('a'.repeat(64))).code).toBe('platform_limit_exceeded');
    expect(compile(rename('a'.repeat(63))).files).toHaveLength(4);
  });

  it('refuses a subagent or a root that is not in the project', () => {
    const ghost = {
      ...sample,
      agents: sample.agents.map((a, i) => (i === 0 ? { ...a, subagents: [{ name: 'ghost' }] } : a)),
    };
    expect(refusalOf(ghost).code).toBe('platform_agent_not_found');
    expect(refusalOf({ ...sample, root: 'ghost' }).code).toBe('platform_agent_not_found');
    expect(
      microsoftFoundryTarget.compile({ ...sample, root: 'ghost' }, { requireApproval: 'always' })
        .ok,
    ).toBe(false);
  });

  it('compiles an agent on a non-Anthropic model', () => {
    const result = compile(sampleWith({ model: { provider: 'openai', id: 'gpt-5-mini' } }), {});
    const body = versionOf(result);
    expect(body.definition.model).toBe('gpt-5-mini');
    expect(body.metadata['aw.model']).toBe('openai/gpt-5-mini');
  });

  it('refuses a body that breaks a vendor limit instead of emitting it', () => {
    const name = 'x'.repeat(64);
    const rootAgent = SAMPLE_PORTABLE_PROJECT.agents.filter((agent) => agent.name === ROOT);
    const refusal = refusalOf(
      parse({
        ...SAMPLE_PORTABLE_PROJECT,
        root: name,
        agents: rootAgent.map((agent) => ({ ...agent, name, subagents: [] })),
      }),
    );
    expect(refusal.code).toBe('platform_limit_exceeded');
  });

  // V3 is pinned as "no limit known": the Learn pages state no maximum for instructions or tool
  // count, so the translator passes the portable maximums through. If Microsoft publishes a limit,
  // this test fails and the limit moves into FoundryAgentVersionBodySchema.
  // https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
  it('passes the portable maximum instructions and tool count through (V3: no limit known)', () => {
    const tools = Array.from({ length: PORTABLE_AGENT_LIST_MAX }, (_, index) => ({
      kind: 'mcp' as const,
      name: `m${index}`,
      transport: 'streamable-http' as const,
      url: `https://mcp.example.com/${index}`,
    }));
    const result = compile(sampleWith({ instructions: 'x'.repeat(100_000), tools }));
    const body = versionOf(result);
    expect(body.definition.instructions).toHaveLength(100_000);
    // the shared aw-tools server comes on top of the agent's own tools
    expect(body.definition.tools).toHaveLength(PORTABLE_AGENT_LIST_MAX + 1);
  });

  it('never exceeds the 16 metadata pairs', () => {
    expect(Object.keys(versionOf(compile(sample)).metadata).length).toBeLessThanOrEqual(16);
  });
});
