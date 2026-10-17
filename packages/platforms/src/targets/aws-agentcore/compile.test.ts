import { fileURLToPath } from 'node:url';

import { SECRET_NAME_PATTERN } from '@indx-workspace/contracts/secrets';
import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import type { PlatformCompileResult } from '../../port.js';
import { platformTarget } from '../../registry.js';
import {
  CREDENTIAL_PATTERNS,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import { AgentCoreProjectSubsetSchema, HarnessSpecSubsetSchema } from './harness-spec.subset.js';
import { awsAgentCoreTarget } from './index.js';
import {
  AGENTCORE_CREDENTIAL_NAME_PATTERN,
  AwsAgentCoreOptionsSchema,
  BEDROCK_CLAUDE_MODEL_IDS,
} from './options.js';

const OPTIONS = {
  region: 'us-east-1',
  accountId: '123456789012',
  skillsS3Uri: 's3://acme-agent-skills/support-triage/',
};
const ARN_PREFIX =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/';
const BASE_OPTIONS = { region: 'us-east-1', accountId: '123456789012' };

const golden = (name: string): string =>
  fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url));

function compile(input: PortableProjectInput, options: unknown = OPTIONS): PlatformCompileResult {
  return compileForPlatform(awsAgentCoreTarget, PortableProjectSchema.parse(input), options);
}

function compiled(input: PortableProjectInput, options: unknown = OPTIONS) {
  const result = compile(input, options);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} ${result.refusal.message}`);
  return result;
}

function refusalOf(input: PortableProjectInput, options: unknown = OPTIONS) {
  const result = compile(input, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function rootWith(patch: Partial<PortableAgentInput>): PortableProjectInput {
  const [root, ...others] = SAMPLE_PORTABLE_PROJECT.agents;
  if (root === undefined) throw new Error('the sample has no agents');
  return { ...SAMPLE_PORTABLE_PROJECT, agents: [{ ...root, ...patch }, ...others] };
}

function renamedRoot(name: string): PortableProjectInput {
  const root = rootWith({ name, subagents: [] }).agents[0];
  if (root === undefined) throw new Error('the sample has no agents');
  return { ...SAMPLE_PORTABLE_PROJECT, root: name, agents: [root] };
}

function text(files: readonly PlatformFile[], path: string): string {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== 'string') throw new Error(`${path} is not an emitted text file`);
  return content;
}

function harnessOf(files: readonly PlatformFile[]): Record<string, unknown> {
  return JSON.parse(text(files, 'app/support_triage/harness.json')) as Record<string, unknown>;
}

function verdictOf(report: readonly FieldVerdict[], path: string): FieldVerdict {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict for ${path}`);
  return entry;
}

const PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

describe('awsAgentCoreTarget', () => {
  it('is registered under its platform id', () => {
    expect(platformTarget('aws-agentcore')).toBe(awsAgentCoreTarget);
  });

  it('passes the platform conformance kit', () => {
    expect(() => {
      runPlatformConformance(awsAgentCoreTarget, BASE_OPTIONS);
    }).not.toThrow();
  });

  it.each([
    ['full', SAMPLE_PORTABLE_PROJECT],
    ['no-tool-endpoint', SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT],
  ])('matches the %s golden byte for byte', (name, input) => {
    const result = compile(input);
    assertVerdictInvariants(awsAgentCoreTarget, PortableProjectSchema.parse(input), result);
    expectGoldenFiles(result, golden(name));
  });

  it('reports the verdict and code the design fixes for every root field of the sample', () => {
    const { report } = compiled(SAMPLE_PORTABLE_PROJECT);
    const pairs = report
      .filter((entry) => !entry.path.startsWith('billing-specialist.'))
      .map((entry) => [entry.path.replace('support-triage.', ''), entry.verdict, entry.code]);
    expect(pairs).toEqual([
      ['toolEndpoint', 'mapped', undefined],
      ['description', 'dropped', 'field_unsupported'],
      ['instructions', 'native', undefined],
      ['model', 'mapped', undefined],
      ['permissions.readFiles', 'dropped', 'permissions_unsupported'],
      ['permissions.writeFiles', 'native', undefined],
      ['permissions.runCommands', 'native', undefined],
      ['permissions.unrestrictedNetwork', 'mapped', undefined],
      ['tools.0', 'native', undefined],
      ['tools.1', 'dropped', 'stdio_mcp_unsupported'],
      ['tools.2', 'mapped', undefined],
      ['tools.3', 'dropped', 'field_unsupported'],
      ['tools.4', 'dropped', 'builtin_unsupported'],
      ['tools.5', 'mapped', undefined],
      ['skills.0', 'mapped', undefined],
      ['knowledge.0', 'dropped', 'knowledge_unsupported'],
      ['knowledge.1', 'dropped', 'knowledge_unsupported'],
      ['subagents.0', 'dropped', 'subagents_unsupported'],
      ['limits.maxTurns', 'mapped', undefined],
      ['limits.maxBudgetUsd', 'dropped', 'limits_unsupported'],
    ]);
  });

  it('drops a code tool without an endpoint and omits the endpoint tool and credential', () => {
    const { files, report } = compiled(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT);
    expect(harnessOf(files)['allowedTools']).toEqual(['@zendesk', 'code_interpreter']);
    expect(text(files, 'agentcore/agentcore.json')).not.toContain('ACME_TOOL_ENDPOINT_TOKEN');
    expect(verdictOf(report, 'support-triage.tools.2')).toMatchObject({
      verdict: 'dropped',
      code: 'code_tool_needs_public_mcp',
    });
  });

  it('emits files that the transcribed AgentCore CLI schemas accept', () => {
    for (const input of [SAMPLE_PORTABLE_PROJECT, SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT]) {
      const { files } = compiled(input);
      HarnessSpecSubsetSchema.parse(harnessOf(files));
      AgentCoreProjectSubsetSchema.parse(JSON.parse(text(files, 'agentcore/agentcore.json')));
    }
  });

  it('writes the instructions verbatim as the system prompt, with one trailing newline', () => {
    const { files } = compiled(rootWith({ instructions: 'Be brief.\n\nNo emoji.' }));
    expect(text(files, 'app/support_triage/system-prompt.md')).toBe('Be brief.\n\nNo emoji.\n');
    expect(harnessOf(files)).not.toHaveProperty('systemPrompt');
  });
});

describe('refusals', () => {
  it('refuses a model with no known Bedrock id and names the override', () => {
    const refusal = refusalOf(
      rootWith({ model: { provider: 'anthropic', id: 'claude-unknown-9' } }),
    );
    expect(refusal.code).toBe('platform_model_unsupported');
    expect(refusal.message).toContain('claude-unknown-9');
    expect(refusal.message).toContain('platforms.aws-agentcore.options.model');
  });

  it('refuses another provider unless options.model overrides it', () => {
    const input = rootWith({ model: { provider: 'openai', id: 'gpt-5' } });
    expect(refusalOf(input).code).toBe('platform_model_unsupported');
    const { files, report } = compiled(input, {
      ...OPTIONS,
      model: { provider: 'open_ai', modelId: 'gpt-5', apiKeyCredential: 'OPENAI_KEY' },
    });
    expect(harnessOf(files)['model']).toEqual({
      provider: 'open_ai',
      modelId: 'gpt-5',
      apiKeyArn: `${ARN_PREFIX}OPENAI_KEY`,
    });
    expect(text(files, 'agentcore/agentcore.json')).toContain('"OPENAI_KEY"');
    expect(verdictOf(report, 'support-triage.model').verdict).toBe('mapped');
  });

  it('maps every confirmed Claude id', () => {
    for (const [id, modelId] of Object.entries(BEDROCK_CLAUDE_MODEL_IDS)) {
      const { files } = compiled(rootWith({ model: { id } }));
      expect(harnessOf(files)['model']).toEqual({ provider: 'bedrock', modelId });
    }
  });

  it('refuses a harness name that starts with a digit or exceeds 40 characters', () => {
    for (const name of ['9lives', `a${'-b'.repeat(20)}c`]) {
      const refusal = refusalOf(renamedRoot(name));
      expect(refusal.code).toBe('platform_limit_exceeded');
      expect(refusal.details).toEqual(['limit: harnessName']);
    }
  });

  it('accepts a name the options override', () => {
    const { files } = compiled(renamedRoot('9lives'), {
      ...OPTIONS,
      harnessName: 'nine_lives',
      projectName: 'NineLives',
    });
    expect(files.map((file) => file.path)).toContain('app/nine_lives/harness.json');
    expect(text(files, 'agentcore/agentcore.json')).toContain('"NineLives"');
  });

  it('refuses a project name over 23 characters', () => {
    const input = renamedRoot('customer-support-triage-xyz-q');
    const refusal = refusalOf(input);
    expect(refusal.code).toBe('platform_limit_exceeded');
    expect(refusal.details).toEqual(['limit: projectName']);
    expect(compile(input, { ...OPTIONS, projectName: 'CustomerSupport' }).ok).toBe(true);
  });

  it('refuses a root that is not in the project', () => {
    const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const result = compileForPlatform(awsAgentCoreTarget, { ...project, root: 'ghost' }, OPTIONS);
    expect(result.ok ? undefined : result.refusal.code).toBe('platform_agent_not_found');
  });
});

describe('AwsAgentCoreOptionsSchema', () => {
  const reject = (options: unknown): void => {
    expect(AwsAgentCoreOptionsSchema.safeParse(options).success).toBe(false);
  };

  it('accepts the base options and rejects bad ones', () => {
    expect(AwsAgentCoreOptionsSchema.safeParse(OPTIONS).success).toBe(true);
    reject({ ...BASE_OPTIONS, model: { provider: 'open_ai', modelId: 'gpt-5' } });
    reject({ ...BASE_OPTIONS, model: { provider: 'gemini', modelId: 'gemini-3' } });
    reject({ ...BASE_OPTIONS, region: 'useast1' });
    reject({ ...BASE_OPTIONS, accountId: '1234' });
    reject({ ...BASE_OPTIONS, skillsS3Uri: 'https://bucket/skills/' });
    reject({ ...BASE_OPTIONS, skillsS3Uri: 's3://acme-agent-skills/no-trailing-slash' });
    reject({ ...BASE_OPTIONS, webSearchGatewayArn: 'not-an-arn' });
    reject({ ...BASE_OPTIONS, unknownKey: true });
  });

  it('turns invalid options into platform_options_invalid', () => {
    expect(refusalOf(SAMPLE_PORTABLE_PROJECT, { region: 'us-east-1' }).code).toBe(
      'platform_options_invalid',
    );
  });
});

describe('permissions', () => {
  it.each([
    ['nothing', PERMISSIONS, []],
    ['write', { ...PERMISSIONS, readFiles: true, writeFiles: true }, ['@builtin/file_operations']],
    ['shell', { ...PERMISSIONS, runCommands: true }, ['@builtin/shell']],
    ['read only', { ...PERMISSIONS, readFiles: true }, []],
  ])('%s → allowedTools', (_label, permissions, allowed) => {
    const { files } = compiled(rootWith({ permissions, tools: [], skills: [], subagents: [] }));
    expect(harnessOf(files)['allowedTools']).toEqual(allowed);
  });

  it('withholds file_operations for read-only access and says so', () => {
    const { report } = compiled(rootWith({ permissions: { ...PERMISSIONS, readFiles: true } }));
    expect(verdictOf(report, 'support-triage.permissions.readFiles')).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
  });

  it('maps the file_access builtin only when writeFiles grants file_operations', () => {
    const fileAccess = (writeFiles: boolean) =>
      verdictOf(
        compiled(
          rootWith({
            permissions: { ...PERMISSIONS, readFiles: true, writeFiles },
            tools: [{ kind: 'builtin', id: 'file_access' }],
            skills: [],
            subagents: [],
          }),
        ).report,
        'support-triage.tools.0',
      );
    expect(fileAccess(true).verdict).toBe('mapped');
    expect(fileAccess(false)).toMatchObject({
      verdict: 'dropped',
      code: 'builtin_unsupported',
      note: 'file_operations is withheld because permissions.writeFiles is false',
    });
  });

  it('maps a closed network only when there is no shell', () => {
    const closed = compiled(rootWith({ permissions: PERMISSIONS })).report;
    expect(verdictOf(closed, 'support-triage.permissions.unrestrictedNetwork').verdict).toBe(
      'mapped',
    );
    const shell = compiled(rootWith({ permissions: { ...PERMISSIONS, runCommands: true } })).report;
    expect(verdictOf(shell, 'support-triage.permissions.unrestrictedNetwork')).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    const open = compiled(
      rootWith({ permissions: { ...PERMISSIONS, runCommands: true, unrestrictedNetwork: true } }),
    ).report;
    expect(verdictOf(open, 'support-triage.permissions.unrestrictedNetwork').verdict).toBe(
      'native',
    );
  });
});

describe('options-driven tools', () => {
  const gateway = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/search-gw';
  const ordersGateway = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/orders-gw';

  it('keeps web search and the OpenAPI tool behind the configured gateways', () => {
    const { files, report } = compiled(SAMPLE_PORTABLE_PROJECT, {
      ...OPTIONS,
      webSearchGatewayArn: gateway,
      openapiGateways: { 'orders-api': ordersGateway },
    });
    const harness = harnessOf(files);
    expect(harness['tools']).toContainEqual({
      type: 'agentcore_gateway',
      name: 'web-search',
      config: { agentCoreGateway: { gatewayArn: gateway } },
    });
    expect(harness['allowedTools']).toEqual(expect.arrayContaining(['@web-search']));
    expect(verdictOf(report, 'support-triage.tools.3').verdict).toBe('dropped');
    expect(verdictOf(report, 'support-triage.tools.4').verdict).toBe('mapped');
    HarnessSpecSubsetSchema.parse(harness);
  });

  it('keeps an OpenAPI tool without allow behind its gateway', () => {
    const { files, report } = compiled(
      rootWith({
        tools: [{ kind: 'openapi', name: 'orders-api', specRef: 'openapi/orders.json' }],
      }),
      { ...OPTIONS, openapiGateways: { 'orders-api': ordersGateway } },
    );
    const harness = harnessOf(files);
    expect(harness['tools']).toContainEqual({
      type: 'agentcore_gateway',
      name: 'orders-api',
      config: { agentCoreGateway: { gatewayArn: ordersGateway, outboundAuth: { awsIam: {} } } },
    });
    expect(harness['allowedTools']).toContain('@orders-api');
    expect(verdictOf(report, 'support-triage.tools.0').verdict).toBe('mapped');
  });

  it('refuses an OpenAPI tool that sets allow: the gateway would expose every operation', () => {
    const { files, report } = compiled(SAMPLE_PORTABLE_PROJECT, {
      ...OPTIONS,
      openapiGateways: { 'orders-api': ordersGateway },
    });
    const verdict = verdictOf(report, 'support-triage.tools.3');
    expect(verdict.verdict).toBe('dropped');
    expect(verdict.code).toBe('permissions_unsupported');
    expect(JSON.stringify(harnessOf(files))).not.toContain('orders-api');
  });

  it('drops both without them', () => {
    const { files } = compiled(SAMPLE_PORTABLE_PROJECT);
    expect(JSON.stringify(harnessOf(files))).not.toMatch(/web-search|orders-api/u);
  });

  it('drops a tool whose name another tool already owns', () => {
    const { report } = compiled(
      rootWith({
        tools: [
          { kind: 'mcp', name: 'browser', transport: 'sse', url: 'https://mcp.example.com/b' },
          { kind: 'builtin', id: 'web_fetch' },
        ],
        skills: [],
        subagents: [],
      }),
    );
    expect(verdictOf(report, 'support-triage.tools.1')).toMatchObject({
      verdict: 'dropped',
      code: 'builtin_unsupported',
    });
  });

  it('drops a tool whose allowedTools entry would exceed 64 characters', () => {
    const name = `m${'x'.repeat(63)}`;
    const { files, report } = compiled(
      rootWith({
        tools: [{ kind: 'mcp', name, transport: 'sse', url: 'https://mcp.example.com/long' }],
        skills: [],
        subagents: [],
      }),
    );
    const verdict = verdictOf(report, 'support-triage.tools.0');
    expect(verdict).toMatchObject({ verdict: 'dropped', code: 'field_unsupported' });
    expect(verdict.note).toContain('longer than the 64 characters');
    const harness = harnessOf(files);
    expect(JSON.stringify(harness)).not.toContain(name);
    HarnessSpecSubsetSchema.parse(harness);
  });

  it('uses x-api-key for an api-key MCP server and drops an OAuth2 one', () => {
    const { files, report } = compiled(
      rootWith({
        tools: [
          {
            kind: 'mcp',
            name: 'keyed',
            transport: 'streamable-http',
            url: 'https://mcp.example.com/keyed',
            auth: { scheme: 'api-key', secretRef: 'KEYED_API_KEY' },
          },
          {
            kind: 'mcp',
            name: 'oauth',
            transport: 'streamable-http',
            url: 'https://mcp.example.com/oauth',
            auth: { scheme: 'oauth2', secretRef: 'OAUTH_CLIENT' },
          },
        ],
        skills: [],
        subagents: [],
      }),
    );
    const agentcore = text(files, 'agentcore/agentcore.json');
    expect(text(files, 'app/support_triage/harness.json')).toContain(
      `"x-api-key": "\${${ARN_PREFIX}KEYED_API_KEY}"`,
    );
    expect(agentcore).toContain('KEYED_API_KEY');
    expect(agentcore).not.toContain('OAUTH_CLIENT');
    expect(verdictOf(report, 'support-triage.tools.1')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
  });
});

describe('skills', () => {
  it('drops skills without skillsS3Uri and emits no skill files', () => {
    const { files, report } = compiled(SAMPLE_PORTABLE_PROJECT, BASE_OPTIONS);
    expect(files.some((file) => file.path.includes('/skills/'))).toBe(false);
    expect(harnessOf(files)).not.toHaveProperty('skills');
    expect(verdictOf(report, 'support-triage.skills.0')).toMatchObject({
      verdict: 'dropped',
      code: 'skills_unsupported',
    });
  });

  it('copies the skill bytes unchanged when skillsS3Uri is set', () => {
    const asset = new Uint8Array([0, 255, 10, 13, 128]);
    const input: PortableProjectInput = {
      ...SAMPLE_PORTABLE_PROJECT,
      skills: [
        {
          name: 'refund-policy',
          files: [
            { path: 'SKILL.md', content: '---\nname: refund-policy\n---\nbody' },
            { path: 'assets/logo.bin', content: asset },
          ],
        },
      ],
    };
    const { files } = compiled(input);
    expect(text(files, 'app/support_triage/skills/refund-policy/SKILL.md')).toBe(
      '---\nname: refund-policy\n---\nbody',
    );
    const binary = files.find((file) => file.path.endsWith('assets/logo.bin'))?.content;
    expect(binary).toEqual(asset);
    expect(harnessOf(files)['skills']).toEqual([
      { s3Uri: 's3://acme-agent-skills/support-triage/refund-policy/' },
    ]);
  });
});

describe('secrets', () => {
  it('references credentials only by name or ARN, never by value', () => {
    const { files } = compiled(SAMPLE_PORTABLE_PROJECT);
    const names = ['ZENDESK_TOKEN', 'ACME_TOOL_ENDPOINT_TOKEN'];
    const harness = text(files, 'app/support_triage/harness.json');
    for (const name of names) {
      const mentions = harness.split(name).length - 1;
      expect(mentions).toBeGreaterThan(0);
      expect(harness.split(`\${${ARN_PREFIX}${name}}`).length - 1).toBe(mentions);
    }
    for (const file of files) {
      for (const pattern of CREDENTIAL_PATTERNS)
        expect(text(files, file.path)).not.toMatch(pattern);
    }
    const project = AgentCoreProjectSubsetSchema.parse(
      JSON.parse(text(files, 'agentcore/agentcore.json')),
    );
    expect(project.credentials).toEqual(
      names.map((name) => ({ authorizerType: 'ApiKeyCredentialProvider', name })),
    );
  });

  it.each([
    ['us-east-1', 'aws'],
    ['eu-west-2', 'aws'],
    ['us-gov-west-1', 'aws-us-gov'],
    ['cn-north-1', 'aws-cn'],
  ])('derives the ARN partition from the region %s', (region, partition) => {
    const { files } = compiled(SAMPLE_PORTABLE_PROJECT, { ...OPTIONS, region });
    const harness = text(files, 'app/support_triage/harness.json');
    expect(harness).toContain(
      `\${arn:${partition}:bedrock-agentcore:${region}:123456789012:token-vault/default/apikeycredentialprovider/ZENDESK_TOKEN}`,
    );
  });

  it('keeps every portable secret name a valid AgentCore credential name', () => {
    expect(SECRET_NAME_PATTERN.test('ZENDESK_TOKEN')).toBe(true);
    for (const name of ['A', 'ZENDESK_TOKEN', `A${'9'.repeat(127)}`, 'A_B_C_0']) {
      expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
      expect(AGENTCORE_CREDENTIAL_NAME_PATTERN.test(name)).toBe(true);
    }
    expect(SECRET_NAME_PATTERN.source).toBe('^[A-Z][A-Z0-9_]{0,127}$');
  });
});

describe('purity', () => {
  it('does not change its input', () => {
    const project: PortableProject = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const before = structuredClone(project);
    compileForPlatform(awsAgentCoreTarget, project, OPTIONS);
    expect(project).toEqual(before);
  });
});
