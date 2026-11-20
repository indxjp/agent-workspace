import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import {
  compiled,
  json,
  projectWith,
  compile,
  text,
  verdict,
} from '../../testing/m365-declarative-agent-compile.test-support.js';
import { AppManifestSchema, PluginManifestV24Schema } from './vendor-schema.js';

describe('tool mappings', () => {
  it('keeps a bearer-authenticated MCP server as an OAuth plugin vault placeholder', () => {
    const { files, report } = compiled(PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT));
    const plugin = PluginManifestV24Schema.parse(json(files, 'appPackage/ai-plugin.zendesk.json'));
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
});

describe('knowledge mappings', () => {
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
});

describe('MCP transport and permission mappings', () => {
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
});

describe('Microsoft 365 options', () => {
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
});

describe('app manifest limits', () => {
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
});

describe('conversation starters', () => {
  it('takes 12 conversation starters and refuses 13', () => {
    const starters = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ text: `Question ${index}` }));
    const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    expect(compile(project, { conversationStarters: starters(12) }).ok).toBe(true);
    expect(compile(project, { conversationStarters: starters(13) }).ok).toBe(false);
  });
});
