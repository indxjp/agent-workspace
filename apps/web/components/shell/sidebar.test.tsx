import { FEATURE_IDS } from '@indx-workspace/contracts/features';
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

  it('shows the manager-only entries to managers and hides them from everyone else (UX-12)', () => {
    const render = (managers: boolean) =>
      renderToStaticMarkup(
        createElement(Sidebar, {
          workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
          user: { name: 'Bo Li', role: 'Viewer', initials: 'BL' },
          managers,
        }),
      );
    for (const href of [
      '/admin/models',
      '/admin/storage',
      '/admin/users',
      '/admin/api-keys',
      '/admin/runtimes',
    ]) {
      expect(render(true)).toContain(`href="${href}"`);
      expect(render(false)).not.toContain(href);
    }
    // Every member may manage the links they shared, and reads the Features card on Settings.
    expect(render(false)).toContain('href="/admin/shares"');
    expect(render(false)).toContain('href="/admin/settings"');
  });

  it('renders byte-identically with no features prop and with every feature on', () => {
    for (const managers of [true, false]) {
      const props = {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: { name: 'Aya Ito', role: 'Owner', initials: 'AI' },
        managers,
      };
      expect(renderToStaticMarkup(createElement(Sidebar, props))).toBe(
        renderToStaticMarkup(createElement(Sidebar, { ...props, features: FEATURE_IDS })),
      );
    }
  });

  it('omits the entry of a feature that is not listed, and keeps the core entries', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: null,
        managers: false,
        features: FEATURE_IDS.filter((feature) => feature !== 'files'),
      }),
    );
    expect(html).not.toContain('href="/files"');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/skills"');
  });

  it("shows only chat's and files' entries beside the core ones when just those are on", () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: null,
        managers: true,
        features: ['chat', 'files'],
      }),
    );
    for (const href of ['/', '/files', '/agents', '/admin/models', '/admin/settings']) {
      expect(html).toContain(`href="${href}"`);
    }
    for (const href of ['/projects', '/skills', '/connectors', '/runs', '/admin/shares']) {
      expect(html).not.toContain(`href="${href}"`);
    }
    expect(html).not.toContain('Shared links');
  });

  it('offers Sign out to a signed-in user when the layout passes the action', () => {
    const signOut = (): Promise<void> => Promise.resolve();
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: { name: 'Aya Ito', role: 'Owner', initials: 'AI' },
        managers: true,
        signOut,
      }),
    );
    expect(html).toMatch(/<form[^>]*>\s*<button type="submit"[^>]*>Sign out<\/button>\s*<\/form>/u);
  });

  it('says Sign out in Japanese to a Japanese reader', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: { name: 'Acme Corp', detail: 'Self-hosted', slug: 'acme' },
        user: { name: 'Aya Ito', role: 'Owner', initials: 'AI' },
        managers: true,
        locale: 'ja',
        signOut: (): Promise<void> => Promise.resolve(),
      }),
    );
    expect(html).toMatch(/<button type="submit"[^>]*>サインアウト<\/button>/u);
    expect(html).not.toContain('Sign out');
  });

  it('shows no Sign out without a user or without the action', () => {
    const signOut = (): Promise<void> => Promise.resolve();
    const brand = { name: 'Acme Corp', detail: 'Self-hosted', slug: null };
    const noUser = renderToStaticMarkup(
      createElement(Sidebar, { workspace: brand, user: null, managers: false, signOut }),
    );
    const noAction = renderToStaticMarkup(
      createElement(Sidebar, {
        workspace: brand,
        user: { name: 'Aya Ito', role: 'Owner', initials: 'AI' },
        managers: false,
      }),
    );
    expect(noUser).not.toContain('Sign out');
    expect(noAction).not.toContain('Sign out');
  });
});
