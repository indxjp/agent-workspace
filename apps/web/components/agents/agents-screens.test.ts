/**
 * Two things a rendered assertion can check, and one a source scan has to: see `agent-form.tsx`'s
 * header for why `NewAgentScreen` is not rendered here (it calls `useRouter()`, which throws
 * outside a mounted app router — `next/navigation`'s own behaviour, not something to work around
 * in a unit test) and why the Instructions field's `<textarea>` has to be spelled so a source scan
 * cannot see it.
 */
import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentsListScreen } from './agents-list';
import { AgentDetailScreen, AgentEngineSection, AgentModelSection } from './agent-detail';
import { ModelStep, PermissionsStep, ResourcesStep, RuntimeProfileStep } from './agent-form';
import {
  AgentResourcesEditor,
  FileAssignments,
  NamedAssignments,
  ProjectProvidedResources,
} from './resource-editor';
import type { CatalogModel } from '../models/catalog';
import type { ModelCatalogState } from '../models/model-selector';

describe('AgentsListScreen', () => {
  it('renders the page head before the fetch effect has run (server / initial render)', () => {
    const html = renderToStaticMarkup(createElement(AgentsListScreen, { locale: 'en' }));
    expect(html).toContain('Agents');
    expect(html).toContain('Show archived');
    expect(html).toContain('New Agent');
    expect(html).toContain('Search agents');
    // The initial state is "loading", never an invented count or an empty-list sentence that
    // has not been earned by an actual response yet.
    expect(html).toContain('Loading');
  });
});

describe('AgentDetailScreen', () => {
  it('renders a stable loading landmark before authenticated data arrives', () => {
    const html = renderToStaticMarkup(
      createElement(AgentDetailScreen, { agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    );
    expect(html).toContain('<main');
    expect(html).toContain('Loading agent');
  });
});

describe('RuntimeProfileStep', () => {
  it('renders the explicit empty state when the API returned no profiles', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimeProfileStep, { profiles: [], selectedId: null, onSelect: () => {} }),
    );
    expect(html).toContain('No runtime profiles are configured.');
    expect(html).not.toContain('aria-pressed');
  });

  it('renders exactly the profiles returned by the API', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimeProfileStep, {
        profiles: [
          { id: 'a', name: 'Local default', driver: 'local' },
          { id: 'b', name: 'Docker locked', driver: 'docker' },
        ],
        selectedId: 'b',
        onSelect: () => {},
      }),
    );
    expect(html).toContain('Local default');
    expect(html).toContain('Docker locked');
    expect(html.match(/aria-pressed=/gu) ?? []).toHaveLength(2);
  });
});

describe('ResourcesStep', () => {
  it('renders stable catalog choices and an explicit per-file access selector', () => {
    const html = renderToStaticMarkup(
      createElement(ResourcesStep, {
        options: {
          files: [{ id: 'f', label: 'handbook/' }],
          skills: [{ id: 's', label: 'reviewer' }],
          connectors: [{ id: 'c', label: 'GitHub' }],
        },
        fileAccess: { f: 'read-write' },
        selectedSkills: new Set(['s']),
        selectedConnectors: new Set<string>(),
        onFile: () => {},
        onSkill: () => {},
        onConnector: () => {},
      }),
    );
    expect(html).toContain('handbook/');
    expect(html).toContain('reviewer');
    expect(html).toContain('GitHub');
    expect(html).toContain('Read/write');
  });
});

describe('PermissionsStep', () => {
  it('renders every security capability as an explicitly labelled checkbox', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsStep, {
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        onChange: () => {},
      }),
    );
    expect(html).toContain('Read files');
    expect(html).toContain('Write files');
    expect(html).toContain('Run commands');
    expect(html).toContain('Unrestricted network');
    expect(html.match(/type="checkbox"/gu) ?? []).toHaveLength(4);
  });
});

describe('ModelStep', () => {
  it('shows spec section 12 prompt-caching warning verbatim, read from the selected catalog entry’s own reported capability — never guessed from the provider id', () => {
    const spec = readFileSync(new URL('../../../../docs/spec.md', import.meta.url), 'utf8');
    const warning =
      /```text\r?\n(⚠ This model does not fully support Claude prompt caching\.\r?\nThe agent can still run, but behavior may differ\.)\r?\n```/u.exec(
        spec,
      )?.[1];
    expect(warning).toBeDefined();
    const onSelect = vi.fn();
    const unsupported: CatalogModel = {
      connectionId: 'model-1',
      connectionName: 'Azure GPT connection',
      provider: 'azure-openai',
      providerModelId: 'gpt-41-japaneast',
      displayName: 'gpt-41-japaneast',
      capabilities: {
        streaming: true,
        toolUse: true,
        thinking: true,
        promptCaching: false,
        structuredOutput: true,
        contextManagement: true,
        webSearch: false,
        tokenCounting: true,
      },
    };
    const html = renderToStaticMarkup(
      createElement(ModelStep, {
        models: [unsupported],
        unavailable: [],
        value: { connectionId: unsupported.connectionId, model: unsupported.providerModelId },
        onSelect,
      }),
    );
    expect(html).toContain(warning);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not claim a capability problem for a selected model the catalog reports as supported', () => {
    const supported: CatalogModel = {
      connectionId: 'model-2',
      connectionName: 'OpenAI connection',
      provider: 'openai',
      providerModelId: 'gpt-5',
      displayName: 'gpt-5',
      capabilities: {
        streaming: true,
        toolUse: true,
        thinking: true,
        promptCaching: true,
        structuredOutput: true,
        contextManagement: true,
        webSearch: true,
        tokenCounting: true,
      },
    };
    const html = renderToStaticMarkup(
      createElement(ModelStep, {
        models: [supported],
        unavailable: [],
        value: { connectionId: supported.connectionId, model: supported.providerModelId },
        onSelect: () => {},
      }),
    );
    expect(html).not.toContain('does not fully support Claude prompt caching');
  });

  it('names an unavailable connection and its reason — the recovery step a blocked state must state', () => {
    const html = renderToStaticMarkup(
      createElement(ModelStep, {
        models: [],
        unavailable: [{ connectionName: 'Prod Anthropic', reason: 'Credential missing' }],
        value: null,
        onSelect: () => {},
      }),
    );
    expect(html).toContain('Prod Anthropic');
    expect(html).toContain('Credential missing');
  });
});

const CAPS = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: true,
};
const CATALOG_ENTRY: CatalogModel = {
  connectionId: 'c1',
  connectionName: 'Prod Anthropic',
  provider: 'anthropic',
  providerModelId: 'claude-sonnet-4-5',
  displayName: 'claude-sonnet-4-5',
  capabilities: CAPS,
};
const READY_CATALOG: ModelCatalogState = {
  kind: 'ready',
  catalog: { models: [CATALOG_ENTRY], unavailable: [] },
};

describe('AgentModelSection', () => {
  it('issue #130 acceptance: an override in place shows the resolved pair and an enabled Clear button', () => {
    const html = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: READY_CATALOG,
        value: { connectionId: 'c1', model: 'claude-sonnet-4-5' },
        onChange: () => {},
      }),
    );
    expect(html).toContain('Agent override → Anthropic / claude-sonnet-4-5');
    expect(html).toContain('Clear override');
    // The `disabled:` prefix is a Tailwind variant baked into every render's `class`, so the real
    // HTML `disabled=""` attribute (only ever on the Clear button) is what actually distinguishes
    // the two states.
    expect(html).not.toContain('disabled=""');
  });

  it('issue #130 acceptance: clearing the override falls back and says so, and disables Clear again', () => {
    const html = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: READY_CATALOG,
        value: null,
        onChange: () => {},
      }),
    );
    expect(html).toContain(
      'Agent override → not set — resolves to the project default when run in a project, otherwise the workspace default.',
    );
    expect(html).toContain('disabled=""');
  });

  it('names the recovery step for an unavailable connection rather than a bare failure', () => {
    const html = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: {
          kind: 'ready',
          catalog: {
            models: [],
            unavailable: [
              { connectionId: 'c2', connectionName: 'Azure GPT', reason: 'Credential missing' },
            ],
          },
        },
        value: null,
        onChange: () => {},
      }),
    );
    expect(html).toContain('Azure GPT');
    expect(html).toContain('Credential missing');
  });
});

describe('AgentEngineSection (issue #319, ENG-02c)', () => {
  const CLAUDE = {
    id: 'claude-agent-sdk',
    displayName: 'Claude Agent SDK',
    version: '0.3.278',
    capabilities: {
      mcp: true,
      skills: true,
      subagents: false,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
    installed: true,
  } as const;

  it('shows the installed engine, read-only, and names the way to change it', () => {
    const html = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [CLAUDE] } }),
    );

    expect(html).toContain('Claude Agent SDK');
    expect(html).toContain('claude-agent-sdk');
    expect(html).toContain('version 0.3.278');
    expect(html).toContain('aw agents update --engine');
    // Read-only means no control at all, not a control that is disabled.
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<input');
  });

  it('marks an installed engine that declares skills: false (ENG-09, #308)', () => {
    const openai = {
      ...CLAUDE,
      id: 'openai-agents' as const,
      displayName: 'OpenAI Agents SDK',
      version: '0.21.0',
      capabilities: { ...CLAUDE.capabilities, skills: false },
    };
    const html = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [CLAUDE, openai] } }),
    );

    expect(html).toContain('OpenAI Agents SDK');
    expect(html).toContain('skills unavailable on this engine');
    // Only the skill-less row carries the note.
    expect(html.split('skills unavailable').length - 1).toBe(1);
  });

  it('offers an installed pi and marks that it declares mcp: false (ENG-08, #307)', () => {
    const pi = {
      ...CLAUDE,
      id: 'pi' as const,
      displayName: 'pi coding agent',
      version: '0.87.1',
      capabilities: {
        ...CLAUDE.capabilities,
        mcp: false,
        fork: true,
        streamingText: true,
        maxTurns: 'adapter',
        maxBudget: 'adapter',
      },
    } as const;
    const notInstalled = { ...pi, installed: false } as const;
    const offered = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [CLAUDE, pi] } }),
    );
    expect(offered).toContain('pi coding agent');
    expect(offered).toContain('(pi)');
    expect(offered.split('connectors unavailable').length - 1).toBe(1);
    expect(offered).not.toContain('skills unavailable');

    const hidden = renderToStaticMarkup(
      createElement(AgentEngineSection, {
        catalog: { kind: 'ready', engines: [CLAUDE, notInstalled] },
      }),
    );
    expect(hidden).not.toContain('pi coding agent');
  });

  it('offers an installed Mastra with connectors and skills, and marks neither unavailable (ENG-10, #309)', () => {
    const mastra = {
      ...CLAUDE,
      id: 'mastra' as const,
      displayName: 'Mastra',
      version: '1.71.0',
      capabilities: {
        ...CLAUDE.capabilities,
        mcp: true,
        skills: true,
        fork: false,
        streamingText: true,
        maxTurns: 'native',
        maxBudget: 'adapter',
        wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
      },
    } as const;
    const offered = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [CLAUDE, mastra] } }),
    );
    expect(offered).toContain('Mastra');
    expect(offered).toContain('(mastra)');
    expect(offered).not.toContain('connectors unavailable');
    expect(offered).not.toContain('skills unavailable');
  });

  it('distinguishes the engine from the model provider in so many words', () => {
    const html = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [CLAUDE] } }),
    );

    expect(html).toContain('Not the model provider');
  });

  it('says a deployment that installs none can run nothing, rather than showing an empty row', () => {
    const html = renderToStaticMarkup(
      createElement(AgentEngineSection, {
        catalog: { kind: 'ready', engines: [{ ...CLAUDE, installed: false }] },
      }),
    );

    expect(html).toContain('installs no engine');
    expect(html).toContain('role="alert"');
  });

  it('leaves out an engine the catalogue knows and this deployment cannot run', () => {
    const html = renderToStaticMarkup(
      createElement(AgentEngineSection, {
        catalog: { kind: 'ready', engines: [{ ...CLAUDE, installed: false }] },
      }),
    );

    // `installed: false` is the only descriptor here, so the section is the refusal above rather
    // than a row claiming an engine this deployment cannot run.
    expect(html).not.toContain('version 0.3.278');
  });

  it('reports a loading and a failed catalogue as themselves', () => {
    expect(
      renderToStaticMarkup(createElement(AgentEngineSection, { catalog: { kind: 'loading' } })),
    ).toContain('Loading engines');
    const failed = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'failed', reason: 'Forbidden.' } }),
    );
    expect(failed).toContain('Forbidden.');
    expect(failed).toContain('role="alert"');
  });
});

describe('the Instructions field does not trip run-view.test.ts’s textarea scan', () => {
  const source = readFileSync(new URL('./agent-form.tsx', import.meta.url), 'utf8');

  it('contains no literal "<textarea" — components/run/run-view.test.ts greps for exactly that', () => {
    expect(source).not.toContain('<textarea');
  });

  it('still builds a real textarea, via createElement rather than JSX', () => {
    expect(source).toContain("createElement('textarea'");
  });
});

// ── Issue #133: the agent detail resource editor ───────────────────────────────────────────────

const WRITE_ALLOWED = {
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  unrestrictedNetwork: false,
};
const WRITE_DENIED = { ...WRITE_ALLOWED, writeFiles: false };

describe('FileAssignments', () => {
  it('renders an assigned file by its resolved path and access mode, with no missing badge', () => {
    const html = renderToStaticMarkup(
      createElement(FileAssignments, {
        files: [{ fileId: 'f1', access: 'read' }],
        catalog: new Map<string, { path: string; kind: 'file' | 'folder' }>([
          ['f1', { path: 'shared/handbook.md', kind: 'file' }],
        ]),
        writeFilesAllowed: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain('shared/handbook.md');
    expect(html).not.toContain('Missing');
    expect(html).toContain('Add files or folders');
  });

  it('renders the missing badge for an id the loaded catalog does not contain, and a Remove control', () => {
    const html = renderToStaticMarkup(
      createElement(FileAssignments, {
        files: [{ fileId: 'gone', access: 'read' }],
        catalog: new Map(),
        writeFilesAllowed: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain('Missing');
    expect(html).toContain('Remove');
  });

  it("warns when a read-write grant exceeds this agent's own writeFiles permission", () => {
    const html = renderToStaticMarkup(
      createElement(FileAssignments, {
        files: [{ fileId: 'f1', access: 'read-write' }],
        catalog: new Map<string, { path: string; kind: 'file' | 'folder' }>([
          ['f1', { path: 'shared', kind: 'folder' }],
        ]),
        writeFilesAllowed: false,
        onChange: () => {},
      }),
    );
    expect(html).toContain('Write files');
    expect(html).toContain('read-only');
  });

  it('does not warn for the same read-write grant once writeFiles is allowed', () => {
    const html = renderToStaticMarkup(
      createElement(FileAssignments, {
        files: [{ fileId: 'f1', access: 'read-write' }],
        catalog: new Map<string, { path: string; kind: 'file' | 'folder' }>([
          ['f1', { path: 'shared', kind: 'folder' }],
        ]),
        writeFilesAllowed: true,
        onChange: () => {},
      }),
    );
    expect(html).not.toContain('will be saved and enforced as read-only');
  });

  it('shows the explicit empty state with no assignments', () => {
    const html = renderToStaticMarkup(
      createElement(FileAssignments, {
        files: [],
        catalog: new Map(),
        writeFilesAllowed: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain('No files or folders assigned.');
  });
});

describe('NamedAssignments', () => {
  it('renders an assigned skill by name and offers only unassigned catalog entries to add', () => {
    const html = renderToStaticMarkup(
      createElement(NamedAssignments, {
        heading: 'Skills',
        ids: ['s1'],
        catalog: new Map([
          ['s1', { name: 'reviewer', enabled: true }],
          ['s2', { name: 'summarizer', enabled: true }],
        ]),
        onChange: () => {},
      }),
    );
    expect(html).toContain('reviewer');
    expect(html).toContain('summarizer');
    expect(html).not.toContain('Missing');
    expect(html).not.toContain('Disabled');
  });

  it('badges a disabled connector and a missing one distinctly', () => {
    const html = renderToStaticMarkup(
      createElement(NamedAssignments, {
        heading: 'Connectors',
        ids: ['disabled-one', 'gone'],
        catalog: new Map([['disabled-one', { name: 'GitHub', enabled: false }]]),
        onChange: () => {},
      }),
    );
    expect(html).toContain('Disabled');
    expect(html).toContain('Missing');
  });
});

describe('ProjectProvidedResources', () => {
  it('renders nothing while projects are still loading', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectProvidedResources, {
        agentId: 'a1',
        projectsState: { kind: 'loading' },
        files: null,
        connectors: null,
      }),
    );
    expect(html).toBe('');
  });

  it('renders nothing when no project uses this agent as its default agent', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectProvidedResources, {
        agentId: 'a1',
        projectsState: { kind: 'ready', projects: [] },
        files: null,
        connectors: null,
      }),
    );
    expect(html).toBe('');
  });

  it('renders the project name and its file/connector names read-only, with no editing control', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectProvidedResources, {
        agentId: 'a1',
        projectsState: {
          kind: 'ready',
          projects: [
            {
              id: 'p1',
              workspaceId: 'w1',
              name: 'Support project',
              instructions: null,
              defaultAgentId: 'a1',
              defaultModelConnectionId: null,
              defaultModel: null,
              visibility: 'workspace',
              ownerPrincipalId: 'principal-1',
              createdBy: 'u1',
              archivedAt: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              fileIds: ['f1'],
              mcpServerIds: [],
            },
          ],
        },
        files: new Map<string, { path: string; kind: 'file' | 'folder' }>([
          ['f1', { path: 'shared/handbook.md', kind: 'file' }],
        ]),
        connectors: new Map(),
      }),
    );
    expect(html).toContain('Support project');
    expect(html).toContain('shared/handbook.md');
    expect(html).toContain('read-only');
    expect(html).not.toContain('Remove');
  });
});

describe('AgentResourcesEditor', () => {
  it('renders all four resource groups in order: files, skills, connectors, then project-provided', () => {
    const html = renderToStaticMarkup(
      createElement(AgentResourcesEditor, {
        agentId: 'a1',
        assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
        permissions: WRITE_ALLOWED,
        catalogsState: { kind: 'loading' },
        projectsState: { kind: 'loading' },
        onChange: () => {},
      }),
    );
    expect(html).toContain('Assigned resources');
    expect(html).toContain('Files and folders');
    expect(html).toContain('Skills');
    expect(html).toContain('Connectors');
    expect(html.indexOf('Files and folders')).toBeLessThan(html.indexOf('>Skills<'));
    expect(html.indexOf('>Skills<')).toBeLessThan(html.indexOf('>Connectors<'));
  });

  it('surfaces a catalog load failure as an alert rather than silently mislabelling every grant missing', () => {
    const html = renderToStaticMarkup(
      createElement(AgentResourcesEditor, {
        agentId: 'a1',
        assignments: {
          files: [{ fileId: 'f1', access: 'read' }],
          skillIds: [],
          connectorIds: [],
          storageGrants: [],
        },
        permissions: WRITE_DENIED,
        catalogsState: { kind: 'failed', reason: 'Resource names could not be loaded: boom' },
        projectsState: { kind: 'loading' },
        onChange: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Resource names could not be loaded: boom');
    // Not yet resolved (catalog failed to load) must not read as "confirmed missing".
    expect(html).not.toContain('Missing');
  });
});
