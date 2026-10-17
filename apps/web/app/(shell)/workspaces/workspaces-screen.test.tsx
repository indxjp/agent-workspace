import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { WorkspaceMembership } from '../../../components/shell/workspaces-directory';
import {
  CreateWorkspaceForm,
  WorkspaceDirectoryTable,
  WorkspaceSettingsPanel,
  WorkspacesProblemView,
  WorkspacesScreen,
} from './workspaces-screen';

const OWNED: WorkspaceMembership = {
  id: 'ws-1',
  slug: 'acme',
  name: 'Acme Corp',
  role: 'owner',
  archivedAt: null,
  publicSharingEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const VIEWER_ROW: WorkspaceMembership = {
  ...OWNED,
  id: 'ws-2',
  slug: 'beta',
  name: 'Beta Inc',
  role: 'viewer',
};

const ARCHIVED_OWNED: WorkspaceMembership = {
  ...OWNED,
  id: 'ws-3',
  slug: 'gamma',
  name: 'Gamma LLC',
  archivedAt: '2026-03-01T00:00:00.000Z',
};

describe('WorkspacesScreen', () => {
  it('renders the page head before the fetch effect has run (server / initial render)', () => {
    const html = renderToStaticMarkup(createElement(WorkspacesScreen));
    expect(html).toContain('<h1');
    expect(html).toContain('Workspaces');
    expect(html).toContain('Loading workspaces');
    // Nothing invented before GET /api/workspaces actually answers.
    expect(html).not.toContain('Create workspace');
  });
});

describe('WorkspaceDirectoryTable', () => {
  it('renders zero memberships as an explicit sentence, not an empty table', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDirectoryTable, {
        items: [],
        selectedId: null,
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain('You do not currently belong to any workspace.');
    expect(html).not.toContain('<table');
  });

  it('renders one membership, its role and its Active status', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDirectoryTable, {
        items: [OWNED],
        selectedId: null,
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain('Acme Corp');
    expect(html).toContain('owner');
    expect(html).toContain('Active');
    expect(html).not.toContain('Archived');
  });

  it('renders many memberships, each with its own role and archived state', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDirectoryTable, {
        items: [OWNED, VIEWER_ROW, ARCHIVED_OWNED],
        selectedId: 'ws-2',
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Beta Inc');
    expect(html).toContain('Gamma LLC');
    expect(html).toContain('viewer');
    expect(html).toContain('Archived');
    expect(html).toContain('aria-current="true"');
  });
});

describe('WorkspaceSettingsPanel', () => {
  it('renders rename and archive controls for the workspace’s own Owner', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettingsPanel, {
        workspace: OWNED,
        onUpdated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html).toContain('<input');
    expect(html).toContain('Save');
    expect(html).toContain('Archive workspace');
    expect(html).not.toContain('Only this workspace');
  });

  it('renders no rename input and no archive control for a non-Owner — absent, not disabled', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettingsPanel, {
        workspace: VIEWER_ROW,
        onUpdated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html).toContain('Beta Inc');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).toContain('Only this workspace');
  });

  it('offers a Restore control for an archived workspace’s Owner', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettingsPanel, {
        workspace: ARCHIVED_OWNED,
        onUpdated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html).toContain('Restore workspace');
  });

  it('states how to restore before archiving even happens', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettingsPanel, {
        workspace: OWNED,
        onUpdated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html.toLowerCase()).toContain('restored');
  });

  it('renders no restore control for an archived workspace’s non-Owner', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettingsPanel, {
        workspace: { ...ARCHIVED_OWNED, role: 'admin' },
        onUpdated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html).not.toContain('Restore workspace');
    expect(html).toContain('Only this workspace');
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): rendering the rename `<input>` and the
  // "Archive workspace…" button unconditionally (dropping the `canAdminister` guard) makes the
  // second test above fail — a Viewer's rendered markup would contain `<input` and `<button>`,
  // exactly the "unauthorised controls are absent" criterion this task must not regress. Restoring
  // the guard fixes it.
});

describe('WorkspacesProblemView', () => {
  it('renders nothing for no problem', () => {
    expect(renderToStaticMarkup(createElement(WorkspacesProblemView, { problem: null }))).toBe('');
  });

  it('renders the server’s exact wording for an API problem — never a generic message', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacesProblemView, {
        problem: {
          kind: 'api',
          status: 409,
          code: 'slug_taken',
          detail: '"acme" is already in use by another workspace.',
        },
      }),
    );
    expect(html).toContain('409');
    expect(html).toContain('slug_taken');
    expect(html).toContain('&quot;acme&quot; is already in use by another workspace.');
  });

  it('renders a transport problem’s reason', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspacesProblemView, {
        problem: { kind: 'transport', reason: 'network down' },
      }),
    );
    expect(html).toContain('network down');
  });
});

describe('CreateWorkspaceForm', () => {
  it('is closed by default: a single "Create workspace" button, no fields', () => {
    const html = renderToStaticMarkup(
      createElement(CreateWorkspaceForm, {
        onCreated: () => undefined,
        onSessionProblem: () => false,
      }),
    );
    expect(html).toContain('Create workspace');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Only this workspace');
  });
});
