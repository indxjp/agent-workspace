import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PlatformFile } from '@indx-workspace/contracts/platforms';
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
import { m365DeclarativeAgentTarget } from './index.js';
import { importM365DeclarativeAgent } from './import.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const target = m365DeclarativeAgentTarget;

function fixture(path: string): string {
  return readFileSync(join(fixtures, path), 'utf8');
}

function file(path: string, content: string | object): PlatformFile {
  return { path, content: typeof content === 'string' ? content : JSON.stringify(content) };
}

function imported(files: readonly PlatformFile[]) {
  const result = importM365DeclarativeAgent(files);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.message} ${result.refusal.details.join()}`);
  return result;
}

function refusal(files: readonly PlatformFile[]) {
  const result = importM365DeclarativeAgent(files);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

const AGENT = {
  version: 'v1.8',
  name: 'Order helper',
  description: 'Helps with orders.',
  instructions: 'Answer order questions.',
};

function agentFiles(agent: object = AGENT, extra: PlatformFile[] = []): PlatformFile[] {
  return [file('appPackage/declarativeAgent.json', agent), ...extra];
}

function plugin(runtime: object): object {
  return { schema_version: 'v2.4', name_for_human: 'P', namespace: 'p', runtimes: [runtime] };
}

describe('m365-declarative-agent importer', () => {
  describe('Microsoft documents', () => {
    it('reads the Learn declarative agent v1.8 example with its plugin', () => {
      const { project, report } = imported([
        file('appPackage/declarativeAgent.json', fixture('learn-declarative-agent-v1.8.json')),
        file(
          'appPackage/repairs-hub-api-plugin.json',
          fixture('learn-plugin-v2.4-mcp-dynamic.json'),
        ),
        file('appPackage/file1.docx', 'embedded'),
      ]);
      const agent = project.agents[0];
      expect(project.root).toBe('teams-toolkit-declarative-agent');
      expect(agent?.instructions).toContain('repairs expert agent');
      expect(agent?.tools).toEqual([
        { kind: 'builtin', id: 'code_execution' },
        {
          kind: 'mcp',
          name: 'repairsPlugin',
          transport: 'streamable-http',
          url: 'https://api.contoso.com/mcp',
        },
      ]);
      expect(agent?.knowledge).toEqual([
        { kind: 'url', url: 'https://contoso.com/projects/mark-8' },
        { kind: 'files', paths: ['appPackage/file1.docx'] },
      ]);
      const verdictAt = (pointer: string) =>
        report.find((verdict) => verdict.path === `appPackage/declarativeAgent.json#/${pointer}`);
      const capabilities = (
        JSON.parse(fixture('learn-declarative-agent-v1.8.json')) as {
          capabilities: { name: string }[];
        }
      ).capabilities;
      const expectedCodes: Record<string, string> = {
        OneDriveAndSharePoint: 'knowledge_unsupported',
        GraphConnectors: 'knowledge_unsupported',
        Dataverse: 'knowledge_unsupported',
        TeamsMessages: 'knowledge_unsupported',
        Email: 'knowledge_unsupported',
        People: 'knowledge_unsupported',
        Meetings: 'knowledge_unsupported',
        GraphicArt: 'builtin_unsupported',
        ScenarioModels: 'builtin_unsupported',
        EmailActions: 'builtin_unsupported',
        MeetingActions: 'builtin_unsupported',
      };
      expect(Object.keys(expectedCodes).length).toBe(11);
      capabilities.forEach(({ name }, index) => {
        const code = expectedCodes[name];
        if (code !== undefined) {
          expect(verdictAt(`capabilities/${index}`), name).toMatchObject({
            verdict: 'dropped',
            code,
          });
        }
      });
      const embedded = capabilities.findIndex(({ name }) => name === 'EmbeddedKnowledge');
      expect(verdictAt(`capabilities/${embedded}/files/0`)?.verdict).toBe('mapped');
      expect(verdictAt(`capabilities/${embedded}/files/1`)).toMatchObject({
        verdict: 'dropped',
        code: 'knowledge_unsupported',
      });
      expect(verdictAt('capabilities/0/sites/0')?.verdict).toBe('mapped');
      expect(verdictAt('name')?.verdict).toBe('mapped');
      expect(agent?.description).toBe(
        'Teams Toolkit declarative agent: Declarative agent created with Teams Toolkit',
      );
      expect(report.find((verdict) => verdict.path.endsWith('.model'))).toMatchObject({
        verdict: 'mapped',
        note: 'set model before running on an engine',
      });
      expect(agent?.extensions?.platforms?.['m365-declarative-agent']).toMatchObject({
        disclaimer:
          'This declarative agent is a fictional example. You should not take it seriously.',
        defaultResponseMode: 'Auto',
        discourageModelKnowledge: true,
      });
      const droppedPaths = report
        .filter((verdict) => verdict.verdict === 'dropped')
        .map((verdict) => verdict.path);
      expect(droppedPaths).toContain('appPackage/declarativeAgent.json#/worker_agents');
      expect(droppedPaths).toContain('appPackage/declarativeAgent.json#/capabilities/1');
      expect(report.find((verdict) => verdict.path.endsWith('#/worker_agents'))).toMatchObject({
        code: 'subagents_unsupported',
      });
    });

    it('reads the atk new project, resolving the instruction file', () => {
      const files = [
        file(
          'appPackage/manifest.json',
          fixture('atk-new-declarative-agent/appPackage/manifest.json'),
        ),
        file(
          'appPackage/declarativeAgent.json',
          fixture('atk-new-declarative-agent/appPackage/declarativeAgent.json'),
        ),
        file(
          'appPackage/instruction.txt',
          fixture('atk-new-declarative-agent/appPackage/instruction.txt'),
        ),
        file('m365agents.yml', fixture('atk-new-declarative-agent/m365agents.yml')),
      ];
      const { project } = imported(files);
      expect(project.root).toBe('my-agent');
      expect(project.agents[0]?.instructions).toContain('helpful assistant');
      expect(project.agents[0]?.extensions?.platforms?.['m365-declarative-agent']).toMatchObject({
        accentColor: '#FFFFFF',
        appVersion: '1.0.0',
      });
    });

    it('keeps the instruction file reference when the file is missing', () => {
      const { project, report } = imported([
        file(
          'appPackage/declarativeAgent.json',
          fixture('atk-new-declarative-agent/appPackage/declarativeAgent.json'),
        ),
      ]);
      expect(project.agents[0]?.instructions).toBe("$[file('instruction.txt')]");
      expect(report.find((verdict) => verdict.path.endsWith('#/instructions'))).toMatchObject({
        verdict: 'mapped',
        note: 'the instruction file is not in the package; the reference is kept',
      });
    });
  });

  describe('round trip', () => {
    it.each([
      ['full', SAMPLE_PORTABLE_PROJECT],
      ['no-tool-endpoint', SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT],
    ])('compile, import and compile again agree for %s', (_name, sample) => {
      const first = compileForPlatform(target, PortableProjectSchema.parse(sample), {});
      if (!first.ok) throw new Error('compile refused');
      const back = imported(first.files);
      const second = compileForPlatform(target, back.project, {});
      if (!second.ok) throw new Error('second compile refused');
      expect(back.project.root).toBe(sample.root);
      const agent = (project: PortableProject) =>
        project.agents.find((a) => a.name === project.root);
      expect(back.project.agents[0]?.instructions).toBe(
        agent(PortableProjectSchema.parse(sample))?.instructions,
      );
      for (const path of ['appPackage/declarativeAgent.json', 'appPackage/manifest.json']) {
        expect(second.files.find((f) => f.path === path)).toEqual(
          first.files.find((f) => f.path === path),
        );
      }
      // The auth config is a tenant object and is not carried, so only auth and the descriptions
      // derived from it may differ in the plugins.
      const withoutAuth = (content: PlatformFile['content'] | undefined) => {
        const plugin = JSON.parse(String(content)) as {
          description_for_human?: string;
          description_for_model?: string;
          runtimes: { auth?: unknown }[];
        };
        delete plugin.description_for_human;
        delete plugin.description_for_model;
        delete plugin.runtimes[0]?.auth;
        return plugin;
      };
      const surviving = first.files.filter((f) =>
        /^appPackage\/(ai-plugin\..+\.json|openapi\/.+)$/u.test(f.path),
      );
      expect(surviving.length).toBeGreaterThan(0);
      for (const before of surviving) {
        const after = second.files.find((f) => f.path === before.path);
        expect(after, before.path).toBeDefined();
        if (before.path.startsWith('appPackage/openapi/')) {
          expect(after?.content).toEqual(before.content);
        } else {
          expect(withoutAuth(after?.content)).toEqual(withoutAuth(before.content));
        }
      }
    });

    it('bundles the OpenAPI document an OpenApi plugin points at', () => {
      const spec = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'O', version: '1' },
        paths: {},
      });
      const { project } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'orders', file: 'ai-plugin.orders.json' }] }, [
          file(
            'appPackage/ai-plugin.orders.json',
            plugin({
              type: 'OpenApi',
              auth: { type: 'None' },
              spec: { url: 'openapi/orders.json' },
            }),
          ),
          file('appPackage/openapi/orders.json', spec),
        ]),
      );
      expect(project.agents[0]?.tools).toEqual([
        { kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json' },
      ]);
      expect(project.openapiSpecs).toEqual([{ ref: 'openapi/orders.json', content: spec }]);
    });

    it('keeps an https OpenAPI url as the spec reference', () => {
      const { project } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'orders', file: 'p.json' }] }, [
          file(
            'appPackage/p.json',
            plugin({ type: 'OpenApi', spec: { url: 'https://api.example.com/o.json' } }),
          ),
        ]),
      );
      expect(project.agents[0]?.tools[0]).toMatchObject({
        specRef: 'https://api.example.com/o.json',
      });
      expect(project.openapiSpecs).toEqual([]);
    });
  });

  describe('refusals and drops', () => {
    it('refuses an empty package', () => {
      expect(refusal([]).code).toBe('platform_agent_not_found');
    });

    it('refuses malformed JSON without echoing its content', () => {
      const refused = refusal([file('appPackage/declarativeAgent.json', '{"secret-token": nope')]);
      expect(refused.code).toBe('platform_agent_not_found');
      expect(JSON.stringify(refused)).not.toContain('secret-token');
    });

    it('refuses an agent of the wrong shape, naming the field and not the value', () => {
      const refused = refusal(agentFiles({ ...AGENT, instructions: 42, name: 'leaky-value' }));
      expect(refused.details.join()).toContain('instructions');
      expect(JSON.stringify(refused)).not.toContain('leaky-value');
    });

    it('follows the agent file the app manifest names', () => {
      const { project } = imported([
        file('appPackage/manifest.json', {
          copilotAgents: { declarativeAgents: [{ id: 'a', file: 'agents/main.json' }] },
        }),
        file('appPackage/agents/main.json', { ...AGENT, name: 'Elsewhere' }),
      ]);
      expect(project.root).toBe('elsewhere');
    });

    it('reads a package whose files are at the root', () => {
      const { project } = imported([
        file('manifest.json', { version: '2.0.0' }),
        file('declarativeAgent.json', {
          ...AGENT,
          actions: [{ id: 'x', file: 'ai-plugin.x.json' }],
        }),
        file(
          'ai-plugin.x.json',
          plugin({ type: 'RemoteMCPServer', spec: { url: 'https://a.example.com/mcp' } }),
        ),
      ]);
      expect(project.root).toBe('order-helper');
      expect(project.agents[0]?.tools).toHaveLength(1);
      expect(project.agents[0]?.extensions?.platforms?.['m365-declarative-agent']).toMatchObject({
        appVersion: '2.0.0',
      });
    });

    it('resolves references against the directory of the document that holds them', () => {
      const spec = JSON.stringify({ openapi: '3.1.0', info: { title: 'O', version: '1' } });
      const { project } = imported([
        file('appPackage/manifest.json', {
          copilotAgents: { declarativeAgents: [{ id: 'a', file: 'agents/da.json' }] },
        }),
        file('appPackage/agents/da.json', {
          ...AGENT,
          instructions: "$[file('instruction.txt')]",
          actions: [{ id: 'x', file: 'ai-plugin.x.json' }],
        }),
        file('appPackage/agents/instruction.txt', 'From the subdirectory.'),
        file(
          'appPackage/agents/ai-plugin.x.json',
          plugin({ type: 'OpenApi', spec: { url: 'openapi/x.json' } }),
        ),
        file('appPackage/agents/openapi/x.json', spec),
      ]);
      expect(project.agents[0]?.instructions).toBe('From the subdirectory.');
      expect(project.agents[0]?.tools).toEqual([
        { kind: 'openapi', name: 'x', specRef: 'openapi/x.json' },
      ]);
      expect(project.openapiSpecs).toEqual([{ ref: 'openapi/x.json', content: spec }]);
    });

    it('drops a LocalPlugin action as an unsupported builtin', () => {
      const { report } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'x', file: 'p.json' }] }, [
          file('appPackage/p.json', plugin({ type: 'LocalPlugin' })),
        ]),
      );
      expect(report.find((verdict) => verdict.path.endsWith('#/actions/0'))).toMatchObject({
        verdict: 'dropped',
        code: 'builtin_unsupported',
      });
    });

    it('reports an invalid option at the source field', () => {
      const { report } = imported([
        file('appPackage/manifest.json', { accentColor: 'blue' }),
        ...agentFiles(),
      ]);
      expect(report.find((verdict) => verdict.verdict === 'dropped')?.path).toBe(
        'appPackage/manifest.json#/accentColor',
      );
    });

    it('refuses an app manifest path that leaves the package', () => {
      const refused = refusal([
        file('appPackage/manifest.json', {
          copilotAgents: { declarativeAgents: [{ id: 'a', file: '../declarativeAgent.json' }] },
        }),
        ...agentFiles(),
      ]);
      expect(refused.code).toBe('platform_agent_not_found');
    });

    it('drops an action whose file path leaves the package', () => {
      const { project, report } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'x', file: '../outside.json' }] }),
      );
      expect(project.agents[0]?.tools).toEqual([]);
      expect(report.find((verdict) => verdict.path.endsWith('#/actions/0'))).toMatchObject({
        verdict: 'dropped',
        code: 'field_unsupported',
      });
    });

    it('drops an MCP plugin whose url is a placeholder', () => {
      const { project, report } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'x', file: 'p.json' }] }, [
          file(
            'appPackage/p.json',
            plugin({ type: 'RemoteMCPServer', spec: { url: '${{MCP_URL}}' } }),
          ),
        ]),
      );
      expect(project.agents[0]?.tools).toEqual([]);
      expect(report.some((verdict) => verdict.verdict === 'dropped')).toBe(true);
    });

    it('keeps the first of two actions with the same id', () => {
      const mcp = file(
        'appPackage/p.json',
        plugin({ type: 'RemoteMCPServer', spec: { url: 'https://a.example.com/mcp' } }),
      );
      const { project, report } = imported(
        agentFiles(
          {
            ...AGENT,
            actions: [
              { id: 'dup', file: 'p.json' },
              { id: 'DUP', file: 'p.json' },
            ],
          },
          [mcp],
        ),
      );
      expect(project.agents[0]?.tools).toHaveLength(1);
      expect(report.filter((verdict) => verdict.verdict === 'dropped')).toHaveLength(1);
    });

    it('reports an authenticated plugin as mapped, without carrying the auth', () => {
      const { report } = imported(
        agentFiles({ ...AGENT, actions: [{ id: 'x', file: 'p.json' }] }, [
          file(
            'appPackage/p.json',
            plugin({
              type: 'RemoteMCPServer',
              auth: { type: 'OAuthPluginVault', reference_id: 'tenant-secret-ref' },
              spec: { url: 'https://a.example.com/mcp' },
            }),
          ),
        ]),
      );
      expect(report.find((verdict) => verdict.path.endsWith('#/actions/0'))?.verdict).toBe(
        'mapped',
      );
      expect(JSON.stringify(report)).not.toContain('tenant-secret-ref');
    });

    it('reads bytes as UTF-8 and refuses invalid bytes', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
      const refused = refusal([{ path: 'appPackage/declarativeAgent.json', content: bytes }]);
      expect(refused.code).toBe('platform_agent_not_found');
    });
  });
});
