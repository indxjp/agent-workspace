import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RuntimeIndicator } from './topbar';

describe('RuntimeIndicator', () => {
  it('allows the status link to shrink and wrap before the mobile viewport overflows', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimeIndicator, {
        runtime: { label: 'not configured', warn: true, href: '/admin/runtimes' },
      }),
    );

    expect(html).toContain('Runtime: not configured');
    expect(html).toContain('min-w-0');
    expect(html).toContain('max-w-full');
    expect(html).toContain('whitespace-normal');
    expect(html).toContain('sm:whitespace-nowrap');
  });

  it('keeps the local chip amber with its isolation reason on hover', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimeIndicator, {
        runtime: {
          label: 'local',
          warn: true,
          href: '/admin/runtimes',
          reason: 'No tenant isolation: commands run as the host user',
        },
      }),
    );

    expect(html).toContain('Runtime: local');
    expect(html).toContain('bg-warn-soft');
    expect(html).toContain('title="No tenant isolation: commands run as the host user"');
    expect(html).not.toContain('aria-label="Dismiss"');
  });
});
