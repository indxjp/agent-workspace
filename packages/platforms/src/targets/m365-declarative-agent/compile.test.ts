import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import {
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import { m365DeclarativeAgentTarget } from './index.js';
import {
  AppManifestSchema,
  DeclarativeAgentManifestV18Schema,
  PluginManifestV24Schema,
} from './vendor-schema.js';

const ORDERS_SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders/{id}': { get: { operationId: 'getOrder' } },
    '/refunds': { post: { operationId: 'createRefund' } },
  },
});

const goldenRoot = join(dirname(fileURLToPath(import.meta.url)), '__golden__');
const target = m365DeclarativeAgentTarget;

type AgentInput = PortableProjectInput['agents'][number];

/** The sample with the root agent changed. */
function projectWith(patch: Partial<AgentInput>): PortableProject {
  return PortableProjectSchema.parse({
    ...SAMPLE_PORTABLE_PROJECT,
    agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) =>
      index === 0 ? { ...agent, ...patch } : agent,
    ),
  });
}

function compile(project: PortableProject, options: unknown = {}) {
  return compileForPlatform(target, project, options);
}

function compiled(project: PortableProject, options: unknown = {}) {
  const result = compile(project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(target, project, result);
  return result;
}

function text(files: readonly PlatformFile[], path: string): string {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== 'string') throw new Error(`${path} is not an emitted text file`);
  return content;
}

function json(files: readonly PlatformFile[], path: string): Record<string, unknown> {
  return JSON.parse(text(files, path)) as Record<string, unknown>;
}

describe('m365-declarative-agent target', () => {
  it('passes the platform conformance suite', () => {
    runPlatformConformance(target);
  });

  const envVariables = [
    'TEAMSFX_ENV=dev',
    'APP_NAME_SUFFIX=dev',
    'AGENT_SCOPE=shared',
    'TEAMS_APP_ID=',
    'M365_TITLE_ID=',
    'M365_APP_ID=',
    'SHARE_LINK=',
    'DEVELOPER_NAME=',
    'DEVELOPER_WEBSITE_URL=',
    'DEVELOPER_PRIVACY_URL=',
    'DEVELOPER_TERMS_OF_USE_URL=',
    'MCP_ZENDESK_AUTH_REFERENCE_ID=',
  ];

  it.each([
    ['full', SAMPLE_PORTABLE_PROJECT, [...envVariables, 'MCP_AW_TOOLS_AUTH_REFERENCE_ID=']],
    ['no-tool-endpoint', SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT, envVariables],
  ])('matches the %s golden', (name, sample, env) => {
    const dir = join(goldenRoot, name);
    // Not `project.json`, which kit's loadGoldenProject reads: Nx takes that name for a project root.
    const project = PortableProjectSchema.parse(
      JSON.parse(readFileSync(join(dir, 'portable-project.json'), 'utf8')),
    );
    expect(project).toEqual(PortableProjectSchema.parse(sample));
    const result = compiled(project);
    // The repository forbids tracking any `.env*` file, so env/.env.dev is pinned here, not in the golden.
    expect(text(result.files, 'env/.env.dev')).toBe(`${env.join('\n')}\n`);
    expectGoldenFiles(
      { ...result, files: result.files.filter((file) => file.path !== 'env/.env.dev') },
      dir,
    );
  });

  describe('emitted files', () => {
    const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const { files } = compiled(project);

    it('validates every JSON document against its strict vendor schema', () => {
      AppManifestSchema.parse(json(files, 'appPackage/manifest.json'));
      DeclarativeAgentManifestV18Schema.parse(json(files, 'appPackage/declarativeAgent.json'));
      const plugins = files.filter((file) => /^appPackage\/ai-plugin\..+\.json$/u.test(file.path));
      expect(plugins.map((file) => file.path)).toEqual([
        'appPackage/ai-plugin.aw-tools.json',
        'appPackage/ai-plugin.zendesk.json',
      ]);
      for (const plugin of plugins) PluginManifestV24Schema.parse(json(files, plugin.path));
    });

    it('names a secret in no file and lists only empty variables in env/.env.dev', () => {
      for (const file of files) {
        if (typeof file.content !== 'string') continue;
        expect(file.content).not.toContain('ZENDESK_TOKEN');
        expect(file.content).not.toContain('ACME_TOOL_ENDPOINT_TOKEN');
      }
      const lines = text(files, 'env/.env.dev').trimEnd().split('\n');
      expect(lines.slice(0, 3)).toEqual([
        'TEAMSFX_ENV=dev',
        'APP_NAME_SUFFIX=dev',
        'AGENT_SCOPE=shared',
      ]);
      for (const line of lines.slice(3)) expect(line).toMatch(/^[A-Z0-9_]+=$/u);
      expect(lines).toContain('MCP_ZENDESK_AUTH_REFERENCE_ID=');
      expect(lines).toContain('MCP_AW_TOOLS_AUTH_REFERENCE_ID=');
    });

    it('emits the placeholder icons at the sizes Microsoft requires', () => {
      const size = (path: string): [number, number] => {
        const bytes = files.find((file) => file.path === path)?.content;
        if (!(bytes instanceof Uint8Array)) throw new Error(`${path} is not bytes`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return [view.getUint32(16), view.getUint32(20)];
      };
      expect(size('appPackage/color.png')).toEqual([192, 192]);
      expect(size('appPackage/outline.png')).toEqual([32, 32]);
    });
  });

  describe('refusals', () => {
    const limit = (project: PortableProject) => {
      const result = compile(project);
      expect(result.ok).toBe(false);
      return result.ok ? undefined : result.refusal;
    };

    it.each([
      [8_001, false],
      [8_000, true],
    ])('takes instructions of %i characters: %s', (length, accepted) => {
      const result = compile(projectWith({ instructions: 'x'.repeat(length) }));
      expect(result.ok).toBe(accepted);
      if (!result.ok) {
        expect(result.refusal.code).toBe('platform_limit_exceeded');
        expect(result.refusal.details).toEqual([
          'field: instructions',
          'limit: 8000',
          `actual: ${length}`,
        ]);
      }
    });

    it('refuses whitespace-only instructions', () => {
      expect(limit(projectWith({ instructions: '  \n ' }))?.details[0]).toBe('field: instructions');
    });

    it('refuses a description over 1000 characters', () => {
      expect(limit(projectWith({ description: 'd'.repeat(1_001) }))?.details).toEqual([
        'field: description',
        'limit: 1000',
        'actual: 1001',
      ]);
    });

    it.each([
      [10, true],
      [11, false],
    ])('takes %i MCP tools: %s', (count, accepted) => {
      const tools = Array.from({ length: count }, (_, index) => ({
        kind: 'mcp' as const,
        name: `server-${index}`,
        transport: 'streamable-http' as const,
        url: `https://mcp.example.com/${index}`,
      }));
      const result = compile(projectWith({ tools }));
      expect(result.ok).toBe(accepted);
      if (!result.ok) expect(result.refusal.details[0]).toBe('field: tools');
    });

    it('refuses an unknown root agent', () => {
      const result = compile({
        ...PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
        root: 'ghost',
      });
      expect(result.ok ? undefined : result.refusal.code).toBe('platform_agent_not_found');
    });

    it('refuses an invalid option without echoing its value', () => {
      const result = compile(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT), {
        accentColor: 'blue',
      });
      expect(result.ok ? undefined : result.refusal.code).toBe('platform_options_invalid');
      expect(JSON.stringify(result)).not.toContain('blue');
    });
  });

  describe('mappings', () => {
    const verdict = (report: readonly FieldVerdict[], path: string) =>
      report.find((entry) => entry.path === path);

    it('keeps a bearer-authenticated MCP server as an OAuth plugin vault placeholder', () => {
      const { files, report } = compiled(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT));
      const plugin = PluginManifestV24Schema.parse(
        json(files, 'appPackage/ai-plugin.zendesk.json'),
      );
      expect(plugin.runtimes[0]).toMatchObject({
        type: 'RemoteMCPServer',
        auth: { type: 'OAuthPluginVault', reference_id: '${{MCP_ZENDESK_AUTH_REFERENCE_ID}}' },
        run_for_functions: ['*'],
      });
      expect(verdict(report, 'support-triage.tools.0')).toMatchObject({ verdict: 'mapped' });
      expect(verdict(report, 'support-triage.tools.1')).toMatchObject({
        verdict: 'dropped',
        code: 'stdio_mcp_unsupported',
      });
    });

    it('serves code tools through one aw-tools plugin, or drops them without an endpoint', () => {
      const withEndpoint = compiled(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT));
      expect(verdict(withEndpoint.report, 'support-triage.tools.2')).toMatchObject({
        verdict: 'mapped',
      });
      const without = compiled(
        PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT),
      );
      expect(verdict(without.report, 'support-triage.tools.2')).toMatchObject({
        verdict: 'dropped',
        code: 'code_tool_needs_public_mcp',
      });
      expect(without.files.some((file) => file.path.includes('aw-tools'))).toBe(false);
    });

    it('covers a knowledge url with the unrestricted web search the agent already has', () => {
      const { files, report } = compiled(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT));
      expect(verdict(report, 'support-triage.knowledge.1')).toMatchObject({ verdict: 'mapped' });
      expect(json(files, 'appPackage/declarativeAgent.json')['capabilities']).toEqual([
        { name: 'WebSearch' },
        { name: 'CodeInterpreter' },
      ]);
    });

    it('turns knowledge urls into WebSearch sites when no web_search tool exists', () => {
      const tools = SAMPLE_PORTABLE_PROJECT.agents[0]?.tools?.filter(
        (tool) => tool.kind !== 'builtin',
      );
      const { files, report } = compiled(
        projectWith({
          tools,
          knowledge: [
            { kind: 'url', url: 'https://help.example.com' },
            { kind: 'url', url: 'https://docs.example.com/a/b/c' },
            { kind: 'url', url: 'https://example.com/search?q=1' },
          ],
        }),
      );
      expect(json(files, 'appPackage/declarativeAgent.json')['capabilities']).toEqual([
        { name: 'WebSearch', sites: [{ url: 'https://help.example.com' }] },
      ]);
      expect(verdict(report, 'support-triage.knowledge.0')).toMatchObject({ verdict: 'mapped' });
      expect(verdict(report, 'support-triage.knowledge.1')).toMatchObject({
        code: 'knowledge_unsupported',
      });
      expect(verdict(report, 'support-triage.knowledge.2')).toMatchObject({
        code: 'knowledge_unsupported',
      });
    });

    it('notes that an sse server must also serve Streamable HTTP', () => {
      const { report } = compiled(
        projectWith({
          tools: [
            { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
          ],
        }),
      );
      const entry = verdict(report, 'support-triage.tools.0');
      expect(entry).toMatchObject({ verdict: 'mapped' });
      expect(entry?.note).toContain('Streamable HTTP');
    });

    it('reports every permission native when none is granted', () => {
      const { report } = compiled(
        projectWith({
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        }),
      );
      for (const key of ['readFiles', 'writeFiles', 'runCommands', 'unrestrictedNetwork']) {
        expect(verdict(report, `support-triage.permissions.${key}`)).toMatchObject({
          verdict: 'native',
        });
      }
    });

    it('writes the developer literally and carries the Microsoft 365-only options', () => {
      const { files } = compiled(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT), {
        appVersion: '2.1.0',
        developer: {
          name: 'Acme',
          websiteUrl: 'https://acme.example.com',
          privacyUrl: 'https://acme.example.com/privacy',
          termsOfUseUrl: 'https://acme.example.com/terms',
        },
        conversationStarters: [{ title: 'Order', text: 'Where is my order?' }],
        disclaimer: 'Answers may be wrong.',
        defaultResponseMode: 'Quick response',
        discourageModelKnowledge: true,
      });
      expect(json(files, 'appPackage/manifest.json')).toMatchObject({
        version: '2.1.0',
        developer: { name: 'Acme', websiteUrl: 'https://acme.example.com' },
      });
      expect(json(files, 'appPackage/declarativeAgent.json')).toMatchObject({
        conversation_starters: [{ title: 'Order', text: 'Where is my order?' }],
        disclaimer: { text: 'Answers may be wrong.' },
        behavior_overrides: {
          default_response_mode: 'Quick response',
          special_instructions: { discourage_model_knowledge: true },
        },
      });
      expect(text(files, 'env/.env.dev')).not.toContain('DEVELOPER_NAME');
    });

    it('cuts the short name and short description to the app manifest limits', () => {
      const name = `${'a'.repeat(40)}`;
      const description = `${'word '.repeat(30)}end`;
      const { files, report } = compiled(
        PortableProjectSchema.parse({
          ...SAMPLE_PORTABLE_PROJECT,
          root: name,
          agents: [{ ...SAMPLE_PORTABLE_PROJECT.agents[0], name, description, subagents: [] }],
        }),
      );
      const app = AppManifestSchema.parse(json(files, 'appPackage/manifest.json'));
      expect(app.name).toEqual({ short: 'a'.repeat(30), full: name });
      expect(app.description.short.length).toBeLessThanOrEqual(80);
      expect(app.description.short.endsWith('…')).toBe(true);
      expect(app.description.full).toBe(description);
      expect(verdict(report, `${name}.description`)).toMatchObject({ verdict: 'mapped' });
    });

    describe('OpenAPI allow rules', () => {
      const ordersTool = {
        kind: 'openapi',
        name: 'orders-api',
        specRef: 'openapi/orders.json',
      } as const;
      const withAllow = (allow: readonly string[], specs = SAMPLE_PORTABLE_PROJECT.openapiSpecs) =>
        PortableProjectSchema.parse({
          ...projectWith({ tools: [{ ...ordersTool, allow }] }),
          openapiSpecs: specs,
        });
      const ordersSpec = { ref: 'openapi/orders.json', content: ORDERS_SPEC };

      it('bundles a spec narrowed to the allowed operations and points the plugin at it', () => {
        const { files, report } = compiled(withAllow(['GET /orders/*'], [ordersSpec]));
        const spec = json(files, 'appPackage/openapi/orders-api.json');
        expect(Object.keys(spec['paths'] as object)).toEqual(['/orders/{id}']);
        expect(text(files, 'appPackage/openapi/orders-api.json')).not.toContain('/refunds');
        const plugin = PluginManifestV24Schema.parse(
          json(files, 'appPackage/ai-plugin.orders-api.json'),
        );
        expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'openapi/orders-api.json' });
        expect(verdict(report, 'support-triage.tools.0')).toMatchObject({ verdict: 'mapped' });
      });

      it('bundles the whole document untouched, keeping its extension, when there is no allow', () => {
        const yaml = 'openapi: 3.1.0\ninfo: {title: Orders, version: "1"}\npaths: {}\n';
        const { files } = compiled(
          PortableProjectSchema.parse({
            ...projectWith({
              tools: [{ kind: 'openapi', name: 'orders-api', specRef: 'specs/orders.yaml' }],
            }),
            openapiSpecs: [{ ref: 'specs/orders.yaml', content: yaml }],
          }),
        );
        expect(text(files, 'appPackage/openapi/orders-api.yaml')).toBe(yaml);
        const plugin = PluginManifestV24Schema.parse(
          json(files, 'appPackage/ai-plugin.orders-api.json'),
        );
        expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'openapi/orders-api.yaml' });
      });

      it('keeps an https spec as the plugin url and bundles nothing', () => {
        const { files } = compiled(
          projectWith({
            tools: [
              { kind: 'openapi', name: 'orders-api', specRef: 'https://api.example.com/spec.json' },
            ],
          }),
        );
        const plugin = PluginManifestV24Schema.parse(
          json(files, 'appPackage/ai-plugin.orders-api.json'),
        );
        expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'https://api.example.com/spec.json' });
        expect(files.some((file) => file.path.startsWith('appPackage/openapi/'))).toBe(false);
      });

      it('drops a relative spec that the project does not bundle', () => {
        const { files, report } = compiled(
          PortableProjectSchema.parse({
            ...projectWith({
              tools: [{ kind: 'openapi', name: 'orders-api', specRef: 'openapi/orders.json' }],
            }),
            openapiSpecs: [],
          }),
        );
        expect(verdict(report, 'support-triage.tools.0')).toMatchObject({
          verdict: 'dropped',
          code: 'field_unsupported',
        });
        expect(files.some((file) => file.path.includes('orders-api'))).toBe(false);
      });

      it.each([
        ['the spec is not bundled', ['GET /orders/*'], []],
        ['allow admits no operation', ['GET /nothing'], [ordersSpec]],
      ])('drops the tool when %s', (_name, allow, specs) => {
        const { files, report } = compiled(withAllow(allow, specs));
        expect(verdict(report, 'support-triage.tools.0')).toMatchObject({
          verdict: 'dropped',
          code: 'permissions_unsupported',
        });
        expect(files.some((file) => file.path.includes('orders-api'))).toBe(false);
      });
    });

    describe('tool name collisions', () => {
      const mcp = (name: string) =>
        ({
          kind: 'mcp',
          name,
          transport: 'streamable-http',
          url: `https://mcp.example.com/${name}`,
          auth: { scheme: 'bearer', secretRef: 'TOKEN' },
        }) as const;

      it('renames tools whose file name, namespace or auth variable would collide', () => {
        const { files, report } = compiled(
          projectWith({ tools: [mcp('my-tool'), mcp('my_tool'), mcp('My-Tool'), mcp('mytool')] }),
        );
        expect(verdict(report, 'support-triage.tools.0')?.note).not.toContain('emitted as');
        expect(verdict(report, 'support-triage.tools.1')).toMatchObject({ verdict: 'mapped' });
        expect(verdict(report, 'support-triage.tools.1')?.note).toMatch(/^emitted as my_tool-2: /u);
        const plugins = files
          .filter((file) => /^appPackage\/ai-plugin\..+\.json$/u.test(file.path))
          .map((file) => ({
            path: file.path,
            plugin: PluginManifestV24Schema.parse(json(files, file.path)),
          }));
        expect(plugins.map(({ path }) => path)).toEqual([
          'appPackage/ai-plugin.My-Tool-3.json',
          'appPackage/ai-plugin.my-tool.json',
          'appPackage/ai-plugin.my_tool-2.json',
          'appPackage/ai-plugin.mytool-4.json',
        ]);
        const unique = (values: readonly string[]) => new Set(values.map((v) => v.toLowerCase()));
        expect(unique(plugins.map(({ plugin }) => plugin.namespace)).size).toBe(4);
        expect(unique(plugins.map(({ path }) => path)).size).toBe(4);
        const actions = DeclarativeAgentManifestV18Schema.parse(
          json(files, 'appPackage/declarativeAgent.json'),
        ).actions;
        expect(actions?.map((action) => action.id)).toEqual([
          'my-tool',
          'my_tool-2',
          'My-Tool-3',
          'mytool-4',
        ]);
        const variables = text(files, 'env/.env.dev')
          .split('\n')
          .filter((line) => line.startsWith('MCP_'));
        expect(variables).toEqual([
          'MCP_MY_TOOL_AUTH_REFERENCE_ID=',
          'MCP_MY_TOOL_2_AUTH_REFERENCE_ID=',
          'MCP_MY_TOOL_3_AUTH_REFERENCE_ID=',
          'MCP_MYTOOL_4_AUTH_REFERENCE_ID=',
        ]);
      });

      it('moves the code-tools plugin aside when a tool already uses its name', () => {
        const { files, report } = compiled(
          projectWith({
            tools: [
              mcp('aw-tools'),
              {
                kind: 'code',
                name: 'get_order',
                description: 'Look up an order',
                inputSchema: { type: 'object' },
              },
            ],
          }),
        );
        expect(files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            'appPackage/ai-plugin.aw-tools.json',
            'appPackage/ai-plugin.aw-tools-2.json',
          ]),
        );
        expect(text(files, 'env/.env.dev')).toContain('MCP_AW_TOOLS_2_AUTH_REFERENCE_ID=');
        expect(verdict(report, 'toolEndpoint')?.note).toContain('ai-plugin.aw-tools-2.json');
      });
    });

    it('takes 12 conversation starters and refuses 13', () => {
      const starters = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ text: `Question ${index}` }));
      const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
      expect(compile(project, { conversationStarters: starters(12) }).ok).toBe(true);
      expect(compile(project, { conversationStarters: starters(13) }).ok).toBe(false);
    });
  });
});
