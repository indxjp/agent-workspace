// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import type { ProjectResource } from '../../contracts/projects';

import { describeEmptyProjectList } from './model';
import { ENGLISH_PROJECTS_STRINGS, projectsStrings } from './projects-messages';

// UX-15 in #2086: the Projects list screen in the reader's language.

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const { ProjectsScreen } = await import('./projects-screen');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a catalog holds, keyed by its path; functions are called with a sample. */
function flatten(strings: object): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === 'string') out.set(prefix, value);
    else if (typeof value === 'function')
      out.set(prefix, (value as (s: string | number) => string)(7));
    else
      for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        visit(prefix === '' ? key : `${prefix}.${key}`, inner);
  };
  visit('', strings);
  return out;
}

const en = projectsStrings('en');
const ja = projectsStrings('ja');

describe('projectsStrings', () => {
  it('has a Japanese word for every English one, and none is the English word', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of japanese) {
      expect(word, key).not.toBe('');
      expect(word, key).not.toBe(english.get(key));
    }
  });

  it('keeps the English empty state the screen always printed', () => {
    expect(en).toBe(ENGLISH_PROJECTS_STRINGS);
    expect(describeEmptyProjectList('archived')).toBe('No archived projects.');
    expect(describeEmptyProjectList('all')).toBe('No projects yet. Create one above.');
    expect(describeEmptyProjectList('archived', ja)).toBe(
      'アーカイブ済みのプロジェクトはありません。',
    );
    expect(describeEmptyProjectList('active', ja)).toBe(ja.emptyActive);
  });
});

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const PROJECT: ProjectResource = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Quarterly report',
  instructions: 'Use the house style.',
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy: '33333333-3333-4333-8333-333333333333',
  ownerPrincipalId: '44444444-4444-4444-8444-444444444444',
  archivedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  fileIds: ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'],
  mcpServerIds: [],
};

function serve(projects: readonly unknown[]) {
  vi.stubGlobal(
    'fetch',
    fetchDouble((request: RecordedRequest) => {
      if (request.url.pathname === '/api/projects') return jsonResponse(200, { projects });
      if (request.url.pathname === '/api/agents') return jsonResponse(200, { agents: [] });
      return jsonResponse(500, { error: { code: 'unexpected', message: 'Unexpected call.' } });
    }).fetch,
  );
}

/** English words of the catalog (long enough not to match a name) found on screen. */
function englishLeft(): string[] {
  const seen = [
    host.textContent ?? '',
    ...[...host.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
  ].join('\n');
  return [...flatten(en).values()]
    .map((word) => word.replace(/7/gu, '').trim())
    .filter((word) => word.length > 3 && seen.includes(word));
}

describe('ProjectsScreen in Japanese', () => {
  it('shows the heading, filter, New project and each row in Japanese', async () => {
    serve([PROJECT]);
    act(() => root.render(<ProjectsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('Quarterly report'));

    expect(host.querySelector('main')?.getAttribute('lang')).toBe('ja');
    expect(host.querySelector('h1')?.textContent).toBe('プロジェクト');
    expect(host.textContent).toContain(ja.intro);
    expect(host.querySelector('label')?.textContent).toBe('表示');
    expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '有効',
      'アーカイブ済み',
      'すべて',
    ]);
    expect(host.textContent).toContain('新しいプロジェクト');
    expect(host.textContent).toContain('ワークスペース');
    expect(host.textContent).toContain('既定のエージェントなし');
    expect(host.textContent).toContain('ファイル 2 件');
    expect(host.textContent).toContain('コネクタ 0 件');
    expect(host.textContent).toContain('プロジェクトの指示文あり');
    expect(englishLeft()).toEqual([]);
  });

  it('says an empty list in Japanese', async () => {
    serve([]);
    act(() => root.render(<ProjectsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain(ja.emptyActive));
    expect(englishLeft()).toEqual([]);
  });

  it('keeps the English screen as it was', async () => {
    serve([PROJECT]);
    act(() => root.render(<ProjectsScreen />));
    await vi.waitFor(() => expect(host.textContent).toContain('Quarterly report'));
    expect(host.querySelector('h1')?.textContent).toBe('Projects');
    expect(host.textContent).toContain('No default agent · 2 files · 0 connectors');
    expect(host.textContent).toContain('New project');
  });
});
