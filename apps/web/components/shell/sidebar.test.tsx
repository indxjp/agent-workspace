import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Sidebar } from './sidebar';

describe('Sidebar', () => {
  it('renders the plain, static brand when there is no session to switch from', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Agent Workspace', detail: 'Self-hosted', slug: null },
        user: null,
        managers: false,
      }),
    );
    expect(html).toContain('Agent Workspace');
    expect(html).toContain('Self-hosted');
    // Nothing to switch among with no session — the switcher's own controls must be absent, not
    // merely disabled, the same "absent, not disabled" rule the workspaces screen holds a Builder
    // to for rename/archive.
    expect(html).not.toContain('aria-haspopup');
  });

  it('renders the workspace switcher once a session names a current workspace', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: { name: 'Aya Ito', role: 'Owner', initials: 'AI' },
        managers: true,
      }),
    );
    expect(html).toContain('Acme Corp');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('shows the Storage entry to managers and hides it from everyone else', () => {
    const render = (managers: boolean) =>
      renderToStaticMarkup(
        createElement(Sidebar, {
          workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
          user: { name: 'Bo Li', role: 'Viewer', initials: 'BL' },
          managers,
        }),
      );
    expect(render(true)).toContain('href="/admin/storage"');
    expect(render(false)).not.toContain('/admin/storage');
    expect(render(false)).toContain('href="/admin/models"');
  });
});
