import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import {
  expectGoldenFiles,
  runPlatformConformance,
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import {
  compile,
  compiled,
  json,
  projectWith,
  sampleProject,
  target,
  text,
} from '../../testing/m365-declarative-agent-compile.test-support.js';
import {
  AppManifestSchema,
  DeclarativeAgentManifestV18Schema,
  PluginManifestV24Schema,
} from './vendor-schema.js';

const goldenRoot = join(dirname(fileURLToPath(import.meta.url)), '__golden__');

const ENV_VARIABLES = [
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

describe('m365-declarative-agent target', () => {
  it('passes the platform conformance suite', () => {
    runPlatformConformance(target);
  });

  it.each([
    ['full', SAMPLE_PORTABLE_PROJECT, [...ENV_VARIABLES, 'MCP_AW_TOOLS_AUTH_REFERENCE_ID=']],
    ['no-tool-endpoint', SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT, ENV_VARIABLES],
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
});

describe('emitted files', () => {
  const { files } = compiled(sampleProject());

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
