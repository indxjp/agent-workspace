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
import { ejectClaudeAgentSdkTarget } from './index.js';

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
  const result = compileForPlatform(ejectClaudeAgentSdkTarget, project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(ejectClaudeAgentSdkTarget, project, result);
  return result;
}

function text(result: ReturnType<typeof compile>, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  if (typeof file?.content !== 'string') throw new Error(`no text file ${path}`);
  return file.content;
}

describe('eject-claude-agent-sdk', () => {
  const full = parse(SAMPLE_PORTABLE_PROJECT);

  it('is registered after aws-agentcore', () => {
    expect(PLATFORM_TARGETS).toContain(ejectClaudeAgentSdkTarget);
  });

  it('passes the conformance kit', () => {
    expect(() => runPlatformConformance(ejectClaudeAgentSdkTarget)).not.toThrow();
  });

  it('matches the golden for a minimal project', () => {
    expectGoldenBundle(
      compileForPlatform(ejectClaudeAgentSdkTarget, parse(MINIMAL), {}),
      golden('minimal'),
    );
  });

  it('matches the golden for the shared sample', () => {
    expectGoldenBundle(compileForPlatform(ejectClaudeAgentSdkTarget, full, {}), golden('full'));
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
      [`${ROOT}.model`]: 'native',
      [`${ROOT}.permissions.readFiles`]: 'native',
      [`${ROOT}.permissions.writeFiles`]: 'native',
      [`${ROOT}.permissions.runCommands`]: 'native',
      [`${ROOT}.permissions.unrestrictedNetwork`]: 'mapped',
      [`${ROOT}.tools.0`]: 'native',
      [`${ROOT}.tools.1`]: 'native',
      [`${ROOT}.tools.2`]: 'native',
      [`${ROOT}.tools.3`]: 'dropped:code_tool_needs_public_mcp',
      [`${ROOT}.tools.4`]: 'dropped:permissions_unsupported',
      [`${ROOT}.tools.5`]: 'mapped',
      [`${ROOT}.skills.0`]: 'native',
      [`${ROOT}.knowledge.0`]: 'dropped:knowledge_unsupported',
      [`${ROOT}.knowledge.1`]: 'dropped:knowledge_unsupported',
      [`${ROOT}.subagents.0`]: 'mapped',
      [`${ROOT}.limits.maxTurns`]: 'native',
      [`${ROOT}.limits.maxBudgetUsd`]: 'native',
      [`${SUBAGENT}.description`]: 'native',
      [`${SUBAGENT}.instructions`]: 'native',
      [`${SUBAGENT}.model`]: 'native',
      [`${SUBAGENT}.permissions.readFiles`]: 'native',
      [`${SUBAGENT}.permissions.writeFiles`]: 'native',
      [`${SUBAGENT}.permissions.runCommands`]: 'native',
      [`${SUBAGENT}.permissions.unrestrictedNetwork`]: 'mapped',
      [`${SUBAGENT}.skills.0`]: 'native',
    });
  });

  it('drops a subagent permission the root denies, since the root’s disallowedTools apply to it', () => {
    const report = compile(
      sampleWith(
        {
          permissions: {
            readFiles: true,
            writeFiles: true,
            runCommands: true,
            unrestrictedNetwork: true,
          },
          tools: [
            { kind: 'builtin', id: 'web_fetch' },
            {
              kind: 'code',
              name: 'get_order',
              description: 'Look up an order by its id',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
        },
        SUBAGENT,
      ),
    ).report;
    const verdictOf = (path: string) => report.find((verdict) => verdict.path === path);
    for (const key of ['writeFiles', 'runCommands', 'unrestrictedNetwork']) {
      expect(verdictOf(`${SUBAGENT}.permissions.${key}`)).toMatchObject({
        verdict: 'dropped',
        code: 'permissions_unsupported',
      });
    }
    expect(verdictOf(`${SUBAGENT}.permissions.readFiles`)?.verdict).toBe('native');
    expect(verdictOf(`${SUBAGENT}.tools.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    expect(verdictOf(`${SUBAGENT}.tools.1`)?.note).toContain(
      'its run context names the root agent',
    );
    expect(verdictOf(`${ROOT}.tools.2`)?.note).not.toContain('run context');
  });

  it('keeps every secret out of the project and names it in .env.example', () => {
    const result = compile(full);
    expect(text(result, '.env.example')).toBe('ANTHROPIC_API_KEY=\nZENDESK_TOKEN=\n');
    const agent = text(result, 'src/agent.ts');
    expect(agent).toContain('requireEnv("ZENDESK_TOKEN")');
    for (const file of result.files) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(String(file.content)).not.toMatch(pattern);
      }
    }
  });

  it('refuses a model of another provider', () => {
    const result = compileForPlatform(
      ejectClaudeAgentSdkTarget,
      sampleWith({ model: { provider: 'openai', id: 'gpt-5' } }),
      {},
    );
    expect(result.ok ? undefined : result.refusal.code).toBe('platform_model_unsupported');
  });

  it('refuses bad options', () => {
    const result = compileForPlatform(ejectClaudeAgentSdkTarget, full, { packageName: 'Bad Name' });
    expect(result.ok ? undefined : result.refusal.code).toBe('platform_options_invalid');
  });

  it('names the package with the option, or else after the root agent', () => {
    expect(
      JSON.parse(text(compile(full, { packageName: '@acme/triage' }), 'package.json')),
    ).toMatchObject({
      name: '@acme/triage',
    });
    expect(JSON.parse(text(compile(full), 'package.json'))).toMatchObject({ name: ROOT });
  });

  it('does not append instructions when they are empty, and omits code tools without one', () => {
    const result = compile(parse(MINIMAL));
    expect(text(result, 'src/agent.ts')).not.toContain('systemPrompt');
    expect(result.files.map((file) => file.path)).not.toContain('src/code-tools.ts');
  });

  it('puts a subagent’s MCP servers in its own mcpServers, not in the root’s', () => {
    const source = text(
      compile(
        sampleWith(
          {
            tools: [
              { kind: 'mcp', name: 'billing-db', transport: 'stdio', command: 'billing-mcp' },
              {
                kind: 'mcp',
                name: 'zendesk',
                transport: 'streamable-http',
                url: 'https://mcp.example.com/zendesk',
                auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
              },
            ],
          },
          SUBAGENT,
        ),
      ),
      'src/agent.ts',
    );
    const root = source.slice(source.indexOf('mcpServers: {'), source.indexOf('skills: ['));
    expect(root).not.toContain('billing-db');
    const subagent = source.slice(source.indexOf(`"${SUBAGENT}": {`));
    expect(subagent).toContain('mcpServers: [');
    expect(subagent).toContain('"billing-db": {');
    expect(subagent).toContain('"zendesk",');
    expect(source).toContain('"mcp__billing-db__*"');
  });

  it('carries hostile text only inside string literals', () => {
    const hostile = '"; process.exit(1); //`${evil}`\n\\';
    const result = compile(sampleWith({ instructions: hostile }));
    expect(text(result, 'src/agent.ts')).toContain(JSON.stringify(hostile));
  });
});
