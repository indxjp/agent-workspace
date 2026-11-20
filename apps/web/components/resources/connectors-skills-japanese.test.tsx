// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';

import { connectorsStrings } from './connectors-messages';
import { ConnectorNewScreen, ConnectorsScreen, SkillsScreen } from './resource-screens';
import { skillsStrings } from './skills-messages';

// UX-15 in #2086: the Connectors, Add connector and Skills screens in the reader's language.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a catalog holds, keyed by its path; functions are called with a sample. */
function flatten(strings: object): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === 'string') out.set(prefix, value);
    else if (typeof value === 'function') out.set(prefix, (value as (s: string) => string)('X'));
    else
      for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        visit(prefix === '' ? key : `${prefix}.${key}`, inner);
  };
  visit('', strings);
  return out;
}

const CATALOGS = [
  ['connectors', connectorsStrings('en'), connectorsStrings('ja')],
  ['skills', skillsStrings('en'), skillsStrings('ja')],
] as const;

describe.each(CATALOGS)('the %s catalog', (_name, en, ja) => {
  it('has a Japanese word for every English one, and none is the English word', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of japanese) {
      expect(word, key).not.toBe('');
      expect(word, key).not.toBe(english.get(key));
    }
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

function server(answer: (request: RecordedRequest) => Response | undefined) {
  return fetchDouble(
    (request: RecordedRequest) =>
      answer(request) ??
      jsonResponse(500, { error: { code: 'unexpected', message: 'Unexpected call.' } }),
  );
}

/** The English words of a catalog (long enough not to match a name) found on screen. */
function englishLeft(en: object): string[] {
  const seen = [
    host.textContent ?? '',
    ...[...host.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
    ...[...host.querySelectorAll('[placeholder]')].map((node) => node.getAttribute('placeholder')),
  ].join('\n');
  return [...flatten(en).values()]
    .map((word) => word.replace(/X/gu, '').trim())
    .filter((word) => word.length > 3 && seen.includes(word));
}

const listed = (path: string, body: unknown) => (request: RecordedRequest) =>
  request.method === 'GET' && request.url.pathname === path ? jsonResponse(200, body) : undefined;

describe('ConnectorsScreen', () => {
  const ja = connectorsStrings('ja');

  it('shows the list in Japanese, the connector name and transport as they are stored', async () => {
    const connector = fixtures.connector({ name: 'docs-search' });
    vi.stubGlobal('fetch', server(listed('/api/connectors', { connectors: [connector] })).fetch);
    act(() => root.render(<ConnectorsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('docs-search'));

    expect(host.querySelector('[lang="ja"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(ja.title);
    expect(host.textContent).toContain(ja.intro);
    expect(host.textContent).toContain(ja.addConnector);
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual([ja.test, ja.delete]);
    expect(host.textContent).toContain('http');
    expect(englishLeft(connectorsStrings('en'))).toEqual([]);
  });

  it('says an empty list in Japanese', async () => {
    vi.stubGlobal('fetch', server(listed('/api/connectors', { connectors: [] })).fetch);
    act(() => root.render(<ConnectorsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain(ja.empty));
    expect(englishLeft(connectorsStrings('en'))).toEqual([]);
  });

  it('keeps the English screen as it was', async () => {
    vi.stubGlobal('fetch', server(listed('/api/connectors', { connectors: [] })).fetch);
    act(() => root.render(<ConnectorsScreen />));
    await vi.waitFor(() => expect(host.textContent).toContain('No connectors yet.'));
    expect(host.querySelector('h1')?.textContent).toBe('Connectors');
    expect(host.textContent).toContain('Add connector');
    expect(host.querySelector('[lang="en"]')).not.toBeNull();
  });
});

describe('ConnectorNewScreen', () => {
  const ja = connectorsStrings('ja');

  it('shows every field, option and button in Japanese, transports as protocol names', () => {
    vi.stubGlobal('fetch', server(() => undefined).fetch);
    act(() => root.render(<ConnectorNewScreen locale="ja" />));

    expect(host.querySelector('h1')?.textContent).toBe(ja.addConnector);
    expect(host.textContent).toContain(ja.newIntro);
    expect(host.textContent).toContain(ja.cancel);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      ja.testConnection,
      ja.save,
    ]);
    const labels = [...host.querySelectorAll('[aria-label]')].map((n) =>
      n.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      ja.connectorName,
      ja.transport,
      ja.endpoint,
      ja.stdioArguments,
      ja.authentication,
    ]);
    const options = [...host.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual([
      'HTTP',
      'SSE',
      'stdio',
      ja.authType.none,
      ja.authType['api-key'],
      ja.authType.bearer,
      ja.authType.oauth,
    ]);
    expect(englishLeft(connectorsStrings('en'))).toEqual([]);
  });

  it('says a passed draft test in Japanese, and a failed one as the server sent it', async () => {
    let ok = true;
    vi.stubGlobal(
      'fetch',
      server((request) =>
        request.method === 'POST'
          ? jsonResponse(
              200,
              ok
                ? {
                    ok: true,
                    kind: 'ok',
                    message: 'ok',
                    serverName: null,
                    serverVersion: null,
                    toolCount: 2,
                  }
                : { ok: false, kind: 'unreachable', message: 'ECONNREFUSED' },
            )
          : undefined,
      ).fetch,
    );
    act(() => root.render(<ConnectorNewScreen locale="ja" />));
    const fill = (name: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (input === null) throw new Error(`no ${name} field`);
      input.value = value;
    };
    fill('name', 'docs');
    fill('endpoint', 'https://mcp.example.com');
    const testButton = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === ja.testConnection,
    );
    act(() => testButton?.click());
    await vi.waitFor(() => expect(host.textContent).toContain(ja.draftTestPassed));
    ok = false;
    act(() => testButton?.click());
    await vi.waitFor(() => expect(host.textContent).toContain('ECONNREFUSED'));
  });
});

/** One item of `GET /api/skills`, contract-valid. */
function skill(name: string, enabled: boolean) {
  return {
    id: `skill-${name}`,
    name,
    enabled,
    description: null,
    fileCount: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    source: null,
    instructions: null,
    allowedTools: null,
    files: [],
  };
}

describe('SkillsScreen', () => {
  const ja = skillsStrings('ja');

  it('shows the screen in Japanese, skill names as they are stored', async () => {
    vi.stubGlobal(
      'fetch',
      server(
        listed('/api/skills', {
          skills: [skill('pdf-summary', true), skill('old-skill', false)],
        }),
      ).fetch,
    );
    act(() => root.render(<SkillsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain('pdf-summary'));

    expect(host.querySelector('[lang="ja"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(ja.title);
    expect(host.textContent).toContain(ja.intro);
    expect(host.textContent).toContain(ja.createSkill);
    expect(host.textContent).toContain(ja.enabled);
    expect(host.textContent).toContain(ja.disabled);
    expect(host.querySelector('[name="name"]')?.getAttribute('placeholder')).toBe('skill-name');
    expect(englishLeft(skillsStrings('en'))).toEqual([]);
  });

  it('says an empty list in Japanese', async () => {
    vi.stubGlobal('fetch', server(listed('/api/skills', { skills: [] })).fetch);
    act(() => root.render(<SkillsScreen locale="ja" />));
    await vi.waitFor(() => expect(host.textContent).toContain(ja.empty));
  });

  it('keeps the English screen as it was', async () => {
    vi.stubGlobal('fetch', server(listed('/api/skills', { skills: [] })).fetch);
    act(() => root.render(<SkillsScreen />));
    await vi.waitFor(() => expect(host.textContent).toContain('No skills yet.'));
    expect(host.querySelector('h1')?.textContent).toBe('Skills');
    expect(host.textContent).toContain('Create and manage private workspace skills.');
    expect(host.textContent).toContain('Create skill');
  });
});
