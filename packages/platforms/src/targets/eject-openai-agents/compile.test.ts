import { fileURLToPath } from 'node:url';

import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import { PLATFORM_TARGETS } from '../../registry.js';
import {
  CREDENTIAL_PATTERNS,
  SAMPLE_PORTABLE_PROJECT,
  assertVerdictInvariants,
  expectGoldenBundle,
  runPlatformConformance,
} from '../../testing/index.js';
import { ejectOpenAiAgentsTarget } from './index.js';

const ROOT = 'support-triage';
const SUBAGENT = 'billing-specialist';

function golden(name: string): string {
  return fileURLToPath(new URL(`./__golden__/${name}.golden.txt`, import.meta.url));
}

function parse(input: PortableProjectInput): PortableProject {
  return PortableProjectSchema.parse(input);
}

function sampleWith(patch: Partial<PortableAgentInput>, name = ROOT): PortableProject {
  return parse({
    ...SAMPLE_PORTABLE_PROJECT,
    agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent) =>
      agent.name === name ? { ...agent, ...patch } : agent,
    ),
  });
}

const MINIMAL: PortableProjectInput = {
  root: 'helper',
  agents: [
    {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name: 'helper',
      instructions: '',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      },
    },
  ],
  skills: [],
  knowledgeFiles: [],
  openapiSpecs: [],
};

function compile(project: PortableProject, options: unknown = {}) {
  const result = compileForPlatform(ejectOpenAiAgentsTarget, project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(ejectOpenAiAgentsTarget, project, result);
  return result;
}

function text(result: ReturnType<typeof compile>, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  if (typeof file?.content !== 'string') throw new Error(`no text file ${path}`);
  return file.content;
}

describe('eject-openai-agents', () => {
  const full = parse(SAMPLE_PORTABLE_PROJECT);

  it('is registered', () => {
    expect(PLATFORM_TARGETS).toContain(ejectOpenAiAgentsTarget);
  });

  it('passes the conformance kit', () => {
    expect(() => runPlatformConformance(ejectOpenAiAgentsTarget)).not.toThrow();
  });

  it('matches the golden for a minimal project', () => {
    expectGoldenBundle(
      compileForPlatform(ejectOpenAiAgentsTarget, parse(MINIMAL), {}),
      golden('minimal'),
    );
  });

  it('matches the golden for the shared sample', () => {
    expectGoldenBundle(compileForPlatform(ejectOpenAiAgentsTarget, full, {}), golden('full'));
  });

  it('is deterministic', () => {
    expect(compile(full)).toEqual(compile(full));
  });

  it('gives the sample the documented verdicts', () => {
    const table = Object.fromEntries(
      compile(full).report.map((verdict) => [
        verdict.path,
        verdict.verdict === 'dropped' ? `dropped:${verdict.code}` : verdict.verdict,
      ]),
    );
    expect(table).toEqual({
      toolEndpoint: 'mapped',
      [`${ROOT}.description`]: 'mapped',
      [`${ROOT}.instructions`]: 'native',
      [`${ROOT}.model`]: 'mapped',
      [`${ROOT}.permissions.readFiles`]: 'dropped:permissions_unsupported',
      [`${ROOT}.permissions.writeFiles`]: 'native',
      [`${ROOT}.permissions.runCommands`]: 'native',
      [`${ROOT}.permissions.unrestrictedNetwork`]: 'mapped',
      [`${ROOT}.tools.0`]: 'native',
      [`${ROOT}.tools.1`]: 'native',
      [`${ROOT}.tools.2`]: 'native',
      [`${ROOT}.tools.3`]: 'dropped:code_tool_needs_public_mcp',
      [`${ROOT}.tools.4`]: 'dropped:builtin_unsupported',
      [`${ROOT}.tools.5`]: 'dropped:builtin_unsupported',
      [`${ROOT}.skills.0`]: 'dropped:skills_unsupported',
      [`${ROOT}.knowledge.0`]: 'dropped:knowledge_unsupported',
      [`${ROOT}.knowledge.1`]: 'dropped:knowledge_unsupported',
      [`${ROOT}.subagents.0`]: 'mapped',
      [`${ROOT}.limits.maxTurns`]: 'native',
      [`${ROOT}.limits.maxBudgetUsd`]: 'dropped:limits_unsupported',
      [`${SUBAGENT}.description`]: 'native',
      [`${SUBAGENT}.instructions`]: 'native',
      [`${SUBAGENT}.model`]: 'mapped',
      [`${SUBAGENT}.permissions.readFiles`]: 'dropped:permissions_unsupported',
      [`${SUBAGENT}.permissions.writeFiles`]: 'native',
      [`${SUBAGENT}.permissions.runCommands`]: 'native',
      [`${SUBAGENT}.permissions.unrestrictedNetwork`]: 'mapped',
      [`${SUBAGENT}.skills.0`]: 'dropped:skills_unsupported',
    });
  });

  it('keeps every secret out of the project and names it in .env.example', () => {
    const result = compile(full);
    expect(text(result, '.env.example')).toBe('ANTHROPIC_API_KEY=\nZENDESK_TOKEN=\n');
    expect(text(result, 'src/agent.ts')).toContain('requireEnv("ZENDESK_TOKEN")');
    for (const file of result.files) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(String(file.content)).not.toMatch(pattern);
      }
    }
  });

  it('refuses a model of another provider', () => {
    const result = compileForPlatform(
      ejectOpenAiAgentsTarget,
      sampleWith({ model: { provider: 'azure-openai', id: 'gpt-5' } }),
      {},
    );
    expect(result.ok ? undefined : result.refusal.code).toBe('platform_model_unsupported');
  });

  it('refuses bad options', () => {
    const result = compileForPlatform(ejectOpenAiAgentsTarget, full, { packageName: 'Bad Name' });
    expect(result.ok ? undefined : result.refusal.code).toBe('platform_options_invalid');
  });

  it('runs an OpenAI model directly and offers the hosted tools it can use', () => {
    const result = compile(
      sampleWith({
        model: { provider: 'openai', id: 'gpt-5' },
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: true,
        },
      }),
    );
    const source = text(result, 'src/agent.ts');
    expect(source).toContain('model: "gpt-5"');
    expect(source).toContain('webSearchTool()');
    expect(source).toContain('codeInterpreterTool()');
    expect(text(result, '.env.example')).toMatch(/^OPENAI_API_KEY=\n/u);
    const byPath = new Map(result.report.map((verdict) => [verdict.path, verdict.verdict]));
    expect(byPath.get(`${ROOT}.tools.4`)).toBe('mapped');
    expect(byPath.get(`${ROOT}.tools.5`)).toBe('mapped');
  });

  it('wires Anthropic only through the AI SDK adapter', () => {
    const source = text(compile(full), 'src/agent.ts');
    expect(source).toContain('model: aisdk(anthropic("claude-sonnet-4-6"))');
    const openai = compile(
      parse({
        ...MINIMAL,
        agents: MINIMAL.agents.map((agent) => ({
          ...agent,
          model: { provider: 'openai', id: 'gpt-5' },
        })),
      }),
    );
    expect(text(openai, 'src/agent.ts')).not.toContain('aisdk');
    expect(text(openai, 'package.json')).not.toContain('@ai-sdk/anthropic');
  });

  it('runs an agent that names no model on the SDK default', () => {
    const result = compile(parse(MINIMAL));
    expect(text(result, 'src/agent.ts')).not.toContain('model:');
    expect(text(result, '.env.example')).toBe('OPENAI_API_KEY=\n');
    expect(result.report.map((verdict) => verdict.path)).not.toContain('helper.model');
  });

  it('names the package with the option, or else after the root agent', () => {
    expect(
      JSON.parse(text(compile(full, { packageName: '@acme/triage' }), 'package.json')),
    ).toMatchObject({ name: '@acme/triage' });
    expect(JSON.parse(text(compile(full), 'package.json'))).toMatchObject({ name: ROOT });
  });

  it('omits MCP servers and code tools when the project has none', () => {
    const result = compile(parse(MINIMAL));
    const source = text(result, 'src/agent.ts');
    expect(source).not.toContain('connect()');
    expect(source).not.toContain('loadCodeTools');
    expect(result.files.map((file) => file.path)).not.toContain('src/code-tools.ts');
  });

  it('gives a subagent only the MCP servers it declares', () => {
    const source = text(
      compile(
        sampleWith(
          {
            tools: [
              { kind: 'mcp', name: 'billing-db', transport: 'stdio', command: 'billing-mcp' },
            ],
          },
          SUBAGENT,
        ),
      ),
      'src/agent.ts',
    );
    const subagent = source.slice(
      source.indexOf('const subagent0'),
      source.indexOf('const agent ='),
    );
    const root = source.slice(source.indexOf('const agent ='));
    expect(subagent).toContain('servers["billing-db"]');
    expect(root).not.toContain('billing-db');
  });

  it('hands the root’s maxTurns to run()', () => {
    const result = compile(full);
    expect(text(result, 'src/main.ts')).toContain('{ maxTurns: 20 }');
  });

  it('compiles an SSE server, web_fetch, file_access and an engines block', () => {
    const sample = SAMPLE_PORTABLE_PROJECT.agents.find((agent) => agent.name === ROOT);
    const result = compile(
      sampleWith({
        tools: [
          ...(sample?.tools ?? []),
          { kind: 'mcp', name: 'events', transport: 'sse', url: 'https://mcp.example.com/sse' },
          { kind: 'builtin', id: 'web_fetch' },
          { kind: 'builtin', id: 'file_access' },
        ],
        extensions: { engines: { mastra: { x: 1 } } },
      }),
    );
    const table = Object.fromEntries(
      result.report.map((verdict) => [
        verdict.path,
        verdict.verdict === 'dropped' ? `dropped:${verdict.code}` : verdict.verdict,
      ]),
    );
    expect(table).toMatchObject({
      [`${ROOT}.tools.6`]: 'native',
      [`${ROOT}.tools.7`]: 'dropped:builtin_unsupported',
      [`${ROOT}.tools.8`]: 'dropped:builtin_unsupported',
      [`${ROOT}.extensions.engines.mastra`]: 'dropped:field_unsupported',
    });
    const source = text(result, 'src/agent.ts');
    expect(source).toContain('new MCPServerSSE(');
    expect(source).toContain('https://mcp.example.com/sse');
  });

  it('carries hostile text only inside string literals', () => {
    const hostile = '"; process.exit(1); //`${evil}`\n\\';
    const result = compile(sampleWith({ instructions: hostile }));
    expect(text(result, 'src/agent.ts')).toContain(JSON.stringify(hostile));
  });
});
