import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceSwitcher } from './workspace-switcher';

describe('WorkspaceSwitcher', () => {
  it('renders the closed trigger before the fetch effect has run (server / initial render)', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        currentSlug: 'acme',
        currentName: 'Acme Corp',
        currentDetail: 'Self-hosted',
      }),
    );
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Self-hosted');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    const controlledId = /aria-controls="([^"]+)"/u.exec(html)?.[1];
    const formId = /<form id="([^"]+)"/u.exec(html)?.[1];
    expect(controlledId).toBeDefined();
    expect(formId).toBeDefined();
    expect(controlledId).not.toBe(formId);
    // The menu itself is not in the tree at all until `open` is true — closed means absent,
    // never present-but-hidden, so a screen reader that walks the whole DOM never meets it.
    expect(html).not.toContain('role="menu"');
    // Never a fabricated role or membership before the response the card requires ("listing
    // exactly GET /api/workspaces") has actually arrived.
    expect(html).not.toContain('Loading workspaces');
  });

  it('posts to POST /api/auth/workspace — issue #120’s named switching endpoint', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        currentSlug: 'acme',
        currentName: 'Acme Corp',
        currentDetail: 'Self-hosted',
      }),
    );
    expect(html).toContain('action="/api/auth/workspace"');
    expect(html).toContain('method="post"');
  });

  it('renders no archived banner before any response has told it the current workspace is archived', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSwitcher, {
        currentSlug: 'acme',
        currentName: 'Acme Corp',
        currentDetail: 'Self-hosted',
      }),
    );
    expect(html).not.toContain('archived');
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): rendering the menu's `role="menu"`
  // container unconditionally and hiding it with a CSS class instead of omitting it from the tree
  // when `open` is false makes the first assertion above (`not.toContain('role="menu"')`) fail —
  // the exact defect a screen reader user would hit as a menu that is announced as present while
  // invisible. Gating the whole block on `open` fixes it.
});
