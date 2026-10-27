import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PlatformFile } from '@indx-workspace/contracts/platforms';
import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import type { PlatformImportResult } from '../../port.js';
import { SAMPLE_PORTABLE_PROJECT } from '../../testing/sample.js';
import { importCopilotStudio } from './import.js';
import { copilotStudioTarget } from './index.js';

const GOLDEN = join(fileURLToPath(new URL('.', import.meta.url)), '__golden__');
const TOPIC = 'kind: AdaptiveDialog\nbeginDialog:\n  kind: OnRecognizedIntent\n';

function listFiles(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}

/** The compile golden's `agent/` tree plus one topic: what a clone of that agent looks like. */
function clonedWorkspace(prefix: string): PlatformFile[] {
  const root = join(GOLDEN, 'full', 'expected', 'agent');
  return [
    ...listFiles(root).map((path) => ({
      path: `${prefix}${path}`,
      content: readFileSync(join(root, path), 'utf8'),
    })),
    { path: `${prefix}topics/greeting.mcs.yml`, content: TOPIC },
  ];
}

function imported(files: readonly PlatformFile[]) {
  const result = importCopilotStudio(files);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  return result;
}

function refusal(files: readonly PlatformFile[]) {
  const result: PlatformImportResult = importCopilotStudio(files);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

const AGENT = {
  path: 'agent.mcs.yml',
  content: 'kind: GptComponentMetadata\ndisplayName: Support Triage\n',
};

describe('copilot-studio import golden', () => {
  const goldenPath = join(GOLDEN, 'import/expected.agent-project.json');

  it.each(['agent/', ''])('imports a cloned workspace under %j to the golden project', (prefix) => {
    const { project } = imported(clonedWorkspace(prefix));
    if (process.env['UPDATE_GOLDEN'] === '1' && prefix === 'agent/') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, `${JSON.stringify(project, null, 2)}\n`);
    }
    expect(JSON.parse(JSON.stringify(project))).toEqual(
      JSON.parse(readFileSync(goldenPath, 'utf8')),
    );
  });

  it('reports the MCP actions dropped, and counts what it ignored once', () => {
    const { report } = imported(clonedWorkspace('agent/'));
    const mcp = report.filter((entry) => entry.path.startsWith('agent/actions/'));
    expect(mcp.map((entry) => entry.path)).toEqual([
      'agent/actions/aw-tools.mcs.yml',
      'agent/actions/zendesk.mcs.yml',
    ]);
    for (const entry of mcp) {
      expect(entry).toMatchObject({ verdict: 'dropped', code: 'field_unsupported' });
      expect(entry.note).toContain('add tools[kind=mcp] by hand');
    }
    expect(report.filter((entry) => entry.path === 'unrecognized-files')).toEqual([]);
    const withExtras = imported([
      ...clonedWorkspace('agent/'),
      { path: 'connectors/zendesk/apiProperties.json', content: '{}' },
      { path: 'README.md', content: '# hi' },
    ]).report;
    const counted = withExtras.filter((entry) => entry.path === 'unrecognized-files');
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ verdict: 'dropped' });
    expect(counted[0]?.note).toContain('2 files');
  });
});

describe('copilot-studio round trip', () => {
  it('imports what compile emitted, and the imported options compile again', () => {
    const options = { publisherPrefix: 'acme', topics: { greeting: TOPIC } };
    const compiled = compileForPlatform(
      copilotStudioTarget,
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
      options,
    );
    if (!compiled.ok) throw new Error('compile refused');
    const { project } = imported(compiled.files);

    const [root, child] = project.agents;
    const original = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT).agents;
    expect(project.root).toBe('support-triage');
    expect(root).toMatchObject({
      name: original[0]?.name,
      description: original[0]?.description,
      instructions: original[0]?.instructions,
      subagents: [{ name: 'billing-specialist' }],
      knowledge: [
        { kind: 'files', paths: ['knowledge/faq.md'] },
        { kind: 'url', url: 'https://help.example.com' },
      ],
      tools: [
        { kind: 'builtin', id: 'web_search' },
        { kind: 'builtin', id: 'code_execution' },
      ],
    });
    expect(child).toMatchObject({
      name: 'billing-specialist',
      description: original[1]?.description,
      instructions: original[1]?.instructions,
    });
    expect(project.knowledgeFiles).toEqual(
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT).knowledgeFiles,
    );
    expect(root?.extensions?.platforms?.['copilot-studio']).toEqual({
      publisherPrefix: 'acme',
      schemaName: 'acme_supportTriage',
      topics: { greeting: TOPIC },
    });

    const again = compileForPlatform(
      copilotStudioTarget,
      project,
      root?.extensions?.platforms?.['copilot-studio'],
    );
    expect(again.ok).toBe(true);
  });
});

describe('copilot-studio import details', () => {
  it('carries the model name hint, a root description and a binary knowledge file', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const { project } = imported([
      {
        path: 'agent.mcs.yml',
        content:
          'mcs.metadata:\n  description: Hello.\nkind: GptComponentMetadata\ndisplayName: Support Triage\ninstructions: Be kind.\naISettings:\n  model:\n    modelNameHint: my-model\n',
      },
      { path: 'knowledge/files/logo.bin', content: bytes },
    ]);
    const root = project.agents[0];
    expect(root).toMatchObject({ description: 'Hello.', instructions: 'Be kind.' });
    expect(root?.extensions?.platforms?.['copilot-studio']).toEqual({ modelNameHint: 'my-model' });
    expect(project.knowledgeFiles).toEqual([{ path: 'knowledge/logo.bin', content: bytes }]);
  });

  it('drops a child that is not an AgentDialog, a non-https site, and a workflow', () => {
    const { project, report } = imported([
      AGENT,
      { path: 'agents/other/agent.mcs.yml', content: 'kind: TaskDialog\n' },
      {
        path: 'knowledge/plain.knowledge.mcs.yml',
        content:
          'kind: KnowledgeSourceConfiguration\nsource:\n  kind: PublicSiteSearchSource\n  site: http://plain.example.com\n',
      },
      { path: 'workflows/flow.mcs.yml', content: 'anything: true\n' },
      {
        path: 'actions/other.mcs.yml',
        content: 'kind: TaskDialog\naction:\n  kind: InvokeFlowTaskAction\n',
      },
    ]);
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]?.knowledge).toEqual([]);
    expect(
      report.filter((entry) => entry.verdict === 'dropped').map((entry) => entry.path),
    ).toEqual([
      'actions/other.mcs.yml',
      'agents/other/agent.mcs.yml',
      'knowledge/plain.knowledge.mcs.yml',
      'workflows/flow.mcs.yml',
    ]);
    expect(report.find((entry) => entry.path === 'actions/other.mcs.yml')?.note).toContain(
      'Power Platform component',
    );
  });

  it('drops options that do not fit the schema instead of importing them', () => {
    const { project, report } = imported([
      AGENT,
      { path: 'settings.mcs.yml', content: 'schemaName: TooLongPrefixValue_agent\n' },
      { path: 'topics/greeting.mcs.yml', content: TOPIC },
    ]);
    expect(project.agents[0]?.extensions).toEqual({
      platforms: { 'copilot-studio': { topics: { greeting: TOPIC } } },
    });
    expect(report.find((entry) => entry.path === 'settings.mcs.yml')?.verdict).toBe('dropped');
    expect(report.find((entry) => entry.path === 'topics/greeting.mcs.yml')?.verdict).toBe(
      'mapped',
    );
  });

  it('drops a model name hint that does not fit and keeps the other options', () => {
    const { project, report } = imported([
      {
        path: 'agent.mcs.yml',
        content: `${AGENT.content}aISettings:\n  model:\n    modelNameHint: ${'x'.repeat(101)}\n`,
      },
      { path: 'settings.mcs.yml', content: 'schemaName: cr6f1_agent\n' },
    ]);
    expect(project.agents[0]?.extensions).toEqual({
      platforms: { 'copilot-studio': { schemaName: 'cr6f1_agent', publisherPrefix: 'cr6f1' } },
    });
    expect(
      report.some((entry) => entry.verdict === 'dropped' && entry.path === 'agent.mcs.yml'),
    ).toBe(true);
  });

  it('counts a single ignored file in the singular', () => {
    const { report } = imported([AGENT, { path: 'README.md', content: 'x' }]);
    expect(report.find((entry) => entry.path === 'unrecognized-files')?.note).toBe(
      '1 file is not part of a portable agent; ignored',
    );
  });

  it('keeps a topic whose stem does not fit as a dropped file', () => {
    const { project, report } = imported([
      AGENT,
      { path: 'topics/Not_Valid.mcs.yml', content: TOPIC },
    ]);
    expect(project.agents[0]?.extensions).toBeUndefined();
    expect(report.find((entry) => entry.path === 'topics/Not_Valid.mcs.yml')?.verdict).toBe(
      'dropped',
    );
  });
});

describe('copilot-studio import refusals', () => {
  it('refuses a workspace with no agent.mcs.yml', () => {
    expect(refusal([{ path: 'settings.mcs.yml', content: 'a: 1\n' }]).code).toBe(
      'platform_agent_not_found',
    );
    expect(refusal([]).code).toBe('platform_agent_not_found');
  });

  it('refuses invalid YAML naming the path and never echoing the text', () => {
    const result = refusal([{ path: 'agent.mcs.yml', content: 'displayName: [secret-text' }]);
    expect(result.code).toBe('platform_options_invalid');
    expect(result.details).toEqual(['agent.mcs.yml: is not valid YAML']);
    expect(JSON.stringify(result)).not.toContain('secret-text');
  });

  it('refuses a display name or child folder that leaves no name', () => {
    expect(refusal([{ path: 'agent.mcs.yml', content: 'displayName: "!!!"\n' }]).details).toEqual([
      'agent.mcs.yml: displayName',
    ]);
    const child = refusal([
      AGENT,
      { path: 'agents/!!!/agent.mcs.yml', content: 'kind: AgentDialog\n' },
    ]);
    expect(child.details).toEqual(['agents/!!!/agent.mcs.yml: folder name']);
  });

  it('refuses a document that does not have the keys it must have', () => {
    const result = refusal([{ path: 'agent.mcs.yml', content: 'instructions: 12\n' }]);
    expect(result.details).toEqual(['agent.mcs.yml: displayName', 'agent.mcs.yml: instructions']);
  });

  it('refuses files that are not a list of files, and a child that repeats the root name', () => {
    expect(refusal('nope' as unknown as PlatformFile[]).code).toBe('platform_options_invalid');
    expect(
      refusal([
        AGENT,
        { path: 'agents/support-triage/agent.mcs.yml', content: 'kind: AgentDialog\n' },
      ]).code,
    ).toBe('platform_options_invalid');
  });
});

describe('copilot-studio multi-line description (#1598)', () => {
  it('round-trips a description the YAML writer would fold', () => {
    const description = ['', '---', ' ', '\r', '---\\' + ' '.repeat(8) + '\\' + ' '.repeat(9)].join(
      '\n',
    );
    const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const input = PortableProjectSchema.parse({
      ...sample,
      agents: sample.agents.map((agent) => ({ ...agent, description })),
    });
    const compiled = compileForPlatform(copilotStudioTarget, input, { publisherPrefix: 'acme' });
    if (!compiled.ok) throw new Error('compile refused');
    expect(imported(compiled.files).project.agents.map((agent) => agent.description)).toEqual(
      input.agents.map(() => description),
    );
  });
});
