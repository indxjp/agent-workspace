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
      }),
    );
    expect(html).toContain('Acme Corp');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
