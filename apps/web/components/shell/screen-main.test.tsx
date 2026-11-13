import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NotAllowedScreen } from './screen-main';

describe('NotAllowedScreen', () => {
  it('keeps a refused screen inside one main landmark, under its own heading (UX-24)', () => {
    const html = renderToStaticMarkup(
      <NotAllowedScreen title="Storage">
        Only workspace Owners and Admins can manage storage.
      </NotAllowedScreen>,
    );
    expect(html.match(/<main/gu)).toHaveLength(1);
    expect(html).toMatch(/^<main[^>]*><h1[^>]*>Storage<\/h1><p[^>]*>Only workspace Owners/u);
  });
});
