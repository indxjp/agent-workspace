import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { compileForPlatform } from '../../compile.js';
import {
  CREDENTIAL_PATTERNS,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import {
  AGENT_TOOLSET_TYPE,
  AW_TOOLS_SERVER_NAME,
  CREDENTIAL_PLAN_FILE,
  MAX_MCP_SERVERS_PER_AGENT,
  MAX_PREDEFINED_AGENTS,
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_URL_MAX_LENGTH,
  MULTIAGENT_TYPE,
  claudeManagedAgentsTarget,
} from './index.js';

type Agent = PortableProject['agents'][number];
type Tool = Agent['tools'][number];
type Options = Parameters<typeof claudeManagedAgentsTarget.compile>[1];

const GOLDEN = join(import.meta.dirname, '__golden__');
const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);

function rootOf(project: PortableProject): Agent {
  const root = project.agents.find((agent) => agent.name === project.root);
  if (root === undefined) throw new Error('the test project has no root');
  return root;
}

/** The sample with the root agent patched; the result is not re-validated, so a test may break a bound. */
function withRoot(patch: Partial<Agent>, base: PortableProject = sample): PortableProject {
  return {
    ...base,
    agents: base.agents.map((agent) => (agent.name === base.root ? { ...agent, ...patch } : agent)),
  };
}

function compiled(
  project: PortableProject,
  options: unknown = {},
): { files: Map<string, PlatformFile['content']>; report: readonly FieldVerdict[] } {
  const result = compileForPlatform(claudeManagedAgentsTarget, project, options);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  return {
    files: new Map(result.files.map((file) => [file.path, file.content])),
    report: result.report,
  };
}

function text(files: Map<string, PlatformFile['content']>, path: string): string {
  const content = files.get(path);
  if (typeof content !== 'string') throw new Error(`${path} is not an emitted text file`);
  return content;
}

function frontmatterOf(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  const parsed: unknown = parse(match?.[1] ?? '', { strict: true });
  return parsed as Record<string, unknown>;
}

function agentFrontmatter(
  files: Map<string, PlatformFile['content']>,
  name: string,
): Record<string, unknown> {
  return frontmatterOf(text(files, `agents/${name}.md`));
}

function refusalOf(project: PortableProject, options: Options = {}): string {
  const result = claudeManagedAgentsTarget.compile(project, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal.code;
}

function mcp(index: number): Tool {
  return {
    kind: 'mcp',
    name: `server-${index}`,
    transport: 'streamable-http',
    url: `https://mcp.example.com/${index}`,
  };
}

function verdictOf(report: readonly FieldVerdict[], path: string): FieldVerdict {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict for ${path}`);
  return entry;
}

describe('claude-managed-agents target', () => {
  it('passes the platform conformance suite', () => {
    runPlatformConformance(claudeManagedAgentsTarget);
  });

  describe('goldens', () => {
    for (const name of ['full', 'no-tool-endpoint'] as const) {
      const dir = join(GOLDEN, name);
      const input =
        name === 'full' ? SAMPLE_PORTABLE_PROJECT : SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT;

      // input.json, not project.json: Nx reads every project.json as a project definition.
      const load = (): PortableProject =>
        PortableProjectSchema.parse(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')));

      it(`${name}: input.json is the shared sample`, () => {
        expect(load()).toEqual(PortableProjectSchema.parse(input));
      });

      it(`${name}: emits exactly the golden tree and report`, () => {
        const project = load();
        const result = compileForPlatform(claudeManagedAgentsTarget, project, {});
        expectGoldenFiles(result, dir);
        assertVerdictInvariants(claudeManagedAgentsTarget, project, result);
      });
    }

    it('full: lists the five kinds of files', () => {
      const { files } = compiled(sample);
      expect([...files.keys()]).toEqual([
        'agents/billing-specialist.md',
        'agents/support-triage.md',
        'aw-vault-credentials.json',
        'environments/default.yaml',
        'skills/refund-policy/SKILL.md',
        'vaults/support-triage.yaml',
      ]);
    });

    it('no-tool-endpoint: has no aw-tools, drops the code tool and plans only the zendesk credential', () => {
      const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT);
      const { files, report } = compiled(project);
      expect(text(files, 'agents/support-triage.md')).not.toContain(AW_TOOLS_SERVER_NAME);
      expect(verdictOf(report, 'support-triage.tools.2')).toMatchObject({
        verdict: 'dropped',
        code: 'code_tool_needs_public_mcp',
      });
      const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as { credentials: unknown[] };
      expect(plan.credentials).toEqual([
        {
          type: 'static_bearer',
          mcp_server_url: 'https://mcp.example.com/zendesk',
          secretRef: 'ZENDESK_TOKEN',
        },
      ]);
    });
  });

  describe('secrets', () => {
    it('names a secret only in the credential plan and carries no credential', () => {
      const { files, report } = compiled(sample);
      for (const [path, content] of files) {
        if (typeof content !== 'string') continue;
        for (const pattern of CREDENTIAL_PATTERNS) expect(content).not.toMatch(pattern);
        if (path === CREDENTIAL_PLAN_FILE) continue;
        expect(content).not.toContain('ZENDESK_TOKEN');
        expect(content).not.toContain('ACME_TOOL_ENDPOINT_TOKEN');
      }
      expect(JSON.stringify(report)).not.toMatch(/ZENDESK_TOKEN|ACME_TOOL_ENDPOINT_TOKEN/u);
    });

    it('emits no vault and no plan when no emitted server has auth', () => {
      const root = rootOf(sample);
      const { files } = compiled(
        withRoot(
          { tools: root.tools.filter((tool) => tool.kind !== 'mcp' && tool.kind !== 'code') },
          {
            ...sample,
            toolEndpoint: undefined,
          },
        ),
      );
      expect(files.has(CREDENTIAL_PLAN_FILE)).toBe(false);
      expect([...files.keys()].some((path) => path.startsWith('vaults/'))).toBe(false);
    });
  });

  describe('verdicts', () => {
    it('covers every row of the mapping table on the sample', () => {
      const { report } = compiled(sample);
      const at = (path: string): FieldVerdict => verdictOf(report, path);
      expect(at('support-triage.tools.0').verdict).toBe('mapped');
      expect(at('support-triage.tools.1').code).toBe('stdio_mcp_unsupported');
      expect(at('support-triage.tools.2').verdict).toBe('mapped');
      expect(at('support-triage.tools.3').code).toBe('field_unsupported');
      expect(at('support-triage.tools.4')).toMatchObject({ verdict: 'native' });
      expect(at('support-triage.tools.4').note).toContain('allowed_hosts');
      expect(at('support-triage.tools.5').verdict).toBe('mapped');
      expect(at('support-triage.knowledge.0').code).toBe('knowledge_unsupported');
      expect(at('support-triage.knowledge.1').code).toBe('knowledge_unsupported');
      expect(at('support-triage.limits.maxTurns').code).toBe('limits_unsupported');
      expect(at('support-triage.limits.maxBudgetUsd').code).toBe('limits_unsupported');
      expect(at('support-triage.permissions.unrestrictedNetwork').verdict).toBe('mapped');
      expect(at('support-triage.subagents.0').verdict).toBe('mapped');
      expect(at('support-triage.skills.0').verdict).toBe('native');
      expect(at('toolEndpoint').verdict).toBe('mapped');
    });

    it('reports sse as mapped, web_fetch as native, file_access as mapped and a connector as dropped', () => {
      const root = rootOf(sample);
      const project = withRoot({
        tools: [
          { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
          { kind: 'builtin', id: 'web_fetch' },
          { kind: 'builtin', id: 'file_access' },
        ],
        knowledge: [{ kind: 'connector', name: 'sharepoint' }],
        engine: root.engine,
      });
      const { files, report } = compiled(project);
      expect(verdictOf(report, 'support-triage.tools.0').verdict).toBe('mapped');
      expect(verdictOf(report, 'support-triage.tools.1').verdict).toBe('native');
      expect(verdictOf(report, 'support-triage.tools.2').verdict).toBe('mapped');
      expect(verdictOf(report, 'support-triage.knowledge.0')).toMatchObject({
        verdict: 'dropped',
        code: 'knowledge_unsupported',
      });
      const servers = agentFrontmatter(files, 'support-triage')['mcp_servers'];
      expect(servers).toEqual([
        { type: 'url', name: 'legacy', url: 'https://mcp.example.com/sse' },
      ]);
    });

    it('maps the own platform block, drops the others and drops engine settings', () => {
      const project = withRoot({
        engine: 'claude-agent-sdk',
        extensions: {
          engines: { 'claude-agent-sdk': { effort: 'high' } },
          platforms: { 'claude-managed-agents': {}, 'copilot-studio': {} },
        },
      });
      const { report } = compiled(project);
      expect(verdictOf(report, 'support-triage.engine').code).toBe('field_unsupported');
      expect(verdictOf(report, 'support-triage.extensions.engines.claude-agent-sdk').code).toBe(
        'field_unsupported',
      );
      expect(
        verdictOf(report, 'support-triage.extensions.platforms.claude-managed-agents'),
      ).toMatchObject({
        verdict: 'mapped',
      });
      expect(verdictOf(report, 'support-triage.extensions.platforms.copilot-studio').code).toBe(
        'field_unsupported',
      );
    });

    it('reports an unused tool endpoint as dropped', () => {
      const root = rootOf(sample);
      const project = withRoot({ tools: root.tools.filter((tool) => tool.kind !== 'code') });
      expect(verdictOf(compiled(project).report, 'toolEndpoint')).toMatchObject({
        verdict: 'dropped',
        code: 'field_unsupported',
      });
    });

    function withNetworking(rootUnrestricted: boolean, subagentUnrestricted: boolean) {
      return {
        ...sample,
        agents: sample.agents.map((agent) => {
          if (agent.name === sample.root) {
            return {
              ...agent,
              permissions: { ...agent.permissions, unrestrictedNetwork: rootUnrestricted },
            };
          }
          if (agent.name === 'billing-specialist') {
            return {
              ...agent,
              permissions: { ...agent.permissions, unrestrictedNetwork: subagentUnrestricted },
            };
          }
          return agent;
        }),
      };
    }

    it('drops unrestricted networking on a subagent under a limited root', () => {
      const { report } = compiled(withNetworking(false, true));
      expect(verdictOf(report, 'billing-specialist.permissions.unrestrictedNetwork')).toMatchObject(
        { verdict: 'dropped', code: 'permissions_unsupported' },
      );
    });

    it('maps a limited subagent under an unrestricted root and names the widening', () => {
      const { report } = compiled(withNetworking(true, false));
      expect(verdictOf(report, 'billing-specialist.permissions.unrestrictedNetwork')).toMatchObject(
        {
          verdict: 'mapped',
          note: "The sandbox is shared; this agent gets the root agent's unrestricted networking",
        },
      );
    });
  });

  describe('refusals', () => {
    it('refuses a non-Claude model', () => {
      expect(refusalOf(withRoot({ model: { provider: 'anthropic', id: 'gpt-5' } }))).toBe(
        'platform_model_unsupported',
      );
    });

    it('refuses another provider even with a claude-* id', () => {
      expect(refusalOf(withRoot({ model: { provider: 'openai', id: 'claude-x' } }))).toBe(
        'platform_model_unsupported',
      );
    });

    it('refuses an agent with no model', () => {
      expect(refusalOf(withRoot({ model: undefined }))).toBe('platform_model_unsupported');
    });

    it('refuses a subagent with a non-Claude model', () => {
      const project: PortableProject = {
        ...sample,
        agents: sample.agents.map((agent) =>
          agent.name === 'billing-specialist' ? { ...agent, model: { id: 'gpt-5' } } : agent,
        ),
      };
      expect(refusalOf(project)).toBe('platform_model_unsupported');
    });

    it('accepts a non-Claude agent model replaced by options.model.id', () => {
      const project = withRoot({ model: { provider: 'openai', id: 'gpt-5' } });
      expect(compileForPlatform(claudeManagedAgentsTarget, project, {}).ok).toBe(false);
      const { files } = compiled(
        {
          ...project,
          agents: project.agents.map((agent) => ({ ...agent, model: { id: 'gpt-5' } })),
        },
        { model: { id: 'claude-opus-5-5' } },
      );
      expect(agentFrontmatter(files, 'support-triage')['model']).toBe('claude-opus-5-5');
      expect(agentFrontmatter(files, 'billing-specialist')['model']).toBe('claude-opus-5-5');
    });

    it('refuses 21 MCP servers', () => {
      const tools = Array.from({ length: MAX_MCP_SERVERS_PER_AGENT + 1 }, (_, index) => mcp(index));
      expect(refusalOf(withRoot({ tools }))).toBe('platform_limit_exceeded');
    });

    it('counts aw-tools toward the 20 servers', () => {
      const servers = Array.from({ length: MAX_MCP_SERVERS_PER_AGENT }, (_, index) => mcp(index));
      expect(
        compileForPlatform(claudeManagedAgentsTarget, withRoot({ tools: servers }), {}).ok,
      ).toBe(true);
      const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
      expect(refusalOf(withRoot({ tools: [...servers, ...code] }))).toBe('platform_limit_exceeded');
    });

    it('refuses more than 20 subagents', () => {
      const names = Array.from({ length: MAX_PREDEFINED_AGENTS + 1 }, (_, index) => `sub-${index}`);
      const specialist = sample.agents.find((agent) => agent.name === 'billing-specialist');
      if (specialist === undefined) throw new Error('missing sample agent');
      const project: PortableProject = {
        ...withRoot({ subagents: names.map((name) => ({ name })) }),
        agents: [
          ...withRoot({ subagents: names.map((name) => ({ name })) }).agents.filter(
            (agent) => agent.name === sample.root,
          ),
          ...names.map((name) => ({ ...specialist, name })),
        ],
      };
      expect(refusalOf(project)).toBe('platform_limit_exceeded');
    });

    it('refuses a URL over the limit and a name over the limit', () => {
      const longUrl: Tool = {
        kind: 'mcp',
        name: 'long-url',
        transport: 'streamable-http',
        url: `https://mcp.example.com/${'a'.repeat(MCP_SERVER_URL_MAX_LENGTH)}`,
      };
      const longName: Tool = {
        kind: 'mcp',
        name: 'n'.repeat(MCP_SERVER_NAME_MAX_LENGTH + 1),
        transport: 'streamable-http',
        url: 'https://mcp.example.com/a',
      };
      expect(refusalOf(withRoot({ tools: [longUrl] }))).toBe('platform_limit_exceeded');
      expect(refusalOf(withRoot({ tools: [longName] }))).toBe('platform_limit_exceeded');
    });

    it('does not put a URL query or a secret in a refusal', () => {
      const result = claudeManagedAgentsTarget.compile(
        withRoot({
          tools: [
            {
              kind: 'mcp',
              name: 'long-url',
              transport: 'streamable-http',
              url: `https://mcp.example.com/${'a'.repeat(MCP_SERVER_URL_MAX_LENGTH)}?token=abc`,
              auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
            },
          ],
        }),
        {},
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/token=abc|ZENDESK_TOKEN/u);
    });

    it('refuses an unknown root through compileForPlatform and an unknown subagent', () => {
      const result = compileForPlatform(
        claudeManagedAgentsTarget,
        { ...sample, root: 'nobody' },
        {},
      );
      expect(result).toMatchObject({ ok: false, refusal: { code: 'platform_agent_not_found' } });
      expect(refusalOf(withRoot({ subagents: [{ name: 'ghost' }] }))).toBe(
        'platform_agent_not_found',
      );
      expect(refusalOf({ ...sample, root: 'nobody' })).toBe('platform_agent_not_found');
    });

    it('refuses a user MCP server named aw-tools when code tools are emitted', () => {
      const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
      const reserved: Tool = {
        kind: 'mcp',
        name: AW_TOOLS_SERVER_NAME,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/reserved',
      };
      expect(refusalOf(withRoot({ tools: [reserved, ...code] }))).toBe('platform_options_invalid');
      expect(
        compileForPlatform(claudeManagedAgentsTarget, withRoot({ tools: [reserved] }), {}).ok,
      ).toBe(true);
    });

    it('refuses an invalid option through compileForPlatform', () => {
      const result = compileForPlatform(claudeManagedAgentsTarget, sample, {
        model: { id: 'gpt-5' },
      });
      expect(result).toMatchObject({ ok: false, refusal: { code: 'platform_options_invalid' } });
      const unknown = compileForPlatform(claudeManagedAgentsTarget, sample, { colour: 'red' });
      expect(unknown).toMatchObject({ ok: false, refusal: { code: 'platform_options_invalid' } });
    });
  });

  describe('toolset and environment', () => {
    const none = {
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    };

    it('emits no agent toolset when no permission or builtin tool enables a tool', () => {
      const { files } = compiled(withRoot({ permissions: none, tools: [] }));
      const frontmatter = agentFrontmatter(files, 'support-triage');
      expect(frontmatter['tools']).toBeUndefined();
      expect(JSON.stringify(frontmatter)).not.toContain(AGENT_TOOLSET_TYPE);
    });

    it('enables write and edit for writeFiles with file_access, in the fixed order', () => {
      const { files } = compiled(
        withRoot({
          permissions: { ...none, writeFiles: true },
          tools: [{ kind: 'builtin', id: 'file_access' }],
        }),
      );
      const tools = agentFrontmatter(files, 'support-triage')['tools'] as Record<string, unknown>[];
      expect(tools[0]).toEqual({
        type: AGENT_TOOLSET_TYPE,
        default_config: { enabled: false },
        configs: ['read', 'write', 'edit', 'glob', 'grep'].map((name) => ({ name, enabled: true })),
      });
    });

    it('uses unrestricted networking without allow_mcp_servers', () => {
      const { files } = compiled(
        withRoot({ permissions: { ...rootOf(sample).permissions, unrestrictedNetwork: true } }),
      );
      const environment = parse(text(files, 'environments/default.yaml')) as {
        config: { networking: Record<string, unknown> };
      };
      expect(environment.config.networking).toEqual({ type: 'unrestricted' });
    });

    it('limits networking, allows MCP servers and adds the allowed hosts', () => {
      const { files } = compiled(sample, { allowedHosts: ['api.example.com', '*.example.org'] });
      const environment = parse(text(files, 'environments/default.yaml')) as {
        name: string;
        config: { networking: Record<string, unknown> };
      };
      expect(environment.name).toBe('support-triage');
      expect(environment.config.networking).toEqual({
        type: 'limited',
        allowed_hosts: ['api.example.com', '*.example.org'],
        allow_mcp_servers: true,
      });
    });
  });

  describe('options', () => {
    it('switches to the object model form on every emitted agent', () => {
      const { files } = compiled(sample, { model: { effort: 'high', inferenceGeo: 'us' } });
      for (const name of ['support-triage', 'billing-specialist']) {
        expect(agentFrontmatter(files, name)['model']).toEqual({
          id: 'claude-sonnet-4-6',
          effort: 'high',
          inference_geo: 'us',
        });
      }
    });

    it('allows package managers when packages are set', () => {
      const { files } = compiled(sample, { packages: { pip: ['pandas'], apt: ['git'] } });
      const environment = parse(text(files, 'environments/default.yaml')) as {
        config: { packages: unknown; networking: Record<string, unknown> };
      };
      expect(environment.config.packages).toEqual({ apt: ['git'], pip: ['pandas'] });
      expect(environment.config.networking['allow_package_managers']).toBe(true);
    });

    it('writes the MCP permission policy on every mcp_toolset', () => {
      const { files } = compiled(sample, {
        mcpPermissionPolicy: 'always_allow',
        toolsetPermissionPolicy: 'auto',
      });
      const tools = agentFrontmatter(files, 'support-triage')['tools'] as Record<string, unknown>[];
      const toolsets = tools.filter((tool) => tool['type'] === 'mcp_toolset');
      expect(toolsets).toHaveLength(2);
      for (const toolset of toolsets) {
        expect(toolset['default_config']).toMatchObject({
          permission_policy: { type: 'always_allow' },
        });
      }
      expect(tools[0]?.['default_config']).toEqual({
        enabled: false,
        permission_policy: { type: 'auto' },
      });
    });
  });

  describe('determinism', () => {
    it('compiles twice to the same files', () => {
      expect(compiled(sample)).toEqual(compiled(sample));
    });

    it('does not depend on the order of agents or skills in the input', () => {
      const shuffled: PortableProject = {
        ...sample,
        agents: [...sample.agents].reverse(),
        skills: [...sample.skills].reverse(),
      };
      expect([...compiled(shuffled).files]).toEqual([...compiled(sample).files]);
    });
  });

  describe('the emitted shape', () => {
    it('lists subagents as agent entries with a relative path id under multiagent, on the root only', () => {
      const { files } = compiled(sample);
      expect(agentFrontmatter(files, 'support-triage')['multiagent']).toEqual({
        type: MULTIAGENT_TYPE,
        subagents: {
          type: 'enabled',
          inline_agents: { type: 'disabled' },
          predefined_agents: [{ type: 'agent', id: './billing-specialist.md' }],
        },
        workflows: { type: 'disabled' },
      });
      expect(agentFrontmatter(files, 'billing-specialist')['multiagent']).toBeUndefined();
    });

    it('copies skill bytes unchanged', () => {
      const bytes = new Uint8Array([0, 1, 2, 255]);
      const project: PortableProject = {
        ...sample,
        skills: sample.skills.map((skill) => ({
          ...skill,
          files: [...skill.files, { path: 'assets/blob.bin', content: bytes }],
        })),
      };
      const { files } = compiled(project);
      expect(files.get('skills/refund-policy/assets/blob.bin')).toEqual(bytes);
      expect(files.get('skills/refund-policy/SKILL.md')).toBe(
        sample.skills[0]?.files.find((file) => file.path === 'SKILL.md')?.content,
      );
    });

    it('does not emit agents outside the root and its subagents', () => {
      const extra: Agent = { ...rootOf(sample), name: 'bystander', subagents: [] };
      const { files } = compiled({ ...sample, agents: [...sample.agents, extra] });
      expect(files.has('agents/bystander.md')).toBe(false);
    });
  });

  describe('VERIFY items (docs read 2026-10-11)', () => {
    const vendor = (...path: string[]): string =>
      readFileSync(join(GOLDEN, 'vendor-fixtures', ...path), 'utf8');

    it('VERIFY-1 still open: the relative path id is reported as mapped with the VERIFY note, not native', () => {
      const lead = frontmatterOf(vendor('multiagent', 'engineering-lead.md')) as {
        multiagent: { type: string; subagents: { predefined_agents: Record<string, unknown>[] } };
      };
      expect(lead.multiagent.type).toBe(MULTIAGENT_TYPE);
      expect(lead.multiagent.subagents.predefined_agents[0]).toMatchObject({ type: 'agent' });
      const coordinator = frontmatterOf(vendor('apply', 'agents', 'lead.md')) as {
        multiagent: { agents: string[] };
      };
      expect(coordinator.multiagent.agents).toEqual(['./reviewer.md']);
      const { files, report } = compiled(sample);
      const emitted = agentFrontmatter(files, 'support-triage') as {
        multiagent: { subagents: { predefined_agents: unknown[] } };
      };
      expect(emitted.multiagent.subagents.predefined_agents).toEqual([
        { type: 'agent', id: './billing-specialist.md' },
      ]);
      const verdict = verdictOf(report, 'support-triage.subagents.0');
      expect(verdict.verdict).toBe('mapped');
      expect(verdict.note).toContain(
        'VERIFY-1: ant apply resolving a relative file path as the agent id is not yet confirmed; see #1003',
      );
    });

    it('VERIFY-2 confirmed by the documented kind inference: the credential plan is skipped by ant apply', () => {
      const { files } = compiled(sample);
      const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as Record<string, unknown>;
      expect(plan['type']).toBeUndefined();
      expect(CREDENTIAL_PLAN_FILE).not.toContain('/');
      expect(CREDENTIAL_PLAN_FILE).not.toMatch(/^(agent|environment|memory_store|deployment)/u);
    });

    it('VERIFY-3 confirmed: an sse server is emitted as a url server, because Managed Agents falls back to SSE', () => {
      const { files } = compiled(
        withRoot({
          tools: [
            { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
          ],
        }),
      );
      expect(agentFrontmatter(files, 'support-triage')['mcp_servers']).toEqual([
        { type: 'url', name: 'legacy', url: 'https://mcp.example.com/sse' },
      ]);
    });

    it('emits the layout of the vendor apply example', () => {
      const reviewer = frontmatterOf(vendor('apply', 'agents', 'reviewer.md'));
      expect(reviewer['skills']).toEqual(['../skills/pr-summary']);
      const { files } = compiled(sample);
      expect(agentFrontmatter(files, 'billing-specialist')['skills']).toEqual([
        '../skills/refund-policy',
      ]);
      const cloud = parse(vendor('apply', 'environments', 'cloud.yaml')) as Record<string, unknown>;
      const emitted = parse(text(files, 'environments/default.yaml')) as Record<string, unknown>;
      expect(Object.keys(emitted)).toEqual(['name', 'config']);
      expect(Object.keys(cloud)).toContain('config');
    });
  });

  describe('credential plan', () => {
    const ENDPOINT_URL = 'https://aw.example.com/mcp/projects/acme-support';

    function authed(
      name: string,
      url: string,
      secretRef: string,
      scheme: 'bearer' | 'api-key' | 'oauth2' = 'bearer',
    ): Tool {
      return { kind: 'mcp', name, transport: 'streamable-http', url, auth: { scheme, secretRef } };
    }

    function withSubagent(tools: Tool[], base: PortableProject = sample): PortableProject {
      return {
        ...base,
        agents: base.agents.map((agent) =>
          agent.name === 'billing-specialist' ? { ...agent, tools } : agent,
        ),
      };
    }

    function planOf(project: PortableProject): { mcp_server_url: string; secretRef: string }[] {
      const { files } = compiled(project);
      const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as {
        credentials: { mcp_server_url: string; secretRef: string }[];
      };
      return plan.credentials;
    }

    function refusalMessage(project: PortableProject): string {
      const result = claudeManagedAgentsTarget.compile(project, {});
      if (result.ok) throw new Error('expected a refusal');
      expect(result.refusal.code).toBe('platform_options_invalid');
      return result.refusal.message;
    }

    it('refuses one URL with two different secrets on one agent', () => {
      const project = withRoot({
        tools: [
          authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN'),
          authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN'),
        ],
      });
      expect(refusalMessage(project)).toContain('different secrets');
    });

    it('refuses one URL with two different secrets across the root and a subagent', () => {
      const project = withSubagent(
        [authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN')],
        withRoot({ tools: [authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN')] }),
      );
      expect(refusalMessage(project)).toContain('different secrets');
    });

    it('refuses a user server on the tool endpoint URL with a different secret', () => {
      const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
      const project = withRoot({ tools: [authed('mine', ENDPOINT_URL, 'OTHER_TOKEN'), ...code] });
      expect(refusalMessage(project)).toContain('different secrets');
    });

    it('names no URL and no secret in that refusal', () => {
      const message = refusalMessage(
        withRoot({
          tools: [
            authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN'),
            authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN'),
          ],
        }),
      );
      expect(message).not.toMatch(/mcp\.example\.com|FIRST_TOKEN|SECOND_TOKEN/u);
    });

    it('plans one credential for one URL used with the same secret by the root and a subagent', () => {
      const shared = authed('shared', 'https://mcp.example.com/shared', 'SHARED_TOKEN');
      const project = withSubagent([shared], withRoot({ tools: [shared] }));
      expect(planOf(project)).toEqual([
        {
          type: 'static_bearer',
          mcp_server_url: 'https://mcp.example.com/shared',
          secretRef: 'SHARED_TOKEN',
        },
      ]);
    });

    it('names static_bearer and the original scheme when api-key or oauth2 is flattened', () => {
      const { report } = compiled(
        withRoot({
          tools: [
            authed('keyed', 'https://mcp.example.com/key', 'KEY_TOKEN', 'api-key'),
            authed('oauth', 'https://mcp.example.com/oauth', 'OAUTH_TOKEN', 'oauth2'),
            authed('plain', 'https://mcp.example.com/plain', 'PLAIN_TOKEN'),
          ],
        }),
      );
      const [keyed, oauth, plain] = [0, 1, 2].map(
        (index) => verdictOf(report, `support-triage.tools.${index}`).note,
      );
      expect(keyed).toContain('static_bearer');
      expect(keyed).toContain('original scheme: api-key');
      expect(oauth).toContain('static_bearer');
      expect(oauth).toContain('original scheme: oauth2');
      expect(plain).toContain('static_bearer');
      expect(plain).not.toContain('original scheme');
    });

    it('names the original scheme of an oauth2 tool endpoint', () => {
      const project: PortableProject = {
        ...sample,
        toolEndpoint: {
          url: ENDPOINT_URL,
          auth: { scheme: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
        },
      };
      const note = verdictOf(compiled(project).report, 'toolEndpoint').note;
      expect(note).toContain('static_bearer');
      expect(note).toContain('original scheme: oauth2');
    });
  });
});
