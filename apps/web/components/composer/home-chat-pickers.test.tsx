// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeChat, type HomeChatProps } from './home-chat';
import type { ComposerAgent } from './model';

const AGENT: ComposerAgent = {
  id: 'a',
  name: 'Research',
  detail: '',
  files: [],
  connectors: [],
  sandbox: 'Standard Sandbox',
  runTarget: { kind: 'runnable', source: 'workspace', connectionName: 'c', model: 'm' },
  drivableProviders: ['anthropic'],
};

const PROPS: HomeChatProps = {
  agents: { kind: 'agents', agents: [AGENT] },
  recent: [],
  user: { initials: 'A', name: 'alex@example.com' },
};

async function render(props: Partial<HomeChatProps> = {}): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<HomeChat {...PROPS} {...props} />);
    await Promise.resolve();
  });
  return container;
}

async function open(
  container: HTMLElement,
  picker: 'agent' | 'files' | 'connectors',
): Promise<void> {
  const summary = container.querySelector<HTMLElement>(
    `details[data-picker="${picker}"] > summary`,
  );
  if (summary === null) throw new Error(`no ${picker} picker`);
  await act(async () => {
    summary.click();
    await Promise.resolve();
  });
}

function picker(container: HTMLElement, id: 'agent' | 'files' | 'connectors'): HTMLElement {
  const element = container.querySelector<HTMLElement>(`details[data-picker="${id}"]`);
  if (element === null) throw new Error(`no ${id} picker`);
  return element;
}

function link(container: HTMLElement, text: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll('a')].find((a) => a.textContent?.trim() === text);
}

// #2089: the pickers were empty boxes with two disabled placeholders.
describe('HomeChat pickers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('says in words why the Files picker lists nothing, and links Upload to Files', async () => {
    const container = await render();
    await open(container, 'files');
    expect(picker(container, 'files').hasAttribute('open')).toBe(true);
    expect(picker(container, 'files').textContent).toContain(
      'No workspace files are listed for this agent. It still reads every file granted to it.',
    );
    expect(link(container, 'Upload')?.getAttribute('href')).toBe('/files');
    // Saying "only permitted files are listed" under an empty list would contradict the sentence.
    expect(picker(container, 'files').textContent).not.toContain(
      'Only files this agent is permitted to read are listed.',
    );
    expect(picker(container, 'files').querySelectorAll('button[aria-pressed]')).toHaveLength(0);
  });

  it('says in words why the Connectors picker lists nothing', async () => {
    const container = await render();
    await open(container, 'connectors');
    expect(picker(container, 'connectors').textContent).toContain(
      "This agent's connectors are not listed here yet. It can still use the connectors set on it in every chat.",
    );
  });

  it('links Manage agents to the Agents screen', async () => {
    const container = await render();
    await open(container, 'agent');
    expect(link(container, 'Manage agents')?.getAttribute('href')).toBe('/agents');
  });

  it('lists an agent’s options without the empty sentence when there are some', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    const container = document.createElement('div');
    document.body.append(container);
    const withFiles: HomeChatProps = {
      ...PROPS,
      agents: {
        kind: 'agents',
        agents: [{ ...AGENT, files: [{ id: 'f1', name: 'Q3 report', detail: 'reports/q3.pdf' }] }],
      },
    };
    await act(async () => {
      createRoot(container).render(<HomeChat {...withFiles} />);
      await Promise.resolve();
    });
    await open(container, 'files');
    expect(picker(container, 'files').textContent).toContain('Q3 report');
    expect(picker(container, 'files').textContent).not.toContain('No workspace files are listed');
    expect(picker(container, 'files').textContent).toContain(
      'Only files this agent is permitted to read are listed. Pick some to limit this chat to them; pick none to keep them all.',
    );
  });

  // UX-21 in #2086: + Files leads only into the switched-off feature.
  it('does not offer + Files when the workspace has Files switched off', async () => {
    const off = await render({ filesEnabled: false });
    expect(off.querySelector('details[data-picker="files"]')).toBeNull();
    expect(off.querySelector('details[data-picker="connectors"]')).not.toBeNull();
    expect(link(off, 'Upload')).toBeUndefined();
    expect(off.textContent).toContain('Pick an agent, add connectors, and start.');
    document.body.replaceChildren();

    const on = await render();
    expect(on.querySelector('details[data-picker="files"]')).not.toBeNull();
    expect(on.textContent).toContain('Pick an agent, add files or connectors, and start.');
  });
});
