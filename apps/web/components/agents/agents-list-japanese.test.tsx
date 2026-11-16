// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentResource } from '../../contracts/agents';
import { agentsListStrings } from './agents-list-messages';
import type { RequestProblem } from './model';
import { newAgentStrings } from './new-agent-messages';
import { ProblemDetail } from './problem-line';

// UX-15 in #2086: the Agents list in the reader's language, and a failed load led in Japanese on
// the Agents list and the New Agent form.

const requests = vi.hoisted(() => ({
  loadAgents: vi.fn(),
  loadNewAgentCatalogs: vi.fn(),
  loadCatalog: vi.fn(),
}));
vi.mock('./agent-requests-model', () => ({
  loadAgents: requests.loadAgents,
  loadNewAgentCatalogs: requests.loadNewAgentCatalogs,
  createAgent: vi.fn(),
}));
vi.mock('../models/connections-model', () => ({ loadCatalog: requests.loadCatalog }));
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));
vi.mock('../shares/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { AgentsListScreen } = await import('./agents-list');
const { NewAgentScreen } = await import('./agent-form');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a strings object holds, keyed by its path; functions are called with a sample. */
function flatten(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') out.set(path, value);
  else if (typeof value === 'function') {
    out.set(`${path}(1)`, (value as (arg: unknown) => string)(1));
    out.set(`${path}(3)`, (value as (arg: unknown) => string)(3));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${path}.${key}`, out);
  }
  return out;
}

const en = agentsListStrings('en');
const ja = agentsListStrings('ja');
const ENGLISH = [...flatten(en).values()].filter((word) => word.length > 1);

function agent(id: string, name: string, model: string | null): AgentResource {
  return {
    id,
    workspaceId: 'w1',
    name,
    instructions: `${name} の指示`,
    modelConnectionId: model === null ? null : 'conn-1',
    model,
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
}

const refused: RequestProblem = {
  kind: 'api',
  status: 403,
  code: 'forbidden',
  message: 'You may not list agents.',
};

let unmount: (() => void) | undefined;
async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  unmount = () => act(() => root.unmount());
  return container;
}

/** The text a reader sees and the names they hear, with what is marked English removed. */
function readable(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const english of copy.querySelectorAll('[lang="en"], input, textarea')) english.remove();
  const names = [...copy.querySelectorAll('[aria-label], [placeholder]')].map(
    (node) => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('placeholder') ?? ''}`,
  );
  return `${copy.textContent ?? ''}\n${names.join('\n')}`;
}

beforeEach(() => {
  for (const fn of Object.values(requests)) fn.mockReset();
  requests.loadNewAgentCatalogs.mockResolvedValue({
    runtimeProfiles: [],
    resources: { files: [], skills: [], connectors: [] },
  });
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

describe('the Agents list words', () => {
  it('has a Japanese word for every English one, and none left the same', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      expect(japanese.get(key), key).not.toBe(word);
    }
  });

  it('keeps the English this screen always printed, word for word', () => {
    expect(en.count(1)).toBe('1 agent');
    expect(en.count(3)).toBe('3 agents');
    expect(en.noMatch('zz')).toBe('No agent matches “zz”.');
    expect(en.empty).toBe('This workspace has no agents yet.');
    expect(en.workspaceDefault).toBe('Workspace default');
  });
});

describe('the Agents list, mounted', () => {
  it('shows the list in Japanese with lang="ja" and no English UI word', async () => {
    requests.loadAgents.mockResolvedValue({
      ok: true,
      value: [agent('a1', '契約書レビュー', null), agent('a2', '議事録', 'claude-x')],
    });
    const root = await mount(createElement(AgentsListScreen, { locale: 'ja' }));
    expect(root.querySelector('main')?.getAttribute('lang')).toBe('ja');
    const text = readable(root);
    for (const word of [
      'エージェント',
      '2 件のエージェント',
      '新しいエージェント',
      'ワークスペースの既定',
      '作成日',
    ]) {
      expect(text).toContain(word);
    }
    expect(root.querySelector('input[type="search"]')?.getAttribute('aria-label')).toBe(
      'エージェントを検索',
    );
    for (const word of ENGLISH) expect(text, word).not.toContain(word);
    // The created date in Japanese, whatever the test machine's own locale.
    expect(text).toContain('2026年11月');
  });

  it('says so in Japanese when nothing matches the search', async () => {
    requests.loadAgents.mockResolvedValue({ ok: true, value: [agent('a1', '議事録', null)] });
    const root = await mount(createElement(AgentsListScreen, { locale: 'ja' }));
    const search = root.querySelector<HTMLInputElement>('input[type="search"]');
    await act(async () => {
      if (search === null) return;
      // The prototype's setter, so React sees the change as typed input.
      Reflect.set(HTMLInputElement.prototype, 'value', 'zz', search);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(root.textContent).toContain('「zz」に一致するエージェントはありません。');
  });

  it('leads a refused list in Japanese and keeps the server’s sentence English', async () => {
    requests.loadAgents.mockResolvedValue({ ok: false, problem: refused });
    const root = await mount(createElement(AgentsListScreen, { locale: 'ja' }));
    expect(root.textContent).toContain('エージェント一覧を読み込めませんでした。');
    expect(root.textContent).toContain('403 forbidden');
    expect(root.querySelector('[lang="en"]')?.textContent).toBe('You may not list agents.');
  });

  it('prints a refused list in English as before, with no lead', async () => {
    requests.loadAgents.mockResolvedValue({ ok: false, problem: refused });
    const root = await mount(createElement(AgentsListScreen, { locale: 'en' }));
    expect(root.textContent).toContain('403 forbiddenYou may not list agents.');
    expect(root.textContent).not.toContain(en.loadFailed);
  });
});

describe('a failed load on the New Agent form', () => {
  it('leads the models failure in Japanese and keeps the error’s own text English', async () => {
    requests.loadCatalog.mockRejectedValue(new Error('offline'));
    const root = await mount(createElement(NewAgentScreen, { chatEnabled: false, locale: 'ja' }));
    const alert = [...root.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes(newAgentStrings('ja').modelsFailed),
    );
    expect(alert?.textContent).toBe('モデルを読み込めませんでした: offline');
    expect(alert?.querySelector('[lang="en"]')?.textContent).toBe('offline');
  });

  it('prints it in English exactly as before', async () => {
    requests.loadCatalog.mockRejectedValue(new Error('offline'));
    const root = await mount(createElement(NewAgentScreen, { chatEnabled: false }));
    const alert = [...root.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes('Models could not be loaded'),
    );
    expect(alert?.innerHTML).toBe('Models could not be loaded: offline');
  });
});

describe('ProblemDetail', () => {
  it('opens with the lead in Japanese only and marks the transport sentence English', () => {
    const problem: RequestProblem = {
      kind: 'transport',
      reason: 'The run list could not be loaded: offline',
    };
    const jaHtml = renderToStaticMarkup(
      createElement(ProblemDetail, {
        locale: 'ja',
        lead: '実行の一覧を読み込めませんでした。',
        problem,
      }),
    );
    expect(jaHtml).toBe(
      '<div class="font-semibold">実行の一覧を読み込めませんでした。</div><div lang="en">The run list could not be loaded: offline</div>',
    );
    const enHtml = renderToStaticMarkup(
      createElement(ProblemDetail, { locale: 'en', lead: 'unused', problem }),
    );
    expect(enHtml).toBe('<div lang="en">The run list could not be loaded: offline</div>');
  });
});
