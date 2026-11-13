// @vitest-environment happy-dom
import type { StorageConnectionResource } from '@indx-workspace/sdk';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentResource, AgentResourceAssignments } from '../../contracts/agents';
import type { EngineDescriptor } from '../../contracts/engines';
import type { RequestOutcome } from '../../lib/request-outcome';
import { ConnectedStorage, StorageGrantList } from '../storage/connected-storage';
import { connectedStorageWords } from '../storage/connected-storage-messages';
import { agentDetailStrings } from './agent-detail-messages';
import type { RequestProblem } from './model';

// UX-15 in #2086: the agent detail screen's Configuration tab in the reader's language.

const AGENT_ID = '0b7f4f0e-6a38-4d6c-9d0e-0c7a1f5a8c11';

const requests = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  loadEngines: vi.fn(),
  saveAgentDefinition: vi.fn(),
  saveAgentAssignments: vi.fn(),
  loadResourceCatalogs: vi.fn(),
  loadAgentProjects: vi.fn(),
  loadCatalog: vi.fn(),
}));
vi.mock('./agent-requests-model', () => ({
  loadAgent: requests.loadAgent,
  loadEngines: requests.loadEngines,
  saveAgentDefinition: requests.saveAgentDefinition,
  saveAgentAssignments: requests.saveAgentAssignments,
  loadResourceCatalogs: requests.loadResourceCatalogs,
  loadAgentProjects: requests.loadAgentProjects,
}));
vi.mock('../models/connections-model', () => ({ loadCatalog: requests.loadCatalog }));
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));

const { AgentDetailScreen, AgentEngineSection, AgentModelSection } = await import('./agent-detail');
const { AgentResourcesEditor, NamedAssignments, ProjectProvidedResources } =
  await import('./resource-editor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a strings object holds, keyed by its path; functions are called with samples. */
function flatten(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') out.set(path, value);
  else if (typeof value === 'function') {
    out.set(path, (value as (...args: unknown[]) => string)('3', '2'));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${path}.${key}`, out);
  }
  return out;
}

function expectEveryWordTranslated(en: object, ja: object): void {
  const english = flatten(en);
  const japanese = flatten(ja);
  expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
  for (const [key, word] of english) {
    expect(japanese.get(key), key).not.toBe('');
    expect(japanese.get(key), key).not.toBe(word);
  }
}

const en = agentDetailStrings('en');
const ja = agentDetailStrings('ja');
const enStorage = connectedStorageWords('en');
const jaStorage = connectedStorageWords('ja');

/** Every English word this tab prints; a Japanese tab shows none as a text node or label. */
const ENGLISH = [...flatten(en).values(), ...flatten(enStorage).values()]
  .map((word) => word.trim())
  .filter((word) => word.length > 1);

/** What a reader sees and hears: text nodes (outside `lang="en"`) and announced names. */
function readable(html: string): string[] {
  const withoutEnglish = html.replace(/<span lang="en">[^<]*<\/span>/gu, '');
  const out: string[] = [];
  for (const match of withoutEnglish.matchAll(/>([^<]+)</gu)) out.push((match[1] ?? '').trim());
  for (const match of withoutEnglish.matchAll(/(?:aria-label|placeholder|title)="([^"]*)"/gu)) {
    out.push(match[1] ?? '');
  }
  return out.filter((text) => text !== '');
}

function expectNoEnglishUi(html: string): void {
  for (const text of readable(html)) {
    for (const word of ENGLISH) expect(text, `"${word}" in "${text}"`).not.toContain(word);
  }
}

const agent: AgentResource = {
  id: AGENT_ID,
  workspaceId: 'w1',
  name: '契約書レビュー',
  instructions: '契約書を読んでください。',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  createdBy: null,
  ownerPrincipalId: 'p1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const assignments: AgentResourceAssignments = {
  files: [
    { fileId: 'f1', access: 'read-write' },
    { fileId: 'gone', access: 'read' },
  ],
  skillIds: ['s1', 'missing-skill'],
  connectorIds: ['c1'],
  storageGrants: [],
};
const engine: EngineDescriptor = {
  id: 'pi',
  displayName: 'Pi',
  version: '1.2.0',
  installed: true,
  capabilities: { skills: false, mcp: false },
} as unknown as EngineDescriptor;
const CONNECTION: StorageConnectionResource = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'acme-data',
  provider: 'file',
  url: 'file:///srv/acme',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const transport = (reason: string): RequestOutcome<never> => ({
  ok: false,
  problem: { kind: 'transport', reason },
});
const apiProblem: RequestProblem = {
  kind: 'api',
  status: 403,
  code: 'forbidden',
  message: 'You may not change this agent.',
};

describe('the agent detail words', () => {
  it('has a Japanese word for every English one, and none left the same', () => {
    expectEveryWordTranslated(en, ja);
    expectEveryWordTranslated(enStorage, jaStorage);
  });

  it('keeps the English this tab always printed, word for word', () => {
    expect(en.subtitle).toBe('Agent configuration and explicit permissions');
    expect(en.overrideNotSet).toBe(
      'Agent override → not set — resolves to the project default when run in a project, otherwise the workspace default.',
    );
    expect(en.permissionLabels.runCommands).toBe(
      'Run commands in the selected runtime, asking before one that changes something',
    );
    expect(en.editor.readOnlyUntilWriteFiles).toBe(
      'This agent’s Write files permission is off, so this read/write grant will be saved and enforced as read-only until Write files is turned on.',
    );
    expect(en.editor.addSelected(2)).toBe('Add 2 selected');
    expect(enStorage.currentFolder('reports/')).toBe('Current folder: reports/');
    expect(enStorage.openFolder('2026')).toBe('Open 2026/');
    expect(enStorage.readWriteGap(enStorage.connectionReadOnly)).toBe(
      'Read/write needs a connection that allows writing and an agent with Write files turned on. This connection is read-only.',
    );
  });
});

describe('the sections in English', () => {
  it('prints the model, engine and resource sections exactly as before', () => {
    const model = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: {
          kind: 'failed',
          reason: 'Models could not be loaded: offline',
          detail: 'offline',
        },
        value: null,
        onChange: () => {},
      }),
    );
    expect(model).toContain('Models could not be loaded: offline');
    expect(model).not.toContain('lang=');
    const engines = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [engine] } }),
    );
    expect(engines).toContain('Pi <span class="text-muted">(pi)</span>, version 1.2.0');
    expect(engines).toContain(' — skills unavailable on this engine');
    expect(engines).toContain(
      'Read-only here: an agent’s engine is the discriminant of its policy. Set it with <code>aw agents update --engine</code>.',
    );
    const skills = renderToStaticMarkup(
      createElement(NamedAssignments, {
        group: 'skills',
        ids: [],
        catalog: new Map(),
        onChange: () => {},
      }),
    );
    expect(skills).toContain('No skills assigned.');
    expect(skills).toContain('id="agent-skills-heading"');
  });
});

describe('the sections in Japanese', () => {
  it('words the model, engine, permissions and resources sections, and keeps server text English', () => {
    const model = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: {
          kind: 'failed',
          reason: 'Models could not be loaded: offline',
          detail: 'offline',
        },
        value: null,
        onChange: () => {},
        locale: 'ja',
      }),
    );
    expect(model).toContain('モデルを読み込めませんでした: <span lang="en">offline</span>');
    expectNoEnglishUi(model);

    const stale = renderToStaticMarkup(
      createElement(AgentModelSection, {
        catalogState: { kind: 'ready', catalog: { models: [], unavailable: [] } },
        value: { connectionId: 'conn-1', model: 'claude-x' },
        onChange: () => {},
        locale: 'ja',
      }),
    );
    expect(stale).toContain('エージェントの上書き → claude-x (接続 conn-1 はもう使えません)');
    expect(stale).toContain('上書きを解除');
    expectNoEnglishUi(stale);

    const engines = renderToStaticMarkup(
      createElement(AgentEngineSection, {
        catalog: { kind: 'ready', engines: [engine] },
        locale: 'ja',
      }),
    );
    expect(engines).toContain('バージョン 1.2.0');
    expect(engines).toContain('このエンジンではスキルを使えません');
    expect(engines).toContain('<code>aw agents update --engine</code>');
    expectNoEnglishUi(engines);

    const refused = renderToStaticMarkup(
      createElement(AgentEngineSection, {
        catalog: { kind: 'failed', reason: 'Forbidden.' },
        locale: 'ja',
      }),
    );
    expect(refused).toContain('エンジンを読み込めませんでした。 <span lang="en">Forbidden.</span>');

    const none = renderToStaticMarkup(
      createElement(AgentEngineSection, { catalog: { kind: 'ready', engines: [] }, locale: 'ja' }),
    );
    expect(none).toContain('エンジンが入っていない');
  });

  it('words the assigned-resources editor, its badges and the project-provided group', () => {
    const editor = renderToStaticMarkup(
      createElement(AgentResourcesEditor, {
        agentId: AGENT_ID,
        assignments,
        permissions: agent.permissions,
        catalogsState: {
          kind: 'ready',
          files: new Map([['f1', { path: '/inputs/a.pdf' }]]),
          skills: new Map([
            ['s1', { name: 'reviewer', enabled: false }],
            ['s2', { name: 'summarizer', enabled: true }],
          ]),
          connectors: new Map([
            ['c1', { name: 'GitHub', enabled: true }],
            ['c2', { name: 'Slack', enabled: true }],
          ]),
        } as never,
        projectsState: {
          kind: 'ready',
          projects: [
            {
              id: 'p1',
              name: '法務',
              defaultAgentId: AGENT_ID,
              fileIds: ['f1'],
              mcpServerIds: ['gone-connector'],
            },
          ],
        } as never,
        onChange: () => {},
        locale: 'ja',
      }),
    );
    expectNoEnglishUi(editor);
    for (const word of [
      '割り当てたリソース',
      '見つかりません',
      '無効',
      'ファイルやフォルダを追加',
      'aria-label="スキルを追加"',
      'aria-label="コネクタを追加"',
      '/inputs/a.pdf のアクセス権',
      '「ファイルの書き込み」を有効にするまでは読み取り専用',
    ]) {
      expect(editor).toContain(word);
    }

    const failed = renderToStaticMarkup(
      createElement(ProjectProvidedResources, {
        agentId: AGENT_ID,
        projectsState: {
          kind: 'failed',
          reason: 'Project associations could not be loaded: boom',
          detail: 'boom',
        },
        files: null,
        connectors: null,
        locale: 'ja',
      }),
    );
    expect(failed).toContain(
      'プロジェクトの関連付けを読み込めませんでした: <span lang="en">boom</span>',
    );
  });

  it('words the connected-storage grants list', () => {
    const html = renderToStaticMarkup(
      createElement(StorageGrantList, {
        agentId: AGENT_ID,
        grants: [{ connectionId: CONNECTION.id, prefix: 'reports', access: 'read-write' }],
        connections: { kind: 'ready', connections: [CONNECTION] },
        focusWhenEmpty: { current: null },
        onChanged: () => {},
        locale: 'ja',
      }),
    );
    expect(html).toContain('aria-label="接続済みストレージの付与"');
    expect(html).toContain('aria-label="acme-data/reports/ を削除"');
    expect(html).toContain('読み書き');
    expectNoEnglishUi(html);
  });
});

let unmount: (() => void) | undefined;
async function mount(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  unmount = () => act(() => root.unmount());
  return container;
}

beforeEach(() => {
  for (const fn of Object.values(requests)) fn.mockReset();
  requests.loadEngines.mockResolvedValue({ ok: true, value: [engine] });
  requests.loadResourceCatalogs.mockResolvedValue({
    files: new Map(),
    skills: new Map(),
    connectors: new Map(),
  });
  requests.loadAgentProjects.mockResolvedValue([]);
  requests.loadCatalog.mockResolvedValue({ models: [], unavailable: [] });
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

describe('the Configuration tab, mounted', () => {
  it('shows the whole tab in Japanese with lang="ja" and no English UI word', async () => {
    requests.loadAgent.mockResolvedValue({ ok: true, value: { agent, assignments } });
    const root = await mount(createElement(AgentDetailScreen, { agentId: AGENT_ID, locale: 'ja' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(root.querySelector('main')?.getAttribute('lang')).toBe('ja');
    const html = root.innerHTML;
    for (const word of [
      'エージェントの設定と明示的な権限',
      '定義',
      '指示文',
      'モデル',
      'エンジン',
      '権限',
      '変更を保存',
    ]) {
      expect(html).toContain(word);
    }
    expectNoEnglishUi(html);
  });

  it('leads a failed load with Japanese and keeps the transport text English', async () => {
    requests.loadAgent.mockResolvedValue(
      transport('The request failed before the server could answer: offline'),
    );
    const root = await mount(createElement(AgentDetailScreen, { agentId: AGENT_ID, locale: 'ja' }));
    const main = root.querySelector('main');
    expect(main?.getAttribute('lang')).toBe('ja');
    expect(main?.getAttribute('role')).toBe('alert');
    expect(main?.textContent).toBe(
      'エージェントを読み込めませんでした。 The request failed before the server could answer: offline',
    );
    expect(main?.querySelector('span[lang="en"]')?.textContent).toBe(
      'The request failed before the server could answer: offline',
    );
  });

  it('prints a failed load in English exactly as before', async () => {
    requests.loadAgent.mockResolvedValue(
      transport('The request failed before the server could answer: offline'),
    );
    const root = await mount(createElement(AgentDetailScreen, { agentId: AGENT_ID }));
    expect(root.querySelector('main')?.innerHTML).toBe(
      'The request failed before the server could answer: offline',
    );
  });

  it('reports a refused save in Japanese, the server’s sentence marked English', async () => {
    requests.loadAgent.mockResolvedValue({ ok: true, value: { agent, assignments } });
    requests.saveAgentDefinition.mockResolvedValue({ ok: false, problem: apiProblem });
    const root = await mount(createElement(AgentDetailScreen, { agentId: AGENT_ID, locale: 'ja' }));
    const form = root.querySelector('form');
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const alerts = [...root.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts).toContain(
      '定義を保存できませんでした: You may not change this agent.リソースの割り当ては保存を試みていません。',
    );
    expect(root.querySelector('[role="alert"] span[lang="en"]')?.textContent).toBe(
      'You may not change this agent.',
    );
    expect(requests.saveAgentAssignments).not.toHaveBeenCalled();
  });

  it('reports a refused save in English exactly as before', async () => {
    requests.loadAgent.mockResolvedValue({ ok: true, value: { agent, assignments } });
    requests.saveAgentDefinition.mockResolvedValue({ ok: false, problem: apiProblem });
    const root = await mount(createElement(AgentDetailScreen, { agentId: AGENT_ID }));
    await act(async () => {
      root
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const alerts = [...root.querySelectorAll('[role="alert"]')].map((node) => node.innerHTML);
    expect(alerts).toContain(
      '<p>Definition was not saved: You may not change this agent.</p><p>Resource assignments was not attempted.</p>',
    );
  });
});

describe('the connected-storage browser, mounted in Japanese', () => {
  it('words the connection picker and the read/write gap', async () => {
    const root = await mount(
      createElement(ConnectedStorage, {
        agentId: AGENT_ID,
        connections: { kind: 'ready', connections: [CONNECTION] },
        writeFilesAllowed: false,
        grantsRef: { current: null },
        onGranted: () => {},
        locale: 'ja',
      }),
    );
    expect(root.textContent).toContain('ストレージ接続');
    expect(root.textContent).toContain('選んでください…');
    expect(jaStorage.readWriteGap(jaStorage.connectionReadOnly, jaStorage.writeFilesOff)).toBe(
      '読み書きには、書き込みを許可した接続と、「ファイルの書き込み」が有効なエージェントの両方が必要です。この接続は読み取り専用です。このエージェントは「ファイルの書き込み」が無効です。',
    );
    expectNoEnglishUi(root.innerHTML);
  });

  it('words the empty state', async () => {
    const root = await mount(
      createElement(ConnectedStorage, {
        agentId: AGENT_ID,
        connections: { kind: 'ready', connections: [] },
        writeFilesAllowed: true,
        grantsRef: { current: null },
        onGranted: () => {},
        locale: 'ja',
      }),
    );
    expect(root.textContent).toBe('このワークスペースにはまだストレージが接続されていません。');
  });
});
