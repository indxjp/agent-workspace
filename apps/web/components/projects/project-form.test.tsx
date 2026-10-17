import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDraft } from './model';
import {
  ProjectFields,
  ProjectProblem,
  confirmDiscard,
  type ProjectCatalogs,
} from './project-form';

const EMPTY_CATALOGS: ProjectCatalogs = { agents: [], files: [], connectors: [] };

const DRAFT: ProjectDraft = {
  name: 'Contract Review',
  instructions: 'Be thorough.',
  visibility: 'workspace',
  defaultAgentId: 'agent-1',
  defaultModel: null,
  fileIds: ['file-1'],
  mcpServerIds: [],
};

const CATALOGS: ProjectCatalogs = {
  agents: [{ id: 'agent-1', label: 'Support' }],
  files: [
    { id: 'file-1', label: '/contracts' },
    { id: 'file-2', label: '/templates' },
  ],
  connectors: [{ id: 'connector-1', label: 'Slack' }],
};

describe('ProjectFields', () => {
  it('renders the fields the Minimum implementation names, and nothing else', () => {
    const html = renderToStaticMarkup(
      <ProjectFields draft={DRAFT} catalogs={CATALOGS} onChange={() => undefined} idPrefix="t" />,
    );
    expect(html).toContain('t-name');
    expect(html).toContain('t-instructions');
    expect(html).toContain('t-visibility');
    expect(html).toContain('t-default-agent');
    expect(html).toContain('/contracts');
    expect(html).toContain('/templates');
    expect(html).toContain('Slack');
    expect(html).toContain('Support');
    // #123 keeps model, runtime and budget controls out until their own resolution contract lands.
    expect(html.toLowerCase()).not.toContain('runtime');
    expect(html.toLowerCase()).not.toContain('budget');
  });

  it('checks exactly the file ids the draft already carries', () => {
    const oneFileCatalog: ProjectCatalogs = {
      ...EMPTY_CATALOGS,
      files: [{ id: 'file-1', label: '/contracts' }],
    };
    const checkedHtml = renderToStaticMarkup(
      <ProjectFields
        draft={{ ...DRAFT, fileIds: ['file-1'] }}
        catalogs={oneFileCatalog}
        onChange={() => undefined}
        idPrefix="t"
      />,
    );
    const uncheckedHtml = renderToStaticMarkup(
      <ProjectFields
        draft={{ ...DRAFT, fileIds: [] }}
        catalogs={oneFileCatalog}
        onChange={() => undefined}
        idPrefix="t"
      />,
    );
    // react-dom's static markup renders a controlled checkbox's boolean prop as the attribute.
    expect(checkedHtml).toContain('checked=""');
    expect(uncheckedHtml).not.toContain('checked=""');
  });

  it('shows an empty-catalogue message rather than an empty, unexplained fieldset', () => {
    const html = renderToStaticMarkup(
      <ProjectFields
        draft={DRAFT}
        catalogs={EMPTY_CATALOGS}
        onChange={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('None configured.');
  });
});

describe('ProjectProblem', () => {
  it('renders nothing for no problem', () => {
    expect(renderToStaticMarkup(<ProjectProblem problem={null} />)).toBe('');
  });

  it("renders the server's own code and message for an api problem, unmodified", () => {
    const html = renderToStaticMarkup(
      <ProjectProblem
        problem={{
          kind: 'api',
          status: 409,
          code: 'project_conflict',
          message: 'Someone else already saved this project.',
        }}
      />,
    );
    expect(html).toContain('409');
    expect(html).toContain('project_conflict');
    expect(html).toContain('Someone else already saved this project.');
    expect(html).toContain('role="alert"');
  });

  it('renders a transport reason when the server never answered', () => {
    const html = renderToStaticMarkup(
      <ProjectProblem problem={{ kind: 'transport', reason: 'the network request failed' }} />,
    );
    expect(html).toContain('the network request failed');
  });
});

describe('confirmDiscard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never prompts over a clean form', () => {
    const confirmSpy = vi.fn();
    vi.stubGlobal('window', { confirm: confirmSpy });
    expect(confirmDiscard(false)).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('asks, and returns the answer, when there is something to lose', () => {
    vi.stubGlobal('window', { confirm: vi.fn().mockReturnValue(false) });
    expect(confirmDiscard(true)).toBe(false);
    vi.stubGlobal('window', { confirm: vi.fn().mockReturnValue(true) });
    expect(confirmDiscard(true)).toBe(true);
  });
});
