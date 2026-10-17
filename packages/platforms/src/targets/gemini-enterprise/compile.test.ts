import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { A2aAgentCardSchema, A2A_PROTOCOL_VERSION } from '@indx-workspace/contracts/a2a';
import type { PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileForPlatform } from '../../compile.js';
import { formatPlatformReport } from '../../report.js';
import {
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import { a2aAgentUrl } from './compile.js';
import { geminiEnterpriseTarget } from './index.js';
import { GeminiEnterpriseOptionsSchema } from './options.js';
import { GeminiAgentRegistrationSchema, discoveryEngineHost } from './registration.js';

const GOLDEN = join(fileURLToPath(new URL('.', import.meta.url)), '__golden__');
const OPTIONS = {
  projectId: 'acme-agents',
  location: 'global',
  engineId: 'acme-support-app',
  publicBaseUrl: 'https://aw.example.com',
  authorizationId: 'aw-oauth',
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function goldenProject(name: string): PortableProject {
  return PortableProjectSchema.parse(readJson(join(GOLDEN, name, 'portable-project.json')));
}

function compiled(project: PortableProject, options: unknown = OPTIONS) {
  const result = compileForPlatform(geminiEnterpriseTarget, project, options);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  return result;
}

function textOf(file: PlatformFile | undefined): string {
  return typeof file?.content === 'string' ? file.content : '';
}

function emitted(project: PortableProject, options: unknown = OPTIONS) {
  const { files } = compiled(project, options);
  return {
    card: JSON.parse(textOf(files.find((file) => file.path === 'agent-card.json'))) as unknown,
    request: JSON.parse(
      textOf(files.find((file) => file.path === 'register-agent.request.json')),
    ) as { url: string; body: unknown },
  };
}

describe('gemini-enterprise goldens', () => {
  it.each(['full', 'no-tool-endpoint', 'minimal'])('compiles %s to its golden', (name) => {
    const dir = join(GOLDEN, name);
    const project = goldenProject(name);
    const result = compileForPlatform(
      geminiEnterpriseTarget,
      project,
      readJson(join(dir, 'options.json')),
    );
    expectGoldenFiles(result, dir);
    assertVerdictInvariants(geminiEnterpriseTarget, project, result);
  });

  it('keeps the golden inputs equal to the shared sample', () => {
    expect(goldenProject('full')).toEqual(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT));
    expect(goldenProject('no-tool-endpoint')).toEqual(
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT),
    );
  });

  it('emits the same files with and without the tool endpoint, and never drops a code tool', () => {
    const withEndpoint = compiled(goldenProject('full'));
    const without = compiled(goldenProject('no-tool-endpoint'));
    expect(without.files).toEqual(withEndpoint.files);
    expect(without.report.some((entry) => entry.code === 'code_tool_needs_public_mcp')).toBe(false);
    expect(withEndpoint.files.map((file) => file.path)).toEqual([
      'agent-card.json',
      'register-agent.request.json',
    ]);
  });

  it('drops only the stdio MCP tool', () => {
    const dropped = compiled(goldenProject('full')).report.filter(
      (entry) => entry.verdict === 'dropped',
    );
    expect(dropped).toEqual([
      expect.objectContaining({
        path: 'support-triage.tools.1',
        code: 'stdio_mcp_unsupported',
      }),
    ]);
  });

  it('generates the card description for a root without one and omits authorizationConfig', () => {
    const { card, request } = emitted(goldenProject('minimal'), {
      ...OPTIONS,
      authorizationId: undefined,
    });
    expect(card).toMatchObject({ description: 'support-triage — an Agent Workspace agent' });
    expect(request.body).not.toHaveProperty('authorizationConfig');
  });

  it('reports the generated description as mapped, saying what it is and its source', () => {
    const { report } = compiled(goldenProject('minimal'));
    const row = report.find((entry) => entry.path === 'support-triage.description');
    expect(row).toMatchObject({ verdict: 'mapped' });
    expect(row?.note).toContain('support-triage — an Agent Workspace agent');
    expect(row?.note).toContain('agent name');
    expect(report.findIndex((entry) => entry.path === 'support-triage.description')).toBe(
      report.findIndex((entry) => entry.path === 'support-triage.instructions') - 1,
    );
    expect(
      compiled(goldenProject('full')).report.find(
        (entry) => entry.path === 'support-triage.description',
      ),
    ).toMatchObject({ verdict: 'native' });
  });

  it('explains the toolEndpoint verdict in plain words', () => {
    const row = compiled(goldenProject('full')).report.find(
      (entry) => entry.path === 'toolEndpoint',
    );
    expect(row).toMatchObject({ verdict: 'mapped' });
    expect(row?.note).toContain('no public tool endpoint is needed');
  });

  it('groups the Markdown report under one heading per agent', () => {
    const text = formatPlatformReport(
      'gemini-enterprise',
      compiled(goldenProject('minimal')).report,
    );
    const root = text.indexOf('## Agent `support-triage`');
    const description = text.indexOf('| description | mapped |  | Generated from the agent name');
    const sub = text.indexOf('## Agent `billing-specialist`');
    expect(root).toBeGreaterThan(text.indexOf('## Project'));
    expect(description).toBeGreaterThan(root);
    expect(sub).toBeGreaterThan(description);
    expect(text.indexOf('| instructions | mapped', sub)).toBeGreaterThan(sub);
    expect(text).not.toContain('| billing-specialist.');
  });
});

describe('gemini-enterprise output', () => {
  it('registers the same card it writes, and both parse with their strict schemas', () => {
    const { card, request } = emitted(goldenProject('full'));
    const body = GeminiAgentRegistrationSchema.parse(request.body);
    expect(A2aAgentCardSchema.parse(card)).toEqual(
      JSON.parse(body.a2aAgentDefinition.jsonAgentCard),
    );
    expect(body.a2aAgentDefinition.jsonAgentCard).not.toContain('\n');
    expect(A2aAgentCardSchema.parse(card).protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });

  it('uses displayName for the card and examples for the skill', () => {
    const { card } = emitted(goldenProject('full'), {
      ...OPTIONS,
      displayName: 'Support Triage',
      examples: ['Where is "my" order, please?'],
    });
    expect(card).toMatchObject({
      name: 'Support Triage',
      skills: [{ examples: ['Where is "my" order, please?'] }],
    });
  });

  it('keeps the agent name as skill id and in the generated description when displayName is set', () => {
    const { card, request } = emitted(goldenProject('minimal'), {
      ...OPTIONS,
      displayName: 'Support Triage',
    });
    expect(card).toMatchObject({
      name: 'Support Triage',
      description: 'support-triage — an Agent Workspace agent',
      skills: [{ id: 'support-triage', name: 'Support Triage' }],
    });
    expect(request.body).toMatchObject({ displayName: 'Support Triage' });
  });

  it('builds the discovery-engine host from the location', () => {
    expect(discoveryEngineHost('global')).toBe('global-discoveryengine.googleapis.com');
    const { request } = emitted(goldenProject('full'), { ...OPTIONS, location: 'us' });
    expect(request.url).toBe(
      'https://us-discoveryengine.googleapis.com/v1alpha/projects/acme-agents/locations/us/collections/default_collection/engines/acme-support-app/assistants/default_assistant/agents',
    );
  });

  it('percent-encodes the agent name in the A2A path and normalises the origin', () => {
    expect(a2aAgentUrl('https://aw.example.com/', 'a b/c')).toBe(
      'https://aw.example.com/api/a2a/agents/a%20b%2Fc',
    );
  });

  it('names no secret', () => {
    const { files } = compiled(goldenProject('full'));
    for (const file of files) {
      expect(textOf(file)).not.toContain('ACME_TOOL_ENDPOINT_TOKEN');
      expect(textOf(file)).not.toContain('ZENDESK_TOKEN');
    }
  });
});

describe('gemini-enterprise refusals', () => {
  it('refuses a root that is not in the project', () => {
    const result = compileForPlatform(
      geminiEnterpriseTarget,
      { ...goldenProject('full'), root: 'ghost' },
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('platform_agent_not_found');
  });

  it.each([
    ['an http base url', { publicBaseUrl: 'http://aw.example.com' }, 'http://aw.example.com'],
    ['a base url with a path', { publicBaseUrl: 'https://aw.example.com/path' }, '/path'],
    ['a base url that is not a url', { publicBaseUrl: 'not a url' }, 'not a url'],
    ['a bad project id', { projectId: 'Bad_Project' }, 'Bad_Project'],
    ['an unknown key', { surprise: 'secret-value-1' }, 'secret-value-1'],
    ['an unknown location', { location: 'asia' }, 'asia'],
  ])('refuses %s without echoing it', (_name, patch, leaked) => {
    const result = compileForPlatform(geminiEnterpriseTarget, goldenProject('full'), {
      ...OPTIONS,
      ...patch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('platform_options_invalid');
    expect(JSON.stringify(result.refusal)).not.toContain(leaked);
  });
});

describe('gemini-enterprise conformance', () => {
  it('passes the platform kit once the required options are supplied', () => {
    runPlatformConformance({
      ...geminiEnterpriseTarget,
      optionsSchema: z.preprocess(
        (raw) => ({ ...OPTIONS, ...(raw as object) }),
        GeminiEnterpriseOptionsSchema,
      ),
    });
  });
});

describe('gemini-enterprise vendor fixtures', () => {
  const fixture = readJson(join(GOLDEN, 'vendor-fixtures', 'gemini-register-a2a-example.json')) as {
    a2aAgentDefinition: { jsonAgentCard: string };
    authorizationConfig: { agentAuthorization: string };
  };

  it('parses the register-page body with the registration schema', () => {
    expect(GeminiAgentRegistrationSchema.safeParse(fixture).success).toBe(true);
  });

  it('is covered by our card: every top-level card key Gemini lists is one we emit', () => {
    const { card } = emitted(goldenProject('full'));
    const vendorKeys = [...fixture.a2aAgentDefinition.jsonAgentCard.matchAll(/\\?"(\w+)\\?":/gu)]
      .map((match) => match[1] ?? '')
      .filter((key) => key !== '');
    expect(vendorKeys).toContain('protocolVersion');
    for (const key of vendorKeys) expect(card, key).toHaveProperty(key);
  });

  it('follows the register-page URL template, with PROJECT_ID rather than PROJECT_NUMBER', () => {
    const template = fixture.authorizationConfig.agentAuthorization;
    expect(template).toContain('projects/PROJECT_ID/');
    const { request } = emitted(goldenProject('full'));
    expect(
      (request.body as { authorizationConfig: { agentAuthorization: string } }).authorizationConfig
        .agentAuthorization,
    ).toBe(
      template
        .replace('PROJECT_ID', OPTIONS.projectId)
        .replace('LOCATION', OPTIONS.location)
        .replace('AUTH_ID', OPTIONS.authorizationId),
    );
  });
});

describe('gemini-enterprise against the A2A v0.3.0 spec', () => {
  const spec = readJson(
    fileURLToPath(
      new URL(
        '../../../../contracts/src/__fixtures__/a2a-spec.v0_3_0.agent-card.json',
        import.meta.url,
      ),
    ),
  ) as {
    AgentCard: { properties: { protocolVersion: { default: string } }; required: string[] };
    AgentSkill: { properties: Record<string, unknown>; required: string[] };
    AgentCapabilities: { properties: Record<string, unknown> };
    HTTPAuthSecurityScheme: { properties: { type: { const: string } }; required: string[] };
  };

  interface Card {
    protocolVersion: string;
    skills: Record<string, unknown>[];
    capabilities: Record<string, unknown>;
    securitySchemes: { awBearer: Record<string, unknown> };
  }

  function emittedCard(patch: object = {}): Card {
    return emitted(goldenProject('full'), { ...OPTIONS, ...patch }).card as Card;
  }

  it.each([
    ['full golden', {}],
    ['with examples and displayName', { displayName: 'Support', examples: ['Hi'] }],
  ])('every key we emit is an A2A v0.3.0 property (%s)', (_label, patch) => {
    const card = emittedCard(patch);
    for (const key of Object.keys(card)) expect(spec.AgentCard.properties, key).toHaveProperty(key);
    for (const key of Object.keys(card.skills[0] ?? {})) {
      expect(spec.AgentSkill.properties, key).toHaveProperty(key);
    }
    for (const key of Object.keys(card.capabilities)) {
      expect(spec.AgentCapabilities.properties, key).toHaveProperty(key);
    }
  });

  it('covers the optional skill keys when options set them', () => {
    expect(emittedCard({ examples: ['Hi'] }).skills[0]).toHaveProperty('examples');
  });

  it('emits every spec-required card and skill key', () => {
    const card = emittedCard();
    for (const key of spec.AgentCard.required) expect(card, key).toHaveProperty(key);
    for (const key of spec.AgentSkill.required) expect(card.skills[0], key).toHaveProperty(key);
  });

  it('declares a bearer scheme that satisfies HTTPAuthSecurityScheme', () => {
    const { awBearer: scheme } = emittedCard().securitySchemes;
    const http = spec.HTTPAuthSecurityScheme;
    expect(scheme).toHaveProperty('type', http.properties.type.const);
    for (const key of Object.keys(scheme)) expect(http.properties, key).toHaveProperty(key);
    for (const key of http.required) expect(scheme, key).toHaveProperty(key);
  });

  it("emits the spec's default protocolVersion", () => {
    const { protocolVersion } = emittedCard();
    expect(protocolVersion).toBe(spec.AgentCard.properties.protocolVersion.default);
    expect(protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });
});
