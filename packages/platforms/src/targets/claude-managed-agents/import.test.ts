import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import { claudeManagedAgentsTarget, importClaudeManagedAgents } from './index.js';

type Agent = PortableProject['agents'][number];

const FIXTURES = join(import.meta.dirname, '__golden__', 'vendor-fixtures');
const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
const sampleWithoutEndpoint = PortableProjectSchema.parse(
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
);

function compileFiles(project: PortableProject): readonly PlatformFile[] {
  const result = compileForPlatform(claudeManagedAgentsTarget, project, {});
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.files;
}

function imported(files: readonly PlatformFile[]): {
  project: PortableProject;
  report: readonly FieldVerdict[];
} {
  const result = importClaudeManagedAgents(files);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  return result;
}

function refusalOf(files: readonly PlatformFile[]): PlatformRefusal {
  const result = importClaudeManagedAgents(files);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function agentNamed(project: PortableProject, name: string): Agent {
  const agent = project.agents.find((candidate) => candidate.name === name);
  if (agent === undefined) throw new Error(`no agent ${name}`);
  return agent;
}

function verdictOf(report: readonly FieldVerdict[], path: string): FieldVerdict {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict for ${path}`);
  return entry;
}

function agentFile(name: string, frontmatter: string, body = ''): PlatformFile {
  return { path: `agents/${name}.md`, content: `---\n${frontmatter}\n---\n${body}` };
}

function vendor(...segments: string[]): string {
  return readFileSync(join(FIXTURES, ...segments), 'utf8');
}

const MODEL = 'model: claude-sonnet-4-6';

describe('claude-managed-agents importer', () => {
  describe('round trip of the shared sample', () => {
    const { project, report } = imported(compileFiles(sample));

    it('keeps the root, both agents, their text and their model', () => {
      expect(project.root).toBe('support-triage');
      expect(project.agents.map((agent) => agent.name)).toEqual([
        'support-triage',
        'billing-specialist',
      ]);
      for (const name of ['support-triage', 'billing-specialist']) {
        const back = agentNamed(project, name);
        const original = agentNamed(sample, name);
        expect(back.description).toBe(original.description);
        expect(back.instructions).toBe(original.instructions);
        expect(back.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
      }
    });

    it('rebuilds the permissions and the tools that the files carry', () => {
      const root = agentNamed(project, 'support-triage');
      expect(root.permissions).toEqual({
        readFiles: true,
        writeFiles: false,
        runCommands: true,
        unrestrictedNetwork: false,
      });
      expect(root.tools).toEqual([
        {
          kind: 'mcp',
          name: 'zendesk',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/zendesk',
        },
        { kind: 'builtin', id: 'web_search' },
      ]);
    });

    it('carries the skills, the subagents and the skill bytes', () => {
      const root = agentNamed(project, 'support-triage');
      expect(root.skills).toEqual([{ name: 'refund-policy', path: 'skills/refund-policy' }]);
      expect(root.subagents).toEqual([{ name: 'billing-specialist' }]);
      expect(project.skills).toEqual(sample.skills);
    });

    it('drops the tool endpoint code tool and maps the zendesk server', () => {
      const endpoint = report.filter((entry) => entry.code === 'code_tool_needs_public_mcp');
      expect(endpoint.map((entry) => entry.path)).toEqual([
        'support-triage.mcp_servers.1',
        'support-triage.tools.2.configs.0',
      ]);
      expect(verdictOf(report, 'support-triage.mcp_servers.0')).toMatchObject({
        verdict: 'mapped',
      });
      expect(verdictOf(report, 'support-triage.mcp_servers.0').note).toContain('auth.secretRef');
    });

    it('imports no tool endpoint and no secret', () => {
      expect(project.toolEndpoint).toBeUndefined();
      expect(JSON.stringify({ project, report })).not.toMatch(
        /ZENDESK_TOKEN|ACME_TOOL_ENDPOINT_TOKEN/u,
      );
    });

    it('is a fixed point: compiling the import gives the same agents, skills and environment', () => {
      const first = compileFiles(sampleWithoutEndpoint);
      const again = compileFiles(imported(first).project);
      const layout = (files: readonly PlatformFile[]): readonly PlatformFile[] =>
        files.filter((file) => /^(agents|skills|environments)\//u.test(file.path));
      expect(layout(again)).toEqual(layout(first));
    });
  });

  describe('the vendor fixtures', () => {
    it('imports the apply example: lead, reviewer, the skill, and ignores the environment', () => {
      const { project, report } = imported([
        { path: 'agents/lead.md', content: vendor('apply', 'agents', 'lead.md') },
        { path: 'agents/reviewer.md', content: vendor('apply', 'agents', 'reviewer.md') },
        {
          path: 'skills/pr-summary/SKILL.md',
          content: vendor('apply', 'skills', 'pr-summary', 'SKILL.md'),
        },
        { path: 'environments/cloud.yaml', content: vendor('apply', 'environments', 'cloud.yaml') },
      ]);
      expect(project.root).toBe('lead');
      const lead = agentNamed(project, 'lead');
      expect(lead.description).toBe('Engineering lead');
      expect(lead.subagents).toEqual([{ name: 'reviewer' }]);
      expect(agentNamed(project, 'reviewer').skills).toEqual([
        { name: 'pr-summary', path: 'skills/pr-summary' },
      ]);
      expect(project.skills.map((skill) => skill.name)).toEqual(['pr-summary']);
      expect(report.some((entry) => entry.path.includes('cloud'))).toBe(false);
    });

    it('imports the multiagent example and drops both agent ids', () => {
      const { project, report } = imported([
        {
          path: 'agents/engineering-lead.md',
          content: vendor('multiagent', 'engineering-lead.md'),
        },
      ]);
      expect(project.root).toBe('engineering-lead');
      expect(agentNamed(project, 'engineering-lead').subagents).toEqual([]);
      for (const index of [0, 1]) {
        expect(
          verdictOf(report, `engineering-lead.multiagent.subagents.predefined_agents.${index}`),
        ).toMatchObject({ verdict: 'dropped', code: 'subagents_unsupported' });
      }
    });
  });

  describe('refusals', () => {
    it('refuses an unknown frontmatter key, naming the file and the key but no value', () => {
      const refusal = refusalOf([
        agentFile('a', `name: a\n${MODEL}\ndescription: sentinel-value\nbogus: 1`),
      ]);
      expect(refusal.code).toBe('platform_options_invalid');
      expect(refusal.message).toContain('agents/a.md');
      expect(refusal.details.join('\n')).toContain('bogus');
      expect(refusal.message).not.toContain('sentinel-value');
    });

    it.each([
      ['a list', '- a\n- b'],
      ['invalid YAML', 'name: [unclosed-sentinel'],
      ['a duplicate key', 'name: a\nname: b'],
      ['a YAML alias', `name: &n a\n${MODEL}\ndescription: *n`],
      ['a scalar', 'just-a-sentinel'],
    ])('refuses frontmatter that is %s, without quoting it', (_, frontmatter) => {
      const refusal = refusalOf([agentFile('a', frontmatter)]);
      expect(refusal.code).toBe('platform_options_invalid');
      expect(JSON.stringify(refusal)).not.toMatch(/sentinel/u);
    });

    it('refuses a file without a frontmatter block', () => {
      expect(refusalOf([{ path: 'agents/a.md', content: 'You are an agent.\n' }]).code).toBe(
        'platform_options_invalid',
      );
    });

    it('refuses a file name that is not a kebab agent name', () => {
      const refusal = refusalOf([agentFile('Not_Kebab', `name: x\n${MODEL}`)]);
      expect(refusal.code).toBe('platform_options_invalid');
      expect(refusal.message).toContain('Not_Kebab');
    });

    it('refuses invalid UTF-8', () => {
      const refusal = refusalOf([{ path: 'agents/a.md', content: new Uint8Array([0xff, 0xfe]) }]);
      expect(refusal.code).toBe('platform_options_invalid');
    });

    it('refuses a Markdown body together with a system key', () => {
      expect(refusalOf([agentFile('a', `name: a\n${MODEL}\nsystem: one`, '\ntwo\n')]).code).toBe(
        'platform_options_invalid',
      );
    });

    it('refuses an MCP server without a toolset and a toolset without a server', () => {
      const server = 'mcp_servers:\n  - type: url\n    name: x\n    url: https://mcp.example.com/x';
      const toolset = 'tools:\n  - type: mcp_toolset\n    mcp_server_name: x';
      expect(refusalOf([agentFile('a', `name: a\n${MODEL}\n${server}`)]).message).toContain(
        'mcp_servers.0',
      );
      expect(refusalOf([agentFile('a', `name: a\n${MODEL}\n${toolset}`)]).message).toContain(
        'tools.0',
      );
    });

    it('refuses an MCP URL that is not http(s), through the project schema', () => {
      const refusal = refusalOf([
        agentFile(
          'a',
          `name: a\n${MODEL}\nmcp_servers:\n  - type: url\n    name: x\n    url: ftp://mcp.example.com/x\ntools:\n  - type: mcp_toolset\n    mcp_server_name: x`,
        ),
      ]);
      expect(refusal.code).toBe('platform_options_invalid');
      expect(refusal.message).toContain('project');
    });

    it('refuses a layout with no agent file', () => {
      expect(refusalOf([]).code).toBe('platform_agent_not_found');
      expect(refusalOf([{ path: 'environments/default.yaml', content: 'name: x\n' }]).code).toBe(
        'platform_agent_not_found',
      );
    });

    it('refuses a file list that is not valid files', () => {
      const refusal = refusalOf([{ path: '../escape.md', content: '' }]);
      expect(refusal.code).toBe('platform_options_invalid');
    });
  });

  describe('lossy and dropped cases', () => {
    it('enables everything for a toolset without default_config', () => {
      const { project } = imported([
        agentFile('a', `name: a\n${MODEL}\ntools:\n  - type: agent_toolset_20260401`),
      ]);
      const agent = agentNamed(project, 'a');
      expect(agent.permissions).toEqual({
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      });
      expect(agent.tools).toEqual([
        { kind: 'builtin', id: 'web_fetch' },
        { kind: 'builtin', id: 'web_search' },
      ]);
    });

    it('enables only the listed tools when default_config is disabled', () => {
      const { project } = imported([
        agentFile(
          'a',
          `name: a\n${MODEL}\ntools:\n  - type: agent_toolset_20260401\n    default_config:\n      enabled: false\n    configs:\n      - name: edit\n        enabled: true\n      - name: web_search\n        enabled: true`,
        ),
      ]);
      const agent = agentNamed(project, 'a');
      expect(agent.permissions).toMatchObject({
        readFiles: false,
        writeFiles: true,
        runCommands: false,
      });
      expect(agent.tools).toEqual([{ kind: 'builtin', id: 'web_search' }]);
    });

    it('drops a custom tool as needing a public MCP endpoint', () => {
      const { report } = imported([
        agentFile(
          'a',
          `name: a\n${MODEL}\ntools:\n  - type: custom\n    name: get_weather\n    description: Weather\n    input_schema:\n      type: object`,
        ),
      ]);
      expect(verdictOf(report, 'a.tools.0')).toMatchObject({
        verdict: 'dropped',
        code: 'code_tool_needs_public_mcp',
      });
    });

    it('drops a skill id, a self reference, a model option and metadata', () => {
      const { project, report } = imported([
        agentFile(
          'a',
          `name: a\nmodel:\n  id: claude-sonnet-4-6\n  effort: high\nskills:\n  - skill_abc\n  - type: anthropic\n    skill_id: pptx\nmetadata:\n  owner: me\nmultiagent:\n  type: multiagent_20261001\n  subagents:\n    type: enabled\n    predefined_agents:\n      - type: self`,
        ),
      ]);
      expect(agentNamed(project, 'a').model).toEqual({
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
      });
      expect(verdictOf(report, 'a.model.effort').code).toBe('field_unsupported');
      expect(verdictOf(report, 'a.skills.0').code).toBe('skills_unsupported');
      expect(verdictOf(report, 'a.skills.1').code).toBe('skills_unsupported');
      expect(verdictOf(report, 'a.metadata').code).toBe('field_unsupported');
      expect(verdictOf(report, 'a.multiagent.subagents.predefined_agents.0').code).toBe(
        'subagents_unsupported',
      );
    });

    it('accepts predefined agents as strings and as agent references to files', () => {
      const { project } = imported([
        agentFile(
          'lead',
          `name: lead\n${MODEL}\nmultiagent:\n  type: multiagent_20261001\n  subagents:\n    type: enabled\n    predefined_agents:\n      - ./one.md\n      - type: agent\n        id: ./two.md`,
        ),
        agentFile('one', `name: one\n${MODEL}`),
        agentFile('two', `name: two\n${MODEL}`),
      ]);
      expect(agentNamed(project, 'lead').subagents).toEqual([{ name: 'one' }, { name: 'two' }]);
    });

    it('uses the system key when the body is empty and keeps a kebab name from the file name', () => {
      const { project, report } = imported([
        agentFile('a', `name: other-name\n${MODEL}\nsystem: Be brief.`),
      ]);
      expect(agentNamed(project, 'a').instructions).toBe('Be brief.');
      expect(agentNamed(project, 'a').description).toBeUndefined();
      expect(verdictOf(report, 'a.name').code).toBe('field_unsupported');
    });

    it('reports memory stores and deployments once each and ignores other files', () => {
      const { report } = imported([
        agentFile('a', `name: a\n${MODEL}`),
        { path: 'memory_stores/one.yaml', content: 'name: one\n' },
        { path: 'memory_stores/two.yaml', content: 'name: two\n' },
        { path: 'deployments/nightly.yaml', content: 'cron: x\n' },
        { path: 'claude-lock.json', content: '{}' },
        { path: 'README.md', content: '# readme\n' },
        { path: 'vaults/a.yaml', content: 'display_name: a\n' },
        { path: 'aw-vault-credentials.json', content: '{}' },
      ]);
      expect(verdictOf(report, 'import.memory_stores').code).toBe('knowledge_unsupported');
      expect(verdictOf(report, 'import.deployments').code).toBe('limits_unsupported');
      expect(report.filter((entry) => entry.path.startsWith('import.'))).toHaveLength(2);
    });

    it('picks the first agent by path as the root when several could be, and says so', () => {
      const { project, report } = imported([
        agentFile('zeta', `name: zeta\n${MODEL}`),
        agentFile('alpha', `name: alpha\n${MODEL}`),
      ]);
      expect(project.root).toBe('alpha');
      expect(verdictOf(report, 'import.root').verdict).toBe('mapped');
    });

    it('keeps only the root orchestrator when two agents have multiagent', () => {
      const multiagent = (target: string): string =>
        `multiagent:\n  type: coordinator\n  agents:\n    - ./${target}.md`;
      const { project, report } = imported([
        agentFile('a', `name: a\n${MODEL}\n${multiagent('b')}`),
        agentFile('b', `name: b\n${MODEL}\n${multiagent('a')}`),
      ]);
      expect(project.root).toBe('a');
      expect(agentNamed(project, 'a').subagents).toEqual([{ name: 'b' }]);
      expect(agentNamed(project, 'b').subagents).toEqual([]);
      expect(verdictOf(report, 'b.multiagent').code).toBe('subagents_unsupported');
    });

    it('does not count an agent with disabled subagents as an orchestrator', () => {
      const { project, report } = imported([
        agentFile('a', `name: a\n${MODEL}`),
        agentFile(
          'b',
          `name: b\n${MODEL}\nmultiagent:\n  type: multiagent_20261001\n  subagents:\n    type: disabled`,
        ),
      ]);
      expect(project.root).toBe('a');
      expect(verdictOf(report, 'import.root').verdict).toBe('mapped');
    });

    it('drops a repeated subagent reference instead of refusing the layout', () => {
      const { project, report } = imported([
        agentFile(
          'a',
          `name: a\n${MODEL}\nmultiagent:\n  type: coordinator\n  agents:\n    - ./b.md\n    - type: agent\n      id: ./b.md`,
        ),
        agentFile('b', `name: b\n${MODEL}`),
      ]);
      expect(agentNamed(project, 'a').subagents).toEqual([{ name: 'b' }]);
      expect(verdictOf(report, 'a.multiagent.agents.1').code).toBe('subagents_unsupported');
    });

    it('uses the system key when the body has only blank or whitespace lines', () => {
      for (const body of ['\n\n\n', '  \n', '\t\n\n']) {
        const { project } = imported([
          agentFile('a', `name: a\n${MODEL}\nsystem: Be brief.`, body),
        ]);
        expect(agentNamed(project, 'a').instructions).toBe('Be brief.');
      }
    });
  });

  describe('purity', () => {
    it('gives equal results for equal input and leaves the input untouched', () => {
      const files = compileFiles(sample);
      const snapshot = structuredClone(files);
      expect(importClaudeManagedAgents(files)).toEqual(importClaudeManagedAgents(files));
      expect(files).toEqual(snapshot);
    });
  });
});
